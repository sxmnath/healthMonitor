const mongoose = require("mongoose");

const PatientSchema = new mongoose.Schema({
  patient_id: { type: String, required: true, unique: true, trim: true },
  deviceId:   { type: String, required: true, unique: true, trim: true },
  name:       { type: String, default: "" },
  // Profile fields — all optional, filled via edit modal
  age:        Number,
  gender:     String,
  bloodType:  String,
  weight:     Number,   // kg
  height:     Number,   // cm
  roomNo:     String,
  ward:       String,
  physician:  String,
  diagnosis:  String,
  phone:      String,
  notes:      String,
  createdAt:  { type: Date, default: Date.now },

  // ── Viewer access ──────────────────────────────────────────────────────
  // select: false ensures viewerToken is NEVER returned by any query
  // unless explicitly requested with .select("+viewerToken")
  viewerToken:          { type: String, default: null, select: false },
  viewerTokenCreatedAt: { type: Date,   default: null },

  // ── Family contact & notification preferences ───────────────────────────
  familyEmail:   { type: String, default: null, trim: true },
  familyPhone:   { type: String, default: null, trim: true },
  alertsEnabled: { type: Boolean, default: true },
});

module.exports = mongoose.model("Patient", PatientSchema);
