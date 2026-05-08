"use strict";
require("dotenv").config();

const express    = require("express");
const rateLimit  = require("express-rate-limit");
const mongoose   = require("mongoose");
const cors       = require("cors");
const http       = require("http");
const path       = require("path");
const { Server } = require("socket.io");
const User          = require("./models/User");
const Alert         = require("./models/Alert");
const { protect, requireRole } = require("./middleware/auth");
const authRouter    = require("./routes/auth");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => { req.io = io; next(); });
// ─── Auth Routes (public — no token needed) ──────────────────────────────────
app.use("/api/auth", authRouter);

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
    const { deviceId, heartRate, spo2, temperature } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    const patient  = await assignPatientId(deviceId);
    const clean    = processVitals(deviceId, { heartRate, spo2, temperature });

    const doc = await SensorData.create({
      patient_id:   patient.patient_id,
      deviceId,
      heartRate:    clean.heartRate,
      spo2:         clean.spo2,
      temperatureF: clean.temperatureF,
      isPeak:       clean.isPeak,
      time:         new Date(),
    });

    const fusion = analyzeHealth(clean.heartRate, clean.spo2, clean.temperatureF);

    // Broadcast to patient's room
    io.to(patient.patient_id).emit("vitals-update", {
      patient_id:   patient.patient_id,
      deviceId,
      name:         patient.name,
      heartRate:    clean.heartRate,
      spo2:         clean.spo2,
      temperatureF: clean.temperatureF,
      isPeak:       clean.isPeak,
      fusion,
      time:         doc.time,
    });

    // Broadcast to ward overview listeners
    io.emit("patient-list-update", { patient_id: patient.patient_id, deviceId });

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
    const patients = await Patient.find({}).lean();
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
        fusion:   analyzeHealth(vitals.heartRate, vitals.spo2, vitals.temperatureF),
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
      fusion: vitals ? analyzeHealth(vitals.heartRate, vitals.spo2, vitals.temperatureF) : null,
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
            time:         1,
          }
        }
      ]);
    } else {
      data = await SensorData
        .find(query, { heartRate: 1, spo2: 1, temperatureF: 1, isPeak: 1, time: 1, _id: 0 })
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
    const fusion  = analyzeHealth(latest.heartRate, latest.spo2, latest.temperatureF);

    res.json({
      patient_id:  patient?.patient_id || latest.patient_id,
      deviceId:    latest.deviceId,
      name:        patient?.name || latest.deviceId,
      vitals: {
        heartRate:    latest.heartRate,
        spo2:         latest.spo2,
        temperatureF: latest.temperatureF,
      },
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
  socket.on("join-patient", (pid) => {
    socket.join(pid);
    console.log(`[WS] ${socket.id} joined room: ${pid}`);
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

app.get("/index.html", (_req, res) => res.redirect("/"));
app.get("/",           (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/patients.html")));
app.get("/patient",    (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/patient.html")));
app.get("/profile",    (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/profile.html")));
app.get("/login",      (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/login.html")));
app.get("/signup",     (_req, res) => res.sendFile(path.join(__dirname, "../esp32-frontend/signup.html")));

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
