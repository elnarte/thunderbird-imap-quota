"use strict";

// MailServices is not a free global in MV3 experiment scripts — import explicitly.
// Services, ExtensionCommon, Cc, Ci are pre-injected by Thunderbird.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

const PANEL_ID  = "imap-quota-ext-pill";  // ID of the floating quota pill
const BAR_CLASS = "imap-quota-bar";       // class prefix for folder pane bars

// Preference key written by the pill click (readable from both parent and child)
const REFRESH_PREF = "extensions.imap-quota-statusbar.refresh-tick";

// EventManager fire function for the fast-path onPillClicked event.
// Stored at module scope to prevent garbage collection.
let _refreshFire = null;

// ── Window helpers ────────────────────────────────────────────────────────────

function getMail3PaneWindow() {
  return Services.wm.getMostRecentWindow("mail:3pane");
}

// ── Status pill ───────────────────────────────────────────────────────────────

function getOrCreatePanel(win) {
  const doc = win.document;
  let el = doc.getElementById(PANEL_ID);
  if (el) return el;

  el = doc.createElement("div");
  el.id = PANEL_ID;
  Object.assign(el.style, {
    position:      "fixed",
    bottom:        "6px",
    left:          "50%",
    transform:     "translateX(-50%)",
    zIndex:        "2147483647",
    background:    "rgba(30,30,30,0.82)",
    color:         "#eee",
    font:          "bold 11px/1.5 monospace",
    padding:       "2px 8px",
    borderRadius:  "5px",
    pointerEvents: "auto",
    whiteSpace:    "nowrap",
    boxShadow:     "0 1px 4px rgba(0,0,0,0.4)",
    userSelect:    "none",
    cursor:        "pointer",
  });
  el.textContent = "Quota: …";

  el.addEventListener("click", () => {
    el.textContent = "↻ Refreshing…";

    // Increment a pref counter — the background's 1-second click-poll alarm
    // detects this change and triggers a refresh. This is the reliable path
    // that works even when the EventManager hasn't fired yet.
    const cur = Services.prefs.prefHasUserValue(REFRESH_PREF)
      ? Services.prefs.getIntPref(REFRESH_PREF) : 0;
    Services.prefs.setIntPref(REFRESH_PREF, cur + 1);

    // Also fire the EventManager directly as a fast path (fires in ~ms
    // when the background's onPillClicked listener is already registered).
    if (_refreshFire) _refreshFire.async();
  });

  (doc.body || doc.documentElement).appendChild(el);
  return el;
}

function setPanelContent(text, tooltip) {
  // Dispatch to main thread since this may be called from async experiment code
  Services.tm.dispatchToMainThread(() => {
    const win = getMail3PaneWindow();
    if (!win || !win.document.body) {
      // Window not ready yet — retry after 1 second
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback(() => setPanelContent(text, tooltip), 1000, Ci.nsITimer.TYPE_ONE_SHOT);
      return;
    }
    const el = getOrCreatePanel(win);
    el.textContent = text;
    el.title = tooltip || text;
    // Hide pill when text is empty (e.g. showPill is disabled in settings)
    el.style.display = text ? "block" : "none";
  });
}

// ── Folder pane bars ──────────────────────────────────────────────────────────

/**
 * In TB 128+ (Supernova) the folder pane is rendered directly in the main
 * window document. Account rows are:
 *   #folderTree li[data-server-type="imap"][data-server-key="serverXX"]
 * Child folder rows share the same data-server-key but also have data-folder-type.
 * We inject a thin progress bar div immediately after each account's .container.
 */
function getFolderPaneDoc(win) {
  if (win.document.getElementById("folderTree")) return win.document;
  // Fallback for possible future <browser> frame embedding
  for (const browser of win.document.querySelectorAll("browser")) {
    try {
      const doc = browser.contentDocument;
      if (doc?.getElementById("folderTree")) return doc;
    } catch (_) {}
  }
  return win.document;
}

function injectStyles(doc) {
  if (doc.getElementById("imap-quota-bar-styles")) return;
  const style = doc.createElement("style");
  style.id = "imap-quota-bar-styles";
  style.textContent = `
    .${BAR_CLASS}-wrap {
      /* Override TB's tree-listbox.css min-height rule on li > div */
      height: var(--imap-quota-bar-height, 4px) !important;
      min-height: 0 !important;
      max-height: var(--imap-quota-bar-height, 4px) !important;
      margin: 0 8px 2px 8px !important;
      padding: 0 !important;
      background: rgba(128,128,128,0.2);
      border: 1px solid rgba(0,0,0,.25) !important;
      border-radius: var(--imap-quota-bar-height, 4px) !important;
      overflow: hidden;
      display: block !important;
      box-sizing: content-box !important;
    }
    .${BAR_CLASS} {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s ease;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function updateFolderPaneBars(quotaMap, barHeight) {
  Services.tm.dispatchToMainThread(() => {
    const win = getMail3PaneWindow();
    if (!win || !win.document.body) {
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback(() => updateFolderPaneBars(quotaMap, barHeight), 1000, Ci.nsITimer.TYPE_ONE_SHOT);
      return;
    }

    const doc = getFolderPaneDoc(win);
    injectStyles(doc);

    // Set bar height CSS variable on the folderTree root
    const folderTree = doc.getElementById("folderTree");
    if (folderTree) folderTree.style.setProperty("--imap-quota-bar-height", barHeight + "px");

    // Remove bars for accounts that are no longer in the quota map
    const keys = new Set(quotaMap.map(q => q.serverKey));
    for (const old of doc.querySelectorAll(`.${BAR_CLASS}-wrap`)) {
      if (!keys.has(old.dataset.serverKey)) old.remove();
    }

    for (const q of quotaMap) {
      // Select the account root row (has data-server-type; child folders don't)
      const li = doc.querySelector(
        `#folderTree li[data-server-key="${q.serverKey}"][data-server-type]`
      );
      if (!li) continue;

      const container = li.querySelector(":scope > .container");
      if (!container) continue;

      // Find or create the bar wrapper, inserted immediately after .container
      let wrap = li.querySelector(`:scope > .${BAR_CLASS}-wrap`);
      if (!wrap) {
        wrap = doc.createElement("div");
        wrap.className = `${BAR_CLASS}-wrap`;
        wrap.dataset.serverKey = q.serverKey;
        const bar = doc.createElement("div");
        bar.className = BAR_CLASS;
        wrap.appendChild(bar);
        container.insertAdjacentElement("afterend", wrap);
      }

      const bar = wrap.querySelector(`.${BAR_CLASS}`);
      bar.style.width      = `${Math.min(q.percentage, 100)}%`;
      bar.style.background = q.color;
      wrap.title = `${q.percentage}% used (${formatKB(q.used)} of ${formatKB(q.limit)})`;
    }
  });
}

function formatKB(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1048576).toFixed(1)} GB`;
  if (kb >= 1024)        return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

// ── Quota fetching ────────────────────────────────────────────────────────────

function parseQuotaArray(quotaArray) {
  // Return the first quota entry with a positive limit (usually the STORAGE root)
  for (const q of quotaArray) {
    if (q.limit > 0) {
      return {
        used:       Number(q.usage),
        limit:      Number(q.limit),
        percentage: Math.round((Number(q.usage) / Number(q.limit)) * 100),
      };
    }
  }
  return null;
}

// Active nsITimer instances kept in a Set so they are not garbage-collected
// before their callback fires (timers need a strong reference to survive).
const _activeTimers = new Set();

function fetchQuotaForFolder(imapFolder) {
  return new Promise((resolve) => {
    // TB populates quota cache after each GETQUOTAROOT response.
    // On subsequent calls we read the cache directly — no network round-trip.
    try {
      const cached = parseQuotaArray(imapFolder.getQuota());
      if (cached) { resolve(cached); return; }
    } catch (_) {}

    // No cached data yet (first run) — trigger a folder update which causes
    // TB to issue GETQUOTAROOT and populate the cache.
    try {
      let done = false;
      const finish = (timer) => {
        if (done) return;
        done = true;
        if (timer) _activeTimers.delete(timer);
        try { resolve(parseQuotaArray(imapFolder.getQuota())); }
        catch (_) { resolve(null); }
      };

      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      _activeTimers.add(timer);
      timer.initWithCallback(() => finish(timer), 8000, Ci.nsITimer.TYPE_ONE_SHOT);

      imapFolder.updateFolderWithListener(null, {
        OnStartRunningUrl() {},
        OnStopRunningUrl() { finish(null); },
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// ── Extension API ─────────────────────────────────────────────────────────────

this.imapQuota = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      imapQuota: {

        // Fetch quota for one IMAP account. Returns { used, limit, percentage, serverKey }
        // or null if the account doesn't support QUOTA or has no data yet.
        async getQuota(accountId) {
          try {
            const account = MailServices.accounts.getAccount(accountId);
            if (!account?.incomingServer) return null;
            const server = account.incomingServer;
            if (server.type !== "imap") return null;
            const inbox = server.rootMsgFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
            if (!inbox) return null;
            const imapFolder = inbox.QueryInterface(Ci.nsIMsgImapMailFolder);
            const result = await fetchQuotaForFolder(imapFolder);
            if (result) result.serverKey = server.key;
            return result;
          } catch (_) {
            return null;
          }
        },

        // Update the floating pill text and tooltip
        setStatusBarText(text, tooltip) {
          setPanelContent(text, tooltip);
        },

        // Update or remove quota progress bars in the folder pane
        updateFolderPaneBars(quotaMap, barHeight) {
          updateFolderPaneBars(quotaMap, barHeight);
        },

        // Read the pill-click pref counter. The background polls this every
        // second via the click-poll alarm and fires a refresh when it changes.
        getRefreshTick() {
          return Services.prefs.prefHasUserValue(REFRESH_PREF)
            ? Services.prefs.getIntPref(REFRESH_PREF) : 0;
        },

        // Fast-path event: fires directly into the background when the pill
        // is clicked and the listener is already registered. The pref-tick
        // mechanism above is the reliable fallback when this misses.
        onPillClicked: new ExtensionCommon.EventManager({
          context,
          name: "imapQuota.onPillClicked",
          register(fire) {
            _refreshFire = fire; // held at module scope — prevents GC
            return () => { _refreshFire = null; };
          },
        }).api(),
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    Services.obs.notifyObservers(null, "startupcache-invalidate", null);
    // Remove injected UI from all documents (main window + any browser frames)
    const win = getMail3PaneWindow();
    if (!win) return;
    const docs = [win.document];
    for (const browser of win.document.querySelectorAll("browser")) {
      try { if (browser.contentDocument) docs.push(browser.contentDocument); } catch (_) {}
    }
    for (const doc of docs) {
      doc.getElementById(PANEL_ID)?.remove();
      doc.getElementById("imap-quota-bar-styles")?.remove();
      for (const el of doc.querySelectorAll(`.${BAR_CLASS}-wrap`)) el.remove();
    }
  }
};
