# IMAP Quota Status — Technical Implementation

**Author:** Arie Tegenbosch  
**Version:** 1.0.0  
**Target:** Thunderbird 128+ (Manifest V3)  
**Implementation:** Claude Sonnet 4.6 (Anthropic) — generated from iterative development sessions

---

## Overview

IMAP Quota Status is a Thunderbird WebExtension that reads IMAP mailbox quota information and displays it in two places: a floating pill at the bottom of the window, and a color-coded progress bar beneath each IMAP account row in the folder pane.

Because the standard WebExtension API does not expose IMAP internals or allow direct DOM injection into Thunderbird's chrome, the extension uses a **Thunderbird Experiment API** — a privileged parent-process script that bridges the gap between the sandboxed background script and Thunderbird's internal XPCOM interfaces.

---

## File Structure

```
imap-quota-statusbar.xpi
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Background script — orchestration logic
├── imapQuota-api.js       # Experiment API — privileged parent-process code
├── imapQuota-schema.json  # Schema declaring the experiment's public API surface
├── options.html           # Settings page UI
├── options.js             # Settings page logic
└── icons/
    └── icon48.png
```

---

## Architecture

The extension is split across two process boundaries:

```
┌──────────────────────────────────────────────────────────────────┐
│  THUNDERBIRD MAIN PROCESS                                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Experiment Parent  (imapQuota-api.js)                     │  │
│  │                                                            │  │
│  │  • Access to XPCOM (MailServices, nsIImapMailFolder)       │  │
│  │  • Direct DOM manipulation (pill, folder pane bars)        │  │
│  │  • Services.prefs  (refresh-tick pref)                     │  │
│  │  • Services.tm, nsITimer  (thread/timer management)        │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │  IPC via schema-declared functions  │
│  ┌─────────────────────────▼──────────────────────────────────┐  │
│  │  Background Script  (background.js)                        │  │
│  │                                                            │  │
│  │  • Standard WebExtension APIs (messenger.*)                │  │
│  │  • messenger.alarms   (poll timer, click-poll timer)       │  │
│  │  • messenger.storage  (user settings)                      │  │
│  │  • messenger.accounts (IMAP account list)                  │  │
│  │  • messenger.imapQuota.*  (experiment API calls)           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

> **Why an Experiment API?**  
> Standard WebExtension APIs cannot access IMAP protocol internals, read `nsIMsgImapMailFolder.getQuota()`, or inject arbitrary HTML into Thunderbird's chrome window. The Experiment API runs in the privileged main process and exposes a safe, schema-validated interface to the background script.

---

## Quota Fetching

Thunderbird's IMAP implementation issues a `GETQUOTAROOT INBOX` command to the server during folder synchronisation and caches the result on the `nsIMsgImapMailFolder` object.

```
┌──────────────┐    GETQUOTAROOT INBOX    ┌─────────────┐
│  Thunderbird │ ───────────────────────► │ IMAP Server │
│  IMAP Client │ ◄─────────────────────── │             │
└──────┬───────┘    QUOTAROOT response    └─────────────┘
       │
       │  caches result on
       ▼
  nsIMsgImapMailFolder.getQuota()
       │
       │  read by experiment
       ▼
  { used, limit, percentage, serverKey }
       │
       │  returned to background via IPC
       ▼
  background.js → updateQuota()
```

On the first run (no cache), the experiment calls `updateFolderWithListener()` to trigger a folder sync, then reads the populated cache in `OnStopRunningUrl`. On subsequent calls the cache is read directly — no network round-trip.

---

## Periodic Polling

The background script uses `messenger.alarms` (the WebExtension Alarms API) for periodic quota polling. Unlike `setInterval`, alarms survive background script throttling and suspension.

```
Startup
  │
  ├─► scheduleAlarm(pollInterval)
  │     └─► messenger.alarms.create("imap-quota-poll", { periodInMinutes })
  │
  └─► setTimeout(updateQuota, 500ms)    ← initial fetch after connections settle

Every N minutes:
  │
  messenger.alarms.onAlarm("imap-quota-poll")
  │
  └─► updateQuota("alarm")
        ├─► messenger.storage.local.get(DEFAULTS)    ← read current settings
        ├─► scheduleAlarm(pollInterval)              ← reschedule (picks up interval changes)
        ├─► messenger.accounts.list()                ← get IMAP accounts
        ├─► messenger.imapQuota.getQuota(id) × N     ← fetch each account
        ├─► messenger.imapQuota.updateFolderPaneBars(...)
        └─► messenger.imapQuota.setStatusBarText(...)
```

The alarm is rescheduled on every `updateQuota` call, so changes to the poll interval setting take effect at the next run without requiring a restart.

---

## Pill Click — Refresh Mechanism

Triggering a refresh from a pill click is non-trivial because the pill lives in the **experiment parent process** while the refresh logic lives in the **background script**. Functions cannot be passed across this boundary.

Two complementary mechanisms are used:

```
User clicks pill
      │
      ├─① Increment Services.prefs tick  (synchronous, always works)
      │     "extensions.imap-quota-statusbar.refresh-tick" += 1
      │
      └─② Fire _refreshFire.async()      (fast path, ~instant when registered)
            └─► onPillClicked EventManager ──► background onPillClicked listener


Background — three detection paths:

  Path ①  CLICK_POLL_ALARM  (every ~1 second, runs indefinitely)
    │
    └─► messenger.imapQuota.getRefreshTick()
          │
          ├── tick unchanged → do nothing
          └── tick changed   → _lastRefreshTick = tick
                               updateQuota("click")

  Path ②  onPillClicked listener  (fast path, fires in milliseconds)
    │
    └─► _lastRefreshTick = getRefreshTick()
        updateQuota("click")

  Path ③  ALARM_NAME poll  (safety net — catches any click missed by ① and ②)
    │
    └─► check tick on every regular poll alarm too
```

This layered approach ensures reliability: if the EventManager fires, the refresh is nearly instant. If it doesn't, the click-poll alarm catches it within 1 second. If somehow both miss (e.g. extension restart mid-click), the next regular poll alarm catches it too.

---

## UI Injection

### Status Pill

The pill is a `<div>` injected into `document.body` of the main Thunderbird window with `position: fixed; bottom: 6px; left: 50%; transform: translateX(-50%)` — always centred, always on top (`z-index: 2147483647`), never intercepting clicks on underlying UI when hidden.

### Folder Pane Bars

The folder pane in TB 128+ renders directly in the main window document. Account rows are:

```html
<ul id="folderTree">
  <li data-server-type="imap" data-server-key="server13">
    <div class="container">          ← visible account row
      <span class="name">Arie @ Tegenbosch</span>
      ...
    </div>
    <!-- ↓ injected by extension ↓ -->
    <div class="imap-quota-bar-wrap" data-server-key="server13">
      <div class="imap-quota-bar" style="width: 80%; background: rgb(255,204,50)">
      </div>
    </div>
    <ul>  ← child folder rows (share data-server-key but also have data-folder-type)
      ...
    </ul>
  </li>
</ul>
```

The selector `li[data-server-key="X"][data-server-type]` specifically targets account root rows (which have `data-server-type`) and excludes child folder rows (which only have `data-folder-type`).

Bar height is controlled via a CSS custom property `--imap-quota-bar-height` set on `#folderTree`, so a single setting change propagates to all bars instantly. The `!important` declarations override Thunderbird's `tree-listbox.css` rule that sets `min-height: var(--list-item-min-height)` on all `li > div` elements.

---

## Settings Storage

User preferences are stored via `messenger.storage.local` (backed by IndexedDB). Defaults:

| Setting           | Default | Description                              |
|-------------------|---------|------------------------------------------|
| `thresholdRed`    | 90%     | Usage at which indicator turns red       |
| `thresholdYellow` | 80%     | Usage at which indicator turns yellow    |
| `thresholdBlue`   | 70%     | Usage at which indicator turns blue      |
| `pollInterval`    | 5 min   | How often to poll for updated quota      |
| `barHeight`       | 4 px    | Height of folder pane progress bars      |
| `showPill`        | true    | Show/hide the status pill                |
| `showBars`        | true    | Show/hide the folder pane bars           |

When settings are saved, `options.js` sends a `"settings-saved"` runtime message to the background, which calls `updateQuota("settings-saved")` immediately — applying the new thresholds, bar height and visibility without waiting for the next poll.

---

## Color Scale

| Indicator | RGB                  | Threshold            |
|-----------|----------------------|----------------------|
| 🟢 Green  | `rgb(124, 179, 66)`  | Below blue threshold |
| 🔵 Blue   | `rgb(25, 118, 210)`  | ≥ blue threshold     |
| 🟡 Yellow | `rgb(255, 204, 50)`  | ≥ yellow threshold   |
| 🔴 Red    | `rgb(244, 67, 54)`   | ≥ red threshold      |

---

## Known Limitations

- **Server support required** — IMAP quota display depends on the server advertising the `QUOTA` capability (RFC 2087). Servers that do not support it (e.g. Outlook/Hotmail, AOL) will show no quota data.
- **Cache dependency** — quota values are read from Thunderbird's internal cache, populated when TB last performed a folder sync. Clicking refresh reads the latest cached value; it does not force a new `GETQUOTAROOT` command to the server.
- **Single account in pill** — the pill shows the account with the highest usage percentage. All accounts with quota data appear in the tooltip.
- **Experiment API required** — because the extension uses a Thunderbird Experiment API, it cannot be listed on addons.thunderbird.net without going through the review process for privileged extensions.
