"use strict";
const mongoose = require("mongoose");

/**
 * Stores an unverified signup until the user confirms their OTP.
 * TTL index auto-deletes documents 10 minutes after creation —
 * no cron job needed, MongoDB handles expiry natively.
 */
const PendingSignupSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  email:     { type: String, required: true, lowercase: true, trim: true },
  password:  { type: String, required: true },          // already bcrypt-hashed
  otp:       { type: String, required: true },          // 6-digit string
  attempts:  { type: Number, default: 0 },              // wrong-guess counter (max 5)
  createdAt: { type: Date,   default: Date.now, index: { expires: "10m" } },
});

// One pending signup per email at a time — upsert replaces on re-send
PendingSignupSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model("PendingSignup", PendingSignupSchema);
