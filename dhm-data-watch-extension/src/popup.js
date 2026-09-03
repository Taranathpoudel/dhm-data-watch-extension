document.addEventListener("DOMContentLoaded", () => {
  let stations = [];
  let currentFilter = "all";
  let extensionEnabled = true;

  // Extension toggle element references
  const extensionToggle = document.getElementById("pop-extension-toggle");
  const toggleStatusLabel = document.getElementById("pop-toggle-status");

  function updateToggleUI(enabled) {
    extensionEnabled = enabled;
    if (extensionToggle) extensionToggle.checked = enabled;
    if (toggleStatusLabel) {
      toggleStatusLabel.textContent = enabled ? "ON" : "OFF";
      if (enabled) {
        toggleStatusLabel.classList.remove("off");
      } else {
        toggleStatusLabel.classList.add("off");
      }
    }
  }

  // Load stored extension toggle state
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ extensionEnabled: true }, (res) => {
      updateToggleUI(res.extensionEnabled);
    });
  }

  if (extensionToggle) {
    extensionToggle.addEventListener("change", (e) => {
      const isEnabled = e.target.checked;
      updateToggleUI(isEnabled);

      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ extensionEnabled: isEnabled }, () => {
          // Send message to active tabs
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                action: "EXTENSION_TOGGLED",
                enabled: isEnabled
              }).catch(() => {});
            }
          });
        });
      }
    });
  }
  
  function updateClock() {
    const d = new Date();
    const timeStr = d.toLocaleTimeString("en-US", {
      timeZone: "Asia/Kathmandu",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
    const el = document.getElementById("pop-clock");
    if (el) el.textContent = timeStr + " NPT";
  }
  updateClock();
  setInterval(updateClock, 1000);

  async function loadData() {
    try {
      const res = await fetch("https://hydrology.gov.np/gss/socket.io/?EIO=3&transport=polling&t=" + Date.now());
      const data = await res.text();
      const sidIdx = data.indexOf("\"sid\":\"");
      if (sidIdx === -1) return;
      const sidEnd = data.indexOf("\"", sidIdx + 7);
      const sid = data.substring(sidIdx + 7, sidEnd);

      const sendReq = (evt) => {
        const payload = "42[\"client_request\",\"" + evt + "\"]";
        return fetch("https://hydrology.gov.np/gss/socket.io/?EIO=3&transport=polling&sid=" + sid + "&t=" + Date.now(), {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: payload.length + ":" + payload
        });
      };

      await Promise.all([sendReq("river_test"), sendReq("rainfall_watch")]);

      setTimeout(async () => {
        const pRes = await fetch("https://hydrology.gov.np/gss/socket.io/?EIO=3&transport=polling&sid=" + sid + "&t=" + Date.now());
        const pData = await pRes.text();
        parseAndRender(pData);
      }, 1200);

    } catch (e) {
      document.getElementById("pop-station-list").innerHTML = "<div class=\"loading-text\">Failed to load live telemetry.</div>";
    }
  }

  function parseAndRender(raw) {
    let riverData = [];
    let rainfallData = [];

    let i = 0;
    while (i < raw.length) {
      const colon = raw.indexOf(":", i);
      if (colon === -1) break;
      const len = parseInt(raw.substring(i, colon), 10);
      if (isNaN(len)) break;
      const payload = raw.substring(colon + 1, colon + 1 + len);
      if (payload.startsWith("42[")) {
        try {
          const parsed = JSON.parse(payload.substring(2));
          if (parsed[0] === "river_test" || parsed[0] === "river_watch") riverData = parsed[1] || [];
          if (parsed[0] === "rainfall_watch") rainfallData = parsed[1] || [];
        } catch(e) {}
      }
      i = colon + 1 + len;
    }

    const stMap = new Map();
    const now = Date.now();

    riverData.forEach(r => {
      let delay = Infinity;
      let timeStr = "";
      if (r.waterLevel && r.waterLevel.datetime) {
        timeStr = r.waterLevel.datetime;
        delay = Math.max(0, Math.floor((now - new Date(timeStr).getTime()) / 60000));
      }

      const wl = r.waterLevel && !isNaN(parseFloat(r.waterLevel.value)) ? parseFloat(r.waterLevel.value) : null;
      const warn = parseFloat(r.warning_level);
      const dang = parseFloat(r.danger_level);
      const diffWarn = (wl !== null && !isNaN(warn) && warn > 0) ? Math.round((wl - warn) * 100) / 100 : null;
      const diffDang = (wl !== null && !isNaN(dang) && dang > 0) ? Math.round((wl - dang) * 100) / 100 : null;

      stMap.set(r.id, {
        id: r.id,
        name: r.name,
        basin: r.basin || "Other",
        district: r.district || "",
        latestTime: timeStr,
        delayMinutes: delay,
        trend: (r.steady || "").toUpperCase(),
        waterLevel: wl,
        warningLevel: isNaN(warn) ? null : warn,
        dangerLevel: isNaN(dang) ? null : dang,
        diffWarning: diffWarn,
        diffDanger: diffDang,
        status: r.status || "",
        type: "River"
      });
    });

    rainfallData.forEach(rf => {
      let delay = Infinity;
      let timeStr = "";
      if (rf.latest_observation && rf.latest_observation.datetime) {
        timeStr = rf.latest_observation.datetime;
        delay = Math.max(0, Math.floor((now - new Date(timeStr).getTime()) / 60000));
      }
      const existing = stMap.get(rf.id);
      if (existing) {
        if (delay < existing.delayMinutes) {
          existing.delayMinutes = delay;
          existing.latestTime = timeStr;
        }
        existing.type = "WL + Rain";
      } else {
        stMap.set(rf.id, {
          id: rf.id,
          name: rf.name,
          basin: rf.basin || "Other",
          district: rf.district || "",
          latestTime: timeStr,
          delayMinutes: delay,
          trend: "",
          waterLevel: null,
          warningLevel: null,
          dangerLevel: null,
          diffWarning: null,
          diffDanger: null,
          status: rf.status || "",
          type: "Rainfall"
        });
      }
    });

    stations = Array.from(stMap.values());
    stations.sort((a, b) => b.delayMinutes - a.delayMinutes);

    // Calculate metrics
    const delayed = stations.filter(s => s.delayMinutes > 10).length;
    const critical = stations.filter(s => s.delayMinutes > 60 && s.delayMinutes < Infinity).length;
    const normal = stations.filter(s => s.delayMinutes <= 10).length;

    const rising = stations.filter(s => s.trend === "RISING").length;
    const falling = stations.filter(s => s.trend === "FALLING").length;
    const steady = stations.filter(s => s.trend === "STEADY").length;

    document.getElementById("stat-delayed-count").textContent = delayed;
    document.getElementById("stat-critical-count").textContent = critical;
    document.getElementById("stat-normal-count").textContent = normal;

    document.getElementById("stat-rising-count").textContent = rising;
    document.getElementById("stat-falling-count").textContent = falling;
    document.getElementById("stat-steady-count").textContent = steady;

    renderList();
  }

  function renderList(filterQuery = "") {
    const listEl = document.getElementById("pop-station-list");
    let filtered = stations;

    if (currentFilter === "rising") {
      filtered = filtered.filter(s => s.trend === "RISING");
    } else if (currentFilter === "falling") {
      filtered = filtered.filter(s => s.trend === "FALLING");
    } else if (currentFilter === "steady") {
      filtered = filtered.filter(s => s.trend === "STEADY");
    } else if (currentFilter === "delayed") {
      filtered = filtered.filter(s => s.delayMinutes > 10);
    } else if (currentFilter === "critical") {
      filtered = filtered.filter(s => s.delayMinutes > 60);
    } else if (currentFilter === "normal") {
      filtered = filtered.filter(s => s.delayMinutes <= 10);
    }

    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      filtered = filtered.filter(s => 
        (s.name || "").toLowerCase().includes(q) || 
        (s.basin || "").toLowerCase().includes(q) ||
        (s.district || "").toLowerCase().includes(q) ||
        (s.trend || "").toLowerCase().includes(q)
      );
    }

    if (filtered.length === 0) {
      listEl.innerHTML = "<div class=\"loading-text\">No matching stations found.</div>";
      return;
    }

    listEl.innerHTML = filtered.slice(0, 35).map(s => {
      let badge = "";
      if (s.delayMinutes <= 10) {
        badge = "<span class=\"pop-badge pop-badge-normal\">" + (s.delayMinutes === 0 ? "Just now" : s.delayMinutes + "m ago") + "</span>";
      } else if (s.delayMinutes <= 60) {
        badge = "<span class=\"pop-badge pop-badge-delayed\">" + s.delayMinutes + "m overdue</span>";
      } else if (s.delayMinutes < Infinity) {
        const h = Math.floor(s.delayMinutes / 60);
        badge = "<span class=\"pop-badge pop-badge-critical\">" + h + "h overdue</span>";
      } else {
        badge = "<span class=\"pop-badge pop-badge-critical\">Offline</span>";
      }

      let trendBadge = "";
      if (s.trend === "RISING") {
        trendBadge = "<span class=\"pop-trend-badge pop-trend-rising\">📈 RISING</span>";
      } else if (s.trend === "FALLING") {
        trendBadge = "<span class=\"pop-trend-badge pop-trend-falling\">📉 FALLING</span>";
      } else if (s.trend === "STEADY") {
        trendBadge = "<span class=\"pop-trend-badge pop-trend-steady\">➡️ STEADY</span>";
      }

      // Warning / Danger difference snippet
      let diffSnippet = "";
      if (s.waterLevel !== null) {
        if (s.diffWarning !== null) {
          if (s.diffWarning > 0) {
            // Crossed warning level -> show diff to danger level
            if (s.diffDanger !== null) {
              if (s.diffDanger > 0) {
                diffSnippet = ` &bull; <span style="color:#dc2626; font-weight:700;">🚨 +${s.diffDanger.toFixed(2)}m above Danger</span>`;
              } else {
                diffSnippet = ` &bull; <span style="color:#d97706; font-weight:700;">⚠️ ${Math.abs(s.diffDanger).toFixed(2)}m to Danger</span>`;
              }
            } else {
              diffSnippet = ` &bull; <span style="color:#d97706; font-weight:700;">⚠️ +${s.diffWarning.toFixed(2)}m above Warn</span>`;
            }
          } else {
            // Below warning level
            const gapWarn = Math.abs(s.diffWarning).toFixed(2);
            diffSnippet = ` &bull; <span style="color:#059669; font-weight:600;">-${gapWarn}m to Warn</span>`;
          }
        }
      }

      return "<div class=\"pop-item\">" +
        "<div>" +
          "<div class=\"pop-item-name\">" + escapeHtml(s.name) + " " + trendBadge + "</div>" +
          "<div class=\"pop-item-sub\">" + escapeHtml(s.basin) + " &bull; " + escapeHtml(s.district) + (s.waterLevel !== null ? " &bull; <b>" + s.waterLevel + "m</b>" : "") + diffSnippet + "</div>" +
        "</div>" +
        badge +
      "</div>";
    }).join("");
  }

  // Search input
  const searchInput = document.getElementById("pop-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      renderList(e.target.value);
    });
  }

  // Quick stat filter cards
  const addFilterClick = (id, filterName) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", () => {
        currentFilter = currentFilter === filterName ? "all" : filterName;
        document.querySelectorAll(".stat-box").forEach(b => b.classList.remove("selected-filter"));
        if (currentFilter === filterName) el.classList.add("selected-filter");
        renderList(searchInput ? searchInput.value : "");
      });
    }
  };

  addFilterClick("box-filter-rising", "rising");
  addFilterClick("box-filter-falling", "falling");
  addFilterClick("box-filter-steady", "steady");
  addFilterClick("box-filter-delayed", "delayed");
  addFilterClick("box-filter-critical", "critical");
  addFilterClick("box-filter-normal", "normal");

  // Open site buttons
  const rwBtn = document.getElementById("btn-open-river-watch");
  if (rwBtn) {
    rwBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://hydrology.gov.np/#/river_watch" });
    });
  }

  const dwBtn = document.getElementById("btn-open-data-watch");
  if (dwBtn) {
    dwBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://hydrology.gov.np/#/data_watch" });
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }

  loadData();
});
