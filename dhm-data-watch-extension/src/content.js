/**
 * DHM Hydrology - Data Watch & River Watch Telemetry Chrome Extension
 * Content Script (Manifest V3)
 * 
 * Features:
 * 1. Data Watch Tab: Monitors & sorts stations missing 10-minute telemetry in Nepal Time (NPT, UTC+5:45).
 * 2. River Watch Table Enhancer:
 *    - Full column-heading sorting on all tables under River Watch (#/river_watch).
 *    - Dedicated Trend Tab / Sorter: Sort by Rising First (📈), Falling First (📉), or Steady First (➡️).
 *    - Water Level vs Warning & Danger Level Differences:
 *      * Below Warning Level: Shows difference to Warning Level AND difference to Danger Level.
 *      * Above Warning Level: Shows difference to Danger Level ONLY (e.g. gap to danger or amount above danger).
 *      * Dedicated Sorting: Sort by difference between current water level and warning level (closest to flood first).
 *    - Interactive click-to-sort on every table column header with visual sort indicators.
 *    - Quick Trend Filter Pills (All, Rising, Falling, Steady, Alerts) with real-time station counts.
 *    - Real-time station search, CSV export, and sequential S.N renumbering.
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
    statusFilter: "delayed", // "delayed", "critical", "offline", "normal", "rising", "falling", "steady", "all"
    basinFilter: "all",
    districtFilter: "all",
    typeFilter: "all",
    sortBy: "delay_desc",
    autoRefreshInterval: 60,
    autoRefreshTimer: null,
    clockTimer: null,
    isDataWatchActive: false,
    socketSid: null,
    extensionEnabled: true
  };

  /* ==========================================================================
     RIVER WATCH TABLE SORTER & FILTER STATE
     ========================================================================== */
  const riverWatchState = {
    sortKey: "dhm_default", // "diff_warning_desc", "diff_warning_asc", "trend_rising", "trend_falling", "trend_steady", "waterlevel_desc", "waterlevel_asc", "warning_desc", "danger_desc", "status_desc", "station_asc", "station_desc", "basin_asc", "district_asc", "index_asc", "sn_asc", "dhm_default"
    activeColIndex: null,
    sortDirection: "asc",
    trendFilter: "all",     // "all", "RISING", "FALLING", "STEADY", "ALERT", "NEAR_WARNING"
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
  /**
   * Calculates difference between Water Level, Warning Level, and Danger Level.
   * - diffWarning = waterLevel - warningLevel (negative means below warning, positive means above)
   * - diffDanger  = waterLevel - dangerLevel  (negative means below danger, positive means above)
   */
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

    return {
      hasWL,
      hasWarn,
      hasDang,
      diffWarning,
      diffDanger,
      isAboveWarning,
      isAboveDanger
    };
  }

  /**
   * Formats HTML for the Status column showing:
   * 1. If below warning level: shows difference to Warning Level AND difference to Danger Level.
   * 2. If crossed warning level: shows difference to Danger Level ONLY.
   */
  function formatStatusWithDifferences(statusText, diffObj) {
    if (!diffObj || !diffObj.hasWL || (!diffObj.hasWarn && !diffObj.hasDang)) {
      return `<div class="dhm-status-plain">${escapeHtml(statusText || "NORMAL")}</div>`;
    }

    const { hasWarn, hasDang, diffWarning, diffDanger, isAboveWarning, isAboveDanger } = diffObj;
    let badgesHtml = "";

    if (isAboveWarning) {
      // Crossed Warning Level: show difference between water level and danger level ONLY
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
      // Below Warning Level: show BOTH difference to Warning Level and difference to Danger Level
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

  /* ==========================================================================
     API & SOCKET TELEMETRY SYNC
     ========================================================================== */
  async function fetchStationsCatalog() {
    try {
      const res = await fetch("https://hydrology.gov.np/gss/api/station");
      if (res.ok) {
        state.stationsCatalog = await res.json();
      }
    } catch (err) {
      console.warn("[DHM Data Watch] Failed to fetch station catalog:", err);
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
            const postData = payload.length + ":" + payload;
            return fetch(baseUrl + "/gss/socket.io/?EIO=3&transport=polling&sid=" + sid + "&t=" + Date.now(), {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=UTF-8" },
              body: postData
            });
          };

          Promise.all([
            sendReq("river_test"),
            sendReq("rainfall_watch"),
            sendReq("river_discharge")
          ]).then(() => {
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
          console.warn("[DHM Data Watch] Socket connection error:", err);
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
          const eventName = parsed[0];
          const eventData = parsed[1];
          if (eventName === "river_test" || eventName === "river_watch") {
            state.riverData = Array.isArray(eventData) ? eventData : [];
          } else if (eventName === "rainfall_watch") {
            state.rainfallData = Array.isArray(eventData) ? eventData : [];
          }
        } catch (e) {
          console.error("[DHM Data Watch] Error parsing packet:", e);
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
        id: st.id,
        identifier: st.identifier || "",
        name: st.name || "Unnamed Station",
        nepaliName: nepaliName,
        stationIndex: stationIndex || st.description || "",
        basin: basin || st.folder_name || "Other",
        district: district || "Unknown",
        latitude: st.latitude,
        longitude: st.longitude,
        elevation: st.elevation,
        waterLevel: null,
        waterLevelTime: null,
        waterLevelTrend: null,
        waterLevelStatus: null,
        warningLevel: null,
        dangerLevel: null,
        diffWarning: null,
        diffDanger: null,
        diffInfo: null,
        rainfall: null,
        rainfallTime: null,
        rainfallStatus: null,
        latestTime: null,
        delayMinutes: Infinity,
        type: "Unknown",
        isReportingOnTime: false
      });
    });

    state.riverData.forEach(r => {
      let st = stationMap.get(r.id);
      if (!st) {
        st = {
          id: r.id,
          identifier: r.identifier || "",
          name: r.name || "Station " + r.id,
          nepaliName: "",
          stationIndex: r.stationIndex || "",
          basin: r.basin || "Other",
          district: r.district || "Unknown",
          latitude: r.latitude,
          longitude: r.longitude,
          elevation: r.elevation,
          waterLevel: null,
          waterLevelTime: null,
          waterLevelTrend: null,
          waterLevelStatus: null,
          warningLevel: null,
          dangerLevel: null,
          diffWarning: null,
          diffDanger: null,
          diffInfo: null,
          rainfall: null,
          rainfallTime: null,
          rainfallStatus: null,
          latestTime: null,
          delayMinutes: Infinity,
          type: "Water Level",
          isReportingOnTime: false
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
          id: rf.id,
          identifier: rf.identifier || "",
          name: rf.name || "Station " + rf.id,
          nepaliName: "",
          stationIndex: rf.stationIndex || "",
          basin: rf.basin || "Other",
          district: rf.district || "Unknown",
          latitude: rf.latitude,
          longitude: rf.longitude,
          elevation: rf.elevation,
          waterLevel: null,
          waterLevelTime: null,
          waterLevelTrend: null,
          waterLevelStatus: null,
          warningLevel: null,
          dangerLevel: null,
          diffWarning: null,
          diffDanger: null,
          diffInfo: null,
          rainfall: null,
          rainfallTime: null,
          rainfallStatus: null,
          latestTime: null,
          delayMinutes: Infinity,
          type: "Rainfall",
          isReportingOnTime: false
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
        if (latestEpoch > 0) {
          st.latestTime = new Date(latestEpoch).toISOString();
        }
      }

      st.delayMinutes = calculateDelayMinutes(st.latestTime);
      st.isReportingOnTime = st.delayMinutes <= 10;
      st.delayInfo = formatDelayDuration(st.delayMinutes);

      // Compute water level differences
      st.diffInfo = calculateWaterLevelDifferences(st.waterLevel, st.warningLevel, st.dangerLevel);
      st.diffWarning = st.diffInfo.diffWarning;
      st.diffDanger = st.diffInfo.diffDanger;

      return st;
    });

    state.stations = combined.filter(st => !st.name.includes("-DELETE") && !st.name.includes("_delete"));
    state.lastSyncTime = new Date();
    state.loading = false;
  }

  function extractFallbackTelemetryFromDOM() {
    const table = document.querySelector("table.watch_table");
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll("tbody tr"));
    const fallbackStations = [];

    rows.forEach((tr, idx) => {
      const data = extractRiverWatchRowData(tr, idx);
      if (!data) return;

      const diffObj = data.diffObj || calculateWaterLevelDifferences(data.waterLevel, data.warningLevel, data.dangerLevel);

      fallbackStations.push({
        id: "dom_" + (data.stationIndex || idx),
        identifier: data.stationIndex || String(idx),
        name: data.stationName || "Station " + (idx + 1),
        nepaliName: "",
        stationIndex: data.stationIndex || "",
        basin: data.basin || "Other",
        district: data.district || "Unknown",
        latitude: null,
        longitude: null,
        elevation: null,
        waterLevel: data.waterLevel,
        waterLevelTime: data.stationTime || null,
        waterLevelTrend: data.trend || "",
        waterLevelStatus: data.status || "",
        warningLevel: data.warningLevel,
        dangerLevel: data.dangerLevel,
        diffWarning: diffObj.diffWarning,
        diffDanger: diffObj.diffDanger,
        diffInfo: diffObj,
        rainfall: null,
        rainfallTime: null,
        rainfallStatus: null,
        latestTime: data.stationTime ? new Date(data.stationTime).toISOString() : null,
        delayMinutes: calculateDelayMinutes(data.stationTime),
        type: "Water Level",
        isReportingOnTime: calculateDelayMinutes(data.stationTime) <= 10,
        delayInfo: formatDelayDuration(calculateDelayMinutes(data.stationTime))
      });
    });

    return fallbackStations;
  }

  async function syncAllData() {
    state.loading = true;
    if (state.isDataWatchActive) renderDashboardContent();
    if (state.stationsCatalog.length === 0) {
      await fetchStationsCatalog();
    }
    await fetchSocketData();
    processStationTelemetry();

    if (state.stations.length === 0) {
      const domFallback = extractFallbackTelemetryFromDOM();
      if (domFallback.length > 0) {
        state.stations = domFallback;
        state.loading = false;
        state.lastSyncTime = new Date();
      }
    }

    if (state.isDataWatchActive) renderDashboardContent();
  }

  /* ==========================================================================
     DATA WATCH TAB FILTERING & SORTING (INCLUDING TREND & WARNING DIFF)
     ========================================================================== */
  function getFilteredAndSortedStations() {
    let list = [...state.stations];

    if (state.statusFilter === "delayed") {
      list = list.filter(st => st.delayMinutes > 10);
    } else if (state.statusFilter === "critical") {
      list = list.filter(st => st.delayMinutes > 60 && st.delayMinutes < Infinity);
    } else if (state.statusFilter === "offline") {
      list = list.filter(st => st.delayMinutes > 1440 || st.delayMinutes === Infinity);
    } else if (state.statusFilter === "normal") {
      list = list.filter(st => st.delayMinutes <= 10);
    } else if (state.statusFilter === "rising") {
      list = list.filter(st => (st.waterLevelTrend || "").toUpperCase() === "RISING");
    } else if (state.statusFilter === "falling") {
      list = list.filter(st => (st.waterLevelTrend || "").toUpperCase() === "FALLING");
    } else if (state.statusFilter === "steady") {
      list = list.filter(st => (st.waterLevelTrend || "").toUpperCase() === "STEADY");
    }

    if (state.basinFilter !== "all") {
      list = list.filter(st => (st.basin || "").toLowerCase() === state.basinFilter.toLowerCase());
    }

    if (state.districtFilter !== "all") {
      list = list.filter(st => (st.district || "").toLowerCase() === state.districtFilter.toLowerCase());
    }

    if (state.typeFilter !== "all") {
      if (state.typeFilter === "river") {
        list = list.filter(st => st.waterLevel !== null || st.type === "Water Level");
      } else if (state.typeFilter === "rainfall") {
        list = list.filter(st => st.rainfall !== null || st.type === "Rainfall");
      } else if (state.typeFilter === "both") {
        list = list.filter(st => st.type.includes("Both"));
      }
    }

    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase().trim();
      list = list.filter(st => 
        (st.name || "").toLowerCase().includes(q) ||
        (st.nepaliName || "").toLowerCase().includes(q) ||
        (st.stationIndex || "").toLowerCase().includes(q) ||
        (st.basin || "").toLowerCase().includes(q) ||
        (st.district || "").toLowerCase().includes(q) ||
        (st.waterLevelTrend || "").toLowerCase().includes(q) ||
        String(st.id).includes(q)
      );
    }

    list.sort((a, b) => {
      switch (state.sortBy) {
        case "diff_warning_desc": {
          const diffA = a.diffWarning !== null && a.diffWarning !== undefined ? a.diffWarning : -Infinity;
          const diffB = b.diffWarning !== null && b.diffWarning !== undefined ? b.diffWarning : -Infinity;
          if (diffA === -Infinity && diffB === -Infinity) return 0;
          if (diffA === -Infinity) return 1;
          if (diffB === -Infinity) return -1;
          return diffB - diffA;
        }
        case "diff_warning_asc": {
          const diffA = a.diffWarning !== null && a.diffWarning !== undefined ? a.diffWarning : Infinity;
          const diffB = b.diffWarning !== null && b.diffWarning !== undefined ? b.diffWarning : Infinity;
          if (diffA === Infinity && diffB === Infinity) return 0;
          if (diffA === Infinity) return 1;
          if (diffB === Infinity) return -1;
          return diffA - diffB;
        }
        case "delay_desc":
          if (a.delayMinutes === b.delayMinutes) return (a.name || "").localeCompare(b.name || "");
          return b.delayMinutes - a.delayMinutes;
        case "delay_asc":
          if (a.delayMinutes === b.delayMinutes) return (a.name || "").localeCompare(b.name || "");
          return a.delayMinutes - b.delayMinutes;
        case "trend_rising": {
          const rank = (t) => t === "RISING" ? 1 : t === "FALLING" ? 2 : t === "STEADY" ? 3 : 4;
          const rA = rank((a.waterLevelTrend || "").toUpperCase());
          const rB = rank((b.waterLevelTrend || "").toUpperCase());
          if (rA !== rB) return rA - rB;
          return (b.waterLevel || 0) - (a.waterLevel || 0);
        }
        case "trend_falling": {
          const rank = (t) => t === "FALLING" ? 1 : t === "RISING" ? 2 : t === "STEADY" ? 3 : 4;
          const rA = rank((a.waterLevelTrend || "").toUpperCase());
          const rB = rank((b.waterLevelTrend || "").toUpperCase());
          if (rA !== rB) return rA - rB;
          return (b.waterLevel || 0) - (a.waterLevel || 0);
        }
        case "trend_steady": {
          const rank = (t) => t === "STEADY" ? 1 : t === "RISING" ? 2 : t === "FALLING" ? 3 : 4;
          const rA = rank((a.waterLevelTrend || "").toUpperCase());
          const rB = rank((b.waterLevelTrend || "").toUpperCase());
          if (rA !== rB) return rA - rB;
          return (b.waterLevel || 0) - (a.waterLevel || 0);
        }
        case "waterlevel_desc": {
          const valA = parseFloat(a.waterLevel);
          const valB = parseFloat(b.waterLevel);
          if (isNaN(valA) && isNaN(valB)) return 0;
          if (isNaN(valA)) return 1;
          if (isNaN(valB)) return -1;
          return valB - valA;
        }
        case "waterlevel_asc": {
          const valA = parseFloat(a.waterLevel);
          const valB = parseFloat(b.waterLevel);
          if (isNaN(valA) && isNaN(valB)) return 0;
          if (isNaN(valA)) return 1;
          if (isNaN(valB)) return -1;
          return valA - valB;
        }
        case "time_desc": {
          const timeA = a.latestTime ? new Date(a.latestTime).getTime() : 0;
          const timeB = b.latestTime ? new Date(b.latestTime).getTime() : 0;
          return timeB - timeA;
        }
        case "time_asc": {
          const tA = a.latestTime ? new Date(a.latestTime).getTime() : 0;
          const tB = b.latestTime ? new Date(b.latestTime).getTime() : 0;
          return tA - tB;
        }
        case "name_asc":
          return (a.name || "").localeCompare(b.name || "");
        case "name_desc":
          return (b.name || "").localeCompare(a.name || "");
        case "basin_asc":
          return (a.basin || "").localeCompare(b.basin || "");
        case "district_asc":
          return (a.district || "").localeCompare(b.district || "");
        default:
          return b.delayMinutes - a.delayMinutes;
      }
    });

    return list;
  }

  /* ==========================================================================
     DATA WATCH TAB UI & DASHBOARD
     ========================================================================== */
  function injectDataWatchTab() {
    const tabsContainer = document.querySelector(".tabs");
    if (!tabsContainer) return;

    let tabWrapper = document.getElementById("dhm-data-watch-tab-link");

    // If tab element exists but was detached from .tabs by React re-render, re-append it
    if (tabWrapper && tabWrapper.parentElement !== tabsContainer) {
      tabWrapper.remove();
      tabWrapper = null;
    }

    if (!tabWrapper) {
      tabWrapper = document.createElement("a");
      tabWrapper.href = "#/data_watch";
      tabWrapper.id = "dhm-data-watch-tab-link";
      tabWrapper.style.textDecoration = "none";

      tabWrapper.innerHTML = `
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

      tabWrapper.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "#/data_watch";
        activateDataWatchView();
      });

      const rainfallTab = tabsContainer.querySelector("a[href*=\"rainfall_watch\"]");
      if (rainfallTab && rainfallTab.nextSibling) {
        tabsContainer.insertBefore(tabWrapper, rainfallTab.nextSibling);
      } else {
        tabsContainer.appendChild(tabWrapper);
      }
    }
  }

  function handleHashRouting() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#/data_watch")) {
      activateDataWatchView();
    } else {
      deactivateDataWatchView();
      if (hash.startsWith("#/river_watch") || hash.includes("river_watch")) {
        setTimeout(checkAndEnhanceRiverWatch, 200);
      }
    }
  }

  function activateDataWatchView() {
    state.isDataWatchActive = true;
    document.title = "Hydrology - Data Watch (10-Min Telemetry Monitor)";

    const dataWatchBtn = document.getElementById("dhm-data-watch-btn-container");
    if (dataWatchBtn) {
      dataWatchBtn.classList.add("active");
    }

    document.querySelectorAll(".tabs > a:not(#dhm-data-watch-tab-link) div[style*=\"background-color: rgb(15, 114, 169)\"]").forEach(el => {
      el.style.backgroundColor = "rgb(255, 255, 255)";
      const span = el.querySelector("span");
      if (span) span.style.color = "rgba(0, 0, 0, 0.87)";
    });

    let mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (!mainEl) return;

    Array.from(mainEl.children).forEach(child => {
      if (child.id !== "dhm-data-watch-root") {
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

    if (state.stations.length === 0) {
      syncAllData();
    }
  }

  function deactivateDataWatchView() {
    state.isDataWatchActive = false;
    const dataWatchBtn = document.getElementById("dhm-data-watch-btn-container");
    if (dataWatchBtn) {
      dataWatchBtn.classList.remove("active");
    }

    const root = document.getElementById("dhm-data-watch-root");
    if (root) {
      root.style.display = "none";
    }

    const mainEl = document.querySelector("main") || document.querySelector(".myContainer");
    if (mainEl) {
      Array.from(mainEl.children).forEach(child => {
        if (child.id !== "dhm-data-watch-root") {
          child.style.display = "";
        }
      });
    }
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
    const risingCount = state.stations.filter(s => (s.waterLevelTrend || "").toUpperCase() === "RISING").length;
    const fallingCount = state.stations.filter(s => (s.waterLevelTrend || "").toUpperCase() === "FALLING").length;
    const steadyCount = state.stations.filter(s => (s.waterLevelTrend || "").toUpperCase() === "STEADY").length;
    const healthRate = totalCount > 0 ? Math.round((normalCount / totalCount) * 100) : 0;

    const { timeStr, dateStr } = formatNepalClock(state.nepalTime);
    const basins = Array.from(new Set(state.stations.map(s => s.basin).filter(Boolean))).sort();
    const districts = Array.from(new Set(state.stations.map(s => s.district).filter(Boolean))).sort();

    root.innerHTML = `
      <div class="dw-header-panel">
        <div class="dw-title-group">
          <h2>
            <span>📡 DHM Data Watch — 10-Minute Telemetry Monitor</span>
            <span class="dw-nepal-badge">Nepal Time Zone (UTC+5:45)</span>
          </h2>
          <p class="dw-subtitle">
            Real-time surveillance of hydrological & meteorological stations missing periodic 10-minute transmissions, with Warning/Danger Level difference analysis.
          </p>
        </div>

        <div class="dw-header-controls">
          <div class="dw-live-clock-card" title="Official Nepal Standard Time (NPT)">
            <span class="dw-clock-label">Nepal Standard Time</span>
            <span class="dw-clock-time" id="dw-live-clock">${timeStr}</span>
            <span class="dw-clock-date">${dateStr}</span>
          </div>

          <button class="dw-btn dw-btn-primary" id="dw-refresh-btn" title="Fetch latest telemetry stream">
            <span>🔄 Refresh</span>
          </button>

          <button class="dw-btn dw-btn-success" id="dw-export-csv-btn" title="Download delayed stations list as CSV">
            <span>📥 Export CSV</span>
          </button>

          <a href="#/river_watch" class="dw-btn dw-btn-rw-link" title="Jump to River Watch tab with Trend & Warning Diff Sorting">
            <span>🌊 River Watch Sorter ↗</span>
          </a>

          <div class="dw-filter-item">
            <span class="dw-filter-label">Auto:</span>
            <select class="dw-select" id="dw-auto-refresh-select">
              <option value="30" ${state.autoRefreshInterval === 30 ? "selected" : ""}>30s</option>
              <option value="60" ${state.autoRefreshInterval === 60 ? "selected" : ""}>1 min</option>
              <option value="120" ${state.autoRefreshInterval === 120 ? "selected" : ""}>2 mins</option>
              <option value="300" ${state.autoRefreshInterval === 300 ? "selected" : ""}>5 mins</option>
              <option value="0" ${state.autoRefreshInterval === 0 ? "selected" : ""}>Off</option>
            </select>
          </div>
        </div>
      </div>

      <div class="dw-kpi-grid">
        <div class="dw-kpi-card kpi-total">
          <div class="dw-kpi-header"><span class="dw-kpi-title">Total Stations</span><span class="dw-kpi-icon">📊</span></div>
          <div class="dw-kpi-value">${totalCount}</div>
          <div class="dw-kpi-sub">Monitored Nationwide</div>
        </div>
        <div class="dw-kpi-card kpi-delayed">
          <div class="dw-kpi-header"><span class="dw-kpi-title">Delayed (>10 min)</span><span class="dw-kpi-icon">⚠️</span></div>
          <div class="dw-kpi-value">${delayedCount}</div>
          <div class="dw-kpi-sub">${totalCount > 0 ? Math.round((delayedCount / totalCount) * 100) : 0}% of all stations</div>
        </div>
        <div class="dw-kpi-card kpi-critical">
          <div class="dw-kpi-header"><span class="dw-kpi-title">Critical / Offline</span><span class="dw-kpi-icon">🚨</span></div>
          <div class="dw-kpi-value">${criticalCount + offlineCount}</div>
          <div class="dw-kpi-sub">${criticalCount} >1h | ${offlineCount} >24h/No data</div>
        </div>
        <div class="dw-kpi-card kpi-normal">
          <div class="dw-kpi-header"><span class="dw-kpi-title">On-Time (≤10 min)</span><span class="dw-kpi-icon">✅</span></div>
          <div class="dw-kpi-value">${normalCount}</div>
          <div class="dw-kpi-sub">Transmitting normally</div>
        </div>
        <div class="dw-kpi-card kpi-rate">
          <div class="dw-kpi-header"><span class="dw-kpi-title">Health Score</span><span class="dw-kpi-icon">⚡</span></div>
          <div class="dw-kpi-value">${healthRate}%</div>
          <div class="dw-kpi-sub">On-time telemetry rate</div>
        </div>
      </div>

      <div class="dw-filter-panel">
        <div class="dw-status-pills">
          <div class="dw-pill ${state.statusFilter === "delayed" ? "active pill-delayed" : ""}" data-status="delayed" title="Stations missing standard 10-minute interval data">
            <span>⚠️ Delayed (>10m)</span>
            <span class="dw-pill-count">${delayedCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "critical" ? "active pill-critical" : ""}" data-status="critical">
            <span>🚨 Critical (>1h)</span>
            <span class="dw-pill-count">${criticalCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "offline" ? "active" : ""}" data-status="offline">
            <span>⚪ Offline (>24h)</span>
            <span class="dw-pill-count">${offlineCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "normal" ? "active pill-normal" : ""}" data-status="normal">
            <span>✅ On-Time (≤10m)</span>
            <span class="dw-pill-count">${normalCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "rising" ? "active pill-rising" : ""}" data-status="rising" title="Filter stations with Rising Water Level">
            <span>📈 Rising</span>
            <span class="dw-pill-count">${risingCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "falling" ? "active pill-falling" : ""}" data-status="falling" title="Filter stations with Falling Water Level">
            <span>📉 Falling</span>
            <span class="dw-pill-count">${fallingCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "steady" ? "active pill-steady" : ""}" data-status="steady" title="Filter stations with Steady Water Level">
            <span>➡️ Steady</span>
            <span class="dw-pill-count">${steadyCount}</span>
          </div>
          <div class="dw-pill ${state.statusFilter === "all" ? "active" : ""}" data-status="all">
            <span>All Stations</span>
            <span class="dw-pill-count">${totalCount}</span>
          </div>
        </div>

        <div class="dw-filter-grid">
          <div class="dw-search-box">
            <input type="text" id="dw-search-input" placeholder="🔍 Search station name, nepali name, index, ID, trend..." value="${escapeHtml(state.searchQuery)}">
            ${state.searchQuery ? "<span class=\"dw-search-clear\" id=\"dw-search-clear\">&times;</span>" : ""}
          </div>
          <div class="dw-filter-item">
            <span class="dw-filter-label">Basin:</span>
            <select class="dw-select" id="dw-basin-select">
              <option value="all">All Basins</option>
              ${basins.map(b => `<option value="${escapeHtml(b)}" ${state.basinFilter.toLowerCase() === b.toLowerCase() ? "selected" : ""}>${escapeHtml(b)}</option>`).join("")}
            </select>
          </div>
          <div class="dw-filter-item">
            <span class="dw-filter-label">District:</span>
            <select class="dw-select" id="dw-district-select">
              <option value="all">All Districts</option>
              ${districts.map(d => `<option value="${escapeHtml(d)}" ${state.districtFilter.toLowerCase() === d.toLowerCase() ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}
            </select>
          </div>
          <div class="dw-filter-item">
            <span class="dw-filter-label">Type:</span>
            <select class="dw-select" id="dw-type-select">
              <option value="all" ${state.typeFilter === "all" ? "selected" : ""}>All Types</option>
              <option value="river" ${state.typeFilter === "river" ? "selected" : ""}>Water Level (River)</option>
              <option value="rainfall" ${state.typeFilter === "rainfall" ? "selected" : ""}>Rainfall</option>
              <option value="both" ${state.typeFilter === "both" ? "selected" : ""}>Combined (WL + Rain)</option>
            </select>
          </div>
          <div class="dw-filter-item">
            <span class="dw-filter-label">Sort:</span>
            <select class="dw-select" id="dw-sort-select">
              <option value="delay_desc" ${state.sortBy === "delay_desc" ? "selected" : ""}>⏳ Longest Delay First (Missing 10m)</option>
              <option value="delay_asc" ${state.sortBy === "delay_asc" ? "selected" : ""}>⚡ Shortest Delay First</option>
              <option value="diff_warning_desc" ${state.sortBy === "diff_warning_desc" ? "selected" : ""}>⚠️ Warning Level Diff (Closest to Flood First)</option>
              <option value="diff_warning_asc" ${state.sortBy === "diff_warning_asc" ? "selected" : ""}>🛡️ Warning Level Diff (Safest / Farthest Below)</option>
              <option value="trend_rising" ${state.sortBy === "trend_rising" ? "selected" : ""}>📈 Trend: Rising First (Flood Alert)</option>
              <option value="trend_falling" ${state.sortBy === "trend_falling" ? "selected" : ""}>📉 Trend: Falling First (Receding)</option>
              <option value="trend_steady" ${state.sortBy === "trend_steady" ? "selected" : ""}>➡️ Trend: Steady First</option>
              <option value="waterlevel_desc" ${state.sortBy === "waterlevel_desc" ? "selected" : ""}>🌊 Water Level (Highest First)</option>
              <option value="waterlevel_asc" ${state.sortBy === "waterlevel_asc" ? "selected" : ""}>🌊 Water Level (Lowest First)</option>
              <option value="time_desc" ${state.sortBy === "time_desc" ? "selected" : ""}>🕒 Last Updated (Newest)</option>
              <option value="time_asc" ${state.sortBy === "time_asc" ? "selected" : ""}>🕒 Last Updated (Oldest)</option>
              <option value="name_asc" ${state.sortBy === "name_asc" ? "selected" : ""}>🔤 Station Name (A-Z)</option>
              <option value="basin_asc" ${state.sortBy === "basin_asc" ? "selected" : ""}>🌊 Basin Name (A-Z)</option>
              <option value="district_asc" ${state.sortBy === "district_asc" ? "selected" : ""}>📍 District (A-Z)</option>
            </select>
          </div>
        </div>
      </div>

      <div class="dw-table-card">
        <div class="dw-table-header">
          <div>
            <span class="dw-table-title">Stations Telemetry Stream</span>
            <span class="dw-table-sub"> — Showing ${filteredStations.length} of ${totalCount} stations</span>
          </div>
          <div class="dw-live-indicator">
            <span class="dw-live-dot"></span>
            <span>Live Sync ${state.lastSyncTime ? formatNepalClock(state.lastSyncTime).timeStr : "Connecting..."}</span>
          </div>
        </div>
        <div class="dw-table-responsive">
          ${state.loading && state.stations.length === 0 ? `
            <div class="dw-loading-state">
              <div class="dw-spinner"></div>
              <div style="font-weight:600; color:var(--dhm-primary);">Connecting to DHM Real-time Telemetry...</div>
              <div style="font-size:12px; color:#64748b; margin-top:4px;">Fetching live water level and rainfall streams in Nepal Time Zone</div>
            </div>
          ` : (filteredStations.length === 0 ? `
            <div class="dw-empty-state">
              <div class="dw-empty-icon">🎯</div>
              <div class="dw-empty-text">No stations match the selected filters</div>
              <p style="font-size:12px; margin-top:6px;">Try adjusting your search query, status tab, or basin filter.</p>
            </div>
          ` : `
            <table class="dw-table">
              <thead>
                <tr>
                  <th style="width:40px;">#</th>
                  <th data-sort="delay_desc">10-Min Status <span class="sort-icon">⇅</span></th>
                  <th data-sort="name_asc">Station Name & Nepali <span class="sort-icon">⇅</span></th>
                  <th data-sort="basin_asc">Basin / District <span class="sort-icon">⇅</span></th>
                  <th>Index / ID</th>
                  <th>Type</th>
                  <th data-sort="trend_rising">Trend & Observation <span class="sort-icon">⇅</span></th>
                  <th data-sort="diff_warning_desc">Level Status & Warning Diff <span class="sort-icon">⇅</span></th>
                  <th data-sort="time_asc">Last Received Time (Nepal Time) <span class="sort-icon">⇅</span></th>
                  <th data-sort="delay_desc">Delay Duration <span class="sort-icon">⇅</span></th>
                  <th style="text-align:center;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredStations.map((st, idx) => renderStationRow(st, idx + 1)).join("")}
              </tbody>
            </table>
          `)}
        </div>
      </div>
    `;

    attachDashboardEvents();
  }

  function renderStationRow(st, index) {
    const delay = st.delayInfo;
    const typeClass = st.type.includes("Both") ? "dw-type-both" : st.type.includes("Water") ? "dw-type-river" : "dw-type-rain";
    let obsDisplay = "<span style=\"color:#94a3b8;\">-</span>";
    
    if (st.waterLevel !== null && st.waterLevel !== undefined) {
      const trend = (st.waterLevelTrend || "").toUpperCase();
      let trendBadge = "";
      if (trend === "RISING") {
        trendBadge = `<span class="dhm-trend-badge dhm-trend-rising" title="Water Level is RISING">RISING ↑</span>`;
      } else if (trend === "FALLING") {
        trendBadge = `<span class="dhm-trend-badge dhm-trend-falling" title="Water Level is FALLING">FALLING ↓</span>`;
      } else if (trend === "STEADY") {
        trendBadge = `<span class="dhm-trend-badge dhm-trend-steady" title="Water Level is STEADY">STEADY →</span>`;
      }
      obsDisplay = `
        <div style="display:flex; flex-direction:column; gap:3px;">
          <div><b>${st.waterLevel} m</b></div>
          <div>${trendBadge}</div>
        </div>
      `;
    } else if (st.rainfall !== null && st.rainfall !== undefined) {
      obsDisplay = `<b>${st.rainfall} mm</b> <span style="font-size:10px; color:#059669;">Rain</span>`;
    }

    // Status & Warning Difference rendering
    const statusDiffHtml = formatStatusWithDifferences(st.waterLevelStatus, st.diffInfo);

    return `
      <tr>
        <td style="color:#94a3b8; font-weight:500;">${index}</td>
        <td>
          <span class="dw-badge ${delay.badgeClass}">
            <span class="dw-badge-dot"></span>
            <span>${delay.level === "normal" ? "🟢 ≤10m On-Time" : delay.level === "offline" ? "⚪ Offline" : "⚠️ Delayed"}</span>
          </span>
        </td>
        <td>
          <div class="dw-station-name"><span>${escapeHtml(st.name)}</span></div>
          ${st.nepaliName ? `<div class="dw-station-nepali">${escapeHtml(st.nepaliName)}</div>` : ""}
        </td>
        <td>
          <div style="font-weight:600; color:#1e293b;">${escapeHtml(st.basin || "Unknown")}</div>
          <div class="dw-station-meta">${escapeHtml(st.district || "Unknown")}</div>
        </td>
        <td>
          <div style="font-family:monospace; font-weight:600;">${escapeHtml(st.stationIndex || "-")}</div>
          <div class="dw-station-meta">ID: ${st.id}</div>
        </td>
        <td><span class="dw-type-tag ${typeClass}">${escapeHtml(st.type)}</span></td>
        <td>${obsDisplay}</td>
        <td>${statusDiffHtml}</td>
        <td><div class="dw-time-nepal">${st.latestTime ? formatNepalDateTime(st.latestTime) : "<span style=\"color:#94a3b8;\">No transmission</span>"}</div></td>
        <td><div class="dw-delay-text dw-delay-${delay.level}">${escapeHtml(delay.text)}</div></td>
        <td style="text-align:center;">
          <a href="#/basin/${st.id}" class="dw-action-link" title="Open Station hydrograph & historical charts">View Details ↗</a>
        </td>
      </tr>
    `;
  }

  function attachDashboardEvents() {
    const refreshBtn = document.getElementById("dw-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => syncAllData());

    const exportBtn = document.getElementById("dw-export-csv-btn");
    if (exportBtn) exportBtn.addEventListener("click", exportToCSV);

    const autoSelect = document.getElementById("dw-auto-refresh-select");
    if (autoSelect) autoSelect.addEventListener("change", (e) => {
      state.autoRefreshInterval = parseInt(e.target.value, 10);
      setupAutoRefresh();
    });

    document.querySelectorAll(".dw-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        state.statusFilter = pill.getAttribute("data-status");
        renderDashboardContent();
      });
    });

    const basinSelect = document.getElementById("dw-basin-select");
    if (basinSelect) basinSelect.addEventListener("change", (e) => {
      state.basinFilter = e.target.value;
      renderDashboardContent();
    });

    const districtSelect = document.getElementById("dw-district-select");
    if (districtSelect) districtSelect.addEventListener("change", (e) => {
      state.districtFilter = e.target.value;
      renderDashboardContent();
    });

    const typeSelect = document.getElementById("dw-type-select");
    if (typeSelect) typeSelect.addEventListener("change", (e) => {
      state.typeFilter = e.target.value;
      renderDashboardContent();
    });

    const sortSelect = document.getElementById("dw-sort-select");
    if (sortSelect) sortSelect.addEventListener("change", (e) => {
      state.sortBy = e.target.value;
      renderDashboardContent();
    });

    const searchInput = document.getElementById("dw-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        state.searchQuery = e.target.value;
        renderDashboardContent();
        const updatedInput = document.getElementById("dw-search-input");
        if (updatedInput) {
          updatedInput.focus();
          updatedInput.setSelectionRange(updatedInput.value.length, updatedInput.value.length);
        }
      });
    }

    const searchClear = document.getElementById("dw-search-clear");
    if (searchClear) searchClear.addEventListener("click", () => {
      state.searchQuery = "";
      renderDashboardContent();
    });

    document.querySelectorAll(".dw-table th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const sortField = th.getAttribute("data-sort");
        if (sortField === "trend_rising") {
          state.sortBy = state.sortBy === "trend_rising" ? "trend_falling" : state.sortBy === "trend_falling" ? "trend_steady" : "trend_rising";
        } else if (sortField === "diff_warning_desc") {
          state.sortBy = state.sortBy === "diff_warning_desc" ? "diff_warning_asc" : "diff_warning_desc";
        } else {
          state.sortBy = state.sortBy === sortField ? 
            (sortField.endsWith("_desc") ? sortField.replace("_desc", "_asc") : sortField.replace("_asc", "_desc")) : 
            sortField;
        }
        renderDashboardContent();
      });
    });
  }

  function exportToCSV() {
    const stationsToExport = getFilteredAndSortedStations();
    if (stationsToExport.length === 0) {
      alert("No stations to export with current filters.");
      return;
    }
    const headers = [
      "Station ID","Station Name","Nepali Name","Station Index","Basin","District","Type",
      "Water Level (m)","Warning Level (m)","Danger Level (m)","Warning Level Diff (m)","Danger Level Diff (m)",
      "Trend","Last Received Time (Nepal Time)","Delay (Minutes)","10-Min Telemetry Status"
    ];
    const rows = stationsToExport.map(st => [
      st.id,
      "\"" + (st.name || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (st.nepaliName || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (st.stationIndex || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (st.basin || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (st.district || "").replace(/"/g, "\"\"") + "\"",
      st.type,
      st.waterLevel !== null ? st.waterLevel : "",
      st.warningLevel !== null ? st.warningLevel : "",
      st.dangerLevel !== null ? st.dangerLevel : "",
      st.diffWarning !== null && st.diffWarning !== undefined ? (st.diffWarning > 0 ? "+" + st.diffWarning : st.diffWarning) : "",
      st.diffDanger !== null && st.diffDanger !== undefined ? (st.diffDanger > 0 ? "+" + st.diffDanger : st.diffDanger) : "",
      st.waterLevelTrend || "",
      st.latestTime ? "\"" + formatNepalDateTime(st.latestTime) + "\"" : "No Data",
      st.delayMinutes === Infinity ? "Offline" : st.delayMinutes,
      st.delayMinutes <= 10 ? "On-Time (<=10m)" : "Delayed (" + st.delayMinutes + "m overdue)"
    ]);
    const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    link.setAttribute("href", url);
    link.setAttribute("download", "DHM_Data_Watch_Delayed_Stations_" + dateStamp + ".csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /* ==========================================================================
     RIVER WATCH TABLE ENHANCER & COLUMN HEADING SORTER
     ========================================================================== */

  /**
   * Scans for table.watch_table on the page (River Watch tab #/river_watch)
   * and enhances it with clickable column sorters, Trend controls, and filter bar.
   */
  function checkAndEnhanceRiverWatch() {
    const table = document.querySelector("table.watch_table");
    if (!table) return;

    if (riverWatchState.isSorting) return;

    enhanceRiverWatchTable(table);
  }

  function extractRiverWatchRowData(tr, index) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 9) return null;

    const snText = (cells[0] && cells[0].innerText || "").trim();
    const basinText = (cells[1] && cells[1].innerText || "").trim();
    const indexText = (cells[2] && cells[2].innerText || "").trim();
    
    // Station Name column often has: "Name <br> <span>Date</span>"
    let stationName = "";
    let stationTime = "";
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
    const wlRaw = (cells[5] && cells[5].innerText || "").trim();
    const wlNum = parseFloat(wlRaw);
    const waterLevel = isNaN(wlNum) ? null : wlNum;

    const warnRaw = (cells[6] && cells[6].innerText || "").trim();
    const warnNum = parseFloat(warnRaw);
    const warningLevel = isNaN(warnNum) ? null : warnNum;

    const dangRaw = (cells[7] && cells[7].innerText || "").trim();
    const dangNum = parseFloat(dangRaw);
    const dangerLevel = isNaN(dangNum) ? null : dangNum;

    const trendText = (cells[8] && cells[8].innerText || "").trim().toUpperCase();
    const statusText = (cells[9] && cells[9].innerText || "").trim().toUpperCase();
    const onmText = (cells[10] && cells[10].innerText || "").trim();

    // Calculate level differences
    const diffObj = calculateWaterLevelDifferences(waterLevel, warningLevel, dangerLevel);

    return {
      element: tr,
      originalIndex: index,
      sn: parseInt(snText, 10) || index,
      basin: basinText,
      stationIndex: indexText,
      stationName: stationName,
      stationTime: stationTime,
      district: districtText,
      waterLevel: waterLevel,
      warningLevel: warningLevel,
      dangerLevel: dangerLevel,
      diffWarning: diffObj.diffWarning,
      diffDanger: diffObj.diffDanger,
      diffObj: diffObj,
      trend: trendText, // "RISING", "FALLING", "STEADY", ""
      status: statusText, // "DANGER", "WARNING", "BELOW WARNING LEVEL", etc.
      onm: onmText
    };
  }

  function enhanceRiverWatchTable(table) {
    if (!table || riverWatchState.isSorting) return;

    const tbody = table.querySelector("tbody.watch_table_tbody") || table.querySelector("tbody");
    if (!tbody) return;

    const rawRows = Array.from(tbody.querySelectorAll("tr.watch_table_tr, tr"));
    if (rawRows.length === 0) return;

    // Cache original order if newly loaded
    const rowDataList = [];
    rawRows.forEach((tr, idx) => {
      let data = riverWatchState.originalOrderMap.get(tr);
      if (!data) {
        data = extractRiverWatchRowData(tr, idx);
        if (data) {
          riverWatchState.originalOrderMap.set(tr, data);
        }
      }
      if (data) rowDataList.push(data);
    });

    if (rowDataList.length === 0) return;
    riverWatchState.cachedRows = rowDataList;
    riverWatchState.lastTableRef = table;

    // Compute live trend and alert stats
    const totalCount = rowDataList.length;
    const risingCount = rowDataList.filter(r => r.trend === "RISING").length;
    const fallingCount = rowDataList.filter(r => r.trend === "FALLING").length;
    const steadyCount = rowDataList.filter(r => r.trend === "STEADY").length;
    const alertCount = rowDataList.filter(r => r.status.includes("DANGER") || (r.status.includes("WARNING") && !r.status.includes("BELOW")) || (r.diffObj && r.diffObj.isAboveWarning)).length;
    const nearWarnCount = rowDataList.filter(r => r.diffWarning !== null && r.diffWarning >= -1.0).length;

    // Inject River Watch Toolbar above the table
    injectRiverWatchToolbar(table, { totalCount, risingCount, fallingCount, steadyCount, alertCount, nearWarnCount });

    // Enhance table headers (thead th) with sortable indicators and click handlers
    enhanceTableHeaders(table);

    // Apply active sort & filter
    applyRiverWatchSortAndFilter(table, false);
  }

  function injectRiverWatchToolbar(table, stats) {
    let toolbar = document.getElementById("dhm-river-watch-enhancer");
    const parent = table.parentElement;
    if (!parent) return;

    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = "dhm-river-watch-enhancer";
      toolbar.className = "dhm-rw-toolbar";
      parent.insertBefore(toolbar, table);
    }

    toolbar.innerHTML = `
      <div class="dhm-rw-header">
        <div class="dhm-rw-title-block">
          <div class="dhm-rw-title">
            <span class="dhm-rw-icon">🌊</span>
            <span>River Watch Telemetry & Trend / Level Sorter</span>
            <span class="dhm-rw-badge-live">Live Streams</span>
          </div>
          <div class="dhm-rw-subtitle">
            Sort and monitor river observation stations by <b>Warning Level Diff (Flood Risk)</b>, <b>Trend (Rising, Falling, Steady)</b>, or Water Level.
          </div>
        </div>

        <div class="dhm-rw-actions">
          <button class="dhm-rw-btn dhm-rw-btn-csv" id="dhm-rw-export-csv" title="Download currently sorted & filtered River Watch table to CSV">
            <span>📥 Export CSV</span>
          </button>
          <button class="dhm-rw-btn dhm-rw-btn-reset" id="dhm-rw-reset-btn" title="Reset all sorting and filters to DHM default">
            <span>🔄 Reset Order</span>
          </button>
        </div>
      </div>

      <!-- Trend & Hazard Filter Tabs / Pills -->
      <div class="dhm-rw-pills-row">
        <span class="dhm-rw-pills-label">Quick Filters:</span>
        <div class="dhm-rw-pills">
          <div class="dhm-rw-pill ${riverWatchState.trendFilter === "all" ? "active pill-all" : ""}" data-trend="all" title="Show all river stations">
            <span>🌊 All Stations</span>
            <span class="dhm-rw-pill-cnt">${stats.totalCount}</span>
          </div>
          <div class="dhm-rw-pill ${riverWatchState.trendFilter === "NEAR_WARNING" ? "active pill-near-warn" : ""}" data-trend="NEAR_WARNING" title="Show stations within 1 meter of Warning Level or exceeding Warning">
            <span>⚠️ Near / Exceeding Warning</span>
            <span class="dhm-rw-pill-cnt">${stats.nearWarnCount}</span>
          </div>
          <div class="dhm-rw-pill ${riverWatchState.trendFilter === "RISING" ? "active pill-rising" : ""}" data-trend="RISING" title="Show only RISING river stations (High flood risk)">
            <span>📈 Rising</span>
            <span class="dhm-rw-pill-cnt">${stats.risingCount}</span>
          </div>
          <div class="dhm-rw-pill ${riverWatchState.trendFilter === "FALLING" ? "active pill-falling" : ""}" data-trend="FALLING" title="Show only FALLING river stations (Receding waters)">
            <span>📉 Falling</span>
            <span class="dhm-rw-pill-cnt">${stats.fallingCount}</span>
          </div>
          <div class="dhm-rw-pill ${riverWatchState.trendFilter === "STEADY" ? "active pill-steady" : ""}" data-trend="STEADY" title="Show only STEADY river stations">
            <span>➡️ Steady</span>
            <span class="dhm-rw-pill-cnt">${stats.steadyCount}</span>
          </div>
          <div class="dhm-rw-pill ${riverWatchState.trendFilter === "ALERT" ? "active pill-alert" : ""}" data-trend="ALERT" title="Show stations above Warning or Danger level">
            <span>🚨 Danger / Warning</span>
            <span class="dhm-rw-pill-cnt">${stats.alertCount}</span>
          </div>
        </div>
      </div>

      <!-- Sorter Controls & Search -->
      <div class="dhm-rw-controls-row">
        <div class="dhm-rw-search-box">
          <span class="dhm-rw-search-icon">🔍</span>
          <input type="text" id="dhm-rw-search-input" placeholder="Search station name, basin, district, index, trend..." value="${escapeHtml(riverWatchState.searchQuery)}">
          ${riverWatchState.searchQuery ? "<span class=\"dhm-rw-search-clear\" id=\"dhm-rw-search-clear\">&times;</span>" : ""}
        </div>

        <div class="dhm-rw-sort-group">
          <span class="dhm-rw-control-label">Sort Table By:</span>
          <select class="dhm-rw-select" id="dhm-rw-sort-select">
            <option value="dhm_default" ${riverWatchState.sortKey === "dhm_default" ? "selected" : ""}>🔄 Default DHM Basin Grouping</option>
            <option value="diff_warning_desc" ${riverWatchState.sortKey === "diff_warning_desc" ? "selected" : ""}>⚠️ Warning Level Diff (Closest to Flood First / High Risk)</option>
            <option value="diff_warning_asc" ${riverWatchState.sortKey === "diff_warning_asc" ? "selected" : ""}>🛡️ Warning Level Diff (Safest / Farthest Below First)</option>
            <option value="trend_rising" ${riverWatchState.sortKey === "trend_rising" ? "selected" : ""}>📈 Trend: Rising First (Flood Alert)</option>
            <option value="trend_falling" ${riverWatchState.sortKey === "trend_falling" ? "selected" : ""}>📉 Trend: Falling First (Receding)</option>
            <option value="trend_steady" ${riverWatchState.sortKey === "trend_steady" ? "selected" : ""}>➡️ Trend: Steady First</option>
            <option value="waterlevel_desc" ${riverWatchState.sortKey === "waterlevel_desc" ? "selected" : ""}>🌊 Water Level (Highest First)</option>
            <option value="waterlevel_asc" ${riverWatchState.sortKey === "waterlevel_asc" ? "selected" : ""}>🌊 Water Level (Lowest First)</option>
            <option value="status_desc" ${riverWatchState.sortKey === "status_desc" ? "selected" : ""}>🚨 Status: Danger & Warning First</option>
            <option value="station_asc" ${riverWatchState.sortKey === "station_asc" ? "selected" : ""}>🔤 Station Name (A-Z)</option>
            <option value="station_desc" ${riverWatchState.sortKey === "station_desc" ? "selected" : ""}>🔤 Station Name (Z-A)</option>
            <option value="basin_asc" ${riverWatchState.sortKey === "basin_asc" ? "selected" : ""}>🌊 Basin Name (A-Z)</option>
            <option value="district_asc" ${riverWatchState.sortKey === "district_asc" ? "selected" : ""}>📍 District (A-Z)</option>
            <option value="index_asc" ${riverWatchState.sortKey === "index_asc" ? "selected" : ""}>🔢 Station Index (Ascending)</option>
            <option value="index_desc" ${riverWatchState.sortKey === "index_desc" ? "selected" : ""}>🔢 Station Index (Descending)</option>
            <option value="warning_desc" ${riverWatchState.sortKey === "warning_desc" ? "selected" : ""}>⚠️ Warning Level (Highest Threshold)</option>
            <option value="danger_desc" ${riverWatchState.sortKey === "danger_desc" ? "selected" : ""}>🚨 Danger Level (Highest Threshold)</option>
          </select>
        </div>

        <div class="dhm-rw-status-text" id="dhm-rw-status-count">
          Showing <b>${stats.totalCount}</b> stations
        </div>
      </div>
    `;

    attachRiverWatchToolbarEvents(toolbar, table);
  }

  function attachRiverWatchToolbarEvents(toolbar, table) {
    // Trend & Level Pills
    toolbar.querySelectorAll(".dhm-rw-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        riverWatchState.trendFilter = pill.getAttribute("data-trend");
        
        if (riverWatchState.trendFilter === "NEAR_WARNING") {
          riverWatchState.sortKey = "diff_warning_desc";
        } else if (riverWatchState.trendFilter === "RISING") {
          riverWatchState.sortKey = "trend_rising";
        } else if (riverWatchState.trendFilter === "FALLING") {
          riverWatchState.sortKey = "trend_falling";
        } else if (riverWatchState.trendFilter === "STEADY") {
          riverWatchState.sortKey = "trend_steady";
        } else if (riverWatchState.trendFilter === "ALERT") {
          riverWatchState.sortKey = "diff_warning_desc";
        } else if (riverWatchState.trendFilter === "all") {
          riverWatchState.sortKey = "dhm_default";
        }

        const sortSelect = document.getElementById("dhm-rw-sort-select");
        if (sortSelect) sortSelect.value = riverWatchState.sortKey;

        toolbar.querySelectorAll(".dhm-rw-pill").forEach(p => p.classList.remove("active"));
        pill.classList.add("active");

        applyRiverWatchSortAndFilter(table, true);
      });
    });

    // Sort Dropdown
    const sortSelect = document.getElementById("dhm-rw-sort-select");
    if (sortSelect) {
      sortSelect.addEventListener("change", (e) => {
        riverWatchState.sortKey = e.target.value;
        applyRiverWatchSortAndFilter(table, true);
      });
    }

    // Search Box
    const searchInput = document.getElementById("dhm-rw-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        riverWatchState.searchQuery = e.target.value;
        applyRiverWatchSortAndFilter(table, true);
      });
    }

    const searchClear = document.getElementById("dhm-rw-search-clear");
    if (searchClear) {
      searchClear.addEventListener("click", () => {
        riverWatchState.searchQuery = "";
        applyRiverWatchSortAndFilter(table, true);
      });
    }

    // Export CSV
    const exportBtn = document.getElementById("dhm-rw-export-csv");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => exportRiverWatchToCSV(table));
    }

    // Reset
    const resetBtn = document.getElementById("dhm-rw-reset-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        riverWatchState.sortKey = "dhm_default";
        riverWatchState.trendFilter = "all";
        riverWatchState.searchQuery = "";
        riverWatchState.activeColIndex = null;
        riverWatchState.sortDirection = "asc";

        const select = document.getElementById("dhm-rw-sort-select");
        if (select) select.value = "dhm_default";

        const input = document.getElementById("dhm-rw-search-input");
        if (input) input.value = "";

        toolbar.querySelectorAll(".dhm-rw-pill").forEach(p => p.classList.remove("active"));
        const allPill = toolbar.querySelector(".dhm-rw-pill[data-trend=\"all\"]");
        if (allPill) allPill.classList.add("active");

        applyRiverWatchSortAndFilter(table, true);
      });
    }
  }

  function enhanceTableHeaders(table) {
    const thead = table.querySelector("thead.watch_table_thead") || table.querySelector("thead");
    if (!thead) return;

    const thList = Array.from(thead.querySelectorAll("th.watch_table_th, th"));
    if (thList.length === 0) return;

    thList.forEach((th, colIdx) => {
      if (th.getAttribute("data-dhm-sorter-init") === "true") {
        updateHeaderSortIndicator(th, colIdx);
        return;
      }

      th.setAttribute("data-dhm-sorter-init", "true");
      th.classList.add("dhm-sortable-th");
      
      const originalText = th.innerText.trim();
      let icon = "⇅";
      let tooltip = `Click to sort by ${originalText}`;

      if (colIdx === 8 || originalText.toLowerCase().includes("trend")) {
        th.classList.add("dhm-th-trend");
        tooltip = "Click to cycle sort by Trend: Rising First (📈) → Falling First (📉) → Steady First (➡️)";
        icon = "📈 ⇅";
      } else if (colIdx === 9 || originalText.toLowerCase().includes("status")) {
        th.classList.add("dhm-th-status");
        tooltip = "Click to sort by Difference between Water Level & Warning Level (Closest to Flood First)";
        icon = "⚠️ ⇅";
      } else if (colIdx === 6 || originalText.toLowerCase().includes("warning level")) {
        tooltip = "Click to sort by Warning Level Threshold or Difference";
      }

      th.title = tooltip;

      // Wrap header content nicely
      th.innerHTML = `
        <div class="dhm-th-inner">
          <span class="dhm-th-text">${originalText}</span>
          <span class="dhm-th-sort-icon" id="dhm-th-icon-${colIdx}">${icon}</span>
        </div>
      `;

      th.addEventListener("click", () => {
        handleHeaderClick(colIdx, originalText, table);
      });
    });
  }

  function handleHeaderClick(colIdx, colName, table) {
    const nameLower = colName.toLowerCase();

    if (colIdx === 8 || nameLower.includes("trend")) {
      // Cycle: Rising -> Falling -> Steady -> Default
      if (riverWatchState.sortKey === "trend_rising") {
        riverWatchState.sortKey = "trend_falling";
      } else if (riverWatchState.sortKey === "trend_falling") {
        riverWatchState.sortKey = "trend_steady";
      } else if (riverWatchState.sortKey === "trend_steady") {
        riverWatchState.sortKey = "dhm_default";
      } else {
        riverWatchState.sortKey = "trend_rising";
      }
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 9 || nameLower.includes("status")) {
      // Cycle: Warning Diff Desc (Flood risk) -> Warning Diff Asc (Safe) -> Status Desc -> Default
      if (riverWatchState.sortKey === "diff_warning_desc") {
        riverWatchState.sortKey = "diff_warning_asc";
      } else if (riverWatchState.sortKey === "diff_warning_asc") {
        riverWatchState.sortKey = "status_desc";
      } else if (riverWatchState.sortKey === "status_desc") {
        riverWatchState.sortKey = "dhm_default";
      } else {
        riverWatchState.sortKey = "diff_warning_desc";
      }
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 0 || nameLower.includes("s.n")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "sn_asc" ? "sn_desc" : "sn_asc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 1 || nameLower.includes("basin")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "basin_asc" ? "basin_desc" : "basin_asc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 2 || nameLower.includes("index")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "index_asc" ? "index_desc" : "index_asc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 3 || nameLower.includes("station")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "station_asc" ? "station_desc" : "station_asc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 4 || nameLower.includes("district")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "district_asc" ? "district_desc" : "district_asc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 5 || nameLower.includes("water level")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "waterlevel_desc" ? "waterlevel_asc" : "waterlevel_desc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 6 || nameLower.includes("warning level")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "diff_warning_desc" ? "diff_warning_asc" : riverWatchState.sortKey === "diff_warning_asc" ? "warning_desc" : "diff_warning_desc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 7 || nameLower.includes("danger level")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "danger_desc" ? "danger_asc" : "danger_desc";
      riverWatchState.activeColIndex = colIdx;
    } else if (colIdx === 10 || nameLower.includes("o & m") || nameLower.includes("onm")) {
      riverWatchState.sortKey = riverWatchState.sortKey === "onm_asc" ? "onm_desc" : "onm_asc";
      riverWatchState.activeColIndex = colIdx;
    }

    // Sync select dropdown in toolbar
    const select = document.getElementById("dhm-rw-sort-select");
    if (select) select.value = riverWatchState.sortKey;

    applyRiverWatchSortAndFilter(table, true);
  }

  function updateHeaderSortIndicator(th, colIdx) {
    const iconEl = th.querySelector(".dhm-th-sort-icon");
    if (!iconEl) return;

    th.classList.remove("dhm-th-active");

    const sortKey = riverWatchState.sortKey;
    let icon = "⇅";

    if (colIdx === 8 && sortKey.startsWith("trend_")) {
      th.classList.add("dhm-th-active");
      if (sortKey === "trend_rising") icon = "📈 ▲";
      else if (sortKey === "trend_falling") icon = "📉 ▼";
      else if (sortKey === "trend_steady") icon = "➡️ ◼";
    } else if (colIdx === 9 && (sortKey === "diff_warning_desc" || sortKey === "diff_warning_asc" || sortKey.startsWith("status_"))) {
      th.classList.add("dhm-th-active");
      if (sortKey === "diff_warning_desc") icon = "⚠️ ▼ (Flood Risk)";
      else if (sortKey === "diff_warning_asc") icon = "🛡️ ▲ (Safe Buffer)";
      else if (sortKey === "status_desc") icon = "🚨 ▼";
      else icon = "▲";
    } else if (colIdx === 6 && (sortKey === "diff_warning_desc" || sortKey === "diff_warning_asc" || sortKey.startsWith("warning_"))) {
      th.classList.add("dhm-th-active");
      if (sortKey === "diff_warning_desc") icon = "⚠️ ▼ (Diff)";
      else if (sortKey === "diff_warning_asc") icon = "🛡️ ▲ (Diff)";
      else if (sortKey === "warning_desc") icon = "▼";
      else icon = "▲";
    } else if (colIdx === 0 && (sortKey === "sn_asc" || sortKey === "sn_desc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "sn_asc" ? "▲" : "▼";
    } else if (colIdx === 1 && (sortKey === "basin_asc" || sortKey === "basin_desc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "basin_asc" ? "▲" : "▼";
    } else if (colIdx === 2 && (sortKey === "index_asc" || sortKey === "index_desc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "index_asc" ? "▲" : "▼";
    } else if (colIdx === 3 && (sortKey === "station_asc" || sortKey === "station_desc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "station_asc" ? "▲" : "▼";
    } else if (colIdx === 4 && (sortKey === "district_asc" || sortKey === "district_desc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "district_asc" ? "▲" : "▼";
    } else if (colIdx === 5 && (sortKey === "waterlevel_desc" || sortKey === "waterlevel_asc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "waterlevel_desc" ? "▼ (High)" : "▲ (Low)";
    } else if (colIdx === 7 && (sortKey === "danger_desc" || sortKey === "danger_asc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "danger_desc" ? "▼" : "▲";
    } else if (colIdx === 10 && (sortKey === "onm_asc" || sortKey === "onm_desc")) {
      th.classList.add("dhm-th-active");
      icon = sortKey === "onm_asc" ? "▲" : "▼";
    }

    iconEl.textContent = icon;
  }

  function applyRiverWatchSortAndFilter(table, shouldScroll) {
    if (!table || riverWatchState.cachedRows.length === 0) return;

    riverWatchState.isSorting = true;

    try {
      const tbody = table.querySelector("tbody.watch_table_tbody") || table.querySelector("tbody");
      if (!tbody) {
        riverWatchState.isSorting = false;
        return;
      }

      // 1. Sort row data
      const sorted = sortRiverWatchRows([...riverWatchState.cachedRows], riverWatchState.sortKey);

      // 2. Filter row data
      const trendF = riverWatchState.trendFilter;
      const searchQ = riverWatchState.searchQuery.toLowerCase().trim();

      let visibleCount = 0;

      // Re-order rows in DOM only if the parent/order changes
      const fragment = document.createDocumentFragment();

      sorted.forEach((row) => {
        let isVisible = true;

        // Quick filter pills
        if (trendF === "NEAR_WARNING") {
          if (row.diffWarning === null || row.diffWarning < -1.0) isVisible = false;
        } else if (trendF === "RISING" && row.trend !== "RISING") isVisible = false;
        else if (trendF === "FALLING" && row.trend !== "FALLING") isVisible = false;
        else if (trendF === "STEADY" && row.trend !== "STEADY") isVisible = false;
        else if (trendF === "ALERT") {
          const isAlert = row.status.includes("DANGER") || (row.status.includes("WARNING") && !row.status.includes("BELOW")) || (row.diffObj && row.diffObj.isAboveWarning);
          if (!isAlert) isVisible = false;
        }

        // Search query
        if (isVisible && searchQ) {
          const match = row.stationName.toLowerCase().includes(searchQ) ||
                        row.basin.toLowerCase().includes(searchQ) ||
                        row.district.toLowerCase().includes(searchQ) ||
                        row.stationIndex.toLowerCase().includes(searchQ) ||
                        row.trend.toLowerCase().includes(searchQ) ||
                        row.status.toLowerCase().includes(searchQ);
          if (!match) isVisible = false;
        }

        if (isVisible) {
          visibleCount++;
          row.element.style.display = "";
          
          // Renumber S.N column
          const snCell = row.element.querySelector("td");
          if (snCell) snCell.textContent = visibleCount;

          const cells = row.element.querySelectorAll("td");

          // Enhance Trend cell badge styling
          if (cells[8]) {
            styleTrendCell(cells[8], row.trend);
          }

          // Enhance Status cell with Warning & Danger Level Differences!
          if (cells[9]) {
            styleStatusCell(cells[9], row.status, row.diffObj);
          }
        } else {
          row.element.style.display = "none";
        }

        fragment.appendChild(row.element);
      });

      tbody.appendChild(fragment);

      // Update Header Indicators
      const thead = table.querySelector("thead");
      if (thead) {
        thead.querySelectorAll("th").forEach((th, idx) => updateHeaderSortIndicator(th, idx));
      }

      // Update Status Counter
      const countEl = document.getElementById("dhm-rw-status-count");
      if (countEl) {
        countEl.innerHTML = `Showing <b>${visibleCount}</b> of <b>${riverWatchState.cachedRows.length}</b> river stations`;
      }

    } catch (err) {
      console.warn("[DHM River Watch Sorter] Error during table sorting:", err);
    } finally {
      setTimeout(() => {
        riverWatchState.isSorting = false;
      }, 50);
    }
  }

  function styleTrendCell(cell, trend) {
    if (cell.getAttribute("data-dhm-trend-styled") === "true") return;
    cell.setAttribute("data-dhm-trend-styled", "true");

    const upper = (trend || cell.innerText || "").trim().toUpperCase();
    if (upper === "RISING") {
      cell.innerHTML = `<span class="dhm-trend-badge dhm-trend-rising">RISING ↑</span>`;
    } else if (upper === "FALLING") {
      cell.innerHTML = `<span class="dhm-trend-badge dhm-trend-falling">FALLING ↓</span>`;
    } else if (upper === "STEADY") {
      cell.innerHTML = `<span class="dhm-trend-badge dhm-trend-steady">STEADY →</span>`;
    }
  }

  function styleStatusCell(cell, statusText, diffObj) {
    if (cell.getAttribute("data-dhm-status-styled") === "true") return;
    cell.setAttribute("data-dhm-status-styled", "true");

    cell.innerHTML = formatStatusWithDifferences(statusText, diffObj);
  }

  function sortRiverWatchRows(rows, sortKey) {
    switch (sortKey) {
      case "diff_warning_desc": {
        // Closest to flood / Exceeding warning level first
        return rows.sort((a, b) => {
          const diffA = a.diffWarning !== null && a.diffWarning !== undefined ? a.diffWarning : -Infinity;
          const diffB = b.diffWarning !== null && b.diffWarning !== undefined ? b.diffWarning : -Infinity;
          if (diffA === -Infinity && diffB === -Infinity) return a.stationName.localeCompare(b.stationName);
          if (diffA === -Infinity) return 1;
          if (diffB === -Infinity) return -1;
          if (diffB !== diffA) return diffB - diffA;
          return (b.waterLevel || 0) - (a.waterLevel || 0);
        });
      }

      case "diff_warning_asc": {
        // Safest / Farthest below warning level first
        return rows.sort((a, b) => {
          const diffA = a.diffWarning !== null && a.diffWarning !== undefined ? a.diffWarning : Infinity;
          const diffB = b.diffWarning !== null && b.diffWarning !== undefined ? b.diffWarning : Infinity;
          if (diffA === Infinity && diffB === Infinity) return a.stationName.localeCompare(b.stationName);
          if (diffA === Infinity) return 1;
          if (diffB === Infinity) return -1;
          if (diffA !== diffB) return diffA - diffB;
          return (a.waterLevel || 0) - (b.waterLevel || 0);
        });
      }

      case "trend_rising": {
        const rank = (t) => t === "RISING" ? 1 : t === "FALLING" ? 2 : t === "STEADY" ? 3 : 4;
        return rows.sort((a, b) => {
          const rA = rank(a.trend);
          const rB = rank(b.trend);
          if (rA !== rB) return rA - rB;
          // Secondary: Water Level vs Warning diff highest first
          const diffA = a.diffWarning !== null ? a.diffWarning : -999;
          const diffB = b.diffWarning !== null ? b.diffWarning : -999;
          if (diffA !== diffB) return diffB - diffA;
          return a.stationName.localeCompare(b.stationName);
        });
      }

      case "trend_falling": {
        const rank = (t) => t === "FALLING" ? 1 : t === "RISING" ? 2 : t === "STEADY" ? 3 : 4;
        return rows.sort((a, b) => {
          const rA = rank(a.trend);
          const rB = rank(b.trend);
          if (rA !== rB) return rA - rB;
          if (a.waterLevel !== null && b.waterLevel !== null) return b.waterLevel - a.waterLevel;
          return a.stationName.localeCompare(b.stationName);
        });
      }

      case "trend_steady": {
        const rank = (t) => t === "STEADY" ? 1 : t === "RISING" ? 2 : t === "FALLING" ? 3 : 4;
        return rows.sort((a, b) => {
          const rA = rank(a.trend);
          const rB = rank(b.trend);
          if (rA !== rB) return rA - rB;
          if (a.waterLevel !== null && b.waterLevel !== null) return b.waterLevel - a.waterLevel;
          return a.stationName.localeCompare(b.stationName);
        });
      }

      case "waterlevel_desc":
        return rows.sort((a, b) => {
          if (a.waterLevel === null && b.waterLevel === null) return 0;
          if (a.waterLevel === null) return 1;
          if (b.waterLevel === null) return -1;
          return b.waterLevel - a.waterLevel;
        });

      case "waterlevel_asc":
        return rows.sort((a, b) => {
          if (a.waterLevel === null && b.waterLevel === null) return 0;
          if (a.waterLevel === null) return 1;
          if (b.waterLevel === null) return -1;
          return a.waterLevel - b.waterLevel;
        });

      case "warning_desc":
        return rows.sort((a, b) => (b.warningLevel || 0) - (a.warningLevel || 0));

      case "warning_asc":
        return rows.sort((a, b) => (a.warningLevel || 0) - (b.warningLevel || 0));

      case "danger_desc":
        return rows.sort((a, b) => (b.dangerLevel || 0) - (a.dangerLevel || 0));

      case "danger_asc":
        return rows.sort((a, b) => (a.dangerLevel || 0) - (b.dangerLevel || 0));

      case "status_desc": {
        const rank = (s) => s.includes("DANGER") ? 1 : s.includes("WARNING") && !s.includes("BELOW") ? 2 : 3;
        return rows.sort((a, b) => {
          const rA = rank(a.status);
          const rB = rank(b.status);
          if (rA !== rB) return rA - rB;
          const diffA = a.diffWarning !== null ? a.diffWarning : -999;
          const diffB = b.diffWarning !== null ? b.diffWarning : -999;
          return diffB - diffA;
        });
      }

      case "status_asc": {
        const rank = (s) => s.includes("BELOW") ? 1 : s.includes("WARNING") ? 2 : 3;
        return rows.sort((a, b) => rank(a.status) - rank(b.status));
      }

      case "station_asc":
        return rows.sort((a, b) => a.stationName.localeCompare(b.stationName));

      case "station_desc":
        return rows.sort((a, b) => b.stationName.localeCompare(a.stationName));

      case "basin_asc":
        return rows.sort((a, b) => a.basin.localeCompare(b.basin) || a.stationName.localeCompare(b.stationName));

      case "basin_desc":
        return rows.sort((a, b) => b.basin.localeCompare(a.basin) || a.stationName.localeCompare(b.stationName));

      case "district_asc":
        return rows.sort((a, b) => a.district.localeCompare(b.district) || a.stationName.localeCompare(b.stationName));

      case "district_desc":
        return rows.sort((a, b) => b.district.localeCompare(a.district) || a.stationName.localeCompare(b.stationName));

      case "index_asc":
        return rows.sort((a, b) => (parseInt(a.stationIndex, 10) || 0) - (parseInt(b.stationIndex, 10) || 0) || a.stationIndex.localeCompare(b.stationIndex));

      case "index_desc":
        return rows.sort((a, b) => (parseInt(b.stationIndex, 10) || 0) - (parseInt(a.stationIndex, 10) || 0) || b.stationIndex.localeCompare(a.stationIndex));

      case "sn_asc":
        return rows.sort((a, b) => a.originalIndex - b.originalIndex);

      case "sn_desc":
        return rows.sort((a, b) => b.originalIndex - a.originalIndex);

      case "dhm_default":
      default:
        return rows.sort((a, b) => a.originalIndex - b.originalIndex);
    }
  }

  function exportRiverWatchToCSV(table) {
    if (riverWatchState.cachedRows.length === 0) {
      alert("No river station rows available to export.");
      return;
    }

    const headers = [
      "S.N","Basin Name","Station Index","Station Name","Last Observation Time","District",
      "Water Level (m)","Warning Level (m)","Danger Level (m)","Warning Level Diff (m)","Danger Level Diff (m)",
      "Trend","Status","O & M by"
    ];
    
    // Export only currently filtered / visible rows
    const visibleRows = riverWatchState.cachedRows.filter(r => r.element.style.display !== "none");
    const sortedVisible = sortRiverWatchRows([...visibleRows], riverWatchState.sortKey);

    const rows = sortedVisible.map((r, idx) => [
      idx + 1,
      "\"" + (r.basin || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (r.stationIndex || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (r.stationName || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (r.stationTime || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (r.district || "").replace(/"/g, "\"\"") + "\"",
      r.waterLevel !== null ? r.waterLevel : "",
      r.warningLevel !== null ? r.warningLevel : "",
      r.dangerLevel !== null ? r.dangerLevel : "",
      r.diffWarning !== null && r.diffWarning !== undefined ? (r.diffWarning > 0 ? "+" + r.diffWarning : r.diffWarning) : "",
      r.diffDanger !== null && r.diffDanger !== undefined ? (r.diffDanger > 0 ? "+" + r.diffDanger : r.diffDanger) : "",
      r.trend || "",
      "\"" + (r.status || "").replace(/"/g, "\"\"") + "\"",
      "\"" + (r.onm || "").replace(/"/g, "\"\"") + "\""
    ]);

    const csvContent = [headers.join(","), ...rows.map(row => row.join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    link.setAttribute("href", url);
    link.setAttribute("download", "DHM_River_Watch_Trend_Level_Diff_" + dateStamp + ".csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /* ==========================================================================
     TIMERS & LIFECYCLE INITIALIZATION
     ========================================================================== */
  function setupAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
    if (state.autoRefreshInterval > 0) {
      state.autoRefreshTimer = setInterval(() => {
        if (state.isDataWatchActive) syncAllData();
      }, state.autoRefreshInterval * 1000);
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
    widget.title = "DHM Data Watch & River Watch Extension Sorter (Click to toggle ON/OFF)";

    widget.innerHTML = `
      <div class="dhm-widget-brand">
        <span>🌊</span>
        <span>DHM Watch</span>
      </div>
      <label class="dhm-widget-switch">
        <input type="checkbox" id="dhm-widget-toggle-input" ${state.extensionEnabled ? "checked" : ""}>
        <span class="dhm-widget-slider"></span>
      </label>
      <span class="dhm-widget-status" id="dhm-widget-status-text">${state.extensionEnabled ? "ON" : "OFF"}</span>
    `;

    document.body.appendChild(widget);

    const toggleInput = widget.querySelector("#dhm-widget-toggle-input");
    if (toggleInput) {
      toggleInput.addEventListener("change", (e) => {
        setExtensionEnabledState(e.target.checked);
      });
    }

    updateFloatingWidgetUI();
  }

  function updateFloatingWidgetUI() {
    const widget = document.getElementById("dhm-floating-toggle-widget");
    if (!widget) return;

    const toggleInput = widget.querySelector("#dhm-widget-toggle-input");
    const statusText = widget.querySelector("#dhm-widget-status-text");

    if (toggleInput) toggleInput.checked = state.extensionEnabled;
    if (statusText) statusText.textContent = state.extensionEnabled ? "ON" : "OFF";

    if (state.extensionEnabled) {
      widget.classList.remove("is-disabled");
    } else {
      widget.classList.add("is-disabled");
    }
  }

  function setExtensionEnabledState(enabled) {
    state.extensionEnabled = enabled;

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ extensionEnabled: enabled });
    }

    updateFloatingWidgetUI();

    if (enabled) {
      enableExtensionFeatures();
    } else {
      disableExtensionFeatures();
    }
  }

  function enableExtensionFeatures() {
    injectDataWatchTab();
    handleHashRouting();
  }

  function disableExtensionFeatures() {
    // 1. Remove injected Data Watch Tab button
    const tabBtn = document.getElementById("dhm-data-watch-tab-link");
    if (tabBtn) tabBtn.remove();

    // 2. If currently on #/data_watch tab, deactivate view and return to standard route
    if (window.location.hash.startsWith("#/data_watch")) {
      deactivateDataWatchView();
      window.location.hash = "#/river_watch";
    }

    // 3. Remove River Watch Toolbar
    const rwToolbar = document.getElementById("dhm-river-watch-enhancer");
    if (rwToolbar) rwToolbar.remove();

    // 4. Reset River Watch Table headers if enhanced
    const table = document.querySelector("table.watch_table");
    if (table) {
      const thead = table.querySelector("thead");
      if (thead) {
        thead.querySelectorAll("th").forEach(th => {
          th.removeAttribute("data-dhm-sorter-init");
          th.classList.remove("dhm-sortable-th", "dhm-th-active", "dhm-th-trend", "dhm-th-status");
        });
      }
    }
  }

  /* ==========================================================================
     TIMERS & LIFECYCLE INITIALIZATION
     ========================================================================== */
  function init() {
    // Read extension state from chrome.storage
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ extensionEnabled: true }, (res) => {
        state.extensionEnabled = res.extensionEnabled !== false;

        injectFloatingToggleWidget();

        if (state.extensionEnabled) {
          enableExtensionFeatures();
        } else {
          disableExtensionFeatures();
        }
      });

      // Listen for popup toggles or storage updates
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === "local" && changes.extensionEnabled) {
          setExtensionEnabledState(changes.extensionEnabled.newValue);
        }
      });

      if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.action === "EXTENSION_TOGGLED") {
            setExtensionEnabledState(msg.enabled);
          }
        });
      }
    } else {
      injectFloatingToggleWidget();
      enableExtensionFeatures();
    }

    window.addEventListener("hashchange", () => {
      if (state.extensionEnabled) handleHashRouting();
    });

    // Debounced MutationObserver to prevent infinite loops and DOM thrashing
    let observerDebounceTimer = null;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations originating inside extension injected UI elements
      const isExtensionMutation = mutations.every(m => {
        const target = m.target;
        return target && (
          target.closest("#dhm-data-watch-root") ||
          target.closest("#dhm-floating-toggle-widget") ||
          target.closest("#dhm-river-watch-enhancer")
        );
      });

      if (isExtensionMutation) return;

      if (observerDebounceTimer) return;

      observerDebounceTimer = setTimeout(() => {
        observerDebounceTimer = null;

        injectFloatingToggleWidget();

        if (!state.extensionEnabled) return;

        injectDataWatchTab();

        const hash = window.location.hash || "";

        if (hash.startsWith("#/data_watch")) {
          if (!state.isDataWatchActive) activateDataWatchView();
        } else if (hash.startsWith("#/river_watch") || hash.includes("river_watch") || document.querySelector("table.watch_table")) {
          if (!riverWatchState.isSorting) {
            checkAndEnhanceRiverWatch();
          }
        }
      }, 100);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setupLiveClock();
    setupAutoRefresh();
    syncAllData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
