# Arc-Style Pinned Tabs for Helium

A tiny standalone Manifest V3 extension that makes pinned Chromium tabs behave more like Arc favorites.

**This fork intends to bring its behaviour closer to function like Zen's Essential Tabs, for personal use.**

## Behavior

### Normal tabs

`Command+W` closes the active tab.

### Pinned tabs

`Command+W`:

1. Keeps the existing tab pinned and in the same position.
2. Switches to the most recently used eligible tab in the same window.
3. Resets the pin to the URL it had when it became pinned.
4. Discards the inactive pin when Chromium permits it.

When clicked later, the pin loads its saved home URL.

### Every other way of closing a pin

Middle-clicking a pinned tab, or choosing **Close tab** from its context menu, reaches the same outcome by a different route. Chromium exposes no way to intercept those closes, because `tabs.onRemoved` fires after the fact and cannot be cancelled. So the extension re-creates the pin instead of preventing the close: same window, same strip position, loading its home URL, left in the background.

Three consequences worth knowing:

- **You see the tab close and reappear.** Chromium plays its close animation, then its open animation for the replacement. Neither can be cancelled from an extension, so the flicker is expected. `Command+W` has no such animation because it never closes the tab.
- The restored pin is a **new tab**, so its back/forward history does not survive. Its home URL, strip position, and most-recently-used slot do.
- There is no way to genuinely close a pinned tab while it is pinned. **Unpin it first**, then close it.

Pins are not restored when their window closes, so quitting Helium behaves normally.

Chromium reports closing a pinned tab as an unpin immediately followed by a removal, which is indistinguishable from a deliberate unpin except by timing. An unpin within 250 ms of the removal is treated as teardown and the pin is restored; anything slower is treated as your decision and the tab closes for good.

### Manually change a pin's home URL

1. Navigate the pinned tab to the page you want as its new home.
2. Right-click the tab in Helium's tab strip.
3. Choose **Set current URL as pin home**.

The new URL replaces the pin's remembered home immediately. You no longer need to unpin and repin a tab just to update its home.

### Long-term memory

Home URLs are saved to `chrome.storage.local`, not just service-worker memory. They survive:

- service-worker suspension;
- extension reloads and updates;
- closing and reopening Helium;
- clearing ordinary browser history and cache.

Chromium tab IDs do not provide a stable cross-restart identity, so durable homes are matched by site (for example, every `github.com` URL belongs to the same site entry). This covers the normal pattern of pinning a site's home and navigating deeper inside that site.

### Close-sweep protection

A pin reset with `Command+W` is excluded from later automatic tab handoffs. This prevents a sequence such as:

```text
close pin A → move to tab B → close tab B → unexpectedly return to pin A
```

There is no arbitrary five-second or one-minute timer. The pin becomes eligible again when you deliberately activate it. Until then, repeated `Command+W` presses continue through other eligible tabs instead of bouncing between recently reset pins.

If every remaining tab is an excluded pin, Chromium has nowhere else to go. In that final edge case, a reset pin may remain or become active, but the extension will not deliberately cycle through excluded pins.

## Install in Helium

1. Download or clone this repository.
2. Open `helium://extensions` in Helium.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder containing `manifest.json`.

No package installation or build command is required.

## Bind Command+W

Helium accepts `Command+W` for an extension command, but does not apply the manifest suggestion automatically.

1. Open `helium://extensions/shortcuts` (or `chrome://extensions/shortcuts`).
2. Find **Arc-Style Pinned Tabs**.
3. Find **Close a normal tab or reset a pinned tab**.
4. Click the pencil/edit button.
5. Press `Command+W`.
6. Confirm the field shows `⌘W` and the scope is **In Helium**.

The manual assignment normally survives an extension reload. Assign it again if it disappears after removing and reinstalling the extension.

## Example

1. Open `https://github.com`.
2. Pin the tab. Its home URL is now `https://github.com`.
3. Navigate inside the pin to a repository or issue.
4. Press `Command+W`.

The GitHub pin remains pinned, Helium returns to the previous eligible tab, and the dormant pin is reset to `https://github.com`. It will not be selected by another automatic close handoff until you activate it yourself.

## How it works

- `chrome.tabs.onUpdated` captures a tab's URL when it becomes pinned.
- A tab-strip context-menu command can replace a pin's saved home with its current URL.
- Navigating inside a pin does not overwrite its home URL.
- Unpinning drops the saved URL once the unpin is confirmed to be deliberate rather than part of a close; pinning again captures a new one.
- `chrome.tabs.onActivated` maintains a separate MRU history for each window.
- Reset pins are kept in a session-scoped exclusion set.
- The extension marks its own tab activations, allowing a later user-driven activation to make an excluded pin eligible again.
- Before closing a normal tab during a close sweep, it chooses an eligible handoff when necessary so Chromium does not fall back to an excluded pin.
- `chrome.tabs.onRemoved` re-creates a pin that was closed by any route other than `Command+W`, using a strip position recorded while the tab was still open.
- Session state that survives worker suspension is pruned with one pass of grace, because a suspended worker is often woken by the very close it must react to.
- Home URLs live in durable `chrome.storage.local`. Current tab associations, MRU histories, close-sweep exclusions, pinned strip positions, and unpin timestamps live in `chrome.storage.session`.
- A URL reset is observed before discard is attempted, avoiding a Chromium race that could otherwise resurrect the old deep URL.

`Command+W` operates on the existing tab and never unpins, moves, deletes, or recreates it. Every other close route cannot be intercepted at all, so the pin is re-created afterwards instead.

## Permissions and privacy

The manifest requests only:

- `contextMenus` — add the **Set current URL as pin home** item to the tab-strip menu.
- `tabs` — inspect pin state, track activation, change tabs, and discard inactive pins.
- `storage` — keep durable home URLs plus session-scoped tab history.

There are no host permissions, injected scripts, analytics, network requests, frameworks, or remote code.

## Repository layout

```text
arc-pinned-tabs/
├── manifest.json
├── service-worker.js
└── README.md
```

## Development and debugging

There is no build step. Edit the files directly, then open `helium://extensions` and click **Reload** on the extension card.

Set `DEBUG = true` at the top of `service-worker.js` for logs covering:

- home URL capture and removal;
- MRU activation history;
- `Command+W` handling;
- automatic handoffs and fallbacks;
- close-sweep exclusion and restoration;
- unpins held pending a possible removal;
- pin re-creation after a close;
- URL reset and discard success or failure.

With Developer mode enabled, open the extension's **service worker** link on `helium://extensions` to view its console.

## Manual test checklist

- [ ] `Command+W` closes an unpinned tab.
- [ ] `Command+W` preserves a pinned tab and its position.
- [ ] The browser returns to the previously used eligible tab.
- [ ] The pin resets to the URL it had when pinned.
- [ ] Clicking the dormant pin loads its home URL.
- [ ] A reset pin is skipped during subsequent rapid `Command+W` presses.
- [ ] Deliberately activating that pin makes it eligible again.
- [ ] Unpinning and repinning captures a new home URL.
- [ ] **Set current URL as pin home** replaces a pin's saved home URL.
- [ ] Multiple pins behave independently.
- [ ] Multiple windows keep independent MRU histories.
- [ ] Closing tabs removes stale MRU entries.
- [ ] A sole pinned tab is preserved.
- [ ] A discard failure does not break the URL reset.
- [ ] Middle-clicking a pin restores it at the same strip position, on its home URL.
- [ ] **Close tab** from a pin's context menu restores it the same way.
- [ ] Unpinning a tab and then closing it leaves it closed.
- [ ] Closing a window does not resurrect the pins it contained.
- [ ] A pin closed after the service worker has gone idle is still restored.

## Limitations

- Chromium does not expose a durable custom identity for an open tab. Persistent homes are therefore matched by site. Two separate pins on the same site share one remembered home, and a pin that crosses to an entirely different site before restart cannot be matched automatically.
- Close-sweep exclusions and MRU history are intentionally session-scoped and reset with the browser or extension. Durable home URLs do not.
- Chromium does not tell extensions whether `tabs.onActivated` came specifically from a mouse click. The extension distinguishes its own automatic activations from other activations; keyboard or other user-driven tab selection therefore also re-enables a pin.
- Chromium has no extension API for changing a discarded tab's pending URL without beginning navigation. The extension waits for the reset URL and then makes a best-effort discard attempt.
- A pinned tab that is alone in its window must remain active and cannot be discarded.
- Browser-internal or otherwise restricted URLs may reject `chrome.tabs.update`. Ordinary web URLs work without host permissions.
- A pin closed by any route other than `Command+W` is restored, not preserved. It comes back as a new tab without the old one's navigation history, after a visible close-then-open animation that no extension API can suppress.
- Telling a teardown unpin apart from a deliberate one rests on a 250 ms timing threshold rather than on anything Chromium states explicitly. A close whose internal unpin somehow lands outside that window would not be restored.
- If Chromium terminates the service worker between the removal and the re-creation, the pin is gone and nothing recovers it.
