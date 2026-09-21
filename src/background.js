// Background service worker for DHM Data Watch & River Watch
chrome.runtime.onInstalled.addListener(() => {
  console.log("DHM Data Watch extension installed / updated");
  // Set default storage values if not present
  chrome.storage.local.get({
    extensionEnabled: true,
    autoRefreshInterval: 300,
    autoRefreshEnabled: true,
    autoNavigateRiverWatch: true,
    autoClickRising: true
  }, (res) => {
    chrome.storage.local.set(res);
  });
});

// Periodic telemetry polling alarm
chrome.alarms.create("dhm_poll_alarm", { periodInMinutes: 2 });

// 5-minute auto-refresh background alarm (ensures background tabs are also refreshed every 5 min)
chrome.alarms.create("dhm_autorefresh_5min_alarm", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dhm_poll_alarm") {
    // Check delayed stations count and update extension badge
    fetch("https://hydrology.gov.np/gss/socket.io/?EIO=3&transport=polling&t=" + Date.now())
      .then(r => r.text())
      .catch(() => {});
  } else if (alarm.name === "dhm_autorefresh_5min_alarm") {
    // Broadcast 5-minute auto-refresh to hydrology tabs
    chrome.storage.local.get({ extensionEnabled: true, autoRefreshEnabled: true }, (res) => {
      if (res.extensionEnabled !== false && res.autoRefreshEnabled !== false) {
        chrome.tabs.query({ url: ["https://hydrology.gov.np/*", "http://hydrology.gov.np/*"] }, (tabs) => {
          if (tabs && tabs.length > 0) {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, { action: "TRIGGER_5MIN_AUTO_REFRESH" }).catch(() => {});
            });
          }
        });
      }
    });
  }
});