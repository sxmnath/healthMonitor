"use strict";
const { Resend } = require("resend");

/**
 * Sends OTP emails via Resend (https://resend.com).
 * Resend uses HTTPS — not raw SMTP — so it works on Render's free tier
 * where outbound SMTP ports (465, 587) are blocked.
 *
 * Required env var: RESEND_API_KEY
 * Optional env var: EMAIL_FROM  (defaults to onboarding@resend.dev which
 *                                works without a custom domain for testing)
 *
 * If RESEND_API_KEY is not set, the OTP is printed to the server log only.
 */

let _client = null;

function getClient() {
  if (_client) return _client;
  if (process.env.RESEND_API_KEY) {
    _client = new Resend(process.env.RESEND_API_KEY);
    return _client;
  }
  console.warn("[email] RESEND_API_KEY not set — OTP will be printed to console only.");
  return null;
}

async function sendOtpEmail(to, name, otp) {
  const client    = getClient();
  const firstName = (name || "there").split(" ")[0];

  // Console-only fallback when no API key is configured
  if (!client) {
    console.log(`[email] OTP for ${to}: ${otp}`);
    return;
  }

  const from = process.env.EMAIL_FROM || "healthMonitor <onboarding@resend.dev>";

  const { error } = await client.emails.send({
    from,
    to,
    subject: `${otp} is your healthMonitor verification code`,
    text: `Hi ${firstName},\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\n— healthMonitor`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.09);">
        <tr>
          <td style="background:#1a1a2e;padding:28px 36px;">
            <span style="color:#e8b4cb;font-size:1.3rem;font-weight:700;">&#9829; healthMonitor</span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 36px 28px;">
            <p style="margin:0 0 8px;font-size:1rem;color:#1a1a2e;font-weight:600;">Hi ${firstName},</p>
            <p style="margin:0 0 28px;font-size:0.9rem;color:#5a5570;line-height:1.6;">
              Use the code below to verify your email and complete sign-up.
              It expires in <strong>10 minutes</strong>.
            </p>
            <div style="background:#f5f0e8;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
              <div style="letter-spacing:0.35em;font-size:2.2rem;font-weight:700;color:#1a1a2e;font-family:'Courier New',monospace;">
                ${otp}
              </div>
            </div>
            <p style="margin:0;font-size:0.82rem;color:#9b96a8;line-height:1.6;">
              If you didn't create a healthMonitor account, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px 28px;border-top:1px solid #e8e2d8;">
            <p style="margin:0;font-size:0.78rem;color:#9b96a8;">healthMonitor &mdash; Real-time patient monitoring</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });

  if (error) {
    throw new Error(error.message || "Resend API error");
  }
}

module.exports = { sendOtpEmail };


/**
 * Lazy-initialised transporter.
 * Priority:
 *   1. EMAIL_USER + EMAIL_PASS env vars → real SMTP (Gmail, Outlook, etc.)
 *   2. Neither set → console-only mode (OTP is printed to server logs)
 *
 * Ethereal is intentionally removed — it requires an outbound HTTP call to
 * api.nodemailer.com which is blocked on Render's free tier and causes the
 * signup route to hang for 1-2 minutes then 500.
 */
let _transporter = null;
let _consoleOnly  = false;

function getTransporter() {
  if (_transporter) return _transporter;

  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    _transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
    return _transporter;
  }

  // No credentials configured — fall back to console logging.
  // This is safe for dev; on production EMAIL_USER must be set.
  _consoleOnly = true;
  console.warn("[email] EMAIL_USER not set — OTP will be printed to console only.");
  return null;
}

/**
 * Send the OTP verification email.
 * @param {string} to    - recipient email
 * @param {string} name  - recipient name (for greeting)
 * @param {string} otp   - 6-digit code
 */
async function sendOtpEmail(to, name, otp) {
  const transporter = getTransporter();

  // Console-only mode — log and return immediately, no network call
  if (_consoleOnly || !transporter) {
    console.log(`[email] OTP for ${to}: ${otp}`);
    return;
  }

  const firstName = (name || "there").split(" ")[0];

  await transporter.sendMail({
    from:    `"healthMonitor" <${process.env.EMAIL_USER}>`,
    to,
    subject: `${otp} is your healthMonitor verification code`,
    text: `Hi ${firstName},\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\n— healthMonitor`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.09);">
        <tr>
          <td style="background:#1a1a2e;padding:28px 36px;">
            <span style="color:#e8b4cb;font-size:1.3rem;font-weight:700;">&#9829; healthMonitor</span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 36px 28px;">
            <p style="margin:0 0 8px;font-size:1rem;color:#1a1a2e;font-weight:600;">Hi ${firstName},</p>
            <p style="margin:0 0 28px;font-size:0.9rem;color:#5a5570;line-height:1.6;">
              Use the code below to verify your email and complete sign-up. It expires in <strong>10 minutes</strong>.
            </p>
            <div style="background:#f5f0e8;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
              <div style="letter-spacing:0.35em;font-size:2.2rem;font-weight:700;color:#1a1a2e;font-family:'Courier New',monospace;">
                ${otp}
              </div>
            </div>
            <p style="margin:0;font-size:0.82rem;color:#9b96a8;line-height:1.6;">
              If you didn't create an account with healthMonitor, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px 28px;border-top:1px solid #e8e2d8;">
            <p style="margin:0;font-size:0.78rem;color:#9b96a8;">healthMonitor &mdash; Real-time patient monitoring</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

module.exports = { sendOtpEmail };


/**
 * Send the OTP verification email.
 * @param {string} to    - recipient email
 * @param {string} name  - recipient first name (for greeting)
 * @param {string} otp   - 6-digit code
 */
async function sendOtpEmail(to, name, otp) {
  const transporter = await getTransporter();
  const firstName   = (name || "there").split(" ")[0];

  const info = await transporter.sendMail({
    from:    `"healthMonitor" <${process.env.EMAIL_USER || "noreply@healthmonitor.app"}>`,
    to,
    subject: `${otp} is your healthMonitor verification code`,
    text:    `Hi ${firstName},\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can safely ignore this email.\n\n— healthMonitor`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.09);">

        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e;padding:28px 36px;text-align:left;">
            <span style="color:#e8b4cb;font-size:1.3rem;font-weight:700;letter-spacing:-0.02em;">
              &#9829; healthMonitor
            </span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 36px 28px;">
            <p style="margin:0 0 8px;font-size:1rem;color:#1a1a2e;font-weight:600;">
              Hi ${firstName},
            </p>
            <p style="margin:0 0 28px;font-size:0.9rem;color:#5a5570;line-height:1.6;">
              Use the code below to verify your email address and complete sign-up.
              It expires in <strong>10 minutes</strong>.
            </p>

            <!-- OTP block -->
            <div style="background:#f5f0e8;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
              <div style="letter-spacing:0.35em;font-size:2.2rem;font-weight:700;color:#1a1a2e;font-family:'Courier New',monospace;">
                ${otp}
              </div>
            </div>

            <p style="margin:0;font-size:0.82rem;color:#9b96a8;line-height:1.6;">
              If you didn't create an account with healthMonitor, you can safely ignore this email.
              Your email will not be registered.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 36px 28px;border-top:1px solid #e8e2d8;">
            <p style="margin:0;font-size:0.78rem;color:#9b96a8;">
              healthMonitor &mdash; Real-time patient monitoring
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });

  // In dev (Ethereal), log the preview URL so you can see the email without a real inbox
  if (process.env.NODE_ENV !== "production") {
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[email] OTP preview → ${previewUrl}`);
    } else {
      console.log(`[email] OTP sent to ${to} — code: ${otp}`);
    }
  }

  return info;
}

module.exports = { sendOtpEmail };
