"use strict";
const mongoose = require("mongoose");

/**
 * Hospital-wide settings — a singleton document (there is only ever one).
 * Currently just the hospital display name, shown in the sidebar logo on
 * every page in place of "healthMonitor". Designed to hold more
 * hospital-wide config later without a schema migration (e.g. logo URL,
 * default ward list) — add fields here as needed.
 */
const SettingsSchema = new mongoose.Schema(
  {
    hospitalName: { type: String, default: "healthMonitor", trim: true, maxlength: 80 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Settings", SettingsSchema);
