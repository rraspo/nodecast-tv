# Duration Ticker — Implementation Report

## What was done

### Tick integration
The existing `_countdownInterval` (set in `show()`, cleared in `hide()`, ticking every 1s) was extended to also drive the elapsed timer. No new interval was created. `_updateCountdowns()` was renamed in comment to "countdown and elapsed" and appended a `querySelectorAll('.rec-elapsed')` loop that reads `data-start-ms` and writes updated `textContent` each tick. The ~7s poll re-render still places fresh initial values; the 1s tick only touches the text nodes.

### UTC-parse fix
`created_at` from SQLite arrives as `"2026-06-27 08:40:13"` (no timezone suffix). `new Date(...)` of that string is implementation-defined and in V8 parses as local time, introducing a timezone offset error. Fix applied: `new Date(r.created_at.replace(' ', 'T') + 'Z')` forces UTC interpretation. A `isNaN` guard hides the timer rather than showing garbage if the value is malformed.

### Where the timer renders
Inside `_render()`, for each row where `r.status === 'recording'` and `created_at` is parseable, a `<span class="rec-elapsed" data-elapsed-for="<id>" data-start-ms="<epochMs>">● HH:MM:SS</span>` is injected immediately after the status badge. Non-recording rows (moving, pending-move, done, error) get no ticker.

### New helper
`_fmtElapsed(elapsedMs)` zero-pads hours/minutes/seconds (`HH:MM:SS`), clamps to `>= 0`.

### CSS
One line added to `main.css` after the existing rec-row rules:
```
.rec-elapsed { font-size: .8em; color: #e53935; font-variant-numeric: tabular-nums; white-space: nowrap; }
```
Matches the red of the recording badge; tabular-nums keeps the timer from jittering.

### Version bump
`RecordingsPage.js?v=4` → `?v=5` in `index.html`.

## Verify output
```
node --check public/js/pages/RecordingsPage.js  # passes
# tests 41
# pass 41
# fail 0
```

## Self-review
- No second interval created; existing interval drives both countdowns and elapsed.
- UTC parse fix is explicit and guarded.
- Elapsed only on `recording` rows; other statuses unaffected.
- Stop dropdown, cancel-schedule button, and row-click-to-channel untouched.
- Leak-free: `hide()` already clears `_countdownInterval`, which covers the elapsed updates too.
- No optional `done` static duration added — would require `ended_at` which isn't in the current API payload shape and wasn't confirmed trivial.
