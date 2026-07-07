const mongoose = require("mongoose");

const SensorSchema = new mongoose.Schema({
  patient_id:   { type: String, required: true },
  deviceId:     { type: String, required: true },
  // Processed vitals (stored clean — raw rejected values are never written)
  heartRate:    { type: Number },          // bpm, already smoothed + validated
  spo2:         { type: Number },          // %, -1 = sensor not connected
  temperatureF: { type: Number },          // °F (converted from °C at ingest)
  // Signal meta
  isPeak:       { type: Boolean, default: false },  // true if detected as spike
  time:         { type: Date, default: Date.now },

  // ── ECG (AD8232) ───────────────────────────────────────────────────────────
  // ecgHeartRate: BPM derived from R-peak detection. -1 = leads off or no data.
  // heartRate above is kept as the primary dashboard field (set equal to ecgHR).
  // ecgHeartRate is stored separately for auditability and future comparison.
  ecgHeartRate: { type: Number, default: null },

  // ── MPU6050 raw readings ────────────────────────────────────────────────────
  accelX: { type: Number, default: null },   // g
  accelY: { type: Number, default: null },   // g
  accelZ: { type: Number, default: null },   // g
  gyroX:  { type: Number, default: null },   // °/s
  gyroY:  { type: Number, default: null },   // °/s
  gyroZ:  { type: Number, default: null },   // °/s

  // ── Derived motion fields ───────────────────────────────────────────────────
  // activityScore: 0–100, derived from excess acceleration above 1g baseline.
  //   0 = at rest, ~10–30 = walking, ~70–100 = high movement.
  activityScore: { type: Number, default: 0 },

  // posture: dominant gravity axis inference.
  //   "upright"  — sitting or standing (default assumption)
  //   "supine"   — lying on back (accelZ < -0.5g)
  //   "lateral"  — on side (accelX > 0.8g)
  //   "unknown"  — MPU6050 not connected or data absent
  posture: {
    type:    String,
    enum:    ["upright", "supine", "lateral", "unknown"],
    default: "unknown",
  },

  // motionDetected: true when acceleration magnitude > 1.2g (0.2g above gravity)
  motionDetected: { type: Boolean, default: false },
});

// Compound index: fast range queries per patient sorted by time
SensorSchema.index({ patient_id: 1, time: -1 });
SensorSchema.index({ deviceId: 1, time: -1 });

module.exports = mongoose.model("SensorData", SensorSchema);
