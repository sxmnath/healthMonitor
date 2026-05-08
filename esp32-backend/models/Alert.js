"use strict";
const mongoose = require("mongoose");

const AlertSchema = new mongoose.Schema(
  {
    // ── Patient reference ───────────────────────────────────────────────────
    patient_id: {
      type:     String,
      required: true,
      trim:     true,
      index:    true,     // queried frequently — fetch alerts by patient
    },

    // ── Severity ────────────────────────────────────────────────────────────
    severity: {
      type:     String,
      required: true,
      enum:     ["critical", "warning"],
    },

    // ── Alert type ──────────────────────────────────────────────────────────
    // Mirrors the threshold checks in server.js getStatus() and healthFusion.js
    type: {
      type:     String,
      required: true,
      enum: [
        "hr_high",        // heart rate > 100 bpm
        "hr_low",         // heart rate < 60 bpm
        "spo2_low",       // SpO₂ < 92 % (critical) or < 95 % (warning)
        "temp_high",      // temperature ≥ 100.4 °F (38.0 °C)
        "temp_low",       // temperature < 96.8 °F (36.0 °C)
        "sensor_off",     // SpO₂ sensor disconnected (spo2 === -1)
        "multi_critical", // two or more vitals simultaneously critical
      ],
    },

    // ── Human-readable description ──────────────────────────────────────────
    message: {
      type:     String,
      required: true,
      trim:     true,
      maxlength: 300,
    },

    // ── Snapshot of the vitals that triggered this alert ────────────────────
    // Stored so the alert is self-contained — no need to re-query SensorData
    vitals: {
      heartRate:    Number,
      spo2:         Number,
      temperatureF: Number,
    },
  },
  {
    // createdAt is provided automatically by timestamps; updatedAt omitted
    // because alerts are immutable — they are never edited after creation.
    timestamps: { createdAt: "createdAt", updatedAt: false },
  }
);

// Compound index: fast retrieval of recent alerts per patient
AlertSchema.index({ patient_id: 1, createdAt: -1 });

module.exports = mongoose.model("Alert", AlertSchema);
