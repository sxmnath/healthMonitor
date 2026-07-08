"use strict";
require("dotenv").config();

const express    = require("express");
const rateLimit  = require("express-rate-limit");
const mongoose   = require("mongoose");
const cors       = require("cors");
const http       = require("http");
const path       = require("path");
const crypto     = require("crypto");
const { Server } = require("socket.io");
const User          = require("./models/User");
const Alert         = require("./models/Alert");
const { protect, requireRole, authorizeRoles } = require("./middleware/auth");
const authRouter    = require("./routes/auth");
const adminRouter   = require("./routes/admin");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => { req.io = io; next(); });
// ─── Auth Routes (public — no token needed) ──────────────────────────────────
app.use("/api/auth", authRouter);
// ─── Admin Routes ─────────────────────────────────────────────────────────────
app.use("/api/admin", adminRouter);

app.use(express.static(path.join(__dirname, "../esp32-frontend"), { index: false }));

// ─── Startup guards ──────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET is not set in .env — refusing to start.");
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error("[FATAL] MONGO_URI is not set in .env — refusing to start.");
  process.exit(1);
}

// ─── DB Connection ────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("[DB] MongoDB connected"))
  .catch(err => console.error("[DB] Connection error:", err.message));

const SensorData    = require("./models/SensorData");
const Patient       = require("./models/Patient");
const analyzeHealth = require("./fusion/healthFusion");
const { generateDischargeSummary } = require("./utils/pdf");
const { buildBundle }              = require("./utils/fhir");
const abdm                         = require("./utils/abdm");

// ─── Signal Processing (server-side) ─────────────────────────────────────────
// Per-device sliding windows for moving average
const deviceWindows = {};  // { deviceId: { hr: [], spo2: [], temp: [] } }
const MA_WINDOW = 5;

// Valid raw ranges (°C for temp at ingest; °F after conversion)
const RAW_LIMITS = {
  hr:   { min: 20,  max: 250 },
  spo2: { min: 50,  max: 100 },
  temp: { min: 30,  max: 43  },  // °C
};

function isValid(type, val) {
  if (val === null || val === undefined) return false;
  if (type === "spo2" && val === -1) return false;  // -1 = not connected, valid sentinel
  const lim = RAW_LIMITS[type];
  return val >= lim.min && val <= lim.max;
}

function movingAvg(buf, val) {
  buf.push(val);
  if (buf.length > MA_WINDOW) buf.shift();
  return Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) * 10) / 10;
}

function cToF(c) {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

// Peak detection: value exceeds the rolling mean by >15%
function isPeak(buf, val) {
  if (buf.length < 3) return false;
  const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
  return Math.abs(val - mean) / mean > 0.15;
}

function processVitals(deviceId, raw) {
  if (!deviceWindows[deviceId]) {
    deviceWindows[deviceId] = { hr: [], spo2: [], temp: [] };
  }
  const win = deviceWindows[deviceId];
  const result = {};

  // Heart Rate
  if (isValid("hr", raw.heartRate)) {
    const spike = isPeak(win.hr, raw.heartRate);
    result.heartRate = movingAvg(win.hr, raw.heartRate);
    result.isPeak    = spike;
  } else {
    result.heartRate = win.hr.length ? win.hr[win.hr.length - 1] : null;
    result.isPeak    = false;
  }

  // SpO2 — -1 means sensor not connected (passthrough, not rejected)
  if (raw.spo2 === -1) {
    result.spo2 = -1;
  } else if (isValid("spo2", raw.spo2)) {
    result.spo2 = movingAvg(win.spo2, raw.spo2);
  } else {
    result.spo2 = win.spo2.length ? win.spo2[win.spo2.length - 1] : null;
  }

  // Temperature — convert to °F, store as °F
  if (isValid("temp", raw.temperature)) {
    const smoothC   = movingAvg(win.temp, raw.temperature);
    result.temperatureF = cToF(smoothC);
    // Clamp to valid °F range (90–104)
    if (result.temperatureF < 90 || result.temperatureF > 104) {
      result.temperatureF = win.temp.length > 1
        ? cToF(win.temp[win.temp.length - 2])
        : null;
    }
  } else {
    result.temperatureF = win.temp.length
      ? cToF(win.temp[win.temp.length - 1])
      : null;
  }

  return result;
}

// ─── Patient Registration ─────────────────────────────────────────────────────
async function assignPatientId(deviceId) {
  let patient = await Patient.findOne({ deviceId });
  if (patient) return patient;
  const count      = await Patient.countDocuments();
  const patient_id = `P${101 + count}`;
  const name       = `Patient ${count + 1}`;
  patient          = await Patient.create({ patient_id, deviceId, name });
  console.log(`[Patient] Registered ${deviceId} → ${patient_id}`);
  return patient;
}

// ─── Alert state (in-memory, per patient) ────────────────────────────────────
// Persists across POST /data calls — resets on server restart (acceptable).
const _lastStatus   = new Map();  // patient_id → "stable"|"warning"|"critical"
const _lastLeadsOff = new Map();  // patient_id → boolean

// generateAlerts — called fire-and-forget after every ingest.
// Two gating strategies:
//   Standard vitals alerts → status-change gated (avoids flooding on same state)
//   ECG leads-off          → leads-state-change gated (only on transition)
//   Exertional desaturation → fires whenever condition is true (clinically important)
async function generateAlerts(patient_id, vitals, motion) {
  try {
    const { heartRate: hr, spo2, temperatureF: tF, ecgHeartRate = null } = vitals;
    const { activityScore = 0 } = motion || {};
    const alerts = [];

    // ── ECG leads-off (state-change gated) ─────────────────────────────────
    const leadsNowOff = (ecgHeartRate === -1);
    const wasLeadsOff = _lastLeadsOff.get(patient_id) || false;
    _lastLeadsOff.set(patient_id, leadsNowOff);
    if (leadsNowOff && !wasLeadsOff) {
      alerts.push({
        patient_id, severity: "warning", type: "ecg_leads_off",
        message: "ECG electrodes are not connected. Attach leads to resume heart rate monitoring.",
        vitals: { heartRate: hr, spo2, temperatureF: tF },
      });
    }

    // ── Exertional desaturation (fires whenever condition is true) ──────────
    // activityScore > 70 = high movement; spo2 < 94 during movement is clinically significant
    if (activityScore > 70 && spo2 !== -1 && spo2 < 94) {
      alerts.push({
        patient_id, severity: "warning", type: "exertional_desaturation",
        message: `SpO₂ dropped to ${spo2}% during high activity (score: ${Math.round(activityScore)}). May indicate reduced cardiorespiratory reserve.`,
        vitals: { heartRate: hr, spo2, temperatureF: tF },
      });
    }

    // ── Standard vitals alerts (status-change gated) ─────────────────────────
    const newStatus = getStatus({ heartRate: hr, spo2, temperatureF: tF });
    const oldStatus = _lastStatus.get(patient_id);
    _lastStatus.set(patient_id, newStatus);

    if (newStatus !== oldStatus && newStatus !== "stable") {
      if (spo2 !== -1 && spo2 < 92) {
        alerts.push({ patient_id, severity: "critical", type: "spo2_low",
          message: `Critical SpO₂: ${spo2}%.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      } else if (spo2 !== -1 && spo2 < 95) {
        alerts.push({ patient_id, severity: "warning", type: "spo2_low",
          message: `Low SpO₂: ${spo2}%.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      }
      if (hr > 120) {
        alerts.push({ patient_id, severity: "critical", type: "hr_high",
          message: `Critical heart rate: ${hr} bpm.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      } else if (hr > 100) {
        alerts.push({ patient_id, severity: "warning", type: "hr_high",
          message: `Elevated heart rate: ${hr} bpm.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      }
      if (hr < 50) {
        alerts.push({ patient_id, severity: "critical", type: "hr_low",
          message: `Critical low heart rate: ${hr} bpm.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      }
      if (tF > 102) {
        alerts.push({ patient_id, severity: "critical", type: "temp_high",
          message: `Critical temperature: ${tF}°F.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      } else if (tF >= 100.4) {
        alerts.push({ patient_id, severity: "warning", type: "temp_high",
          message: `Fever detected: ${tF}°F.`, vitals: { heartRate: hr, spo2, temperatureF: tF } });
      }
      if (spo2 === -1) {
        alerts.push({ patient_id, severity: "warning", type: "sensor_off",
          message: "SpO₂ sensor is not connected.", vitals: { heartRate: hr, spo2, temperatureF: tF } });
      }
      if (alerts.filter(a => a.severity === "critical").length >= 2) {
        alerts.push({ patient_id, severity: "critical", type: "multi_critical",
          message: "Multiple critical vitals detected simultaneously.", vitals: { heartRate: hr, spo2, temperatureF: tF } });
      }
    }

    if (alerts.length > 0) {
      await Alert.insertMany(alerts);
    }
  } catch (err) {
    console.error("[generateAlerts]", err.message);
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function getStatus(vitals) {
  const { heartRate: hr, spo2, temperatureF: tF } = vitals;
  const spo2Bad = spo2 !== -1 && spo2 < 92;
  if (hr > 120 || hr < 50 || spo2Bad || tF > 102) return "critical";
  if (hr > 100 || (spo2 !== -1 && spo2 <= 95) || tF >= 100.4) return "warning";
  return "stable";
}

// ─── Ingest endpoint (ESP32 → POST /data) ────────────────────────────────────
app.post("/data", async (req, res) => {
  try {
    // Destructure all fields — existing vitals + ECG + MPU6050
    const {
      deviceId, heartRate, spo2, temperature,
      ecgHeartRate,
      accelX, accelY, accelZ,
      gyroX,  gyroY,  gyroZ,
      activityScore, posture, motionDetected,
    } = req.body;

    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    const patient = await assignPatientId(deviceId);
    const clean   = processVitals(deviceId, { heartRate, spo2, temperature });

    // Normalise motion fields — safe defaults when MPU6050 data is absent
    const motion = {
      activityScore:  (activityScore  != null) ? Number(activityScore)      : 0,
      posture:        (posture        != null) ? String(posture)             : "unknown",
      motionDetected: (motionDetected != null) ? Boolean(motionDetected)    : false,
    };

    const doc = await SensorData.create({
      patient_id:   patient.patient_id,
      deviceId,
      // Core vitals (smoothed)
      heartRate:    clean.heartRate,
      spo2:         clean.spo2,
      temperatureF: clean.temperatureF,
      isPeak:       clean.isPeak,
      time:         new Date(),
      // ECG
      ecgHeartRate: (ecgHeartRate != null) ? Number(ecgHeartRate) : null,
      // MPU6050 raw
      accelX: (accelX != null) ? Number(accelX) : null,
      accelY: (accelY != null) ? Number(accelY) : null,
      accelZ: (accelZ != null) ? Number(accelZ) : null,
      gyroX:  (gyroX  != null) ? Number(gyroX)  : null,
      gyroY:  (gyroY  != null) ? Number(gyroY)  : null,
      gyroZ:  (gyroZ  != null) ? Number(gyroZ)  : null,
      // Derived motion
      activityScore:  motion.activityScore,
      posture:        motion.posture,
      motionDetected: motion.motionDetected,
    });

    const fusion = analyzeHealth(clean.heartRate, clean.spo2, clean.temperatureF, motion);

    // ── Staff room broadcast (full payload) ─────────────────────────────────
    io.to(patient.patient_id).emit("vitals-update", {
      patient_id:   patient.patient_id,
      deviceId,
      name:         patient.name,
      heartRate:    clean.heartRate,
      spo2:         clean.spo2,
      temperatureF: clean.temperatureF,
      isPeak:       clean.isPeak,
      // ECG + motion fields for patient dashboard
      ecgHeartRate:   doc.ecgHeartRate,
      activityScore:  motion.activityScore,
      posture:        motion.posture,
      motionDetected: motion.motionDetected,
      fusion,
      time:         doc.time,
    });

    // ── Viewer room broadcast (safe subset only — no clinical details) ──────
    io.to(`viewer:${patient.patient_id}`).emit("vitals-update", {
      name:    patient.name,
      vitals:  { heartRate: clean.heartRate, spo2: clean.spo2, temperatureF: clean.temperatureF },
      status:  getStatus(clean),
      lastSeen: doc.time,
    });

    // ── Ward overview broadcast ─────────────────────────────────────────────
    io.emit("patient-list-update", { patient_id: patient.patient_id, deviceId });

    // ── Alert generation (fire-and-forget) ──────────────────────────────────
    generateAlerts(
      patient.patient_id,
      { heartRate: clean.heartRate, spo2: clean.spo2, temperatureF: clean.temperatureF, ecgHeartRate: doc.ecgHeartRate },
      motion
    );

    res.status(200).json({ status: "ok", patient_id: patient.patient_id });
  } catch (err) {
    console.error("[POST /data]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/patients ────────────────────────────────────────────────────────
// List all patients with their latest vitals
app.get("/api/patients", protect, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json(demoPatients());
    }
    // Build query — filter by ward if ?ward= param is present
    const query = {};
    if (req.query.ward && req.query.ward.trim()) {
      query.ward = req.query.ward.trim();
    }
    const patients = await Patient.find(query).lean();
    if (!patients.length) return res.json([]);

    const results = await Promise.all(patients.map(async (p) => {
      const latest = await SensorData
        .findOne({ patient_id: p.patient_id })
        .sort({ time: -1 })
        .lean();
      if (!latest) return null;

      const vitals = { heartRate: latest.heartRate, spo2: latest.spo2, temperatureF: latest.temperatureF };
      return {
        patient_id: p.patient_id,
        deviceId:   p.deviceId,
        name: p.name, age: p.age, gender: p.gender, bloodType: p.bloodType,
        weight: p.weight, height: p.height, roomNo: p.roomNo, ward: p.ward,
        physician: p.physician, diagnosis: p.diagnosis, phone: p.phone, notes: p.notes,
        vitals,
        fusion:   analyzeHealth(vitals.heartRate, vitals.spo2, vitals.temperatureF, {
          activityScore:  latest.activityScore,
          posture:        latest.posture,
          motionDetected: latest.motionDetected,
        }),
        status:   getStatus(vitals),
        lastSeen: latest.time,
      };
    }));

    const order  = { critical: 0, warning: 1, stable: 2 };
    const sorted = results.filter(Boolean).sort((a, b) => order[a.status] - order[b.status]);
    res.json(sorted);
  } catch (err) {
    console.error("[GET /api/patients]", err);
    res.json(demoPatients());
  }
});

// ─── GET /api/patients/:id ────────────────────────────────────────────────────
// Patient profile + latest vitals
app.get("/api/patients/:id", protect, async (req, res) => {
  try {
    const patient = await Patient.findOne({ patient_id: req.params.id }).lean();
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const latest = await SensorData
      .findOne({ patient_id: req.params.id })
      .sort({ time: -1 })
      .lean();

    const vitals = latest
      ? { heartRate: latest.heartRate, spo2: latest.spo2, temperatureF: latest.temperatureF }
      : null;

    res.json({
      ...patient,
      vitals,
      fusion: vitals ? analyzeHealth(vitals.heartRate, vitals.spo2, vitals.temperatureF, {
        activityScore:  latest?.activityScore,
        posture:        latest?.posture,
        motionDetected: latest?.motionDetected,
      }) : null,
      status: vitals ? getStatus(vitals) : "unknown",
      lastSeen: latest?.time || null,
    });
  } catch (err) {
    console.error("[GET /api/patients/:id]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/patients ───────────────────────────────────────────────────────
// Create or update patient profile
app.post("/api/patients", protect, async (req, res) => {
  try {
    const { patient_id, deviceId } = req.body;
    if (!patient_id || !deviceId) return res.status(400).json({ error: "patient_id and deviceId required" });
    const allowed = ["name","age","gender","bloodType","weight","height","roomNo","ward","physician","diagnosis","phone","notes"];
    const update  = { deviceId };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.ward) update.ward = update.ward.trim();
    const patient = await Patient.findOneAndUpdate(
      { patient_id },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── PATCH /api/patients/:id ──────────────────────────────────────────────────
// Partial profile update (used by edit modal)
app.patch("/api/patients/:id", protect, async (req, res) => {
  try {
    const allowed = ["name","age","gender","bloodType","weight","height","roomNo","ward","physician","diagnosis","phone","notes"];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.ward) update.ward = update.ward.trim();
    const patient = await Patient.findOneAndUpdate({ patient_id: req.params.id }, update, { new: true });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // Broadcast updated profile to ward overview
    io.emit("patient-profile-update", { patient_id: req.params.id });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/patients/:id/history?range=1h|24h ───────────────────────────────
// Historical vitals — the fix for empty graphs
app.get("/api/patients/:id/history", protect, async (req, res) => {
  try {
    const { range = "1h", limit } = req.query;
    const pid = req.params.id;

    const rangeMap = { "1h": 3600, "24h": 86400, "7d": 604800 };
    const seconds  = rangeMap[range];
    if (!seconds) return res.status(400).json({ error: "Invalid range. Use 1h, 24h, or 7d" });

    const since = new Date(Date.now() - seconds * 1000);

    // Build query — first try patient_id, fallback to deviceId
    let query = { patient_id: pid, time: { $gte: since } };

    // Down-sample for large ranges: every Nth record to keep response lean
    // 24h @ ~1/5s = ~17280 docs — we cap at 500 points for the chart
    const MAX_POINTS = 500;
    const totalCount = await SensorData.countDocuments(query);
    const nth = Math.max(1, Math.floor(totalCount / MAX_POINTS));

    let data;
    if (nth > 1) {
      // Aggregate with $bucket-like approach via aggregation pipeline
      data = await SensorData.aggregate([
        { $match: query },
        { $sort: { time: 1 } },
        {
          $group: {
            _id: {
              bucket: {
                $subtract: [
                  { $toLong: "$time" },
                  { $mod: [{ $toLong: "$time" }, nth * 5000] }  // bucket by nth*5s
                ]
              }
            },
            heartRate:    { $avg: "$heartRate" },
            spo2:         { $avg: "$spo2" },
            temperatureF: { $avg: "$temperatureF" },
            isPeak:       { $max: "$isPeak" },
            // ECG + motion — avg for numeric, first for string/bool
            ecgHeartRate:   { $avg: "$ecgHeartRate" },
            activityScore:  { $avg: "$activityScore" },
            posture:        { $first: "$posture" },
            motionDetected: { $max: "$motionDetected" },
            time:         { $first: "$time" },
          }
        },
        { $sort: { time: 1 } },
        {
          $project: {
            _id: 0,
            heartRate:    { $round: ["$heartRate", 1] },
            spo2:         { $round: ["$spo2", 1] },
            temperatureF: { $round: ["$temperatureF", 1] },
            isPeak:       1,
            ecgHeartRate:   { $round: ["$ecgHeartRate", 0] },
            activityScore:  { $round: ["$activityScore", 1] },
            posture:        1,
            motionDetected: 1,
            time:         1,
          }
        }
      ]);
    } else {
      data = await SensorData
        .find(query, {
          heartRate: 1, spo2: 1, temperatureF: 1, isPeak: 1,
          ecgHeartRate: 1, activityScore: 1, posture: 1, motionDetected: 1,
          time: 1, _id: 0,
        })
        .sort({ time: 1 })
        .lean();
    }

    res.json({ range, count: data.length, data });
  } catch (err) {
    console.error("[GET /api/patients/:id/history]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── DELETE /api/patients/:id/data ───────────────────────────────────────────
// Reset all vitals for a patient (keeps profile)
app.delete("/api/patients/:id/data", protect, async (req, res) => {
  try {
    const result = await SensorData.deleteMany({ patient_id: req.params.id });
    const patient = await Patient.findOne({ patient_id: req.params.id }).lean();
    if (patient?.deviceId && deviceWindows[patient.deviceId]) {
      delete deviceWindows[patient.deviceId];
    }
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── DELETE /api/patients/:id/profile ────────────────────────────────────────
// Clear all profile fields — keeps the Patient document (device stays registered)
const PROFILE_FIELDS = ["name","age","gender","bloodType","weight","height","roomNo","ward","physician","diagnosis","phone","notes"];
app.delete("/api/patients/:id/profile", protect, requireRole("admin"), async (req, res) => {
  try {
    const unset = {};
    PROFILE_FIELDS.forEach(k => { unset[k] = ""; });
    // Reset name to default "Patient <N>" based on patient_id suffix
    const patient = await Patient.findOne({ patient_id: req.params.id }).lean();
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    const defaultName = `Patient ${parseInt(patient.patient_id.replace(/\D/g, ""), 10) - 100}`;
    await Patient.updateOne(
      { patient_id: req.params.id },
      { $unset: { age:1, gender:1, bloodType:1, weight:1, height:1, roomNo:1, ward:1, physician:1, diagnosis:1, phone:1, notes:1 },
        $set:   { name: defaultName } }
    );
    const updated = await Patient.findOne({ patient_id: req.params.id }).lean();
    res.json(updated);
  } catch (err) {
    console.error("[DELETE /api/patients/:id/profile]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/patients/:id/viewer-link ───────────────────────────────────────
// Generate a secure random viewer token and return a shareable URL.
// Access: doctor and admin only.
app.post("/api/patients/:id/viewer-link", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const patient = await Patient.findOne({ patient_id: req.params.id }).select("+viewerToken");
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const token = crypto.randomBytes(32).toString("hex"); // 64-char hex, 256-bit entropy
    patient.viewerToken = token;
    patient.viewerTokenCreatedAt = new Date();
    await patient.save();

    const url = `${req.protocol}://${req.get("host")}/view/${token}`;
    res.json({ url, token, createdAt: patient.viewerTokenCreatedAt });
  } catch (err) {
    console.error("[POST /api/patients/:id/viewer-link]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── DELETE /api/patients/:id/viewer-link ─────────────────────────────────────
// Revoke the viewer token — any existing link immediately becomes dead.
// Access: doctor and admin only.
app.delete("/api/patients/:id/viewer-link", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const patient = await Patient.findOne({ patient_id: req.params.id }).select("+viewerToken");
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    patient.viewerToken = null;
    patient.viewerTokenCreatedAt = null;
    await patient.save();

    res.json({ message: "Viewer access revoked." });
  } catch (err) {
    console.error("[DELETE /api/patients/:id/viewer-link]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ABHA / ABDM integration
// ═══════════════════════════════════════════════════════════════════════════
//
// Stage 1 — link the patient's ABHA number (this section).
// Stage 2 — nothing to build; SensorData already accumulates through the stay.
// Stage 3 — push on discharge (see POST /api/patients/:id/discharge below).

// ─── POST /api/patients/:id/abha/link ─────────────────────────────────────────
// Stage 1a. Nurse/doctor enters the patient's 14-digit ABHA number. Stores it
// on the Patient record and asks the ABDM gateway to send the patient an OTP
// on their Aadhaar-linked phone. Returns a txnId used to confirm the OTP.
app.post("/api/patients/:id/abha/link", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const { abhaNumber } = req.body;
    const cleaned = (abhaNumber || "").replace(/[\s-]/g, "");
    if (!/^\d{14}$/.test(cleaned)) {
      return res.status(422).json({ error: "ABHA number must be 14 digits." });
    }

    const existing = await Patient.findOne({ patient_id: req.params.id }).lean();
    if (!existing) return res.status(404).json({ error: "Patient not found" });

    const { txnId, demo } = await abdm.initiateCareContextLink({ ...existing, abhaNumber: cleaned });

    // Atomic $set — deliberately NOT findOne() + mutate + .save() here.
    // abhaLinkTxnId/abhaConsentToken have select:false, and mutating a
    // select:false field on a document loaded without that field in its
    // projection is a known Mongoose footgun: the write can silently fail
    // to persist because the path was never part of the document's loaded
    // state. findOneAndUpdate sends a plain MongoDB update and sidesteps
    // that entirely — this is also what every other route here already does.
    const patient = await Patient.findOneAndUpdate(
      { patient_id: req.params.id },
      {
        $set: {
          abhaNumber:       cleaned,
          abhaLinked:       false,
          abhaConsentToken: null,
          abhaLinkedAt:     null,
          abhaLinkTxnId:    txnId,
        },
      },
      { new: true }
    );
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    res.json({
      message: demo
        ? 'OTP sent (demo mode — use "000000" to confirm).'
        : "OTP sent to the patient's Aadhaar-linked phone.",
      txnId,
      demo,
    });
  } catch (err) {
    console.error("[POST /api/patients/:id/abha/link]", err);
    res.status(500).json({ error: err.message || "Failed to initiate ABHA link." });
  }
});

// ─── POST /api/patients/:id/abha/verify-otp ───────────────────────────────────
// Stage 1b. Confirms the OTP and stores the resulting consent artifact —
// this is what proves the patient authorised this HIP to push their data.
app.post("/api/patients/:id/abha/verify-otp", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(422).json({ error: "OTP is required." });

    // Reading a select:false field back requires the +field override — that
    // part is fine. It's writing it back via a mutated .save() that's the
    // footgun (see the /abha/link route above for why); use $set instead.
    const patient = await Patient.findOne({ patient_id: req.params.id }).select("+abhaLinkTxnId");
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    if (!patient.abhaLinkTxnId) {
      return res.status(400).json({ error: "No pending ABHA link for this patient. Start over." });
    }

    const { consentToken } = await abdm.confirmCareContextLink(patient.abhaLinkTxnId, otp);

    await Patient.findOneAndUpdate(
      { patient_id: req.params.id },
      {
        $set: {
          abhaLinked:       true,
          abhaConsentToken: consentToken,
          abhaLinkedAt:     new Date(),
          abhaLinkTxnId:    null,
        },
      }
    );

    io.emit("patient-profile-update", { patient_id: req.params.id });
    res.json({ message: "ABHA linked successfully.", abhaLinked: true });
  } catch (err) {
    if (err.code === "INVALID_OTP") {
      return res.status(422).json({ error: "Incorrect OTP." });
    }
    console.error("[POST /api/patients/:id/abha/verify-otp]", err);
    res.status(500).json({ error: err.message || "Failed to verify OTP." });
  }
});

// ─── POST /api/patients/:id/discharge ─────────────────────────────────────────
// Stage 3. "Discharge & Export" — the single action that:
//   1. Generates a PDF discharge summary and streams it back to the caller
//   2. If the patient has a verified ABHA link, serialises the same stay's
//      vitals into a FHIR Bundle and pushes it to the ABDM Health Repository
//      asynchronously (fire-and-forget — a failed push never blocks the PDF)
// Access: doctor and admin only.
app.post("/api/patients/:id/discharge", protect, authorizeRoles("admin", "doctor"), async (req, res) => {
  try {
    const patient = await Patient.findOne({ patient_id: req.params.id }).select("+abhaConsentToken").lean();
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const since = patient.admittedAt || new Date(0);
    const [readings, alerts] = await Promise.all([
      SensorData.find({ patient_id: patient.patient_id, time: { $gte: since } }).sort({ time: 1 }).lean(),
      Alert.find({ patient_id: patient.patient_id, createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean(),
    ]);

    // ── Fire the ABHA push in the background — does not block the PDF ──────
    if (patient.abhaNumber && patient.abhaLinked && patient.abhaConsentToken) {
      const bundle = buildBundle(patient, readings);
      abdm.pushHealthRecord(patient, bundle)
        .then(result => {
          io.emit("abha-push-result", { patient_id: patient.patient_id, ...result });
          if (!result.success) console.error(`[abdm] push failed for ${patient.patient_id}:`, result.error);
        })
        .catch(err => console.error(`[abdm] push threw for ${patient.patient_id}:`, err.message));
    }

    // ── Generate and return the PDF synchronously ───────────────────────────
    const pdfBuffer = await generateDischargeSummary(patient, readings, alerts);
    res.set({
      "Content-Type":        "application/pdf",
      "Content-Disposition": `attachment; filename="discharge-${patient.patient_id}.pdf"`,
      "X-Abha-Push":         patient.abhaNumber && patient.abhaLinked ? "queued" : "skipped-no-link",
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[POST /api/patients/:id/discharge]", err);
    res.status(500).json({ error: "Failed to generate discharge summary." });
  }
});

// ─── Legacy /api/patient/:id routes (backwards compat) ───────────────────────
app.get("/api/patient/:id",        protect, (req, res) => res.redirect(`/api/patients/${req.params.id}`));
app.patch("/api/patient/:id",      protect, async (req, res) => {
  try {
    const allowed = ["name","age","gender","bloodType","weight","height","roomNo","ward","physician","diagnosis","phone","notes"];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const patient = await Patient.findOneAndUpdate({ patient_id: req.params.id }, update, { new: true });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    io.emit("patient-profile-update", { patient_id: req.params.id });
    res.json(patient);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});
app.delete("/api/patient/:id/data", protect, (req, res) => res.redirect(307, `/api/patients/${req.params.id}/data`));

// ─── Legacy /data/recent (backwards compat) ───────────────────────────────────
app.get("/data/recent", protect, async (req, res) => {
  const { patientId, deviceId, seconds } = req.query;
  if (!seconds) return res.status(400).json({ error: "seconds required" });
  try {
    const pid   = patientId || deviceId;
    const range = Number(seconds) >= 82800 ? "24h" : "1h";
    // Redirect to the new clean endpoint
    const id = patientId || (deviceId ? (await Patient.findOne({ deviceId }))?.patient_id : null);
    if (!id) return res.json({ count: 0, data: [] });
    res.redirect(`/api/patients/${id}/history?range=${range}`);
  } catch { res.json({ count: 0, data: [] }); }
});

// ─── Dashboard endpoint (poll fallback) ──────────────────────────────────────
app.get("/api/dashboard", protect, async (req, res) => {
  try {
    const { patientId, deviceId } = req.query;
    if (mongoose.connection.readyState !== 1) return res.json({ message: "No data yet" });

    let filter = {};
    if (patientId)     filter = { patient_id: patientId };
    else if (deviceId) filter = { deviceId };

    const latest = await SensorData.findOne(filter).sort({ time: -1 }).lean();
    if (!latest) return res.json({ message: "No data yet" });

    const pFilter = latest.patient_id ? { patient_id: latest.patient_id } : { deviceId: latest.deviceId };
    const patient = await Patient.findOne(pFilter).lean();
    const fusion  = analyzeHealth(latest.heartRate, latest.spo2, latest.temperatureF, {
      activityScore:  latest.activityScore,
      posture:        latest.posture,
      motionDetected: latest.motionDetected,
    });

    res.json({
      patient_id:  patient?.patient_id || latest.patient_id,
      deviceId:    latest.deviceId,
      name:        patient?.name || latest.deviceId,
      vitals: {
        heartRate:    latest.heartRate,
        spo2:         latest.spo2,
        temperatureF: latest.temperatureF,
      },
      // ECG + motion fields — poll fallback parity with the WS "vitals-update" payload
      ecgHeartRate:   latest.ecgHeartRate,
      activityScore:  latest.activityScore,
      posture:        latest.posture,
      motionDetected: latest.motionDetected,
      fusion,
      time: latest.time,
    });
  } catch (err) {
    console.error("[GET /api/dashboard]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Patient map helper ───────────────────────────────────────────────────────
app.get("/api/patient-map", protect, async (req, res) => {
  try {
    const map = await Patient.find({}, { _id: 0, patient_id: 1, deviceId: 1, name: 1 }).lean();
    res.json(map);
  } catch { res.json([]); }
});

// ─── Routers ──────────────────────────────────────────────────────────────────
// Note: /api/patients is now inline above; keep old route file only for legacy

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[WS] Connected:", socket.id);

  // Staff room — authenticated clients join by patient_id
  socket.on("join-patient", (pid) => {
    if (typeof pid !== "string" || pid.length > 20) return;
    socket.join(pid);
    console.log(`[WS] ${socket.id} joined staff room: ${pid}`);
  });

  // Viewer room — public clients join by viewer token
  // Token is validated against DB before the socket joins the room
  socket.on("join-viewer", async (token) => {
    try {
      if (!/^[0-9a-f]{64}$/.test(token)) {
        socket.emit("viewer-error", { message: "Invalid link." });
        return;
      }
      const patient = await Patient
        .findOne({ viewerToken: token })
        .select("+viewerToken patient_id");
      if (!patient) {
        socket.emit("viewer-error", { message: "Viewer link not found or expired." });
        return;
      }
      socket.join(`viewer:${patient.patient_id}`);
      socket.emit("viewer-joined", { patient_id: patient.patient_id });
      console.log(`[WS] ${socket.id} joined viewer room: viewer:${patient.patient_id}`);
    } catch (err) {
      console.error("[WS join-viewer]", err.message);
      socket.emit("viewer-error", { message: "Server error." });
    }
  });

  socket.on("disconnect", () => console.log("[WS] Disconnected:", socket.id));
});

// ─── Page routes ──────────────────────────────────────────────────────────────
const viewerLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

// ─── GET /api/view/:token/alerts ─────────────────────────────────────────────
// Returns the 5 most recent alerts for the patient linked to this viewer token.
// Public — no authentication. Same rate limiter as GET /api/view/:token.
app.get("/api/view/:token/alerts", viewerLimiter, async (req, res) => {
  try {
    const { token } = req.params;

    if (!/^[0-9a-f]{64}$/.test(token)) {
      return res.status(404).json({ error: "Viewer link not found." });
    }

    const patient = await Patient
      .findOne({ viewerToken: token })
      .select("+viewerToken patient_id")
      .lean();

    if (!patient) {
      return res.status(404).json({ error: "Viewer link not found." });
    }

    const alerts = await Alert
      .find({ patient_id: patient.patient_id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("severity type message createdAt -_id")
      .lean();

    res.status(200).json({ alerts });

  } catch (err) {
    console.error("[GET /api/view/:token/alerts]", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

// ─── GET /api/view/:token ─────────────────────────────────────────────────────
// Public vitals endpoint — returns safe subset for family viewer.
// No auth required. Rate limited to 60 req/min per IP.
app.get("/api/view/:token", viewerLimiter, async (req, res) => {
  try {
    const { token } = req.params;

    if (!/^[0-9a-f]{64}$/.test(token)) {
      return res.status(404).json({ error: "Viewer link not found." });
    }

    const patient = await Patient
      .findOne({ viewerToken: token })
      .select("+viewerToken patient_id name")
      .lean();

    if (!patient) {
      return res.status(404).json({ error: "Viewer link not found." });
    }

    const latest = await SensorData
      .findOne({ patient_id: patient.patient_id })
      .sort({ time: -1 })
      .lean();

    if (!latest) {
      return res.json({ name: patient.name, vitals: null, status: "unknown", lastSeen: null });
    }

    const vitals = { heartRate: latest.heartRate, spo2: latest.spo2, temperatureF: latest.temperatureF };
    res.json({
      name:     patient.name,
      vitals,
      status:   getStatus(vitals),
      lastSeen: latest.time,
    });

  } catch (err) {
    console.error("[GET /api/view/:token]", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.get("/index.html", (_req, res) => res.redirect("/"));
app.get("/",           (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/patients.html")));
app.get("/patient",    (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/patient.html")));
app.get("/profile",    (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/profile.html")));
app.get("/admin",      (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/admin.html")));
app.get("/login",      (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/login.html")));
app.get("/signup",     (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/signup.html")));
app.get("/view/:token",(_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/viewer.html")));

// ─── Demo data (when DB is offline) ──────────────────────────────────────────
function demoPatients() {
  const list = [
    { patient_id: "P103", deviceId: "ESP32_03", name: "Demo Patient C", vitals: { heartRate: 135, spo2: 89,  temperatureF: 101.3 } },
    { patient_id: "P102", deviceId: "ESP32_02", name: "Demo Patient B", vitals: { heartRate: 112, spo2: 94,  temperatureF: 99.8  } },
    { patient_id: "P101", deviceId: "ESP32_01", name: "Demo Patient A", vitals: { heartRate: 78,  spo2: 98,  temperatureF: 98.6  } },
  ];
  return list.map(p => ({
    ...p,
    fusion:   analyzeHealth(p.vitals.heartRate, p.vitals.spo2, p.vitals.temperatureF),
    status:   getStatus(p.vitals),
    lastSeen: new Date(),
  }));
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
