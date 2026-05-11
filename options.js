"use strict";

const DEFAULTS = { thresholdRed: 90, thresholdYellow: 80, thresholdBlue: 70, pollInterval: 5, barHeight: 4, showPill: true, showBars: true };

const redInput    = document.getElementById("threshold-red");
const yellowInput = document.getElementById("threshold-yellow");
const blueInput   = document.getElementById("threshold-blue");
const pollInput   = document.getElementById("poll-interval");
const barHeightInput = document.getElementById("bar-height");
const showPillInput  = document.getElementById("show-pill");
const showBarsInput  = document.getElementById("show-bars");
const previewPill = document.getElementById("preview-pill");
const savedMsg    = document.getElementById("saved-msg");

function dot(pct, red, yellow, blue) {
  return pct >= red ? "🔴" : pct >= yellow ? "🟡" : pct >= blue ? "🔵" : "🟢";
}

function updatePreview() {
  const red    = parseInt(redInput.value)    || DEFAULTS.thresholdRed;
  const yellow = parseInt(yellowInput.value) || DEFAULTS.thresholdYellow;
  const blue   = parseInt(blueInput.value)   || DEFAULTS.thresholdBlue;
  previewPill.textContent = `${dot(42, red, yellow, blue)} My Account  42%  420 MB/1.0 GB`;
  previewPill.title = [
    "IMAP Quota — click to refresh",
    `${dot(42,     red, yellow, blue)} Account A: 42% — 420 MB of 1.0 GB`,
    `${dot(blue,   red, yellow, blue)} Account B: ${blue}% — ${blue*10} MB of 1.0 GB`,
    `${dot(yellow, red, yellow, blue)} Account C: ${yellow}% — ${yellow*10} MB of 1.0 GB`,
    `${dot(red,    red, yellow, blue)} Account D: ${red}% — ${red*10} MB of 1.0 GB`,
  ].join("\n");
}

async function load() {
  const stored = await messenger.storage.local.get(DEFAULTS);
  redInput.value       = stored.thresholdRed;
  yellowInput.value    = stored.thresholdYellow;
  blueInput.value      = stored.thresholdBlue;
  pollInput.value      = stored.pollInterval;
  barHeightInput.value   = stored.barHeight;
  showPillInput.checked  = stored.showPill;
  showBarsInput.checked  = stored.showBars;
  updatePreview();
}

document.getElementById("btn-save").addEventListener("click", async () => {
  const red        = Math.max(1, Math.min(100, parseInt(redInput.value)       || DEFAULTS.thresholdRed));
  const yellow     = Math.max(1, Math.min(100, parseInt(yellowInput.value)    || DEFAULTS.thresholdYellow));
  const blue       = Math.max(1, Math.min(100, parseInt(blueInput.value)      || DEFAULTS.thresholdBlue));
  const interval   = Math.max(1, Math.min(60,  parseInt(pollInput.value)      || DEFAULTS.pollInterval));
  const barHeight  = Math.max(1, Math.min(20,  parseInt(barHeightInput.value) || DEFAULTS.barHeight));
  redInput.value       = red;
  yellowInput.value    = yellow;
  blueInput.value      = blue;
  pollInput.value      = interval;
  barHeightInput.value   = barHeight;
  const showPill = showPillInput.checked;
  const showBars = showBarsInput.checked;
  await messenger.storage.local.set({ thresholdRed: red, thresholdYellow: yellow, thresholdBlue: blue, pollInterval: interval, barHeight, showPill, showBars });
  // Trigger immediate refresh and restart the poll timer with new interval
  await messenger.runtime.sendMessage("settings-saved");
  savedMsg.classList.add("visible");
  setTimeout(() => savedMsg.classList.remove("visible"), 2000);
  updatePreview();
});

document.getElementById("btn-reset").addEventListener("click", () => {
  redInput.value       = DEFAULTS.thresholdRed;
  yellowInput.value    = DEFAULTS.thresholdYellow;
  blueInput.value      = DEFAULTS.thresholdBlue;
  pollInput.value      = DEFAULTS.pollInterval;
  barHeightInput.value   = DEFAULTS.barHeight;
  showPillInput.checked  = DEFAULTS.showPill;
  showBarsInput.checked  = DEFAULTS.showBars;
  updatePreview();
});

redInput.addEventListener("input", updatePreview);
yellowInput.addEventListener("input", updatePreview);
blueInput.addEventListener("input", updatePreview);

load();
