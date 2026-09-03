// Background service worker for DHM Data Watch
chrome.runtime.onInstalled.addListener(() => {
  console.log("DHM Data Watch extension installed");
});

// Alarm for periodic telemetry polling if needed
chrome.alarms.create("dhm_poll_alarm", { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dhm_poll_alarm") {
    // Check delayed stations count and update extension badge
    fetch("https://hydrology.gov.np/gss/socket.io/?EIO=3&transport=polling&t=" + Date.now())
      .then(r => r.text())
      .catch(() => {});
  }
});