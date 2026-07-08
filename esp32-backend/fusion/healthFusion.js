// analyzeHealth — works with temperatureF (Fahrenheit)
//
// motion = { activityScore, posture, motionDetected }
//   activityScore  — 0–100, derived from excess acceleration above 1g baseline
//   posture        — "upright" | "supine" | "lateral" | "unknown"
//   motionDetected — boolean, true if magnitude > 1.2g
//
// All motion fields have safe defaults so existing call sites that don't
// pass the 4th argument continue to work without any changes.
function analyzeHealth(hr, spo2, tempF, motion = {}) {
  const {
    activityScore  = 0,
    posture        = "unknown",
    motionDetected = true,    // assume mobile by default — avoids false immobility alerts
                              // when MPU6050 data is absent (motionDetected defaults to true
                              // in SensorData model too, so old docs won't trigger this)
  } = motion;

  const indicators = [];
  let riskScore    = 0;

  const spo2Connected = spo2 !== -1 && spo2 != null;
  const highActivity  = activityScore > 50;  // threshold for suppressing false positives

  // ── Stress detected (tachycardia at rest) ──────────────────────────────────
  // Suppressed when activityScore > 50 — elevated HR during exercise is expected
  // and should not be flagged as stress. "Elevated activity" fires instead (below).
  if (hr > 100 && spo2Connected && spo2 >= 95 && tempF < 100.4 && !highActivity) {
    indicators.push("Stress detected");
    riskScore += 2;
  }

  // ── Elevated activity ───────────────────────────────────────────────────────
  // Informational — not a warning. High HR during movement is physiologically normal.
  if (activityScore > 60 && hr > 100) {
    indicators.push("Elevated activity");
    riskScore += 1;
  }

  // ── Fever risk ──────────────────────────────────────────────────────────────
  if (tempF >= 100.4 && hr > 95) {
    indicators.push("Fever risk");
    riskScore += 3;
  }

  // ── Respiratory concern ─────────────────────────────────────────────────────
  if (spo2Connected && spo2 < 92 && hr <= 100) {
    indicators.push("Respiratory concern");
    riskScore += 4;
  }

  // ── Exertional desaturation ─────────────────────────────────────────────────
  // SpO₂ drop during high activity is more clinically significant than at rest —
  // it may indicate reduced cardiorespiratory reserve.
  if (activityScore > 70 && spo2Connected && spo2 < 94) {
    indicators.push("Exertional desaturation");
    riskScore += 3;
  }

  // ── SpO₂ sensor disconnected ────────────────────────────────────────────────
  if (!spo2Connected) {
    indicators.push("SpO₂ sensor disconnected");
    riskScore += 1;
  }

  // ── Prolonged immobility ────────────────────────────────────────────────────
  // No movement detected while lying on back — pressure sore risk for bedridden patients.
  // Only fires when motionDetected is explicitly false (not the default true) so it
  // does not trigger on old readings that predate MPU6050 integration.
  if (motionDetected === false && posture === "supine") {
    indicators.push("Prolonged immobility");
    riskScore += 2;
  }

  if (indicators.length === 0) {
    indicators.push("Normal");
  }

  return { indicators, riskScore };
}

module.exports = analyzeHealth;
