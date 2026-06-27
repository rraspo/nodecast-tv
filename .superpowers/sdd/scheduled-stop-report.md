# Scheduled Stop Feature — Implementation Report

## Schema + Migration

`server/db/recordings.js`: Added `stop_at INTEGER` column to `RECORDINGS_DDL` (new databases get it via CREATE TABLE). Added `setStopAt(id, stopAtMs)` method that runs a parameterized UPDATE, accepting a number or null.

`server/db/sqlite.js`: Added migration block immediately after the channel-identity migrations — `try { ALTER TABLE recording_sessions ADD COLUMN stop_at INTEGER } catch` (same try/catch ignore pattern as existing migrations). Existing databases gain the column on next startup.

## clampStopAt

Pure helper in `server/routes/record.js`, exported for tests:

- Non-finite input (NaN, Infinity) → `{ ok: false }`
- `stopAtMs <= nowMs` → `{ ok: true, stopAtMs: nowMs }` (caller interprets as stop-now)
- `stopAtMs - nowMs > maxMs` (default 24h) → clamped to `nowMs + maxMs`
- Otherwise → passthrough

Unit tests cover all four branches (past→now, within window→passthrough, beyond 24h→clamped, NaN→not ok, Infinity→not ok). Five new tests in `record.test.js`.

## scheduleStop / cancelScheduledStop / reaper

`server/services/recordSession.js`: Added `_stopTimer = null` to constructor. `scheduleStop(atMs)` cancels any existing timer, then sets a new `setTimeout(() => this.stop(), delay).unref()`. `cancelScheduledStop()` clears `_stopTimer`. `stop()` now calls `cancelScheduledStop()` first, ensuring no dangling timer whether the stop is manual or scheduled.

Safety reaper: in `getMover()` in `server/routes/record.js`, alongside `mover.start()`, a 30-second `setInterval` scans all live sessions and calls `session.stop()` for any whose persisted `stop_at <= Date.now()`. Interval is `.unref()`'d so it doesn't prevent process exit.

## Route: POST /:id/schedule-stop

Mounted in `server/routes/record.js`:
- No live session → 404
- `stopAtMs === null` → `session.cancelScheduledStop()` + `repo.setStopAt(id, null)` → `{ canceled: true }`
- Non-finite `stopAtMs` → 400
- Clamped value <= now → `session.stop()` + `repo.setStopAt(id, null)` → `{ stopped: true }`
- Clamped value in future → `session.scheduleStop(clamped)` + `repo.setStopAt(id, clamped)` → `{ stopAtMs: clamped }`

`DELETE /:id` updated to also call `repo.setStopAt(id, null)` (clears persisted schedule on manual stop-now). `session.stop()` already clears the in-memory timer.

## Frontend Dropdown

`public/js/api.js`: Added `record.scheduleStop(id, stopAtMs)` → `POST /record/:id/schedule-stop`.

`public/js/pages/RecordingsPage.js`: Complete rewrite of the stop area on `recording` rows.

- `_openStopMenu(btn, id)`: creates `.record-menu.stop-schedule-menu` positioned fixed at the toggle button (same viewport-clamping logic as `recordMenu.js`). Contains: Stop now, Stop in 15/30/60 min, custom minutes number input + Go, time input + Go. Each handler closes the menu before calling the API.
- `resolveClockToMs(hh, mm, now)`: resolves a HH:MM time to the next future epoch ms (adds one day if the time has already passed today).
- `_fmtTime(ms)` / `_fmtCountdown(stopAtMs, nowMs)`: formatting helpers for the countdown display.
- If `r.stop_at` is set and in the future at render time: shows `.rec-countdown` span with `data-stop-at` attribute and a Cancel button. The Cancel button calls `API.record.scheduleStop(id, null)`.
- `_updateCountdowns()`: called by a 1-second `_countdownInterval` (started in `show()`, cleared in `hide()`). Only updates the text content of existing `.rec-countdown` spans — no re-render.
- `show()` / `hide()` extended to manage `_countdownInterval`; `hide()` also removes any open `.stop-schedule-menu`.
- Row-click guard: `e.target.closest('.rec-stop-toggle, .rec-cancel-sched')` prevents channel navigation when clicking stop controls.

`public/index.html`: `api.js` and `RecordingsPage.js` bumped from `?v=3` to `?v=4`.

## Tests

- `server/db/recordings.test.js`: +1 test — `setStopAt sets and clears stop_at`
- `server/routes/record.test.js`: +5 tests — `clampStopAt` past→now, within window→passthrough, beyond 24h→clamped, NaN→not ok, Infinity→not ok

## Verify Output

```
node --check server/routes/record.js         OK
node --check server/services/recordSession.js OK
node --check server/db/recordings.js          OK
node --check public/js/pages/RecordingsPage.js OK
node --check public/js/api.js                 OK
# tests 41
# pass 41
# fail 0
```

Suite grew from 35 to 41; 0 failures.

## Self-Review

- Timer leak: `_stopTimer` is cleared in `stop()` via `cancelScheduledStop()`; reaper interval is `.unref()`'d; `_countdownInterval` is cleared in `hide()`.
- Data safety: timed stop calls the same `session.stop()` path as manual stop → status becomes `'stopped'` → `shouldMove()` returns true → normal finalize+move flow.
- XSS: all dynamic values go through `_recEsc()` before insertion into innerHTML; `data-stop-at` is a numeric string.
- Row-click navigation guard: uses `e.target.closest()` so any child of the stop controls (including the time input and number input) blocks navigation.
- `DELETE /:id` now calls `setStopAt(id, null)` even when no live session exists — this is safe (UPDATE on a non-existent or already-done row is a no-op) and ensures a stale scheduled-stop value is cleared if the route is called after the session was already removed from memory.
