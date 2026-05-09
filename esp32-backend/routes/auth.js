"use strict";
const express  = require("express");
const router   = express.Router();
const crypto   = require("crypto");
const bcrypt   = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const User          = require("../models/User");
const PendingSignup = require("../models/PendingSignup");
const { sendOtpEmail }           = require("../utils/email");
const { signToken, protect }     = require("../middleware/auth");

// ─── Validation rule sets ─────────────────────────────────────────────────────
const signupRules = [
  body("name")
    .trim()
    .notEmpty().withMessage("Name is required")
    .isLength({ min: 2, max: 80 }).withMessage("Name must be 2–80 characters"),

  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Must be a valid email address")
    .normalizeEmail(),

  body("password")
    .notEmpty().withMessage("Password is required")
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters")
    .matches(/[A-Za-z]/).withMessage("Password must contain at least one letter")
    .matches(/\d/).withMessage("Password must contain at least one number"),

];

const loginRules = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Must be a valid email address")
    .normalizeEmail(),

  body("password")
    .notEmpty().withMessage("Password is required"),
];

// ─── Validation error handler ─────────────────────────────────────────────────
function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return first error per field for a clean UX response
    const mapped = {};
    errors.array().forEach(e => { if (!mapped[e.path]) mapped[e.path] = e.msg; });
    res.status(422).json({ error: "Validation failed", fields: mapped });
    return true;   // caller should return after this
  }
  return false;
}

// ─── POST /auth/signup ────────────────────────────────────────────────────────
/**
 * Step 1: Validate fields, hash password, store pending signup, send OTP.
 * Body: { name, email, password }
 * Returns: { message } — frontend shows the OTP entry screen.
 */
router.post("/signup", signupRules, async (req, res) => {
  if (handleValidation(req, res)) return;

  try {
    const { name, email, password } = req.body;

    // Reject if email is already a confirmed account
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({
        error:  "Email already registered",
        fields: { email: "An account with this email address already exists" },
      });
    }

    // Hash password now — PendingSignup stores the hash, not plaintext
    const salt   = await bcrypt.genSalt(12);
    const hashed = await bcrypt.hash(password, salt);

    // Generate cryptographically random 6-digit OTP
    const otp = String(crypto.randomInt(100000, 999999));

    // Upsert: if a previous pending signup exists for this email, replace it
    await PendingSignup.findOneAndUpdate(
      { email },
      { name, email, password: hashed, otp, attempts: 0, createdAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendOtpEmail(email, name, otp);

    res.status(200).json({
      message: "Verification code sent. Please check your email.",
    });

  } catch (err) {
    console.error("[POST /auth/signup]", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

// ─── POST /auth/verify-otp ────────────────────────────────────────────────────
/**
 * Step 2: Verify the OTP, create the User record, issue a JWT.
 * Body: { email, otp }
 * Returns: { user, token }
 */
router.post("/verify-otp", [
  body("email").trim().isEmail().normalizeEmail(),
  body("otp").trim().notEmpty().withMessage("Verification code is required"),
], async (req, res) => {
  if (handleValidation(req, res)) return;

  try {
    const { email, otp } = req.body;

    const pending = await PendingSignup.findOne({ email });

    if (!pending) {
      return res.status(404).json({
        error: "No pending signup for this email. Please start over.",
        expired: true,
      });
    }

    // Increment attempt counter before checking
    pending.attempts += 1;
    await pending.save();

    if (pending.attempts > 5) {
      await PendingSignup.deleteOne({ email });
      return res.status(429).json({
        error: "Too many incorrect attempts. Please sign up again.",
        expired: true,
      });
    }

    if (pending.otp !== otp.trim()) {
      const left = 5 - pending.attempts;
      return res.status(422).json({
        error: `Incorrect code. ${left > 0 ? `${left} attempt${left === 1 ? "" : "s"} remaining.` : "No attempts remaining."}`,
      });
    }

    // OTP correct — create the confirmed user
    const user = await User.create({
      name:     pending.name,
      email:    pending.email,
      password: pending.password,  // already hashed
      role:     "viewer",
    });

    await PendingSignup.deleteOne({ email });

    // Record first login time without triggering pre-save hash
    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    const token = signToken(user);

    res.status(201).json({
      message: "Account verified and created successfully.",
      user:    user.toPublicJSON(),
      token,
    });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error:  "Email already registered",
        fields: { email: "An account with this email address already exists" },
      });
    }
    console.error("[POST /auth/verify-otp]", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────
/**
 * Authenticate an existing user.
 *
 * Body: { email, password }
 *
 * Returns: { user, token }
 */
router.post("/login", loginRules, async (req, res) => {
  if (handleValidation(req, res)) return;

  try {
    const { email, password } = req.body;

    // Explicitly select password since it's excluded by default (select: false)
    const user = await User.findOne({ email }).select("+password");

    // Use the same generic message for both "not found" and "wrong password"
    // to avoid user enumeration attacks
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: "Account is disabled. Contact an administrator.",
      });
    }

    const passwordMatch = await user.comparePassword(password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Update last login timestamp
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);

    res.status(200).json({
      message: "Login successful",
      user:    user.toPublicJSON(),
      token,
    });

  } catch (err) {
    console.error("[POST /auth/login]", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
/**
 * Return the currently authenticated user's profile.
 * Requires a valid Bearer token in Authorization header.
 *
 * Returns: { user }
 */
router.get("/me", protect, async (req, res) => {
  // req.user is already populated by the protect middleware (no password)
  res.status(200).json({
    user: req.user.toPublicJSON(),
  });
});

// ─── PATCH /auth/me ───────────────────────────────────────────────────────────
/**
 * Update the current user's own name or profileImage.
 * Password changes require a dedicated endpoint (not implemented here) so that
 * they can enforce re-entry of the old password.
 */
router.patch(
  "/me",
  protect,
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 80 }).withMessage("Name must be 2–80 characters"),
    body("profileImage")
      .optional()

  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const allowed = ["name", "profileImage"];
      const update  = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

      const updated = await User.findByIdAndUpdate(
        req.user._id,
        update,
        { new: true, runValidators: true }
      );

      res.status(200).json({
        message: "Profile updated",
        user:    updated.toPublicJSON(),
      });
    } catch (err) {
      console.error("[PATCH /auth/me]", err);
      res.status(500).json({ error: "Server error. Please try again." });
    }
  }
);


// ─── PUT /auth/update ─────────────────────────────────────────────────────────
/**
 * Update the logged-in user's profile and/or password in one call.
 *
 * Body (all fields optional — send only what needs to change):
 *   { name, email, profileImage, currentPassword, newPassword }
 *
 * profileImage: base64 data URL, https:// URL, or null (to clear).
 * Password change: both currentPassword + newPassword must be provided together.
 *
 * Returns: { message, user }
 */
router.put(
  "/update",
  protect,
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 80 }).withMessage("Name must be 2–80 characters"),

    body("email")
      .optional()
      .trim()
      .isEmail().withMessage("Must be a valid email address")
      .normalizeEmail(),

    body("newPassword")
      .optional()
      .isLength({ min: 8 }).withMessage("Password must be at least 8 characters")
      .matches(/[A-Za-z]/).withMessage("Password must contain at least one letter")
      .matches(/\d/).withMessage("Password must contain at least one number"),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const { name, email, profileImage, currentPassword, newPassword } = req.body;
      const hasProfileChanges = name !== undefined || email !== undefined || profileImage !== undefined;
      const hasPasswordChange = !!newPassword;

      if (!hasProfileChanges && !hasPasswordChange) {
        return res.status(400).json({ error: "No changes provided" });
      }

      // Load user with +password so pre-save hook can hash if needed
      const user = await User.findById(req.user._id).select("+password");

      // ── Verify current password before accepting a new one ─────────────
      if (hasPasswordChange) {
        if (!currentPassword) {
          return res.status(422).json({
            error:  "Validation failed",
            fields: { currentPassword: "Current password is required to set a new one" },
          });
        }
        const match = await user.comparePassword(currentPassword);
        if (!match) {
          return res.status(422).json({
            error:  "Validation failed",
            fields: { currentPassword: "Current password is incorrect" },
          });
        }
        user.password = newPassword; // pre-save hook in User.js hashes it
      }

      // ── Email uniqueness check ─────────────────────────────────────────
      if (email !== undefined && email !== user.email) {
        const taken = await User.findOne({ email, _id: { $ne: user._id } });
        if (taken) {
          return res.status(409).json({
            error:  "Validation failed",
            fields: { email: "This email address is already in use" },
          });
        }
        user.email = email;
      }

      // ── Apply profile field changes ────────────────────────────────────
      if (name !== undefined)         user.name         = name;
      if (profileImage !== undefined) user.profileImage = profileImage || null;

      // Single save — pre-save hook only hashes if password was modified
      await user.save();

      res.status(200).json({
        message: hasPasswordChange && hasProfileChanges
          ? "Profile and password updated"
          : hasPasswordChange ? "Password updated" : "Profile updated",
        user: user.toPublicJSON(),
      });

    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          error:  "Validation failed",
          fields: { email: "This email address is already in use" },
        });
      }
      console.error("[PUT /auth/update]", err);
      res.status(500).json({
        error: err.message || "Server error",
        type:  err.name,
        ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
      });
    }
  }
);

module.exports = router;
