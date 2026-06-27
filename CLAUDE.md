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
