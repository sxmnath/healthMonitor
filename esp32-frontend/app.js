"use strict";
// ─── Config ───────────────────────────────────────────────────────────────────
const urlParams       = new URLSearchParams(window.location.search);
const PAGE_PATIENT_ID = urlParams.get("id") || null;
const isPatientId     = PAGE_PATIENT_ID && /^P\d+$/.test(PAGE_PATIENT_ID);

const API = PAGE_PATIENT_ID
  ? isPatientId
    ? `/api/dashboard?patientId=${encodeURIComponent(PAGE_PATIENT_ID)}`
    : `/api/dashboard?deviceId=${encodeURIComponent(PAGE_PATIENT_ID)}`
  : "/api/dashboard";

let hrChart, spo2Chart, tempChart;
let currentFilter    = "1h";
let currentPatientId = PAGE_PATIENT_ID;
let currentDeviceId  = null;

// ─── Client-side Signal Processing ───────────────────────────────────────────
// Note: server already applies moving average + noise rejection before storing.
// Here we apply a LIGHTER smoothing only for the live stream display so the
// UI doesn't jump on individual WebSocket frames before they hit the DB.
const MA_WIN = 3;
const hrBuf = [], spo2Buf = [], tempBuf = [];
let peakHr = null, minSpo2 = null, peakTempF = null;

function clientSmooth(buf, val) {
  buf.push(val);
  if (buf.length > MA_WIN) buf.shift();
  return Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) * 10) / 10;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const AI_NOTES = {
  "Stress detected":          "Elevated heart rate with normal oxygen suggests stress.",
  "Fever risk":               "High temperature with increased heart rate suggests fever.",
  "Respiratory concern":      "Low oxygen saturation may indicate breathing issues.",
  "SpO₂ sensor disconnected": "Blood oxygen sensor is not connected to the device.",
  "Normal":                   "All vitals are within healthy ranges.",
};

function getVitalStatus(type, value) {
  if (type === "hr") {
    if (value < 50)   return { level: "critical", text: "Bradycardia",  icon: "fa-triangle-exclamation" };
    if (value <= 100) return { level: "normal",   text: "Normal",       icon: "fa-circle-check"         };
    if (value <= 120) return { level: "warning",  text: "Tachycardia",  icon: "fa-circle-exclamation"   };
    return                   { level: "critical", text: "Critical HR",  icon: "fa-triangle-exclamation" };
  }
  if (type === "spo2") {
    if (value > 95)  return { level: "normal",   text: "Normal",   icon: "fa-circle-check"        };
    if (value >= 92) return { level: "warning",  text: "Low",      icon: "fa-circle-exclamation"  };
    return                  { level: "critical", text: "Critical", icon: "fa-triangle-exclamation" };
  }
  if (type === "temp") {   // °F  [97°F–99.5°F normal; <97 = hypothermic; >=100.4 = fever]
    if (value < 95)    return { level: "critical", text: "Hypothermic",  icon: "fa-triangle-exclamation" };
    if (value < 97)    return { level: "warning",  text: "Low Temp",     icon: "fa-circle-exclamation"   };
    if (value < 100.4) return { level: "normal",   text: "Normal",       icon: "fa-circle-check"         };
    if (value <= 102)  return { level: "warning",  text: "Mild Fever",   icon: "fa-circle-exclamation"   };
    return                    { level: "critical", text: "High Fever",   icon: "fa-triangle-exclamation" };
  }
}

// ─── WS indicator ─────────────────────────────────────────────────────────────
function setWsStatus(state) {
  const dot  = document.getElementById("wsDot");
  const text = document.getElementById("wsText");
  if (!dot || !text) return;
  const map = {
    connected:    { color: "#3dab6e", label: "Live"          },
    disconnected: { color: "#e05c5c", label: "Reconnecting…" },
    connecting:   { color: "#e09a3c", label: "Connecting…"   },
  };
  const s = map[state] || map.connecting;
  dot.style.background = s.color;
  text.innerText        = s.label;
}

// ─── Render vitals ─────────────────────────────────────────────────────────────
// `raw` now contains { heartRate, spo2, temperatureF } — already processed by server
function renderVitals(raw, time) {
  // Light client-side smoothing for live stream visual stability
  const hr    = raw.heartRate    != null ? clientSmooth(hrBuf,   raw.heartRate)    : null;
  const spo2  = raw.spo2;   // -1 = not connected — do NOT smooth sentinel
  const spo2v = spo2 === -1 ? -1 : (spo2 != null ? clientSmooth(spo2Buf, spo2) : null);
  const tempF = raw.temperatureF != null ? clientSmooth(tempBuf, raw.temperatureF) : null;

  // Peak tracking (session highs/lows)
  if (hr    != null && (peakHr    === null || hr    > peakHr))    peakHr    = hr;
  if (tempF != null && (peakTempF === null || tempF > peakTempF)) peakTempF = tempF;
  if (spo2v !== -1 && spo2v != null && (minSpo2 === null || spo2v < minSpo2)) minSpo2 = spo2v;

  // ── Heart Rate card ────────────────────────────────────────────────────────
  if (hr != null) {
    const st   = getVitalStatus("hr", hr);
    const card = document.getElementById("card-hr");
    const valEl  = document.getElementById("hr");
    const statEl = document.getElementById("status-hr");
    if (valEl)  valEl.innerText   = hr;
    if (statEl) { statEl.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; statEl.className = `vc-status status-${st.level}`; }
    if (card)   card.className    = `vital-card card-${st.level}`;
    const bar = document.getElementById("bar-hr");
    if (bar) bar.style.width = `${Math.min(100, (hr / 200) * 100)}%`;
    const pk = document.getElementById("peak-hr");
    if (pk) pk.innerText = peakHr !== null ? `${peakHr} bpm` : "--";
  }

  // ── SpO2 card ──────────────────────────────────────────────────────────────
  const spo2Card  = document.getElementById("card-spo2");
  const spo2ValEl = document.getElementById("spo2");
  const spo2Stat  = document.getElementById("status-spo2");
  const spo2Bar   = document.getElementById("bar-spo2");
  const spo2Pk    = document.getElementById("peak-spo2");

  if (spo2v === -1) {
    if (spo2ValEl) spo2ValEl.innerText = "—";
    if (spo2Stat)  { spo2Stat.innerHTML = '<i class="fa-solid fa-hand-pointer"></i> Place finger on sensor'; spo2Stat.className = "vc-status status-disconnected"; }
    if (spo2Card)  spo2Card.className   = "vital-card card-disconnected";
    if (spo2Bar)   spo2Bar.style.width  = "0%";
    if (spo2Pk)    spo2Pk.innerText     = "—";
  } else if (spo2v != null) {
    const st = getVitalStatus("spo2", spo2v);
    if (spo2ValEl) spo2ValEl.innerText = spo2v;
    if (spo2Stat)  { spo2Stat.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; spo2Stat.className = `vc-status status-${st.level}`; }
    if (spo2Card)  spo2Card.className   = `vital-card card-${st.level}`;
    if (spo2Bar)   spo2Bar.style.width  = `${Math.max(0, ((spo2v - 80) / 20) * 100)}%`;
    if (spo2Pk)    spo2Pk.innerText     = minSpo2 !== null ? `${minSpo2}%` : "--";
  }

  // ── Temperature card ───────────────────────────────────────────────────────
  if (tempF != null) {
    const st   = getVitalStatus("temp", tempF);
    const card = document.getElementById("card-temp");
    const valEl  = document.getElementById("temp");
    const statEl = document.getElementById("status-temp");
    if (valEl)  valEl.innerText   = tempF;
    if (statEl) { statEl.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; statEl.className = `vc-status status-${st.level}`; }
    if (card)   card.className    = `vital-card card-${st.level}`;
    const bar = document.getElementById("bar-temp");
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((tempF - 90) / 14) * 100))}%`;
    const pk = document.getElementById("peak-temp");
    if (pk) pk.innerText = peakTempF !== null ? `${peakTempF}°F` : "--";
  }

  // ── Status Banner ──────────────────────────────────────────────────────────
  const banner = document.getElementById("statusBanner");
  const label  = document.getElementById("statusLabel");
  if (banner && label) {
    const isCrit = [
      hr    != null && getVitalStatus("hr",   hr).level    === "critical",
      spo2v !== -1  && spo2v != null && getVitalStatus("spo2", spo2v).level === "critical",
      tempF != null && getVitalStatus("temp", tempF).level === "critical",
    ].some(Boolean);
    const isWarn = [
      hr    != null && getVitalStatus("hr",   hr).level    === "warning",
      spo2v !== -1  && spo2v != null && getVitalStatus("spo2", spo2v).level === "warning",
      tempF != null && getVitalStatus("temp", tempF).level === "warning",
    ].some(Boolean);
    if (isCrit)      { banner.className = "status-banner status-critical"; label.innerText = "⚠ Critical — Immediate Attention Required"; }
    else if (isWarn) { banner.className = "status-banner status-warning";  label.innerText = "◉ Warning — Monitor Closely";               }
    else             { banner.className = "status-banner status-normal";   label.innerText = "✓ All Vitals Stable";                       }
  }

  // Timestamps
  const t = new Date(time).toLocaleTimeString();
  ["updated", "footerUpdated"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerText = `Last updated: ${t}`;
  });

  // Live chart update
  const chartLabel = new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  updateLiveCharts(chartLabel, hr, spo2v === -1 ? null : spo2v, tempF, raw.isPeak);
  syncChartColors(hr, spo2v, tempF);

  generateAlerts({ heartRate: hr, spo2: spo2v, temperatureF: tempF });
}

// ─── AI Alerts & Insights — unified engine ────────────────────────────────────
const activeAlerts = new Map();   // keyed vital alerts (real-time, dismissable)
let   aiInsights   = [];          // latest AI indicator strings from fusion

const ALERT_RULES = [
  { key: "hr_low",    check: v => v.heartRate != null && v.heartRate < 50,                                      severity: "critical", icon: "fa-heart-crack",      title: "Bradycardia Detected",   detail: v => `Heart rate ${v.heartRate} bpm (threshold: <50 bpm)` },
  { key: "hr_crit",   check: v => v.heartRate != null && v.heartRate > 120,                                     severity: "critical", icon: "fa-heart-crack",      title: "Critical Tachycardia",   detail: v => `Heart rate ${v.heartRate} bpm (threshold: >120 bpm)` },
  { key: "hr_warn",   check: v => v.heartRate != null && v.heartRate > 100 && v.heartRate <= 120,               severity: "warning",  icon: "fa-heart-pulse",      title: "Elevated Heart Rate",    detail: v => `Heart rate ${v.heartRate} bpm (normal: 50–100 bpm)` },
  { key: "spo2_nc",   check: v => v.spo2 === -1,                                                                severity: "warning",  icon: "fa-hand-pointer",     title: "SpO₂ Sensor",            detail: () => "Please place finger on the sensor" },
  { key: "spo2_crit", check: v => v.spo2 !== -1 && v.spo2 != null && v.spo2 < 92,                              severity: "critical", icon: "fa-lungs",            title: "Critical Low SpO₂",      detail: v => `SpO₂ ${v.spo2}% (critical: <92%)` },
  { key: "spo2_warn", check: v => v.spo2 !== -1 && v.spo2 != null && v.spo2 >= 92 && v.spo2 <= 95,            severity: "warning",  icon: "fa-lungs",            title: "SpO₂ Slightly Low",      detail: v => `SpO₂ ${v.spo2}% (borderline: 92–95%)` },
  { key: "temp_crit", check: v => v.temperatureF != null && v.temperatureF > 102,                               severity: "critical", icon: "fa-temperature-full", title: "High Fever",             detail: v => `Temp ${v.temperatureF}°F (critical: >102°F)` },
  { key: "temp_warn", check: v => v.temperatureF != null && v.temperatureF >= 100.4 && v.temperatureF <= 102,  severity: "warning",  icon: "fa-temperature-half", title: "Mild Fever",             detail: v => `Temp ${v.temperatureF}°F (mild: 100.4–102°F)` },
];

// Update active alerts from latest vitals, then re-render unified panel
function generateAlerts(vitals) {
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  ALERT_RULES.forEach(r => {
    if (r.check(vitals)) {
      if (!activeAlerts.has(r.key))
        activeAlerts.set(r.key, { severity: r.severity, icon: r.icon, title: r.title, detail: r.detail(vitals), time: now });
    } else {
      activeAlerts.delete(r.key);
    }
  });
  renderInsightsPanel();
}

// Update AI insight strings then re-render
function updateAIInsights(indicators) {
  if (!indicators || !indicators.length) return;
  aiInsights = indicators;
  renderInsightsPanel();
}

// ── Unified render: alerts first (dismissable), then AI insights below ────────
function renderInsightsPanel() {
  const list  = document.getElementById("insightsList");
  const badge = document.getElementById("alertBadge");
  if (!list) return;

  const alertCount = activeAlerts.size;
  if (badge) { badge.textContent = alertCount; badge.style.display = alertCount > 0 ? "inline-flex" : "none"; }

  list.innerHTML = "";

  // ── Active vital alerts (dismissable) ──────────────────────────────────────
  if (alertCount === 0) {
    const ok = document.createElement("div");
    ok.className = "alert-empty";
    ok.innerHTML = `<i class="fa-solid fa-circle-check"></i> All vitals normal`;
    list.appendChild(ok);
  } else {
    let delay = 0;
    activeAlerts.forEach((a, key) => {
      const div = document.createElement("div");
      div.className = `alert-item alert-${a.severity}`;
      div.style.animationDelay = `${delay}ms`;
      div.innerHTML = `<i class="fa-solid ${a.icon} alert-icon"></i><div class="alert-body"><div class="alert-title">${a.title}</div><div class="alert-detail">${a.detail}</div></div><span class="alert-time">${a.time}</span><button class="alert-dismiss" onclick="dismissAlert('${key}')"><i class="fa-solid fa-xmark"></i></button>`;
      list.appendChild(div);
      delay += 60;
    });
  }

  // ── AI insights (informational, not dismissable) ───────────────────────────
  if (aiInsights.length && !(aiInsights.length === 1 && aiInsights[0] === "Normal")) {
    const divider = document.createElement("div");
    divider.className = "insights-divider";
    divider.innerHTML = `<span>AI Analysis</span>`;
    list.appendChild(divider);

    aiInsights.forEach((indicator, idx) => {
      const div = document.createElement("div");
      div.className = "fusion-item";
      div.style.animationDelay = `${idx * 60}ms`;
      div.innerHTML = `<i class="fa-solid fa-brain"></i><div class="fusion-item-content"><h4>${indicator}</h4><p>${AI_NOTES[indicator] || ""}</p></div>`;
      list.appendChild(div);
    });
  }
}

function dismissAlert(key) { activeAlerts.delete(key); renderInsightsPanel(); }

// ─── Charts ────────────────────────────────────────────────────────────────────
// Normal-range band: rendered as a second filled dataset behind the data line
// Using the "between datasets" fill trick — no plugin needed.
function makeNormalBand(low, high, points) {
  // Returns two constant datasets that Chart.js fills between
  return {
    low:  { label: "_band_low",  data: points.map(() => low),  borderWidth: 0, pointRadius: 0, fill: false, tension: 0 },
    high: { label: "_band_high", data: points.map(() => high), borderWidth: 0, pointRadius: 0, fill: "-1",  backgroundColor: "rgba(61,171,110,0.07)", tension: 0 },
  };
}

function makeChartOpts({ yLabel, yMin, yMax, tickSuffix, normalLow, normalHigh }) {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: false },
      tooltip: {
        filter: item => item.dataset.label && !item.dataset.label.startsWith("_band"),
        backgroundColor: "#fff", titleColor: "#1a1a2e", bodyColor: "#5a5570",
        borderColor: "#e8e2d8", borderWidth: 1, padding: 10,
        callbacks: { label: ctx => ` ${ctx.parsed.y}${tickSuffix}` },
      },
    },
    scales: {
      x: {
        ticks: { color: "#9b96a8", maxTicksLimit: 8, font: { size: 11 }, maxRotation: 0 },
        grid:  { display: false },                          // ← vertical gridlines OFF
        title: { display: true, text: "Time", color: "#9b96a8", font: { size: 11 } },
      },
      y: {
        min: yMin, max: yMax,
        ticks: { color: "#9b96a8", font: { size: 11 }, callback: v => v + tickSuffix },
        grid:  { color: "rgba(0,0,0,0.035)", drawBorder: false },  // only horizontal
        title: { display: true, text: yLabel, color: "#9b96a8", font: { size: 11 } },
      },
    },
    elements: {
      line:  { tension: 0.4, borderWidth: 2.5 },
      point: { radius: 0, hitRadius: 12, hoverRadius: 5 },
    },
  };
}

function makeChart(id, label, color, opts) {
  const { yMin, yMax, yLabel, tickSuffix, normalLow, normalHigh } = opts;
  // Band datasets are placeholders — filled once real data loads
  const bandLow  = { label: "_band_low",  data: [], borderWidth: 0, pointRadius: 0, fill: false,  tension: 0, backgroundColor: "transparent" };
  const bandHigh = { label: "_band_high", data: [], borderWidth: 0, pointRadius: 0, fill: "-1",   tension: 0, backgroundColor: "rgba(61,171,110,0.07)", borderColor: "transparent" };
  const dataSet  = { label, data: [], borderColor: color, backgroundColor: color + "18", fill: 2, spanGaps: false, order: 0 };
  // order: data line above fill datasets
  bandLow.order  = 2;
  bandHigh.order = 1;

  const chart = new Chart(document.getElementById(id).getContext("2d"), {
    type: "line",
    data: { labels: [], datasets: [dataSet, bandHigh, bandLow] },
    options: makeChartOpts({ yMin, yMax, yLabel, tickSuffix, normalLow, normalHigh }),
  });
  chart._normalLow  = normalLow;
  chart._normalHigh = normalHigh;
  return chart;
}

// Sync band data length to match labels after data load
function syncBands(chart) {
  if (!chart) return;
  const len  = chart.data.labels.length;
  const low  = chart._normalLow;
  const high = chart._normalHigh;
  chart.data.datasets[2].data = Array(len).fill(low);   // bandLow
  chart.data.datasets[1].data = Array(len).fill(high);  // bandHigh
}

function initCharts() {
  hrChart   = makeChart("hrChart",   "Heart Rate",  "#5b8dee", { yLabel: "bpm", yMin: 30,  yMax: 200, tickSuffix: " bpm", normalLow: 60,  normalHigh: 100 });
  spo2Chart = makeChart("spo2Chart", "SpO₂",        "#4ab3c8", { yLabel: "%",   yMin: 80,  yMax: 100, tickSuffix: "%",    normalLow: 95,  normalHigh: 100 });
  tempChart = makeChart("tempChart", "Temperature", "#e0963c", { yLabel: "°F",  yMin: 90,  yMax: 104, tickSuffix: "°F",   normalLow: 97,  normalHigh: 100.4 });
}

// ── Dynamic chart line coloring ───────────────────────────────────────────────
// Blue = normal, amber = warning, red = critical. Removed from "safe" reads.
const CHART_COLORS = {
  normal:   { line: "#5b8dee", fill: "#5b8dee18" },
  warning:  { line: "#e09a3c", fill: "#e09a3c18" },
  critical: { line: "#e05c6e", fill: "#e05c6e18" },
};

function updateChartColor(chart, level) {
  if (!chart) return;
  const c = CHART_COLORS[level] || CHART_COLORS.normal;
  chart.data.datasets[0].borderColor     = c.line;
  chart.data.datasets[0].backgroundColor = c.fill;
  // Don't call update here — caller will do it to batch
}

function syncChartColors(hr, spo2, tempF) {
  if (hr != null) {
    const lvl = getVitalStatus("hr", hr).level;
    updateChartColor(hrChart, lvl);
    // Also update the chart label dot in HTML
    const dot = document.getElementById("hrChartDot");
    if (dot) dot.style.background = CHART_COLORS[lvl]?.line || "#5b8dee";
    if (hrChart) hrChart.update("none");
  }
  // SpO2 and temp keep their dedicated colors (teal/amber) — only shade shifts
  if (spo2 != null && spo2 !== -1) {
    const lvl = getVitalStatus("spo2", spo2).level;
    updateChartColor(spo2Chart, lvl === "normal" ? "normal" : lvl);
    if (spo2Chart) spo2Chart.update("none");
  }
  if (tempF != null) {
    const lvl = getVitalStatus("temp", tempF).level;
    updateChartColor(tempChart, lvl);
    if (tempChart) tempChart.update("none");
  }
}

// Append a single new data point to whichever historical chart is active.
// This keeps both the 1h and 24h charts live without re-fetching all data.
function appendToActiveChart(time, hr, spo2, tempF) {
  const label = new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const longLabel = new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const chartLabel = currentFilter === "1h" ? label : longLabel;

  [
    { c: hrChart,   v: hr   },
    { c: spo2Chart, v: spo2 === -1 ? null : spo2 },
    { c: tempChart, v: tempF },
  ].forEach(({ c, v }) => {
    if (!c) return;
    c.data.labels.push(chartLabel);
    c.data.datasets[0].data.push(v ?? null);
    // Extend band arrays to match
    if (c.data.datasets[2]) c.data.datasets[2].data.push(c._normalLow);
    if (c.data.datasets[1]) c.data.datasets[1].data.push(c._normalHigh);

    // Trim to window
    const maxPoints = currentFilter === "1h" ? 720 : 17280;
    while (c.data.labels.length > maxPoints) {
      c.data.labels.shift();
      c.data.datasets[0].data.shift();
      if (c.data.datasets[1]) c.data.datasets[1].data.shift();
      if (c.data.datasets[2]) c.data.datasets[2].data.shift();
    }
    c.update("none");
  });
}

function updateLiveCharts() {
  // (kept as no-op stub — live appending is handled by appendToActiveChart)
}

// ─── Historical Data — THE FIX ────────────────────────────────────────────────
// Uses the new /api/patients/:id/history?range=1h|24h endpoint.
// The server stores temperatureF directly so no conversion needed here.
async function fetchHistoricalData(range) {
  const pid = currentPatientId;
  if (!pid) { console.warn("[history] No patient ID"); return; }

  showChartLoading(true);
  try {
    const res    = await authFetch(`/api/patients/${encodeURIComponent(pid)}/history?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    if (!result.data || result.data.length === 0) {
      showChartEmpty(range);
      return;
    }

    const labels = [], hrD = [], spo2D = [], tempD = [];
    result.data.forEach(d => {
      // For 1h: show HH:MM:SS; for 24h: show HH:MM
      const opts = range === "1h"
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
        : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
      labels.push(new Date(d.time).toLocaleString([], opts));
      hrD.push(d.heartRate ?? null);
      spo2D.push(d.spo2 === -1 ? null : (d.spo2 ?? null));
      tempD.push(d.temperatureF ?? null);
    });

    [
      { c: hrChart,   d: hrD   },
      { c: spo2Chart, d: spo2D },
      { c: tempChart, d: tempD },
    ].forEach(({ c, d }) => {
      if (!c) return;
      c.data.labels           = labels;
      c.data.datasets[0].data = d;
      syncBands(c);    // keep normal-range band same length as data
      c.update();
    });
  } catch (e) {
    console.error("[fetchHistoricalData]", e);
    showChartEmpty(range);
  } finally {
    showChartLoading(false);
  }
}

function showChartLoading(on) {
  const el = document.getElementById("chartLoadingMsg");
  if (el) el.style.display = on ? "flex" : "none";
}

function showChartEmpty(range) {
  const label = range === "1h" ? "last 1 hour" : "last 24 hours";
  const el    = document.getElementById("chartEmptyMsg");
  if (el) { el.textContent = `No data for the ${label}. Data will appear here once the sensor sends readings.`; el.style.display = "block"; }
}

// ─── Patient Profile ───────────────────────────────────────────────────────────
let patientProfile = {};

function renderProfile(p) {
  patientProfile = p || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val || "—"; };
  const name = p.name || p.patient_id || PAGE_PATIENT_ID || "Patient";
  set("patientName",   name);
  set("bcPatientName", name);
  document.title = `${name} — HealthMonitor`;
  set("patientId",    p.patient_id || PAGE_PATIENT_ID);
  set("pf-room",      p.roomNo);
  set("pf-ward",      p.ward);
  set("pf-age",       p.age       ? `${p.age} yrs`  : null);
  set("pf-gender",    p.gender);
  set("pf-blood",     p.bloodType);
  set("pf-weight",    p.weight    ? `${p.weight} kg` : null);
  set("pf-height",    p.height    ? `${p.height} cm` : null);
  set("pf-physician", p.physician);
  set("pf-diagnosis", p.diagnosis);
  set("pf-phone",     p.phone);
  set("pf-notes",     p.notes);
}

async function loadPatientProfile() {
  if (!PAGE_PATIENT_ID || !isPatientId) return;
  try {
    const res = await authFetch(`/api/patients/${encodeURIComponent(PAGE_PATIENT_ID)}`);
    if (!res.ok) return;
    const p = await res.json();
    renderProfile(p);
    currentDeviceId = p.deviceId;
  } catch (e) { console.warn("Profile load failed:", e); }
}

// ─── Edit Modal ────────────────────────────────────────────────────────────────
function openEditModal() {
  const p = patientProfile;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  setVal("f-name", p.name);       setVal("f-age", p.age);           setVal("f-gender", p.gender);
  setVal("f-bloodType", p.bloodType); setVal("f-weight", p.weight); setVal("f-height", p.height);
  setVal("f-roomNo", p.roomNo);   setVal("f-ward", p.ward);         setVal("f-physician", p.physician);
  setVal("f-diagnosis", p.diagnosis); setVal("f-phone", p.phone);   setVal("f-notes", p.notes);
  document.getElementById("editModal")?.classList.add("open");
}

function closeEditModal() {
  document.getElementById("editModal")?.classList.remove("open");
}

async function saveModal() {
  const g  = id => document.getElementById(id)?.value?.trim();
  const gn = id => { const v = document.getElementById(id)?.value; return v ? Number(v) : undefined; };
  const data = {
    name: g("f-name"), age: gn("f-age"), gender: g("f-gender"), bloodType: g("f-bloodType"),
    weight: gn("f-weight"), height: gn("f-height"), roomNo: g("f-roomNo"), ward: (g("f-ward") || "").trim(),
    physician: g("f-physician"), diagnosis: g("f-diagnosis"), phone: g("f-phone"),
    notes: document.getElementById("f-notes")?.value?.trim(),
  };
  const btn = document.getElementById("modalSave");
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
    const res = await authFetch(`/api/patients/${encodeURIComponent(PAGE_PATIENT_ID)}`, {
      method: "PATCH", body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Save failed");
    const updated = await res.json();
    renderProfile(updated);
    closeEditModal();
  } catch { alert("Failed to save. Please try again."); }
  finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Save Changes'; }
  }
}

// ─── Toast helper ─────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  const toast = document.getElementById("resultToast");
  if (!toast) return;
  const icon = toast.querySelector(".toast-icon");
  document.getElementById("toastMsg").textContent = msg;
  toast.classList.toggle("toast-error", isError);
  if (icon) icon.className = `fa-solid ${isError ? "fa-circle-xmark" : "fa-circle-check"} toast-icon`;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3500);
}

// ─── Reset Patient Data — in-page modal confirm ────────────────────────────────
function resetPatientData() {
  const pid  = currentPatientId || PAGE_PATIENT_ID;
  if (!pid) return;
  const name = patientProfile.name || pid;

  // Populate and open the confirm modal
  const bodyEl = document.getElementById("confirmBodyText");
  if (bodyEl) bodyEl.textContent = `You are about to fully reset "${name}".`;

  const modal = document.getElementById("resetConfirmModal");
  modal?.classList.add("open");
}

async function executeReset() {
  const pid = currentPatientId || PAGE_PATIENT_ID;
  if (!pid) return;

  const btn = document.getElementById("confirmResetBtn");
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Resetting…'; }

  document.getElementById("resetConfirmModal")?.classList.remove("open");

  try {
    // 1. Delete all sensor/vitals data
    const dataRes = await authFetch(`/api/patients/${encodeURIComponent(pid)}/data`, { method: "DELETE" });
    const dataR   = await dataRes.json();

    // 2. Clear all profile fields (keeps device registration)
    const profRes = await authFetch(`/api/patients/${encodeURIComponent(pid)}/profile`, { method: "DELETE" });
    if (!profRes.ok) throw new Error("Profile reset failed");
    const resetProfile = await profRes.json();

    // 3. Clear charts
    [hrChart, spo2Chart, tempChart].forEach(c => {
      if (!c) return;
      c.data.labels = []; c.data.datasets[0].data = []; syncBands(c); c.update();
    });

    // 4. Clear signal processing buffers and peaks
    hrBuf.length = 0; spo2Buf.length = 0; tempBuf.length = 0;
    peakHr = null; minSpo2 = null; peakTempF = null;

    // 5. Clear alerts and insights panel
    activeAlerts.clear(); aiInsights = []; renderInsightsPanel();

    // 6. Blank the profile UI
    renderProfile(resetProfile);

    showToast(`Reset complete — ${dataR.deleted || 0} records deleted.`);
  } catch (e) {
    console.error("[executeReset]", e);
    showToast("Reset failed. Check server connection.", true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-trash"></i> Reset Everything'; }
  }
}

// ─── Dashboard poll (fallback when WebSocket misses a frame) ──────────────────
async function loadDashboard() {
  try {
    const res  = await authFetch(API);
    const data = await res.json();
    if (data.message === "No data yet" || data.error) return;

    currentDeviceId  = data.deviceId;
    currentPatientId = data.patient_id || PAGE_PATIENT_ID;

    if (!patientProfile.name && data.name) {
      renderProfile({ ...data, patient_id: currentPatientId });
    }

    // AI Insights → merged panel
    if (data.fusion?.indicators) updateAIInsights(data.fusion.indicators);

    // data.vitals now uses temperatureF from the new server
    renderVitals(data.vitals, data.time);
  } catch (e) { console.warn("[poll]", e.message); }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchCurrentUser();
  initCharts();
  setWsStatus("connecting");
  loadPatientProfile();

  // WebSocket
  const socket = io();
  socket.on("connect", () => {
    setWsStatus("connected");
    if (PAGE_PATIENT_ID) socket.emit("join-patient", PAGE_PATIENT_ID);
  });
  socket.on("disconnect", () => setWsStatus("disconnected"));
  socket.on("vitals-update", doc => {
    currentDeviceId  = doc.deviceId;
    currentPatientId = doc.patient_id || PAGE_PATIENT_ID;
    // doc now has temperatureF directly from server
    const vTime = doc.time || new Date();
    renderVitals(
      { heartRate: doc.heartRate, spo2: doc.spo2, temperatureF: doc.temperatureF, isPeak: doc.isPeak },
      vTime
    );
    // Append new point to the active historical chart in real time
    appendToActiveChart(vTime, doc.heartRate, doc.spo2, doc.temperatureF);
    // AI insights → merged panel
    if (doc.fusion?.indicators) updateAIInsights(doc.fusion.indicators);
  });

  // Poll fallback every 5s
  setInterval(loadDashboard, 5000);
  loadDashboard();

  // Alerts
  document.getElementById("clearAlertsBtn")?.addEventListener("click", () => {
    activeAlerts.clear(); renderInsightsPanel();
  });

  // Time filter buttons (1h / 24h only)
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      currentFilter = e.currentTarget.dataset.filter;
      const emptyEl = document.getElementById("chartEmptyMsg");
      if (emptyEl) emptyEl.style.display = "none";
      fetchHistoricalData(currentFilter);  // "1h" or "24h"
    });
  });

  // Auto-load 1h on page open
  fetchHistoricalData("1h");

  // Sidebar collapse toggle
  document.getElementById("sidebarToggle")?.addEventListener("click", () => {
    const sb = document.getElementById("sidebar");
    sb?.classList.toggle("collapsed");
  });

  // Edit modal
  document.getElementById("editBtn")?.addEventListener("click", openEditModal);
  document.getElementById("modalClose")?.addEventListener("click", closeEditModal);
  document.getElementById("modalCancel")?.addEventListener("click", closeEditModal);
  document.getElementById("modalSave")?.addEventListener("click", saveModal);
  document.getElementById("editModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeEditModal();
  });

  // Reset button — opens confirm modal
  document.getElementById("resetDataBtn")?.addEventListener("click", resetPatientData);

  // Confirm modal buttons
  document.getElementById("confirmResetBtn")?.addEventListener("click", executeReset);
  document.getElementById("confirmCancelBtn")?.addEventListener("click", () => {
    document.getElementById("resetConfirmModal")?.classList.remove("open");
  });
  document.getElementById("resetConfirmModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget)
      document.getElementById("resetConfirmModal")?.classList.remove("open");
  });
});
