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

  // ── ABDM / ABHA integration ───────────────────────────────────────────────
  // abhaNumber is entered by staff at admission (Stage 1 of the ABHA flow).
  // It only becomes a usable consent-backed link once abhaLinked is true —
  // see POST /api/patients/:id/abha/link and /abha/verify-otp in server.js.
  abhaNumber:        { type: String, default: null, trim: true },
  abhaLinked:        { type: Boolean, default: false },
  abhaConsentToken:  { type: String, default: null, select: false }, // signed consent artifact once linked
  abhaLinkedAt:      { type: Date, default: null },

  // admittedAt marks the start of the current stay/session — used to scope
  // the discharge PDF + FHIR export to "this admission" rather than all-time.
  admittedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Patient", PatientSchema);
