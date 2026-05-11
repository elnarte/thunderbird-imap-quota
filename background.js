"use strict";

const ALARM_NAME      = "imap-quota-poll";       // periodic quota poll
const CLICK_POLL_ALARM = "imap-quota-click-poll"; // 1-second alarm for pill-click detection
const DEFAULTS = {
  thresholdRed:    90,
  thresholdYellow: 80,
  thresholdBlue:   70,
  pollInterval:    5,   // minutes
  barHeight:       4,   // px
  showPill:        true,
  showBars:        true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1048576).toFixed(1)} GB`;
  if (kb >= 1024)        return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

function dotAndColor(pct, red, yellow, blue) {
  if (pct >= red)    return { dot: "🔴", color: "rgb(244, 67, 54)"  };
  if (pct >= yellow) return { dot: "🟡", color: "rgb(255, 204, 50)" };
  if (pct >= blue)   return { dot: "🔵", color: "rgb(25, 118, 210)" };
  return               { dot: "🟢", color: "rgb(124, 179, 66)"  };
}

// ── Core update ───────────────────────────────────────────────────────────────

async function updateQuota(trigger = "poll") {
  console.log(`[imap-quota] refresh triggered by: ${trigger} at ${new Date().toLocaleTimeString()}`);

  const { thresholdRed, thresholdYellow, thresholdBlue,
          pollInterval, barHeight, showPill, showBars } =
    await messenger.storage.local.get(DEFAULTS);

  // Reschedule the poll alarm in case the interval setting changed
  await scheduleAlarm(pollInterval);

  // Fetch quota for every IMAP account
  const accounts = await messenger.accounts.list();
  const results  = [];
  for (const acc of accounts) {
    if (acc.type !== "imap") continue;
    try {
      const q = await messenger.imapQuota.getQuota(acc.id);
      if (q) {
        results.push({ ...q, name: acc.name });
        console.log(`[imap-quota]   ${acc.name}: ${q.percentage}% (${fmt(q.used)}/${fmt(q.limit)})`);
      } else {
        console.log(`[imap-quota]   ${acc.name}: no quota data`);
      }
    } catch (e) {
      console.warn(`[imap-quota]   ${acc.name}: error — ${e.message}`);
    }
  }

  // ── Folder pane bars ──────────────────────────────────────────────────────
  if (showBars && results.length) {
    messenger.imapQuota.updateFolderPaneBars(
      results.map(r => ({
        serverKey:  r.serverKey,
        percentage: r.percentage,
        used:       r.used,
        limit:      r.limit,
        color:      dotAndColor(r.percentage, thresholdRed, thresholdYellow, thresholdBlue).color,
      })),
      barHeight
    );
  } else {
    // Pass empty array to clear any existing bars when showBars is off
    messenger.imapQuota.updateFolderPaneBars([], barHeight);
  }

  // ── Status pill ───────────────────────────────────────────────────────────
  if (!showPill) {
    messenger.imapQuota.setStatusBarText("", "");
    return;
  }
  if (!results.length) {
    messenger.imapQuota.setStatusBarText(
      "📭 No quota",
      "No IMAP quota reported. Server may not support QUOTAROOT."
    );
    return;
  }

  // Show the account with highest usage in the pill; all accounts in tooltip
  results.sort((a, b) => b.percentage - a.percentage);
  const top = results[0];
  const { dot } = dotAndColor(top.percentage, thresholdRed, thresholdYellow, thresholdBlue);
  const label   = `${dot} ${top.name}  ${top.percentage}%  ${fmt(top.used)}/${fmt(top.limit)}`;
  const tooltip = [
    "IMAP Quota — click to refresh",
    ...results.map(r => {
      const { dot: d } = dotAndColor(r.percentage, thresholdRed, thresholdYellow, thresholdBlue);
      return `${d} ${r.name}: ${r.percentage}% — ${fmt(r.used)} of ${fmt(r.limit)}`;
    }),
  ].join("\n");

  messenger.imapQuota.setStatusBarText(label, tooltip);
  console.log(`[imap-quota] pill: ${label}`);
}

// ── Alarm scheduling ──────────────────────────────────────────────────────────

async function scheduleAlarm(intervalMinutes) {
  await messenger.alarms.clear(ALARM_NAME);
  await messenger.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes });
  console.log(`[imap-quota] poll alarm set to every ${intervalMinutes} min`);
}

// ── Pill-click detection ──────────────────────────────────────────────────────
// The pill click writes to a pref (readable from the experiment parent scope).
// We detect changes via two complementary mechanisms:
//
//  1. Fast path  — onPillClicked EventManager fires directly if the listener
//                  is already registered (works most of the time, ~instant).
//  2. Backup     — CLICK_POLL_ALARM fires every ~1 second and compares the
//                  pref tick; catches any clicks the EventManager missed.

let _lastRefreshTick = 0;

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log(`[imap-quota] poll alarm at ${new Date().toLocaleTimeString()}`);
    // Also check the pref tick here so clicks are never missed longer than
    // the poll interval (even if the click-poll alarm were somehow cleared)
    const tick = messenger.imapQuota.getRefreshTick();
    if (tick !== _lastRefreshTick) {
      _lastRefreshTick = tick;
      console.log("[imap-quota] pill click caught by poll alarm");
      updateQuota("click");
    } else {
      updateQuota("alarm");
    }
  }

  if (alarm.name === CLICK_POLL_ALARM) {
    const tick = messenger.imapQuota.getRefreshTick();
    if (tick !== _lastRefreshTick) {
      _lastRefreshTick = tick;
      console.log("[imap-quota] pill click detected by click-poll alarm");
      updateQuota("click");
    }
  }
});

// Fast path: EventManager notifies us directly when the pill is clicked
messenger.imapQuota.onPillClicked.addListener(() => {
  console.log("[imap-quota] pill click (fast path via EventManager)");
  _lastRefreshTick = messenger.imapQuota.getRefreshTick();
  updateQuota("click");
});

// Settings saved in the options page — refresh immediately with new settings
messenger.runtime.onMessage.addListener((msg) => {
  if (msg === "settings-saved") {
    console.log("[imap-quota] settings saved — refreshing");
    updateQuota("settings-saved");
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Read the current pref tick so we don't misfire on the first click-poll tick
_lastRefreshTick = messenger.imapQuota.getRefreshTick();
console.log(`[imap-quota] initial refresh tick: ${_lastRefreshTick}`);

// Start the 1-second click-poll alarm (runs indefinitely, negligible overhead)
messenger.alarms.create(CLICK_POLL_ALARM, { periodInMinutes: 0.0167 });

// Short delay on startup to let IMAP connections settle before first fetch
setTimeout(() => updateQuota("startup"), 500);
