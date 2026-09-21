/**
 * DHM Station Compare Chrome Extension
 * Content Script (Manifest V3)
 */

(function() {
  "use strict";

  /* ==========================================================================
     GLOBAL STATE & COMPARE STATE
     ========================================================================== */
  const state = {
    stations: [],
    stationsCatalog: [],
    riverData: [],
    loading: true,
    lastSyncTime: null,
    nepalTime: new Date(),
    autoRefreshInterval: 300,
    autoRefreshEnabled: true,
    autoNavigateCompare: true,
    nextRefreshTimestamp: null,
    countdownTimer: null,
    autoRefreshTimer: null,
    clockTimer: null,
    isCompareActive: false,
    socketSid: null,
    extensionEnabled: true
  };

  /* ==========================================================================
     NEPAL TIME & DATE UTILITIES
     ========================================================================== */
  function formatNepalClock(d) {
    const timeStr = d.toLocaleTimeString("en-US", {
      timeZone: "Asia/Kathmandu",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
    const dateStr = d.toLocaleDateString("en-US", {
      timeZone: "Asia/Kathmandu",
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric"
    });
    return { timeStr, dateStr };
  }

  /* ==========================================================================
     WATER LEVEL DIFFERENCE CALCULATIONS (WARNING & DANGER LEVEL)
     ========================================================================== */
  function calculateWaterLevelDifferences(waterLevel, warningLevel, dangerLevel) {
    const wl = parseFloat(waterLevel);
    const warn = parseFloat(warningLevel);
    const dang = parseFloat(dangerLevel);

    const hasWL = !isNaN(wl) && wl !== null;
    const hasWarn = !isNaN(warn) && warn !== null && warn > 0;
    const hasDang = !isNaN(dang) && dang !== null && dang > 0;

    let diffWarning = null;
    let diffDanger = null;
    let isAboveWarning = false;
    let isAboveDanger = false;

    if (hasWL && hasWarn) {
      diffWarning = Math.round((wl - warn) * 100) / 100;
      isAboveWarning = diffWarning > 0;
    }

    if (hasWL && hasDang) {
      diffDanger = Math.round((wl - dang) * 100) / 100;
      isAboveDanger = diffDanger > 0;
    }

    return { hasWL, hasWarn, hasDang, diffWarning, diffDanger, isAboveWarning, isAboveDanger };
  }

  function formatStatusWithDifferences(statusText, diffObj) {
    if (!diffObj || !diffObj.hasWL || (!diffObj.hasWarn && !diffObj.hasDang)) {
      return `<div class="dhm-status-plain">${escapeHtml(statusText || "NORMAL")}</div>`;
    }

    const { hasWarn, hasDang, diffWarning, diffDanger, isAboveWarning, isAboveDanger } = diffObj;
    let badgesHtml = "";

    if (isAboveWarning) {
      if (hasDang) {
        if (isAboveDanger) {
          badgesHtml = `<span class="dhm-diff-badge dhm-diff-danger-exceeded" title="Exceeded Danger Level by ${diffDanger.toFixed(2)}m">🚨 +${diffDanger.toFixed(2)}m above Danger</span>`;
        } else {
          const gapDang = Math.abs(diffDanger).toFixed(2);
          badgesHtml = `<span class="dhm-diff-badge dhm-diff-danger-near" title="Warning Level crossed! ${gapDang}m remaining to Danger Level">⚠️ ${gapDang}m to Danger</span>`;
        }
      } else {
        badgesHtml = `<span class="dhm-diff-badge dhm-diff-warning-exceeded" title="Exceeded Warning Level by ${diffWarning.toFixed(2)}m">⚠️ +${diffWarning.toFixed(2)}m above Warning</span>`;
      }
    } else {
      const parts = [];
      if (hasWarn) {
        const gapWarn = Math.abs(diffWarning).toFixed(2);
        parts.push(`<span class="dhm-diff-badge dhm-diff-warn-gap" title="${gapWarn}m remaining until Warning Level">⚠️ -${gapWarn}m to Warning</span>`);
      }
      if (hasDang) {
        const gapDang = Math.abs(diffDanger).toFixed(2);
        parts.push(`<span class="dhm-diff-badge dhm-diff-dang-gap" title="${gapDang}m remaining until Danger Level">🚨 -${gapDang}m to Danger</span>`);
      }
      badgesHtml = parts.join(" ");
    }

    const rawStatus = (statusText || "").toUpperCase();
    const statusClass = isAboveDanger || rawStatus.includes("DANGER") ? "status-danger" : 
                        isAboveWarning || (rawStatus.includes("WARNING") && !rawStatus.includes("BELOW")) ? "status-warning" : 
                        "status-normal";
    const displayTitle = statusText || (isAboveDanger ? "DANGER LEVEL" : isAboveWarning ? "WARNING LEVEL" : "BELOW WARNING LEVEL");

    return `
      <div class="dhm-status-cell-wrapper">
        <div class="dhm-status-main ${statusClass}">
          <span>${escapeHtml(displayTitle)}</span>
        </div>
        <div class="dhm-diff-badges">
          ${badgesHtml}
        </div>
      </div>
    `;
  }

  function getTrendBadgeHTML(trend) {
    const t = (trend || "").toUpperCase();
    if (t === "RISING") return `<span class="dhm-trend-badge dhm-trend-rising">RISING ↑</span>`;
    if (t === "FALLING") return `<span class="dhm-trend-badge dhm-trend-falling">FALLING ↓</span>`;
    if (t === "STEADY") return `<span class="dhm-trend-badge dhm-trend-steady">STEADY →</span>`;
    return `<span style="color:#94a3b8;">-</span>`;
  }

  /* ==========================================================================
     API & SOCKET TELEMETRY SYNC
     ========================================================================== */
  async function fetchStationsCatalog() {
    try {
      const res = await fetch("https://hydrology.gov.np/gss/api/station");
      if (res.ok) state.stationsCatalog = await res.json();
    } catch (err) {
      console.warn("[DHM Extension] Failed to fetch station catalog:", err);
    }
  }

  function fetchSocketData() {
    return new Promise((resolve) => {
      const baseUrl = "https://hydrology.gov.np";
      fetch(baseUrl + "/gss/socket.io/?EIO=3&transport=polling&t=" + Date.now())
        .then(r => r.text())
        .then(data => {
          const sidIdx = data.indexOf("\"sid\":\"");
          if (sidIdx === -1) { resolve(false); return; }
          const sidEnd = data.indexOf("\"", sidIdx + 7);
          const sid = data.substring(sidIdx + 7, sidEnd);
          state.socketSid = sid;

          const sendReq = (eventName) => {
            const payload = "42[\"client_request\",\"" + eventName + "\"]";
            return fetch(baseUrl + "/gss/socket.io/?EIO=3&transport=polling&sid=" + sid + "&t=" + Date.now(), {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=UTF-8" },
              body: payload.length + ":" + payload
            });
          };

          Promise.all([sendReq("river_test")])
            .then(() => {
              setTimeout(() => {
                fetch(baseUrl + "/gss/socket.io/?EIO=3&transport=polling&sid=" + sid + "&t=" + Date.now())
                  .then(r => r.text())
                  .then(pollData => {
                    parseSocketPackets(pollData);
                    resolve(true);
                  })
                  .catch(() => resolve(false));
              }, 1200);
            });
        })
        .catch(err => {
          console.warn("[DHM Extension] Socket connection error:", err);
          resolve(false);
        });
    });
  }

  function parseSocketPackets(data) {
    if (!data) return;
    let i = 0;
    while (i < data.length) {
      const colon = data.indexOf(":", i);
      if (colon === -1) break;
      const len = parseInt(data.substring(i, colon), 10);
      if (isNaN(len)) break;
      const payload = data.substring(colon + 1, colon + 1 + len);
      if (payload.startsWith("42[")) {
        try {
          const parsed = JSON.parse(payload.substring(2));
          if (parsed[0] === "river_test" || parsed[0] === "river_watch") state.riverData = Array.isArray(parsed[1]) ? parsed[1] : [];
        } catch (e) {
          console.error("[DHM Extension] Error parsing packet:", e);
        }
      }
      i = colon + 1 + len;
    }
  }

  function processStationTelemetry() {
    const stationMap = new Map();

    state.stationsCatalog.forEach(st => {
      let district = "", basin = "", stationIndex = "";
      if (st.meta_data && Array.isArray(st.meta_data)) {
        st.meta_data.forEach(m => {
          if (m.name === "District" && m.value) district = m.value.trim();
          if (m.name === "Basin" && m.value) basin = m.value.trim();
          if (m.name === "Station Index" && m.value) stationIndex = m.value.trim();
        });
      }
      stationMap.set(st.id, {
        id: st.id, name: st.name || "Unnamed Station", stationIndex: stationIndex || st.description || "",
        basin: basin || st.folder_name || "Other", district: district || "Unknown",
        waterLevel: null, waterLevelTrend: null, waterLevelStatus: null,
        warningLevel: null, dangerLevel: null, diffWarning: null, diffDanger: null, diffInfo: null
      });
    });

    state.riverData.forEach(r => {
      let st = stationMap.get(r.id);
      if (!st) {
        st = {
          id: r.id, name: r.name || "Station " + r.id, stationIndex: r.stationIndex || "",
          basin: r.basin || "Other", district: r.district || "Unknown",
          waterLevel: null, waterLevelTrend: null, waterLevelStatus: null,
          warningLevel: null, dangerLevel: null, diffWarning: null, diffDanger: null, diffInfo: null
        };
        stationMap.set(r.id, st);
      }
      if (r.waterLevel) {
        st.waterLevel = r.waterLevel.value;
        st.waterLevelTrend = r.steady || "";
        st.waterLevelStatus = r.status || "";
        st.warningLevel = r.warning_level;
        st.dangerLevel = r.danger_level;
      }
      if (r.stationIndex && !st.stationIndex) st.stationIndex = r.stationIndex;
      if (r.district && st.district === "Unknown") st.district = r.district;
      if (r.basin && st.basin === "Other") st.basin = r.basin;
    });

    const combined = Array.from(stationMap.values()).map(st => {
      st.diffInfo = calculateWaterLevelDifferences(st.waterLevel, st.warningLevel, st.dangerLevel);
      st.diffWarning = st.diffInfo.diffWarning;
      st.diffDanger = st.diffInfo.diffDanger;
      return st;
    });

    state.stations = combined.filter(st => !st.name.includes("-DELETE") && !st.name.includes("_delete"));
    state.lastSyncTime = new Date();
    state.loading = false;
  }

  async function syncAllData() {
    state.loading = true;
    if (state.isCompareActive) renderCompareContent();
    if (state.stationsCatalog.length === 0) await fetchStationsCatalog();
    await fetchSocketData();
    processStationTelemetry();
    if (state.isCompareActive) renderCompareContent();
  }

  /* ==========================================================================
     CUSTOM TABS INJECTION & ROUTING
     ========================================================================== */
  function injectCustomTabs() {
    const tabsContainer = document.querySelector(".tabs");
    if (!tabsContainer) return;

    if (!document.getElementById("dhm-compare-tab-link")) {
      const cmpWrapper = document.createElement("a");
      cmpWrapper.href = "#/compare";
      cmpWrapper.id = "dhm-compare-tab-link";
      cmpWrapper.style.textDecoration = "none";
      cmpWrapper.innerHTML = `
        <div class="dhm-custom-tab-btn" id="dhm-compare-btn-container">
          <button tabindex="0" type="button">
            <div>
              <div class="tab-label">
                <span>Compare</span>
                <span class="dhm-tab-pulse-badge" style="background-color: #f59e0b;" title="Compare Top 5 Near Warning vs Rising"></span>
              </div>
            </div>
          </button>
        </div>
      `;
      cmpWrapper.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "#/compare";
        activateCompareView();
      });
      tabsContainer.appendChild(cmpWrapper);
    }
  }

  function handleHashRouting() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#/compare")) {
      activateCompareView();
    } else {
      deactivateCompareView();
    }
  }

  function resetOtherTabsAppearance() {
    document.querySelectorAll(".tabs > a:not(#dhm-compare-tab-link) div[style*=\"background-color: rgb(15, 114, 169)\"]").forEach(el => {
      el.style.backgroundColor = "rgb(255, 255, 255)";
      const span = el.querySelector("span");
      if (span) span.style.color = "rgba(0, 0, 0, 0.87)";
    });
  }

  /* ==========================================================================
     COMPARE TAB (DEFAULT VIEW)
     ========================================================================== */
  function activateCompareView() {
    state.isCompareActive = true;
    document.title = "DHM Station Compare";

    const compareBtn = document.getElementById("dhm-compare-btn-container");
    if (compareBtn) compareBtn.classList.add("active");

    resetOtherTabsAppearance();

    let mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (!mainEl) return;

    Array.from(mainEl.children).forEach(child => {
      if (child.id !== "dhm-compare-root") {
        child.style.display = "none";
      }
    });

    let root = document.getElementById("dhm-compare-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "dhm-compare-root";
      mainEl.appendChild(root);
    }
    root.style.display = "block";

    renderCompareContent();

    if (state.stations.length === 0) {
      syncAllData();
    }
  }

  function deactivateCompareView() {
    state.isCompareActive = false;
    const compareBtn = document.getElementById("dhm-compare-btn-container");
    if (compareBtn) compareBtn.classList.remove("active");

    const root = document.getElementById("dhm-compare-root");
    if (root) root.style.display = "none";

    const mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (mainEl) {
      Array.from(mainEl.children).forEach(child => {
        if (child.id !== "dhm-compare-root") {
          child.style.display = "";
        }
      });
    }
  }

  function renderCompareContent() {
    const root = document.getElementById("dhm-compare-root");
    if (!root || !state.isCompareActive) return;

    if (state.loading && state.stations.length === 0) {
      root.innerHTML = `
        <div class="cmp-loading-state">
          <div class="cmp-spinner"></div>
          <div style="font-weight:600; color:#0f72a9;">Syncing live DHM comparison data...</div>
        </div>
      `;
      return;
    }

    // Top 5 Near Warning (highest difference first)
    const nearWarnList = state.stations
      .filter(st => st.diffWarning !== null)
      .sort((a, b) => b.diffWarning - a.diffWarning)
      .slice(0, 5);

    // Top 5 Rising (highest difference first)
    const risingList = state.stations
      .filter(st => (st.waterLevelTrend || "").toUpperCase() === "RISING")
      .sort((a, b) => {
        const diffA = a.diffWarning !== null ? a.diffWarning : -Infinity;
        const diffB = b.diffWarning !== null ? b.diffWarning : -Infinity;
        return diffB - diffA;
      })
      .slice(0, 5);

    const maxRows = Math.max(nearWarnList.length, risingList.length, 1);
    let rowsHtml = "";

    for (let i = 0; i < maxRows; i++) {
      const nw = nearWarnList[i];
      const ri = risingList[i];

      const renderCell = (st) => {
        if (!st) return `<td colspan="4" class="cmp-empty">No Station Available</td>`;
        const diffHtml = formatStatusWithDifferences(st.waterLevelStatus, st.diffInfo);
        const trendHtml = getTrendBadgeHTML(st.waterLevelTrend);
        return `
          <td>
            <div class="cmp-station-name">${escapeHtml(st.name)}</div>
            <div class="cmp-basin">${escapeHtml(st.basin)} | ${escapeHtml(st.district)}</div>
          </td>
          <td style="font-weight:700;">${st.waterLevel !== null ? st.waterLevel + "m" : "-"}</td>
          <td>${diffHtml}</td>
          <td>${trendHtml}</td>
        `;
      };

      rowsHtml += `
        <tr>
          ${renderCell(nw)}
          <td class="cmp-divider"></td>
          ${renderCell(ri)}
        </tr>
      `;
    }

    root.innerHTML = `
      <div class="cmp-header-panel">
        <h2>📊 DHM Station Compare</h2>
        <p>A side-by-side view highlighting stations closest to Warning levels against those currently Rising the fastest.</p>
      </div>
      <div class="cmp-table-container">
        <table class="cmp-table">
          <thead>
            <tr class="cmp-main-header">
              <th colspan="4" class="cmp-warn-header">⚠️ Top 5 Near Warning / Exceeding</th>
              <th class="cmp-divider"></th>
              <th colspan="4" class="cmp-rise-header">📈 Top 5 Rising Stations</th>
            </tr>
            <tr class="cmp-sub-header">
              <th>Station / Basin</th>
              <th>Water Level</th>
              <th>Level Status & Buffer Gap</th>
              <th>Trend</th>
              <th class="cmp-divider"></th>
              <th>Station / Basin</th>
              <th>Water Level</th>
              <th>Level Status & Buffer Gap</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ==========================================================================
     TIMERS, AUTO-REFRESH & LIFECYCLE INITIALIZATION
     ========================================================================== */
  function setupAutoRefresh() {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    if (state.countdownTimer) clearInterval(state.countdownTimer);

    if (!state.extensionEnabled || !state.autoRefreshEnabled || state.autoRefreshInterval <= 0) {
      updateAutoRefreshUI("Off");
      return;
    }

    state.nextRefreshTimestamp = Date.now() + state.autoRefreshInterval * 1000;

    state.countdownTimer = setInterval(() => {
      if (!state.extensionEnabled || !state.autoRefreshEnabled || state.autoRefreshInterval <= 0) {
        clearInterval(state.countdownTimer);
        updateAutoRefreshUI("Off");
        return;
      }
      const now = Date.now();
      const remainingSec = Math.max(0, Math.ceil((state.nextRefreshTimestamp - now) / 1000));

      if (remainingSec <= 0) {
        clearInterval(state.countdownTimer);
        executePageRefresh();
        return;
      }

      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      updateAutoRefreshUI(`${mins}:${secs < 10 ? "0" : ""}${secs}`);
      
      if (remainingSec % 60 === 0 && state.isCompareActive) syncAllData();
    }, 1000);
  }

  function updateAutoRefreshUI(timeStr) {
    const widgetTime = document.getElementById("dhm-widget-timer-time");
    if (widgetTime) widgetTime.textContent = timeStr;
  }

  function executePageRefresh() {
    console.log("[DHM Extension] Auto-refresh triggered. Reloading on Compare default...");
    if (state.autoNavigateCompare) {
      if (window.location.protocol.startsWith("http")) {
        const targetUrl = window.location.origin + window.location.pathname + "#/compare";
        if (window.location.href !== targetUrl) window.location.href = targetUrl;
      } else {
        window.location.hash = "#/compare";
      }
    }
    window.location.reload();
  }

  function ensureComparePageLoaded(attempt = 0) {
    if (!state.extensionEnabled) return;
    if (attempt > 60) return; // 12 seconds max

    const hash = window.location.hash || "";
    if (state.autoNavigateCompare && !hash.includes("compare")) {
      const compareLink = document.getElementById("dhm-compare-tab-link");
      if (compareLink) {
        compareLink.click();
      } else {
        window.location.hash = "#/compare";
      }
    }

    if (!document.getElementById("dhm-compare-root")) {
      setTimeout(() => ensureComparePageLoaded(attempt + 1), 200);
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\x27/g, "&#039;");
  }

  /* ==========================================================================
     FLOATING WEBPAGE EXTENSION TOGGLE WIDGET
     ========================================================================== */
  function injectFloatingToggleWidget() {
    if (document.getElementById("dhm-floating-toggle-widget")) return;
    const widget = document.createElement("div");
    widget.id = "dhm-floating-toggle-widget";
    widget.title = "DHM Station Compare Extension (Click to toggle ON/OFF)";
    widget.innerHTML = `
      <div class="dhm-widget-brand"><span>📊</span><span>DHM Compare</span></div>
      <div class="dhm-widget-timer-chip" id="dhm-widget-timer-chip" title="Auto-refresh with Compare page priority">
        <span class="dhm-widget-timer-icon">⏱️</span><span class="dhm-widget-timer-time" id="dhm-widget-timer-time">5:00</span>
      </div>
      <label class="dhm-widget-switch"><input type="checkbox" id="dhm-widget-toggle-input" ${state.extensionEnabled ? "checked" : ""}><span class="dhm-widget-slider"></span></label>
      <span class="dhm-widget-status" id="dhm-widget-status-text">${state.extensionEnabled ? "ON" : "OFF"}</span>
    `;
    document.body.appendChild(widget);

    widget.querySelector("#dhm-widget-toggle-input").addEventListener("change", (e) => setExtensionEnabledState(e.target.checked));
    widget.querySelector("#dhm-widget-timer-chip").addEventListener("click", executePageRefresh);
    updateFloatingWidgetUI();
  }

  function updateFloatingWidgetUI() {
    const widget = document.getElementById("dhm-floating-toggle-widget");
    if (!widget) return;
    const toggleInput = widget.querySelector("#dhm-widget-toggle-input");
    const statusText = widget.querySelector("#dhm-widget-status-text");
    if (toggleInput) toggleInput.checked = state.extensionEnabled;
    if (statusText) statusText.textContent = state.extensionEnabled ? "ON" : "OFF";
    widget.classList.toggle("is-disabled", !state.extensionEnabled);
  }

  function setExtensionEnabledState(enabled) {
    state.extensionEnabled = enabled;
    if (typeof chrome !== "undefined" && chrome.storage) chrome.storage.local.set({ extensionEnabled: enabled });
    updateFloatingWidgetUI();
    if (enabled) {
      enableExtensionFeatures();
      setupAutoRefresh();
      ensureComparePageLoaded();
    } else {
      disableExtensionFeatures();
      if (state.countdownTimer) clearInterval(state.countdownTimer);
      updateAutoRefreshUI("Off");
    }
  }

  function enableExtensionFeatures() {
    injectCustomTabs();
    handleHashRouting();
  }

  function disableExtensionFeatures() {
    const cmpBtn = document.getElementById("dhm-compare-tab-link");
    if (cmpBtn) cmpBtn.remove();
    if (window.location.hash.startsWith("#/compare")) {
      deactivateCompareView();
      window.location.hash = "#/river_watch";
    }
  }

  /* ==========================================================================
     INITIALIZATION
     ========================================================================== */
  function init() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({
        extensionEnabled: true,
        autoRefreshInterval: 300,
        autoRefreshEnabled: true,
        autoNavigateCompare: true
      }, (res) => {
        state.extensionEnabled = res.extensionEnabled !== false;
        state.autoRefreshInterval = typeof res.autoRefreshInterval === "number" ? res.autoRefreshInterval : 300;
        state.autoRefreshEnabled = res.autoRefreshEnabled !== false;
        state.autoNavigateCompare = res.autoNavigateCompare !== false;

        injectFloatingToggleWidget();

        if (state.extensionEnabled) {
          enableExtensionFeatures();
          setupAutoRefresh();
          ensureComparePageLoaded();
          syncAllData();
        } else {
          disableExtensionFeatures();
        }
      });

      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === "local") {
          if (changes.extensionEnabled) setExtensionEnabledState(changes.extensionEnabled.newValue);
          if (changes.autoRefreshInterval) { state.autoRefreshInterval = changes.autoRefreshInterval.newValue; setupAutoRefresh(); }
          if (changes.autoRefreshEnabled) { state.autoRefreshEnabled = changes.autoRefreshEnabled.newValue; setupAutoRefresh(); }
        }
      });

      if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.action === "EXTENSION_TOGGLED") setExtensionEnabledState(msg.enabled);
          else if (msg && msg.action === "TRIGGER_5MIN_AUTO_REFRESH") executePageRefresh();
        });
      }
    } else {
      injectFloatingToggleWidget();
      enableExtensionFeatures();
      setupAutoRefresh();
      ensureComparePageLoaded();
      syncAllData();
    }

    window.addEventListener("hashchange", () => {
      if (state.extensionEnabled) handleHashRouting();
    });

    const observer = new MutationObserver(() => {
      injectFloatingToggleWidget();
      if (!state.extensionEnabled) return;
      injectCustomTabs();
      const hash = window.location.hash || "";
      if (hash.startsWith("#/compare") && !state.isCompareActive) activateCompareView();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();