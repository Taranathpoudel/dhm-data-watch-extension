# DHM Hydrology — Data Watch & River Watch Telemetry Sorter

A comprehensive Google Chrome Extension (Manifest V3) built for the **Department of Hydrology and Meteorology (DHM) Nepal** portal ([hydrology.gov.np](https://hydrology.gov.np/)).

---

## 🌟 Key Features

### 1. ⏱️ 5-Minute Auto-Refresh & Default River Watch Rising Mode
* **Automated 5-Minute Refresh Cycle**:
  * Automatically reloads the DHM Hydrology portal every 5 minutes (300 seconds) to ensure telemetry and socket data are completely fresh and never stale.
  * Supported by both a live in-tab high-precision countdown timer and a background service worker alarm (`dhm_autorefresh_5min_alarm`).
* **Default Navigation to River Watch (`#/river_watch`)**:
  * Immediately upon every page reload, refresh, or fresh visit, the extension automatically navigates to the **River Watch** view by triggering the tab routing.
* **Automatic 📈 Rising Filter & Sort**:
  * Once on River Watch, the extension automatically clicks the **[📈 Rising]** button (pill), filtering the table to show river observation stations with rising water levels and ranking highest flood risks first.
* **Live Visual Countdown & Instant Reload**:
  * **River Watch Toolbar**: Live `⏱️ Auto-Refresh: mm:ss` countdown chip with an instant `[🔄]` reload button.
  * **Floating Toggle Widget**: Shows `⏱️ mm:ss` countdown chip at the bottom-right corner of the screen.
  * **Popup & Data Watch**: Live countdown display with 1-click tab reload.

### 2. ⚡ Real-Time Trend Column Shift Detection & Early Reload (Before 5 Min)
* **Continuous Trend Column Surveillance**:
  * While on the River Watch page under the **Rising** section, the extension continuously tracks the **Trend Column** for every rising station using a triple-layer detection system:
    1. **DOM MutationObserver**: Detects instant changes inside `table.watch_table` cells.
    2. **DOM Scanner (every 1.5s)**: Actively validates that all stations in the rising section remain in `RISING` status.
    3. **Live Telemetry Poller (every 15s)**: Checks real-time socket streams from DHM.
* **Early Page Reload on Trend Change (`RISING` → `FALLING` or `STEADY`)**:
  * The moment any station that was previously rising switches to **FALLING (📉)** or **STEADY (➡️)**, the extension detects the change immediately.
  * Displays a prominent red alert toast: `⚡ River Trend Change Detected! Station [Name] changed from RISING to FALLING/STEADY. Reloading River Watch page before 5 min...`
  * Automatically reloads the page **immediately without waiting for the 5-minute timer** to ensure the user always sees an accurate, up-to-the-second rising stations list.

### 3. 🌊 River Watch Table Enhancer & Hazard Level Differences (`#/river_watch`)
* **Dynamic Warning & Danger Level Difference Display in Status Column**:
  * 🟢 **Below Warning Level**: Simultaneously displays the difference to Warning Level AND difference to Danger Level:
    * `⚠️ -X.XXm to Warning` (remaining safety buffer before warning)
    * `🚨 -Y.YYm to Danger` (remaining buffer before danger threshold)
  * 🟡 **Crossed Warning Level (`Water Level > Warning Level`)**:
    * Automatically switches to show the difference to **Danger Level ONLY**:
      * If below Danger: `⚠️ Z.ZZm to Danger`
      * If above Danger: `🚨 +Z.ZZm ABOVE Danger Level`
* **Dedicated Sorting by Water Level vs. Warning Level Difference**:
  * ⚠️ **Closest to Flood / Exceeding Warning First (`diff_warning_desc`)**: Ranks stations highest above or closest to Warning Level first for rapid flood hazard detection.
  * 🛡️ **Safest / Farthest Below Warning First (`diff_warning_asc`)**: Ranks stations with the largest safety buffers first.
  * Click on the **Status** (`⚠️ ⇅`) or **Warning Level** table header to toggle diff sorting directly.
* **Interactive Table Column Sorting**: Click on *any* column header (`<th>`) in the River Watch table:
  * **Trend Heading (📈 ⇅)**: Cycle through **Rising First** (📈 Flood Alert) → **Falling First** (📉 Receding) → **Steady First** (➡️ Normal) → Default DHM Grouping.
  * **Water Level (m)**: Sort by highest water level or lowest water level.
  * **Warning Level & Danger Level**: Sort by highest threshold or level difference.
  * **Hazard Status**: Group by DANGER → WARNING → BELOW WARNING LEVEL.
  * **Station Name, Basin, District, & Index**: Alphabetical (A–Z / Z–A) and numeric index sorting.
  * **Sequential S.N Renumbering**: Serial numbers (1, 2, 3...) re-index automatically after every sort or filter.
* **River Watch Control Toolbar**:
  * Injected directly above `table.watch_table` with live telemetry counters (Total, Near Warning, Rising, Falling, Steady, Alerts).
  * **One-Click Quick Filter Pills**:
    * `[🌊 All Stations]`
    * `[⚠️ Near / Exceeding Warning]` (Instant filter for stations within 1m of or exceeding warning)
    * `[📈 Rising]` (Instant filter for rising water levels)
    * `[📉 Falling]` (Instant filter for receding water levels)
    * `[➡️ Steady]` (Instant filter for stable water levels)
    * `[🚨 Danger / Warning]` (Instant filter for active alert stations)
  * **Live Search**: Instant search across station name, Nepali name, index, basin, and district.
  * **1-Click CSV Export**: Download the currently sorted & filtered River Watch table (including exact Warning and Danger differences) as a CSV file.

---

### 2. 📡 "Data Watch" Navigation Tab (`#/data_watch`)
* Seamlessly injected into the DHM top navigation bar alongside native tabs.
* **10-Minute Reporting Surveillance in Nepal Time (NPT, UTC+5:45)**:
  * Automatically categorizes stations missing telemetry:
    * 🟢 **On-Time (≤ 10 mins)**: Normal reporting cycle.
    * 🟡 **Delayed (> 10m to 30m)**: Missed 1 to 3 cycles.
    * 🟠 **Moderate Delay (> 30m to 1h)**: Multiple missed cycles.
    * 🔴 **Critical Outage (> 1h to 24h)**: Urgent attention required.
    * ⚪ **Offline (> 24h / No Data)**: Inactive station.
* **Sort Options**:
  * ⏳ Longest Delay First (Missing 10-minute intervals)
  * ⚡ Shortest Delay First
  * ⚠️ Warning Level Diff (Closest to Flood First)
  * 🛡️ Warning Level Diff (Safest / Farthest Below First)
  * 📈 Trend: Rising First
  * 📉 Trend: Falling First
  * ➡️ Trend: Steady First
  * 🌊 Water Level (Highest First)
  * 🕒 Last Updated Time (Newest / Oldest)
  * 🔤 Station Name (A–Z / Z–A), Basin, & District
* **Live Nepal Digital Clock**: Displays ticking `HH:mm:ss A NPT` with date.
* **KPI Dashboard**: Total Stations, Delayed Count (%), Critical Count, On-Time Count, and Health Score (%).

---

### 3. 🧩 Toolbar Action Popup
* Click the extension icon in Chrome for an immediate overview:
  * Current Nepal Time clock.
  * Live Trend counters: **Rising (📈)**, **Falling (📉)**, **Steady (➡️)**.
  * Live Delay counters: **Delayed (>10m)**, **Critical (>1h)**, **On-Time (≤10m)**.
  * Water level & warning/danger gap badges in station search list.
  * Quick links to **River Watch** and **Data Watch**.

---

## 📂 File Architecture

```
dhm-data-watch-extension/
├── manifest.json              # Chrome Manifest V3 configuration
├── README.md                  # Detailed documentation
├── icons/                     # Extension branding icons (16x16, 48x48, 128x128, svg)
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── icon.svg
└── src/
    ├── content.js             # Core script: River Watch sorter, Level difference engine, Data Watch tab
    ├── data-watch.css         # Theme styles, toolbar, warning/danger diff badges & table header indicators
    ├── background.js          # Background service worker & alarm scheduler
    ├── popup.html             # Toolbar popup interface
    ├── popup.js               # Toolbar popup logic, trend & diff snippets
    └── popup.css              # Popup styling
```

---

## 🚀 Installation Guide

1. Open **Google Chrome** (or Edge / Brave / Chromium).
2. Go to `chrome://extensions/` in the address bar.
3. Enable **Developer mode** (toggle switch in the top-right corner).
4. Click **Load unpacked** in the top-left corner.
5. Select the folder:
   ```
   Z:\DHM_Hydrology_Site\dhm-data-watch-extension
   ```
6. Open or reload [https://hydrology.gov.np/](https://hydrology.gov.np/).
7. Navigate to:
   * **River Watch** (`#/river_watch`): Check the Status column for dynamic Warning & Danger differences and sort by clicking headers (Status, Trend, Warning Level, etc.).
   * **Data Watch** (`#/data_watch`): Monitor delayed stations missing 10-minute transmissions.
