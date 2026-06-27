# CLAUDE.md — nodecast-tv (DVR fork)

Fork of [technomancer702/nodecast-tv](https://github.com/technomancer702/nodecast-tv)
adding **DVR recording** for Live TV channels. Upstream is tracked as the `upstream`
remote; feature work lives on `feat/recording` and is rebased onto `upstream/main`.

This file is the living spec for the recording feature. Keep it current when behavior
changes. All configuration is env-driven so nothing deployment-specific is committed.

---

## Feature: Live TV recording (DVR)

Record any Live TV channel server-side, independent of who is watching. Recordings are
captured to fast local storage and then moved to a configurable destination, so a brief
outage of remote/network storage never loses an in-progress recording.

### Trigger modes (graceful degradation)
The per-channel record control offers, depending on availability:

- **Record this program** — shown only when EPG has a current programme for the channel.
  Records from programme start to end with configurable pre/post padding; the file is
  named from the programme title.
- **Record for N minutes** — always available; ffmpeg auto-stops via `-t`. Default
  duration is configurable.
- **Record now / Stop** — manual toggle; runs until stopped from the Recordings view.

### Capture
Each recording spawns its **own** ffmpeg process pulling the channel's upstream URL
directly (not a tap on the per-viewer proxy), so it keeps running after the viewer
navigates away and a channel can be recorded without watching it.

- `ffmpeg -i <upstream> -c copy -f mpegts <file>.ts` — no re-encode: low CPU, original
  quality preserved, and `.ts` stays playable if the process is killed mid-write.
- Post-move remux to `.mp4` is intentionally out of scope for v1 (YAGNI).

### Resilience: local staging then move
1. ffmpeg writes to a local staging directory (`RECORD_STAGING_PATH`).
2. On completion the file is **moved** to `RECORD_SAVE_PATH`.
3. If the destination is unhealthy at move time, the file stays staged and a **retry
   queue** re-attempts on an interval until the move succeeds.

A recording therefore survives a remote-storage reboot mid-record; the destination only
needs to be healthy at move time. Destination health is checked before each move (the
mount must actually be a mounted filesystem, not an empty placeholder directory). Staged
and pending-move states are visible in the Recordings view and persist across restarts.

### Provider connection cost
Each recording opens its **own connection to the IPTV provider**. Most providers cap
concurrent connections, so recording while watching — or multiple simultaneous
recordings — can exceed the limit. `RECORD_MAX_CONCURRENT` bounds this; exceeding it
surfaces a clear error rather than failing silently. The header recording indicator
makes the active connection cost visible (see UI).

The navbar **connection badge** shows each Xtream provider's `active_cons/max_connections`
(per source, not summed — limits are per provider), merged with nodecast's own in-flight
usage (active recordings by `source_id`, transcoded playback by host match) so this box's
activity is attributed to the right source immediately. A **direct** browser→provider
playback (compatible streams) holds no server session, so only the provider's (laggy)
counter sees it — this is what the shared-live-stream feature below resolves.

---

## Feature: Shared live stream — watch + record on one connection (in progress)

**Problem.** Playback and recording each open a *separate* upstream connection. With
per-channel/per-account provider limits, watching + recording the same channel exceeds the
limit (403). Playback path also varies by probe result:
- compatible stream → **direct** browser→provider (no server connection)
- `needsRemux` → `/api/remux` proxy (1 server upstream)
- `needsTranscode` → HLS session in `transcode-cache` (1 server upstream)

**Goal.** One upstream connection per `(source, stream)` feeds **both** playback and recording.

**Design — shared live session**, keyed by `sourceId:streamId`:
- One server ffmpeg pulls the provider once and writes rolling HLS segments to the transcode
  cache (mechanism already exists). Reuse via `getOrCreateSession` (currently bypassed by the
  route — see Phase 1).
- **Playback** loads that session's local m3u8 (already how `needsTranscode` works).
- **Recording** points its ffmpeg input at the **local** playlist
  (`127.0.0.1/api/transcode/{id}/stream.m3u8`) with `-c copy` → **zero** extra upstream
  connections.
- **Lifecycle:** ref-count viewers + recorders; the session lives while either is attached;
  existing idle cleanup tears it down after the last detaches. A recording must pin the
  session alive even if the viewer leaves.

**Quality rule.** Recording from the shared session is lossless only when the session is
copy/remux (compatible stream). If the session must *transcode* (incompatible codec),
recording from it captures the re-encoded stream; for lossless, the recording falls back to
its own direct upstream connection (costs the 2nd connection, preserves quality).

**Phased plan** (each phase shipped + verified before the next):
1. **Session reuse** (foundation, low risk): `POST /api/transcode/session` keys/dedupes via
   `getOrCreateSession` on `sourceId:streamId` so N viewers of a channel share one
   ffmpeg/upstream. No recording change. Verify: two plays of one channel = one session.
2. **Record-from-session** (the core win): when starting a recording, attach to (or create)
   the channel's shared session and run the recorder with `-i <local m3u8> -c copy`. Net
   watch+record = 1 upstream. Fall back to direct upstream when no session exists or a
   transcoding session can't satisfy the lossless rule.
3. **Lifecycle + accounting:** ref-count viewers+recorders; keep the session alive for the
   recording's duration; the connection badge counts a shared session once.
4. *(Optional, later)* route **all** live playback through sessions for exact connection
   accounting; this HLS buffer is also the basis for the parked **record-last-X (timeshift)**.

Note: Phases 1–2 change the live playback path — checkpoint before each.

---

## Configuration (env)

All recording config is read from the environment at startup. Code falls back to generic
container-internal defaults only — never to deployment-specific values. See
`.env.example` for the documented shape; the real `.env` is gitignored.

| Variable | Default | Purpose |
|---|---|---|
| `RECORD_SAVE_PATH` | `/recordings` | Destination directory for finished recordings (container path) |
| `RECORD_STAGING_PATH` | `/staging` | Local fast-storage staging directory (container path) |
| `RECORD_DEFAULT_DURATION_MIN` | `120` | Default duration for fixed-duration recordings |
| `RECORD_EPG_PRE_PAD_MIN` | `2` | Minutes recorded before EPG programme start |
| `RECORD_EPG_POST_PAD_MIN` | `5` | Minutes recorded after EPG programme end |
| `RECORD_MAX_CONCURRENT` | `1` | Max simultaneous recordings (provider connection cap) |

The host paths that back `RECORD_SAVE_PATH` / `RECORD_STAGING_PATH` are supplied via env
interpolation in compose (e.g. `${RECORD_HOST_PATH}:/recordings`) and live only in the
gitignored `.env`. A committed `docker-compose.example.yml` documents the volume shape.

---

## Architecture

UI strings are English to match upstream.

### Backend
- `server/routes/record.js` (new) — `POST /api/record/start`, `DELETE /api/record/:id`,
  `GET /api/record` (status). Protected by the existing `requireAuth` middleware.
- `server/services/recordSession.js` (new) — `RecordSession`, mirroring the existing
  `TranscodeSession`: builds ffmpeg args, spawns the process, tracks lifecycle, writes to
  staging, then enqueues the move.
- `server/services/recordMover.js` (new) — destination health check + move + retry queue,
  driven off the `recording_sessions` table so it resumes after a restart.
- Recording config loaded from env at startup (alongside `app.locals.ffmpegPath`).

### Database
- New `recording_sessions` table (better-sqlite3): id, channel id/name, programme title,
  mode, start/end, file path, state (`recording|moving|pending-move|done|error`), error.
  Backs the Recordings view and the resumable retry queue.

### Frontend
- `public/js/components/ChannelList.js` — per-channel record control next to the favorite
  button, opening a small mode menu (program / duration / manual).
- Recordings view — active / queued / completed list with stop and a pending-move
  indicator; this is where the connection-cost context is shown.
- Header recording indicator — compact, e.g. `● REC 2`, shown only while recordings are
  active; click navigates to the Recordings view to manage them.
- `public/js/api.js` — `API.record.{ start, stop, list }` client methods.

---

## Testing

- Unit: destination health check; move/retry-queue state machine; EPG end-time + padding
  math; filename sanitization.
- Integration: `/api/record` start -> stop -> move against a temporary destination dir.
- ffmpeg is mocked at the spawn boundary.

---

## Working on this fork

```sh
# catch up with upstream
git fetch upstream && git rebase upstream/main

# run the local branch build
docker compose up -d --build
```
