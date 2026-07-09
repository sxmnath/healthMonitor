"use strict";
const mongoose = require("mongoose");

/**
 * Single-document settings store — always upserted on the fixed _id "global".
 * Query: Settings.findById("global")
 * Upsert: Settings.findByIdAndUpdate("global", {...}, { upsert: true, new: true })
 */
const SettingsSchema = new mongoose.Schema({
  _id:          { type: String, default: "global" },
  hospitalName: {
    type:      String,
    default:   "",
    trim:      true,
    maxlength: 80,   // fits comfortably in the sidebar logo
  },
  updatedAt:    { type: Date, default: Date.now },
});

module.exports = mongoose.model("Settings", SettingsSchema);
