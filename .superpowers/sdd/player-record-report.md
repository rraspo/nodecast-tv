# Player Record Button + Xtream URL Fix — Implementation Report

## What was built

### 1. `public/js/components/recordMenu.js` (new file)

Exposes `window.RecordMenu = { open(anchorEl, ctx), start(payload) }`.

- `open()` builds the same 3-or-4-option dropdown that the sidebar previously built inline in `ChannelList.showRecordMenu`. The `epgEndMs` option only appears when the value is truthy.
- URL resolution is deferred: `resolveUrl()` is called only when the user clicks a menu item, which means the Xtream API call never fires unless the user actually picks an option.
- `start()` calls `API.record.start(payload)` and dispatches `recordings-changed` on success.

### 2. `ChannelList.showRecordMenu` refactored

The old implementation read `anchorEl.dataset.recUrl` which is always empty for Xtream channels (`channel.url` is not set). The new version:

```js
const resolveUrl = async () => {
    if (dataset.sourceType === 'xtream' && channel) {
        const streamFormat = window.app?.player?.settings?.streamFormat || 'm3u8';
        const result = await API.proxy.xtream.getStreamUrl(
            channel.sourceId, channel.streamId, 'live', streamFormat
        );
        return result.url;
    }
    return channel?.url || '';
};
window.RecordMenu.open(anchorEl, { channelName, epgEndMs, programmeTitle, resolveUrl });
```

This is exactly the same resolution path used by `ChannelList.selectChannel()` (~line 1272), reused here.

`startRecording()` was removed; its logic now lives in `RecordMenu.start()`.

### 3. Player record button (`index.html` + `VideoPlayer.js`)

Button added after `#btn-fullscreen` in the `.watch-controls` of the live player (line ~246 in the DOM). SVG is inline, matching the pattern used by all other `.watch-btn` elements.

Wired in `VideoPlayer.initCustomControls()`:

```js
const btnRecord = document.getElementById('btn-record');
btnRecord?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!this.currentChannel || !this.currentUrl) {
        alert('No channel is currently playing');
        return;
    }
    // currentUrl is already the resolved stream URL — no extra request for Xtream
    window.RecordMenu.open(btnRecord, {
        channelName: this.currentChannel.name,
        epgEndMs,
        programmeTitle,
        resolveUrl: async () => this.currentUrl,
    });
});
```

Because `this.currentUrl` is the URL the player is already using (set by `play()` after Xtream resolution), recording from the player requires zero additional API calls for Xtream channels.

EPG data is pulled from `window.app.epgGuide.getCurrentProgram()`, same source as `fetchEpgData()`.

### 4. Script load order

`recordMenu.js` is loaded after `VideoPlayer.js` and before `ChannelList.js`:

```html
<script src="/js/components/VideoPlayer.js?v=2"></script>
<script src="/js/components/recordMenu.js"></script>
<script src="/js/components/ChannelList.js?v=3"></script>
```

## Xtream URL resolution

Both paths (sidebar and player) now resolve the Xtream URL the same way:

```js
API.proxy.xtream.getStreamUrl(sourceId, streamId, 'live', streamFormat)
```

The sidebar resolves it on demand (when user clicks a menu item). The player reuses `this.currentUrl` which was already resolved when `play()` was called.

## Verification output

```
$ docker run --rm -v ... node:20 node --check public/js/components/recordMenu.js   → OK
$ docker run --rm -v ... node:20 node --check public/js/components/VideoPlayer.js  → OK
$ docker run --rm -v ... node:20 node --check public/js/components/ChannelList.js  → OK
$ docker run --rm -v ... node:20 npm test
  27 tests / 0 fail / 0 skip
```

## Self-review

- No duplicate menu code: `showRecordMenu` in ChannelList is 10 lines; all menu-building logic is in `recordMenu.js`.
- DRY: `resolveUrl()` lambda carries the source-type check at the call site, keeping the shared helper source-agnostic.
- Guard in VideoPlayer: if no `currentChannel`/`currentUrl`, shows `alert()` before opening menu. No partial state.
- The `startRecording()` method was the only internal caller; removing it does not break anything.
- EPG data for the player record button mirrors the exact same call as `fetchEpgData()`.
- `.watch-btn` class and inline SVG pattern matches existing buttons exactly.
- No test changes needed: server-side logic is unchanged. All 27 tests green.

## Files changed

- `public/js/components/recordMenu.js` — new
- `public/js/components/ChannelList.js` — `showRecordMenu` replaced, `startRecording` removed
- `public/js/components/VideoPlayer.js` — record button wired in `initCustomControls`
- `public/index.html` — record button added, `recordMenu.js` script tag added
