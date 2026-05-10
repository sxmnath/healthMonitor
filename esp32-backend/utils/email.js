"use strict";
const { BrevoClient } = require("@getbrevo/brevo");

/**
 * Sends OTP emails via Brevo Transactional Email REST API (port 443).
 * No domain verification needed — works out of the box on Render free tier.
 *
 * Required env var : BREVO_API_KEY  (from brevo.com → SMTP & API → API Keys)
 * Optional env var : EMAIL_FROM     (e.g. "healthMonitor <noreply@yourdomain.com>")
 *                                   defaults to a generic sender name
 *
 * If BREVO_API_KEY is not set, OTP is printed to server logs only.
 */

let _client = null;

function getClient() {
  if (_client) return _client;
  if (process.env.BREVO_API_KEY) {
    _client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
    return _client;
  }
  console.warn("[email] BREVO_API_KEY not set — OTP will be printed to console only.");
  return null;
}

async function sendOtpEmail(to, name, otp) {
  const client    = getClient();
  const firstName = (name || "there").split(" ")[0];

  if (!client) {
    console.log(`[email] OTP for ${to}: ${otp}`);
    return;
  }

  // Parse EMAIL_FROM env var or use default
  const fromRaw  = process.env.EMAIL_FROM || "healthMonitor <noreply@healthmonitor.app>";
  const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
  const sender = fromMatch
    ? { name: fromMatch[1].trim(), email: fromMatch[2].trim() }
    : { name: "healthMonitor", email: fromRaw.trim() };

  const result = await client.transactionalEmails.sendTransacEmail({
    sender,
    to: [{ email: to, name: name || to }],
    subject: `${otp} is your healthMonitor verification code`,
    textContent: `Hi ${firstName},\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\n— healthMonitor`,
    htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#f5f0e8;font-family:'Segoe UI',Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 16px;"><tr><td align="center"><table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.09);"><tr><td style="background:#1a1a2e;padding:28px 36px;"><span style="color:#e8b4cb;font-size:1.3rem;font-weight:700;">&#9829; healthMonitor</span></td></tr><tr><td style="padding:36px;"><p style="margin:0 0 8px;font-size:1rem;color:#1a1a2e;font-weight:600;">Hi ${firstName},</p><p style="margin:0 0 28px;font-size:0.9rem;color:#5a5570;line-height:1.6;">Use the code below to verify your email. It expires in <strong>10 minutes</strong>.</p><div style="background:#f5f0e8;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;"><div style="letter-spacing:0.35em;font-size:2.2rem;font-weight:700;color:#1a1a2e;font-family:'Courier New',monospace;">${otp}</div></div><p style="margin:0;font-size:0.82rem;color:#9b96a8;">If you did not create a healthMonitor account, ignore this email.</p></td></tr><tr><td style="padding:16px 36px 28px;border-top:1px solid #e8e2d8;"><p style="margin:0;font-size:0.78rem;color:#9b96a8;">healthMonitor &mdash; Real-time patient monitoring</p></td></tr></table></td></tr></table></body></html>`,
  });

  console.log("[email] Sent via Brevo, messageId:", result && result.messageId);
}

module.exports = { sendOtpEmail };
