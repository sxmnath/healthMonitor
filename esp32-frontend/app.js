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
  "Elevated activity":        "High movement combined with an elevated heart rate — likely physical exertion, not distress.",
  "Exertional desaturation":  "Oxygen saturation dropped during a period of high activity — worth monitoring closely.",
  "Prolonged immobility":     "No movement detected while lying down — may indicate pressure injury risk.",
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
// `raw` now contains { heartRate, spo2, temperatureF, ecgHeartRate, ... } — already processed by server
// Returns { hr, ecgLeadsOff } so callers (WS handler) can feed the same merged
// heart-rate value into the live chart without recomputing the ECG/legacy merge.
function renderVitals(raw, time) {
  // ── Heart rate source resolution ─────────────────────────────────────────
  // ECG (AD8232) is the primary HR source once a device sends ecgHeartRate.
  // ecgHeartRate === -1  → leads are on the device but not making contact (leads-off state)
  // ecgHeartRate == null → this device hasn't been upgraded with ECG yet — fall back
  //                         to the legacy MAX30102-derived heartRate field
  const ecgSent     = raw.ecgHeartRate != null;
  const ecgLeadsOff = raw.ecgHeartRate === -1;
  const hrSourceRaw = ecgSent && !ecgLeadsOff ? raw.ecgHeartRate : (ecgSent ? null : raw.heartRate);

  // Light client-side smoothing for live stream visual stability
  const hr    = hrSourceRaw != null ? clientSmooth(hrBuf, hrSourceRaw) : null;
  const spo2  = raw.spo2;   // -1 = not connected — do NOT smooth sentinel
  const spo2v = spo2 === -1 ? -1 : (spo2 != null ? clientSmooth(spo2Buf, spo2) : null);
  const tempF = raw.temperatureF != null ? clientSmooth(tempBuf, raw.temperatureF) : null;

  // Peak tracking (session highs/lows)
  if (hr    != null && !ecgLeadsOff && (peakHr === null || hr > peakHr)) peakHr = hr;
  if (tempF != null && (peakTempF === null || tempF > peakTempF)) peakTempF = tempF;
  if (spo2v !== -1 && spo2v != null && (minSpo2 === null || spo2v < minSpo2)) minSpo2 = spo2v;

  // ── Heart Rate card (ECG primary, MAX30102 legacy fallback) ─────────────────
  const hrCard  = document.getElementById("card-hr");
  const hrValEl = document.getElementById("hr");
  const hrStat  = document.getElementById("status-hr");
  const hrBar   = document.getElementById("bar-hr");
  const hrPk    = document.getElementById("peak-hr");

  if (ecgLeadsOff) {
    if (hrValEl) hrValEl.innerText  = "—";
    if (hrStat)  { hrStat.innerHTML = '<i class="fa-solid fa-hand-pointer"></i> Leads off — attach electrodes'; hrStat.className = "vc-status status-disconnected"; }
    if (hrCard)  hrCard.className   = "vital-card card-disconnected";
    if (hrBar)   hrBar.style.width  = "0%";
    if (hrPk)    hrPk.innerText     = peakHr !== null ? `${peakHr} bpm` : "--";
  } else if (hr != null) {
    const st = getVitalStatus("hr", hr);
    if (hrValEl) hrValEl.innerText  = hr;
    if (hrStat)  { hrStat.innerHTML = `<i class="fa-solid ${st.icon}"></i> ${st.text}`; hrStat.className = `vc-status status-${st.level}`; }
    if (hrCard)  hrCard.className   = `vital-card card-${st.level}`;
    if (hrBar)   hrBar.style.width  = `${Math.min(100, (hr / 200) * 100)}%`;
    if (hrPk)    hrPk.innerText     = peakHr !== null ? `${peakHr} bpm` : "--";
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

  // ── Activity card (Part 7) ───────────────────────────────────────────────
  renderActivity(raw.activityScore, raw.posture, raw.motionDetected);

  // Live chart update
  const chartLabel = new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  updateLiveCharts(chartLabel, hr, spo2v === -1 ? null : spo2v, tempF, raw.isPeak);
  syncChartColors(hr, spo2v, tempF);

  generateAlerts({ heartRate: hr, spo2: spo2v, temperatureF: tempF, ecgLeadsOff });

  return { hr: ecgLeadsOff ? null : hr, ecgLeadsOff };
}

// ── Activity card ──────────────────────────────────────────────────────────
// posture icons: upright → walking figure, lateral → seated/side figure,
// supine → bed icon, unknown → question mark (MPU6050 not connected/no data)
function postureIconClass(posture) {
  if (posture === "supine")  return "fa-bed";
  if (posture === "lateral") return "fa-person";
  if (posture === "upright") return "fa-person-walking";
  return "fa-circle-question";
}

function renderActivity(activityScore, posture, motionDetected) {
  if (activityScore == null) return;   // MPU6050 not wired yet on this node — leave placeholders

  const score = Math.round(activityScore);
  const card  = document.getElementById("card-activity");
  const valEl = document.getElementById("activityScore");
  const statEl = document.getElementById("status-activity");
  const bar   = document.getElementById("bar-activity");

  let level, text, icon;
  if (score > 70)      { level = "warning"; text = "High Activity"; icon = "fa-person-running"; }
  else if (score > 30) { level = "normal";  text = "Active";        icon = "fa-person-walking"; }
  else                 { level = "normal";  text = "Resting";       icon = "fa-bed"; }

  if (valEl)  valEl.innerText = score;
  if (statEl) { statEl.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`; statEl.className = `vc-status status-${level}`; }
  if (card)   card.className  = `vital-card card-${level}`;
  if (bar)    bar.style.width = `${Math.min(100, score)}%`;

  const postureIcon = document.getElementById("postureIcon");
  const postureText = document.getElementById("postureText");
  const motionDot   = document.getElementById("motionDot");
  if (postureIcon) postureIcon.className = `fa-solid ${postureIconClass(posture)}`;
  if (postureText) postureText.innerText = posture && posture !== "unknown"
    ? posture.charAt(0).toUpperCase() + posture.slice(1)
    : "Unknown";
  if (motionDot) motionDot.className = `motion-dot ${motionDetected ? "motion-active" : "motion-still"}`;
}

// ─── AI Alerts & Insights — unified engine ────────────────────────────────────
const activeAlerts = new Map();   // keyed vital alerts (real-time, dismissable)
let   aiInsights   = [];          // latest AI indicator strings from fusion

const ALERT_RULES = [
  { key: "ecg_leads_off", check: v => v.ecgLeadsOff === true,                                                   severity: "warning",  icon: "fa-hand-pointer",     title: "ECG Leads Off",          detail: () => "Attach electrodes to resume ECG heart rate monitoring" },
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

// ── Live ECG Waveform (Serial-Plotter-style canvas trace) ────────────────────────
// Raw AD8232 samples relayed live via the "ecg-waveform" WS event — a plain
// <canvas> rather than Chart.js, since this is a raw autoscaled trace redrawn
// wholesale on each burst rather than a sparse time-series line.
let _ecgWaveformStaleTimer = null;

function initEcgWaveformCanvas() {
  const canvas = document.getElementById("ecgWaveformCanvas");
  const wrap   = document.getElementById("ecgWaveformCanvas")?.parentElement;
  if (!canvas || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  canvas.style.width  = rect.width  + "px";
  canvas.style.height = rect.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawEcgGrid(ctx, rect.width, rect.height);
}

function drawEcgGrid(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(232, 84, 122, 0.12)";
  ctx.lineWidth = 1;
  const cols = 12, rows = 6;
  for (let i = 0; i <= cols; i++) {
    const x = (w / cols) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    const y = (h / rows) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

function renderEcgWaveform(data) {
  const canvas = document.getElementById("ecgWaveformCanvas");
  const empty  = document.getElementById("ecgWaveformEmpty");
  const dot    = document.getElementById("ecgLiveDot");
  const meta   = document.getElementById("ecgWaveformMeta");
  if (!canvas) return;

  const samples = Array.isArray(data.samples) ? data.samples : [];

  if (_ecgWaveformStaleTimer) clearTimeout(_ecgWaveformStaleTimer);

  if (!samples.length) {
    // Leads off — mirrors the HR card's disconnected treatment
    if (empty)  empty.style.display  = "flex";
    if (canvas) canvas.style.opacity = "0.15";
    if (dot)    dot.className = "live-dot live-dot-off";
    if (meta)   meta.textContent = "No signal — leads off";
    return;
  }

  if (empty)  empty.style.display  = "none";
  if (canvas) canvas.style.opacity = "1";
  if (dot)    dot.className = "live-dot live-dot-on";
  if (meta)   meta.textContent = `${data.sampleRate || 50} Hz · updated ${new Date(data.time || Date.now()).toLocaleTimeString()}`;

  const wrap = canvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(rect.width * dpr)) initEcgWaveformCanvas();

  const ctx = canvas.getContext("2d");
  const w = rect.width, h = rect.height;
  drawEcgGrid(ctx, w, h);

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const pad = Math.max(20, (max - min) * 0.15); // headroom so peaks don't clip
  const lo  = min - pad, hi = max + pad;
  const range = Math.max(1, hi - lo);

  ctx.strokeStyle = "#e8547a";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  samples.forEach((v, i) => {
    const x = samples.length > 1 ? (i / (samples.length - 1)) * w : w / 2;
    const y = h - ((v - lo) / range) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // If no new burst arrives for a while (WS hiccup, device offline), fall
  // back to the leads-off/no-signal state rather than showing a frozen trace.
  _ecgWaveformStaleTimer = setTimeout(() => {
    if (dot)  dot.className = "live-dot live-dot-off";
    if (meta) meta.textContent = "No recent signal";
    if (canvas) canvas.style.opacity = "0.15";
    if (empty) empty.style.display = "flex";
  }, 12000);
}

function initCharts() {
  hrChart   = makeChart("hrChart",   "Heart Rate (ECG)", "#5b8dee", { yLabel: "bpm", yMin: 30,  yMax: 200, tickSuffix: " bpm", normalLow: 60,  normalHigh: 100 });
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
      // ECG primary / legacy MAX30102 fallback — same rule as the live card.
      // ecgHeartRate === -1 (leads off) renders as a gap, not a fallback value.
      const ecgVal = d.ecgHeartRate;
      const hrVal  = ecgVal == null ? (d.heartRate ?? null) : (ecgVal === -1 ? null : ecgVal);
      hrD.push(hrVal);
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
  renderAbhaSection();
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
  cancelAbhaLink();
  renderAbhaSection();
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
    weight: gn("f-weight"), height: gn("f-height"), roomNo: g("f-roomNo"), ward: g("f-ward"),
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

// ─── Post-discharge data wipe ──────────────────────────────────────────────────
// Deletes this patient's vitals history AND profile fields (keeps the
// patient_id/device registration so the bed can be reused for the next
// patient). Previously a separate "Reset All Data" button+modal — folded
// into Discharge & Export since running one without the other rarely made
// sense: you don't discharge someone and leave their data live, and you
// don't wipe someone's data without it being a discharge.
async function wipePatientDataAndProfile(pid) {
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

  // Reset activity card to its placeholder state
  const activityCard = document.getElementById("card-activity");
  if (activityCard) activityCard.className = "vital-card";
  const activityValEl = document.getElementById("activityScore");
  if (activityValEl) activityValEl.innerText = "--";

  // 5. Clear alerts and insights panel
  activeAlerts.clear(); aiInsights = []; renderInsightsPanel();

  // 6. Blank the profile UI
  renderProfile(resetProfile);

  return dataR.deleted || 0;
}

// ─── Discharge & Export (Stage 3 trigger + data wipe) ───────────────────────────
// One button, one route: generates + downloads the PDF discharge summary,
// fires the ABHA push in the background if linked, then wipes this
// patient's vitals + profile so the bed is ready for the next admission.
function dischargePatient() {
  const pid = PAGE_PATIENT_ID;
  if (!pid) { showToast("No patient loaded.", true); return; }

  const p = patientProfile || {};

  const textEl = document.getElementById("dischargeConfirmText");
  if (textEl) textEl.textContent = `You are about to discharge "${p.name || pid}". This will:`;

  const abhaLi = document.getElementById("dischargeConfirmAbha");
  if (abhaLi) abhaLi.style.display = p.abhaLinked ? "flex" : "none";

  document.getElementById("dischargeConfirmModal")?.classList.add("open");
}

function closeDischargeModal() {
  document.getElementById("dischargeConfirmModal")?.classList.remove("open");
}

async function executeDischarge() {
  const pid = PAGE_PATIENT_ID;
  if (!pid) return;

  closeDischargeModal();

  const btn = document.getElementById("dischargeBtn");
  const confirmBtn = document.getElementById("dischargeConfirmBtn");
  try {
    if (btn)         { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…'; }
    if (confirmBtn)  { confirmBtn.disabled = true; }

    const res = await authFetch(`/api/patients/${encodeURIComponent(pid)}/discharge`, { method: "POST" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "Discharge export failed");
    }

    const abhaPushStatus = res.headers.get("X-Abha-Push");
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `discharge-${pid}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);

    if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Clearing patient data…';
    const deletedCount = await wipePatientDataAndProfile(pid);

    showToast(
      `Discharge summary downloaded${abhaPushStatus === "queued" ? " — ABHA push in progress" : ""}. ` +
      `${deletedCount} record${deletedCount === 1 ? "" : "s"} cleared.`
    );
  } catch (e) {
    console.error("[executeDischarge]", e);
    showToast("Discharge export failed: " + e.message, true);
  } finally {
    if (btn)        { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-file-export"></i> Discharge &amp; Export'; }
    if (confirmBtn) { confirmBtn.disabled = false; }
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
    renderVitals(
      {
        ...data.vitals,
        ecgHeartRate: data.ecgHeartRate, activityScore: data.activityScore,
        posture: data.posture, motionDetected: data.motionDetected,
      },
      data.time
    );
  } catch (e) { console.warn("[poll]", e.message); }
}

// ─── Share with Family ────────────────────────────────────────────────────────
var _shareUrl = "";

async function shareFamily() {
  var pid = PAGE_PATIENT_ID;
  if (!pid) { showToast("No patient loaded.", true); return; }

  var box = document.getElementById("shareUrlBox");
  if (box) box.textContent = "Generating link…";

  // Open modal immediately so user sees it working
  var modal = document.getElementById("shareModal");
  if (modal) modal.classList.add("open");

  try {
    var res  = await authFetch("/api/patients/" + encodeURIComponent(pid) + "/viewer-link", { method: "POST" });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to generate link");
    _shareUrl = data.url;
    if (box) box.textContent = _shareUrl;
  } catch (e) {
    console.error("[shareFamily]", e);
    if (box) box.textContent = "Error: " + e.message;
  }
}

async function revokeAccess() {
  var pid = PAGE_PATIENT_ID;
  if (!pid) return;

  try {
    var res = await authFetch("/api/patients/" + encodeURIComponent(pid) + "/viewer-link", { method: "DELETE" });
    if (!res.ok) { var d = await res.json(); throw new Error(d.error || "Revoke failed"); }
    _shareUrl = "";
    var box = document.getElementById("shareUrlBox");
    if (box) box.textContent = "Access revoked. Generate a new link to share again.";
    closeShareModal();
    showToast("Family access revoked.");
  } catch (e) {
    console.error("[revokeAccess]", e);
    showToast("Revoke failed: " + e.message, true);
  }
}

// ─── ABHA Health ID linking (Stage 1 of ABDM integration) ──────────────────────
// Two-step flow, mirroring the existing signup OTP UX: enter the ABHA number
// and request a link → an OTP row appears → confirm the OTP to complete the
// consent-backed link. abhaSection() re-renders whenever patientProfile changes.
function renderAbhaSection() {
  const p = patientProfile || {};
  const badge = document.getElementById("abhaBadge");
  if (badge) {
    badge.textContent   = p.abhaLinked ? "Linked" : (p.abhaNumber ? "Pending verification" : "Not linked");
    badge.className     = `abha-badge ${p.abhaLinked ? "abha-badge-linked" : ""}`;
  }

  const entryRow  = document.getElementById("abhaEntryRow");
  const linkedRow = document.getElementById("abhaLinkedRow");
  const hint      = document.getElementById("abhaHint");
  const numInput  = document.getElementById("f-abhaNumber");

  if (p.abhaLinked && p.abhaNumber) {
    // Linking already saved the moment OTP was verified — show that plainly
    // instead of leaving an editable form that implies "Save Changes" is
    // still needed for this field.
    if (entryRow)  entryRow.style.display  = "none";
    if (linkedRow) linkedRow.style.display = "flex";
    const masked = p.abhaNumber.replace(/^(\d{2})\d{8}(\d{4})$/, "$1••••••••$2");
    const linkedText = document.getElementById("abhaLinkedText");
    if (linkedText) linkedText.textContent = `${masked}${p.abhaLinkedAt ? " — linked " + new Date(p.abhaLinkedAt).toLocaleDateString() : ""}`;
    if (hint) hint.textContent = "This patient's ABHA link is already saved — no further action needed here.";
  } else {
    if (entryRow)  entryRow.style.display  = "flex";
    if (linkedRow) linkedRow.style.display = "none";
    if (numInput)  numInput.value = p.abhaNumber || "";
    if (hint) hint.textContent = "Enter the patient's ABHA number and click Link — an OTP is sent to their Aadhaar-linked phone to confirm consent.";
  }

  // Also reflect status on the read-only profile panel
  const pfNum   = document.getElementById("pf-abha-number");
  const pfBadge = document.getElementById("pf-abha-badge");
  if (pfNum)   pfNum.textContent = p.abhaNumber || "—";
  if (pfBadge) {
    if (p.abhaNumber) {
      pfBadge.style.display = "";
      pfBadge.textContent   = p.abhaLinked ? "Linked" : "Pending verification";
      pfBadge.className     = `abha-badge ${p.abhaLinked ? "abha-badge-linked" : ""}`;
    } else {
      pfBadge.style.display = "none";
    }
  }
}

let _abhaLinkToken = null; // short-lived signed token from /abha/link, echoed back on verify

async function linkAbha() {
  const pid = PAGE_PATIENT_ID;
  const abhaNumber = document.getElementById("f-abhaNumber")?.value?.trim().replace(/[\s-]/g, "");
  if (!pid) return;
  if (!/^\d{14}$/.test(abhaNumber || "")) {
    showToast("ABHA number must be 14 digits.", true);
    return;
  }

  const btn = document.getElementById("abhaLinkBtn");
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending OTP…'; }
    const res  = await authFetch(`/api/patients/${encodeURIComponent(pid)}/abha/link`, {
      method: "POST", body: JSON.stringify({ abhaNumber }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to initiate link");

    _abhaLinkToken = data.linkToken;

    const otpRow = document.getElementById("abhaOtpRow");
    if (otpRow) otpRow.style.display = "flex";
    document.getElementById("f-abhaOtp")?.focus();
    const hint = document.getElementById("abhaHint");
    if (hint) hint.textContent = data.demo
      ? 'Demo mode — no real OTP was sent. Enter "000000" to confirm the link.'
      : "OTP sent to the patient's Aadhaar-linked phone. Enter it below to confirm.";
    showToast(data.message || "OTP sent.");
  } catch (e) {
    console.error("[linkAbha]", e);
    showToast("Link failed: " + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-link"></i> Link ABHA'; }
  }
}

async function verifyAbhaOtp() {
  const pid = PAGE_PATIENT_ID;
  const otp = document.getElementById("f-abhaOtp")?.value?.trim();
  if (!pid || !otp) { showToast("Enter the OTP first.", true); return; }
  if (!_abhaLinkToken) { showToast("No pending ABHA link — click Link ABHA again.", true); return; }

  const btn = document.getElementById("abhaVerifyBtn");
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying…'; }
    const res  = await authFetch(`/api/patients/${encodeURIComponent(pid)}/abha/verify-otp`, {
      method: "POST", body: JSON.stringify({ otp, linkToken: _abhaLinkToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Verification failed");
    console.log("[verifyAbhaOtp] server response:", data);

    // Apply the response directly — it's the authoritative post-write
    // document from the server's own update, so the UI is correct
    // immediately without depending on a follow-up GET to catch up.
    patientProfile.abhaLinked   = data.abhaLinked;
    patientProfile.abhaNumber   = data.abhaNumber;
    patientProfile.abhaLinkedAt = data.abhaLinkedAt;
    renderAbhaSection();

    showToast("ABHA linked successfully.");
    cancelAbhaLink(); // hide the OTP row, clear the token
    loadPatientProfile().catch(() => {}); // best-effort background sync for the rest of the profile
  } catch (e) {
    console.error("[verifyAbhaOtp]", e);
    showToast("Verification failed: " + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Verify'; }
  }
}

function cancelAbhaLink() {
  _abhaLinkToken = null;
  const row = document.getElementById("abhaOtpRow");
  if (row) row.style.display = "none";
  const otpInput = document.getElementById("f-abhaOtp");
  if (otpInput) otpInput.value = "";
  const hint = document.getElementById("abhaHint");
  if (hint) hint.textContent = "Enter the patient's ABHA number and click Link — an OTP is sent to their Aadhaar-linked phone to confirm consent.";
}

// Lets staff re-open the entry form from the "already linked" confirmation
// state — e.g. to relink under a different ABHA number.
function changeAbha() {
  const linkedRow = document.getElementById("abhaLinkedRow");
  const entryRow  = document.getElementById("abhaEntryRow");
  if (linkedRow) linkedRow.style.display = "none";
  if (entryRow)  entryRow.style.display  = "flex";
  cancelAbhaLink();
}

function copyShareUrl() {
  if (!_shareUrl) return;
  var icon = document.getElementById("shareCopyIcon");

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(_shareUrl).then(function() {
      if (icon) { icon.className = "fa-solid fa-check"; setTimeout(function() { icon.className = "fa-solid fa-copy"; }, 2000); }
    }).catch(function() { fallbackCopy(); });
  } else { fallbackCopy(); }

  function fallbackCopy() {
    var ta = document.createElement("textarea");
    ta.value = _shareUrl;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    if (icon) { icon.className = "fa-solid fa-check"; setTimeout(function() { icon.className = "fa-solid fa-copy"; }, 2000); }
  }
}

function closeShareModal() {
  var modal = document.getElementById("shareModal");
  if (modal) modal.classList.remove("open");
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchCurrentUser();
  applyHospitalBranding();
  applyPatientPageGates();
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
    const { hr } = renderVitals(
      {
        heartRate: doc.heartRate, spo2: doc.spo2, temperatureF: doc.temperatureF, isPeak: doc.isPeak,
        ecgHeartRate: doc.ecgHeartRate, activityScore: doc.activityScore,
        posture: doc.posture, motionDetected: doc.motionDetected,
      },
      vTime
    );
    // Append new point to the active historical chart in real time.
    // `hr` here is already the ECG-primary/legacy-fallback merged value.
    appendToActiveChart(vTime, hr, doc.spo2, doc.temperatureF);
    // AI insights → merged panel
    if (doc.fusion?.indicators) updateAIInsights(doc.fusion.indicators);
  });
  socket.on("ecg-waveform", data => {
    console.log("[ecg-waveform] received:", data.patient_id, "samples:", data.samples?.length);
    if (data.patient_id && data.patient_id !== PAGE_PATIENT_ID) return;
    renderEcgWaveform(data);
  });
  socket.on("settings-update", data => {
    const name = data.hospitalName || "healthMonitor";
    document.querySelectorAll(".logo-text, .brand-logo-text").forEach(el => { el.textContent = name; });
  });

  initEcgWaveformCanvas();
  window.addEventListener("resize", initEcgWaveformCanvas);

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

  document.getElementById("shareFamilyBtn")?.addEventListener("click", shareFamily);
  document.getElementById("revokeAccessBtn")?.addEventListener("click", revokeAccess);
  document.getElementById("shareModalClose")?.addEventListener("click", closeShareModal);
  document.getElementById("shareModalCancel")?.addEventListener("click", closeShareModal);
  document.getElementById("shareModal")?.addEventListener("click", e => {
    if (e.target.id === "shareModal") closeShareModal();
  });

  // ABHA linking (Stage 1)
  document.getElementById("abhaLinkBtn")?.addEventListener("click", linkAbha);
  document.getElementById("abhaVerifyBtn")?.addEventListener("click", verifyAbhaOtp);
  document.getElementById("abhaCancelBtn")?.addEventListener("click", cancelAbhaLink);
  document.getElementById("abhaChangeBtn")?.addEventListener("click", changeAbha);

  // Discharge & Export (Stage 3 trigger + data wipe)
  document.getElementById("dischargeBtn")?.addEventListener("click", dischargePatient);
  document.getElementById("dischargeConfirmBtn")?.addEventListener("click", executeDischarge);
  document.getElementById("dischargeCancelBtn")?.addEventListener("click", closeDischargeModal);
  document.getElementById("dischargeConfirmModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeDischargeModal();
  });
});
