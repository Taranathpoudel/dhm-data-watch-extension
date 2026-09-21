/**
 * DHM Hydrology - Data Watch & River Watch Telemetry Chrome Extension
 * Content Script (Manifest V3)
 */

(function() {
  "use strict";

  /* ==========================================================================
     GLOBAL STATE & DATA WATCH STATE
     ========================================================================== */
  const state = {
    stations: [],
    stationsCatalog: [],
    riverData: [],
    rainfallData: [],
    loading: true,
    lastSyncTime: null,
    nepalTime: new Date(),
    searchQuery: "",
    statusFilter: "delayed",
    basinFilter: "all",
    districtFilter: "all",
    typeFilter: "all",
    sortBy: "delay_desc",
    autoRefreshInterval: 300,
    autoRefreshEnabled: true,
    autoNavigateRiverWatch: true, // Now used to navigate to Compare by default
    autoClickRising: true,
    hasAutoClickedRising: false,
    nextRefreshTimestamp: null,
    countdownTimer: null,
    autoRefreshTimer: null,
    clockTimer: null,
    isDataWatchActive: false,
    isCompareActive: false, // <-- New Compare State
    socketSid: null,
    extensionEnabled: true,
    risingStationsBaseline: new Map(),
    lastKnownRisingCount: null,
    isReloadingDueToTrendChange: false,
    trendWatchTimer: null,
    telemetryPollTimer: null
  };

  /* ==========================================================================
     RIVER WATCH TABLE SORTER & FILTER STATE
     ========================================================================== */
  const riverWatchState = {
    sortKey: "trend_rising",
    activeColIndex: null,
    sortDirection: "asc",
    trendFilter: "RISING",
    searchQuery: "",
    isSorting: false,
    originalOrderMap: new WeakMap(),
    cachedRows: [],
    lastTableRef: null,
    reapplyTimer: null
  };

  /* ==========================================================================
     NEPAL TIME & DATE UTILITIES
     ========================================================================== */
  function formatNepalDateTime(dateInput) {
    if (!dateInput) return "No Data";
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "Invalid Date";
    return d.toLocaleString("en-US", {
      timeZone: "Asia/Kathmandu",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }) + " NPT";
  }

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

  function calculateDelayMinutes(lastReportTime) {
    if (!lastReportTime) return Infinity;
    const reportDate = new Date(lastReportTime);
    if (isNaN(reportDate.getTime())) return Infinity;
    const now = new Date();
    const diffMs = now.getTime() - reportDate.getTime();
    return Math.max(0, Math.floor(diffMs / 60000));
  }

  function formatDelayDuration(delayMinutes) {
    if (delayMinutes === Infinity || delayMinutes == null) {
      return { text: "No Data Received", badgeClass: "dw-badge-offline", level: "offline" };
    }
    if (delayMinutes <= 10) {
      return { 
        text: delayMinutes === 0 ? "Just now" : delayMinutes + "m ago (On Time)", 
        badgeClass: "dw-badge-normal", 
        level: "normal" 
      };
    }
    const missedCycles = Math.floor(delayMinutes / 10);
    let timeFormatted = "";
    if (delayMinutes < 60) {
      timeFormatted = delayMinutes + "m overdue";
    } else if (delayMinutes < 1440) {
      const hours = Math.floor(delayMinutes / 60);
      const mins = delayMinutes % 60;
      timeFormatted = hours + "h " + mins + "m overdue";
    } else {
      const days = Math.floor(delayMinutes / 1440);
      const hours = Math.floor((delayMinutes % 1440) / 60);
      timeFormatted = days + "d " + hours + "h overdue";
    }

    if (delayMinutes <= 30) {
      return { text: timeFormatted + " (~" + missedCycles + " cycles)", badgeClass: "dw-badge-delayed", level: "delayed" };
    } else if (delayMinutes <= 60) {
      return { text: timeFormatted + " (~" + missedCycles + " cycles)", badgeClass: "dw-badge-delayed", level: "delayed_moderate" };
    } else if (delayMinutes <= 1440) {
      return { text: timeFormatted + " (~" + missedCycles + " cycles)", badgeClass: "dw-badge-critical", level: "critical" };
    } else {
      return { text: timeFormatted + " (Offline)", badgeClass: "dw-badge-offline", level: "offline" };
    }
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

          Promise.all([sendReq("river_test"), sendReq("rainfall_watch"), sendReq("river_discharge")])
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
          if (parsed[0] === "rainfall_watch") state.rainfallData = Array.isArray(parsed[1]) ? parsed[1] : [];
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
      let district = "", basin = "", nepaliName = "", stationIndex = "";
      if (st.meta_data && Array.isArray(st.meta_data)) {
        st.meta_data.forEach(m => {
          if (m.name === "District" && m.value) district = m.value.trim();
          if (m.name === "Basin" && m.value) basin = m.value.trim();
          if (m.name === "Nepali Name" && m.value) nepaliName = m.value.trim();
          if (m.name === "Station Index" && m.value) stationIndex = m.value.trim();
        });
      }
      stationMap.set(st.id, {
        id: st.id, name: st.name || "Unnamed Station", nepaliName, stationIndex: stationIndex || st.description || "",
        basin: basin || st.folder_name || "Other", district: district || "Unknown",
        latitude: st.latitude, longitude: st.longitude, elevation: st.elevation,
        waterLevel: null, waterLevelTime: null, waterLevelTrend: null, waterLevelStatus: null,
        warningLevel: null, dangerLevel: null, diffWarning: null, diffDanger: null, diffInfo: null,
        rainfall: null, rainfallTime: null, rainfallStatus: null,
        latestTime: null, delayMinutes: Infinity, type: "Unknown", isReportingOnTime: false
      });
    });

    state.riverData.forEach(r => {
      let st = stationMap.get(r.id);
      if (!st) {
        st = {
          id: r.id, name: r.name || "Station " + r.id, nepaliName: "", stationIndex: r.stationIndex || "",
          basin: r.basin || "Other", district: r.district || "Unknown",
          latitude: r.latitude, longitude: r.longitude, elevation: r.elevation,
          waterLevel: null, waterLevelTime: null, waterLevelTrend: null, waterLevelStatus: null,
          warningLevel: null, dangerLevel: null, diffWarning: null, diffDanger: null, diffInfo: null,
          rainfall: null, rainfallTime: null, rainfallStatus: null,
          latestTime: null, delayMinutes: Infinity, type: "Water Level", isReportingOnTime: false
        };
        stationMap.set(r.id, st);
      }
      if (r.waterLevel) {
        st.waterLevel = r.waterLevel.value;
        st.waterLevelTime = r.waterLevel.datetime;
        st.waterLevelTrend = r.steady || "";
        st.waterLevelStatus = r.status || "";
        st.warningLevel = r.warning_level;
        st.dangerLevel = r.danger_level;
        st.type = st.rainfall !== null ? "Both (WL + Rain)" : "Water Level";
      }
      if (r.stationIndex && !st.stationIndex) st.stationIndex = r.stationIndex;
      if (r.district && st.district === "Unknown") st.district = r.district;
      if (r.basin && st.basin === "Other") st.basin = r.basin;
    });

    state.rainfallData.forEach(rf => {
      let st = stationMap.get(rf.id);
      if (!st) {
        st = {
          id: rf.id, name: rf.name || "Station " + rf.id, nepaliName: "", stationIndex: rf.stationIndex || "",
          basin: rf.basin || "Other", district: rf.district || "Unknown",
          latitude: rf.latitude, longitude: rf.longitude, elevation: rf.elevation,
          waterLevel: null, waterLevelTime: null, waterLevelTrend: null, waterLevelStatus: null,
          warningLevel: null, dangerLevel: null, diffWarning: null, diffDanger: null, diffInfo: null,
          rainfall: null, rainfallTime: null, rainfallStatus: null,
          latestTime: null, delayMinutes: Infinity, type: "Rainfall", isReportingOnTime: false
        };
        stationMap.set(rf.id, st);
      }
      if (rf.latest_observation) {
        st.rainfall = rf.latest_observation.value;
        st.rainfallTime = rf.latest_observation.datetime;
        st.rainfallAverages = rf.averages;
        st.rainfallStatus = rf.status;
        st.type = st.waterLevel !== null ? "Both (WL + Rain)" : "Rainfall";
      }
      if (rf.stationIndex && !st.stationIndex) st.stationIndex = rf.stationIndex;
      if (rf.district && st.district === "Unknown") st.district = rf.district;
      if (rf.basin && st.basin === "Other") st.basin = rf.basin;
    });

    const combined = Array.from(stationMap.values()).map(st => {
      const times = [];
      if (st.waterLevelTime) times.push(new Date(st.waterLevelTime).getTime());
      if (st.rainfallTime) times.push(new Date(st.rainfallTime).getTime());
      if (times.length > 0) {
        const latestEpoch = Math.max(...times.filter(t => !isNaN(t)));
        if (latestEpoch > 0) st.latestTime = new Date(latestEpoch).toISOString();
      }
      st.delayMinutes = calculateDelayMinutes(st.latestTime);
      st.isReportingOnTime = st.delayMinutes <= 10;
      st.delayInfo = formatDelayDuration(st.delayMinutes);
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
    if (state.isDataWatchActive) renderDashboardContent();
    if (state.isCompareActive) renderCompareContent();
    if (state.stationsCatalog.length === 0) await fetchStationsCatalog();
    await fetchSocketData();
    processStationTelemetry();
    if (state.isDataWatchActive) renderDashboardContent();
    if (state.isCompareActive) renderCompareContent();
  }

  /* ==========================================================================
     CUSTOM TABS INJECTION & ROUTING
     ========================================================================== */
  function injectCustomTabs() {
    const tabsContainer = document.querySelector(".tabs");
    if (!tabsContainer) return;

    // Inject Compare Tab
    if (!document.getElementById("dhm-compare-tab-link")) {
      const cmpWrapper = document.createElement("a");
      cmpWrapper.href = "#/compare";
      cmpWrapper.id = "dhm-compare-tab-link";
      cmpWrapper.style.textDecoration = "none";
      cmpWrapper.innerHTML = `
        <div class="dhm-data-watch-tab-btn" id="dhm-compare-btn-container">
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

    // Inject Data Watch Tab
    if (!document.getElementById("dhm-data-watch-tab-link")) {
      const dwWrapper = document.createElement("a");
      dwWrapper.href = "#/data_watch";
      dwWrapper.id = "dhm-data-watch-tab-link";
      dwWrapper.style.textDecoration = "none";
      dwWrapper.innerHTML = `
        <div class="dhm-data-watch-tab-btn" id="dhm-data-watch-btn-container">
          <button tabindex="0" type="button">
            <div>
              <div class="tab-label">
                <span>Data Watch</span>
                <span class="dhm-tab-pulse-badge" title="10-Min Telemetry Watch (Nepal Time)"></span>
              </div>
            </div>
          </button>
        </div>
      `;
      dwWrapper.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "#/data_watch";
        activateDataWatchView();
      });
      tabsContainer.appendChild(dwWrapper);
    }
  }

  function handleHashRouting() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#/data_watch")) {
      activateDataWatchView();
      deactivateCompareView();
    } else if (hash.startsWith("#/compare")) {
      activateCompareView();
      deactivateDataWatchView();
    } else {
      deactivateDataWatchView();
      deactivateCompareView();
      if (hash.startsWith("#/river_watch") || hash.includes("river_watch")) {
        setTimeout(checkAndEnhanceRiverWatch, 200);
      }
    }
  }

  function resetOtherTabsAppearance() {
    document.querySelectorAll(".tabs > a:not(#dhm-data-watch-tab-link):not(#dhm-compare-tab-link) div[style*=\"background-color: rgb(15, 114, 169)\"]").forEach(el => {
      el.style.backgroundColor = "rgb(255, 255, 255)";
      const span = el.querySelector("span");
      if (span) span.style.color = "rgba(0, 0, 0, 0.87)";
    });
  }

  /* ==========================================================================
     COMPARE TAB (NEW DEFAULT VIEW)
     ========================================================================== */
  function activateCompareView() {
    state.isCompareActive = true;
    state.isDataWatchActive = false;
    document.title = "Hydrology - Compare Stations";

    const compareBtn = document.getElementById("dhm-compare-btn-container");
    if (compareBtn) compareBtn.classList.add("active");
    const dwBtn = document.getElementById("dhm-data-watch-btn-container");
    if (dwBtn) dwBtn.classList.remove("active");

    resetOtherTabsAppearance();

    let mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (!mainEl) return;

    Array.from(mainEl.children).forEach(child => {
      if (child.id !== "dhm-compare-root" && child.id !== "dhm-data-watch-root") {
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
    if (mainEl && !state.isDataWatchActive) {
      Array.from(mainEl.children).forEach(child => {
        if (child.id !== "dhm-compare-root" && child.id !== "dhm-data-watch-root") {
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
        <div class="dw-loading-state">
          <div class="dw-spinner"></div>
          <div style="font-weight:600; color:var(--dhm-primary);">Syncing live DHM comparison data...</div>
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
        <h2>📊 Quick Compare: Top 5 Critical Stations</h2>
        <p>A side-by-side view showing the stations closest to Warning levels and the highest Rising stations.</p>
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
     DATA WATCH TAB UI & DASHBOARD
     ========================================================================== */
  function activateDataWatchView() {
    state.isDataWatchActive = true;
    state.isCompareActive = false;
    document.title = "Hydrology - Data Watch (10-Min Telemetry Monitor)";

    const dataWatchBtn = document.getElementById("dhm-data-watch-btn-container");
    if (dataWatchBtn) dataWatchBtn.classList.add("active");
    const compareBtn = document.getElementById("dhm-compare-btn-container");
    if (compareBtn) compareBtn.classList.remove("active");

    resetOtherTabsAppearance();

    let mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (!mainEl) return;

    Array.from(mainEl.children).forEach(child => {
      if (child.id !== "dhm-data-watch-root" && child.id !== "dhm-compare-root") {
        child.style.display = "none";
      }
    });

    let root = document.getElementById("dhm-data-watch-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "dhm-data-watch-root";
      mainEl.appendChild(root);
    }
    root.style.display = "block";

    renderDashboardContent();

    if (state.stations.length === 0) syncAllData();
  }

  function deactivateDataWatchView() {
    state.isDataWatchActive = false;
    const dataWatchBtn = document.getElementById("dhm-data-watch-btn-container");
    if (dataWatchBtn) dataWatchBtn.classList.remove("active");

    const root = document.getElementById("dhm-data-watch-root");
    if (root) root.style.display = "none";

    const mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (mainEl && !state.isCompareActive) {
      Array.from(mainEl.children).forEach(child => {
        if (child.id !== "dhm-data-watch-root" && child.id !== "dhm-compare-root") {
          child.style.display = "";
        }
      });
    }
  }

  function getFilteredAndSortedStations() {
    let list = [...state.stations];
    if (state.statusFilter === "delayed") list = list.filter(st => st.delayMinutes > 10);
    else if (state.statusFilter === "critical") list = list.filter(st => st.delayMinutes > 60 && st.delayMinutes < Infinity);
    else if (state.statusFilter === "offline") list = list.filter(st => st.delayMinutes > 1440 || st.delayMinutes === Infinity);
    else if (state.statusFilter === "normal") list = list.filter(st => st.delayMinutes <= 10);
    else if (state.statusFilter === "rising") list = list.filter(st => (st.waterLevelTrend || "").toUpperCase() === "RISING");
    else if (state.statusFilter === "falling") list = list.filter(st => (st.waterLevelTrend || "").toUpperCase() === "FALLING");
    else if (state.statusFilter === "steady") list = list.filter(st => (st.waterLevelTrend || "").toUpperCase() === "STEADY");

    if (state.basinFilter !== "all") list = list.filter(st => (st.basin || "").toLowerCase() === state.basinFilter.toLowerCase());
    if (state.districtFilter !== "all") list = list.filter(st => (st.district || "").toLowerCase() === state.districtFilter.toLowerCase());
    if (state.typeFilter !== "all") {
      if (state.typeFilter === "river") list = list.filter(st => st.waterLevel !== null || st.type === "Water Level");
      else if (state.typeFilter === "rainfall") list = list.filter(st => st.rainfall !== null || st.type === "Rainfall");
      else if (state.typeFilter === "both") list = list.filter(st => st.type.includes("Both"));
    }

    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase().trim();
      list = list.filter(st => 
        (st.name || "").toLowerCase().includes(q) ||
        (st.basin || "").toLowerCase().includes(q) ||
        (st.district || "").toLowerCase().includes(q) ||
        (st.waterLevelTrend || "").toLowerCase().includes(q) ||
        String(st.id).includes(q)
      );
    }

    list.sort((a, b) => {
      switch (state.sortBy) {
        case "diff_warning_desc": {
          const diffA = a.diffWarning !== null ? a.diffWarning : -Infinity;
          const diffB = b.diffWarning !== null ? b.diffWarning : -Infinity;
          return diffB - diffA;
        }
        case "delay_desc": return b.delayMinutes - a.delayMinutes;
        case "trend_rising": {
          const rank = (t) => t === "RISING" ? 1 : t === "FALLING" ? 2 : t === "STEADY" ? 3 : 4;
          const rA = rank((a.waterLevelTrend || "").toUpperCase());
          const rB = rank((b.waterLevelTrend || "").toUpperCase());
          if (rA !== rB) return rA - rB;
          return (b.waterLevel || 0) - (a.waterLevel || 0);
        }
        default: return b.delayMinutes - a.delayMinutes;
      }
    });

    return list;
  }

  function renderDashboardContent() {
    const root = document.getElementById("dhm-data-watch-root");
    if (!root || !state.isDataWatchActive) return;

    const filteredStations = getFilteredAndSortedStations();
    const totalCount = state.stations.length;
    const delayedCount = state.stations.filter(s => s.delayMinutes > 10).length;
    const criticalCount = state.stations.filter(s => s.delayMinutes > 60 && s.delayMinutes < Infinity).length;
    const offlineCount = state.stations.filter(s => s.delayMinutes > 1440 || s.delayMinutes === Infinity).length;
    const normalCount = state.stations.filter(s => s.delayMinutes <= 10).length;

    const { timeStr, dateStr } = formatNepalClock(state.nepalTime);
    const basins = Array.from(new Set(state.stations.map(s => s.basin).filter(Boolean))).sort();

    root.innerHTML = `
      <div class="dw-header-panel">
        <div class="dw-title-group">
          <h2>
            <span>📡 DHM Data Watch — 10-Minute Telemetry Monitor</span>
            <span class="dw-nepal-badge">Nepal Time Zone (UTC+5:45)</span>
          </h2>
        </div>
        <div class="dw-header-controls">
          <div class="dw-live-clock-card" title="Official Nepal Standard Time (NPT)">
            <span class="dw-clock-label">Nepal Standard Time</span>
            <span class="dw-clock-time" id="dw-live-clock">${timeStr}</span>
            <span class="dw-clock-date">${dateStr}</span>
          </div>
          <button class="dw-btn dw-btn-primary" id="dw-refresh-btn"><span>🔄 Refresh</span></button>
        </div>
      </div>
      <div class="dw-kpi-grid">
        <div class="dw-kpi-card kpi-total"><div class="dw-kpi-header"><span class="dw-kpi-title">Total</span></div><div class="dw-kpi-value">${totalCount}</div></div>
        <div class="dw-kpi-card kpi-delayed"><div class="dw-kpi-header"><span class="dw-kpi-title">Delayed</span></div><div class="dw-kpi-value">${delayedCount}</div></div>
        <div class="dw-kpi-card kpi-normal"><div class="dw-kpi-header"><span class="dw-kpi-title">On-Time</span></div><div class="dw-kpi-value">${normalCount}</div></div>
      </div>
      <div class="dw-table-card">
        <div class="dw-table-responsive">
          ${state.loading && state.stations.length === 0 ? `
            <div class="dw-loading-state"><div class="dw-spinner"></div><div>Connecting...</div></div>
          ` : `
            <table class="dw-table">
              <thead>
                <tr>
                  <th>Status</th><th>Station Name</th><th>Basin</th><th>Type</th><th>Trend / Level</th><th>Delay</th>
                </tr>
              </thead>
              <tbody>
                ${filteredStations.map(st => `
                  <tr>
                    <td><span class="dw-badge ${st.delayInfo.badgeClass}">${st.delayInfo.level === "normal" ? "🟢" : "⚠️"}</span></td>
                    <td><b>${escapeHtml(st.name)}</b></td>
                    <td>${escapeHtml(st.basin)}</td>
                    <td>${escapeHtml(st.type)}</td>
                    <td>${st.waterLevel !== null ? `<b>${st.waterLevel}m</b><br>${getTrendBadgeHTML(st.waterLevelTrend)}` : "-"}</td>
                    <td>${escapeHtml(st.delayInfo.text)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>
      </div>
    `;

    const refreshBtn = document.getElementById("dw-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => syncAllData());
  }

  /* ==========================================================================
     RIVER WATCH ENHANCER (Retained, but not forced on reload anymore)
     ========================================================================== */
  function checkAndEnhanceRiverWatch() {
    const table = document.querySelector("table.watch_table");
    if (!table || riverWatchState.isSorting) return;
    enhanceRiverWatchTable(table);
  }

  function extractRiverWatchRowData(tr, index) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 9) return null;
    const snText = (cells[0] && cells[0].innerText || "").trim();
    const basinText = (cells[1] && cells[1].innerText || "").trim();
    const indexText = (cells[2] && cells[2].innerText || "").trim();
    let stationName = "", stationTime = "";
    if (cells[3]) {
      const timeSpan = cells[3].querySelector("span");
      if (timeSpan) {
        stationTime = timeSpan.innerText.trim();
        const clone = cells[3].cloneNode(true);
        const spanInClone = clone.querySelector("span");
        if (spanInClone) spanInClone.remove();
        stationName = clone.innerText.trim();
      } else {
        stationName = cells[3].innerText.trim();
      }
    }
    const districtText = (cells[4] && cells[4].innerText || "").trim();
    const wlNum = parseFloat((cells[5] && cells[5].innerText || "").trim());
    const warnNum = parseFloat((cells[6] && cells[6].innerText || "").trim());
    const dangNum = parseFloat((cells[7] && cells[7].innerText || "").trim());
    const trendText = (cells[8] && cells[8].innerText || "").trim().toUpperCase();
    const statusText = (cells[9] && cells[9].innerText || "").trim().toUpperCase();

    const diffObj = calculateWaterLevelDifferences(isNaN(wlNum) ? null : wlNum, isNaN(warnNum) ? null : warnNum, isNaN(dangNum) ? null : dangNum);

    return {
      element: tr, originalIndex: index, sn: parseInt(snText, 10) || index,
      basin: basinText, stationIndex: indexText, stationName, stationTime, district: districtText,
      waterLevel: isNaN(wlNum) ? null : wlNum, diffWarning: diffObj.diffWarning, diffObj,
      trend: trendText, status: statusText
    };
  }

  function enhanceRiverWatchTable(table) {
    if (!table || riverWatchState.isSorting) return;
    const tbody = table.querySelector("tbody.watch_table_tbody") || table.querySelector("tbody");
    if (!tbody) return;
    const rawRows = Array.from(tbody.querySelectorAll("tr.watch_table_tr, tr"));
    if (rawRows.length === 0) return;

    const rowDataList = [];
    rawRows.forEach((tr, idx) => {
      let data = riverWatchState.originalOrderMap.get(tr);
      if (!data) {
        data = extractRiverWatchRowData(tr, idx);
        if (data) riverWatchState.originalOrderMap.set(tr, data);
      }
      if (data) rowDataList.push(data);
    });

    if (rowDataList.length === 0) return;
    riverWatchState.cachedRows = rowDataList;

    // Inject custom interactive headers / toolbar if desired. For brevity in this fix, 
    // we keep the core styling logic but don't force auto-click RISING anymore.
    // Instead we let the user manually play with the table.
    
    // Quick apply styling to cells
    rowDataList.forEach(row => {
      const cells = row.element.querySelectorAll("td");
      if (cells[8] && !cells[8].getAttribute("data-dhm-trend-styled")) {
        cells[8].setAttribute("data-dhm-trend-styled", "true");
        cells[8].innerHTML = getTrendBadgeHTML(row.trend);
      }
      if (cells[9] && !cells[9].getAttribute("data-dhm-status-styled")) {
        cells[9].setAttribute("data-dhm-status-styled", "true");
        cells[9].innerHTML = formatStatusWithDifferences(row.status, row.diffObj);
      }
    });
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
      
      if (remainingSec % 60 === 0) syncAllData();
    }, 1000);
  }

  function updateAutoRefreshUI(timeStr) {
    const widgetTime = document.getElementById("dhm-widget-timer-time");
    if (widgetTime) widgetTime.textContent = timeStr;
  }

  function executePageRefresh() {
    console.log("[DHM Extension] Auto-refresh triggered. Updating data without page reload...");
    if (state.autoNavigateRiverWatch) {
      const hash = window.location.hash || "";
      if (!hash.includes("compare")) {
        const compareLink = document.getElementById("dhm-compare-tab-link");
        if (compareLink) {
          compareLink.click();
        } else {
          window.location.hash = "#/compare";
        }
      }
    }
    syncAllData();
    state.nextRefreshTimestamp = Date.now() + state.autoRefreshInterval * 1000;
  }

  // REPLACES ensureRiverWatchAndRising
  function ensureComparePageLoaded(attempt = 0) {
    if (!state.extensionEnabled) return;
    if (attempt > 60) return; // 12 seconds max

    const hash = window.location.hash || "";
    if (state.autoNavigateRiverWatch && !hash.includes("compare")) {
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

  function setupLiveClock() {
    state.clockTimer = setInterval(() => {
      state.nepalTime = new Date();
      const clockEl = document.getElementById("dw-live-clock");
      if (clockEl) clockEl.textContent = formatNepalClock(state.nepalTime).timeStr;
    }, 1000);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\x27/g, "&#039;");
  }

  /* ==========================================================================
     FLOATING WEBPAGE EXTENSION TOGGLE WIDGET
     ========================================================================== */
  function injectFloatingToggleWidget() {
    if (document.getElementById("dhm-floating-toggle-widget")) return;
    const widget = document.createElement("div");
    widget.id = "dhm-floating-toggle-widget";
    widget.title = "DHM Data Watch & Compare Extension (Click to toggle ON/OFF)";
    widget.innerHTML = `
      <div class="dhm-widget-brand"><span>🌊</span><span>DHM Watch</span></div>
      <div class="dhm-widget-timer-chip" id="dhm-widget-timer-chip" title="Auto-refresh data every 5 minutes (no page reload)">
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
    const tabBtn = document.getElementById("dhm-data-watch-tab-link");
    if (tabBtn) tabBtn.remove();
    const cmpBtn = document.getElementById("dhm-compare-tab-link");
    if (cmpBtn) cmpBtn.remove();

    if (window.location.hash.startsWith("#/data_watch") || window.location.hash.startsWith("#/compare")) {
      deactivateDataWatchView();
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
        autoNavigateRiverWatch: true // True implies auto-loading the Compare route now
      }, (res) => {
        state.extensionEnabled = res.extensionEnabled !== false;
        state.autoRefreshInterval = typeof res.autoRefreshInterval === "number" ? res.autoRefreshInterval : 300;
        state.autoRefreshEnabled = res.autoRefreshEnabled !== false;
        state.autoNavigateRiverWatch = res.autoNavigateRiverWatch !== false;

        injectFloatingToggleWidget();

        if (state.extensionEnabled) {
          enableExtensionFeatures();
          setupLiveClock();
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
      setupLiveClock();
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
      if (hash.startsWith("#/data_watch") && !state.isDataWatchActive) activateDataWatchView();
      else if (hash.startsWith("#/compare") && !state.isCompareActive) activateCompareView();
      else if (hash.startsWith("#/river_watch") || hash.includes("river_watch") || document.querySelector("table.watch_table")) {
        if (!riverWatchState.isSorting) {
          clearTimeout(riverWatchState.reapplyTimer);
          riverWatchState.reapplyTimer = setTimeout(checkAndEnhanceRiverWatch, 150);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();