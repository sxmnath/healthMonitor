// analyzeHealth — works with temperatureF (Fahrenheit)
//
// motion (optional, Part 5 addition): { activityScore, posture, motionDetected }
// Sourced from the MPU6050 fusion layer (Part 4 in server.js). When omitted,
// all motion-derived behaviour is inert (activityScore=0, posture="unknown",
// motionDetected=false) so this remains backward compatible with any caller
// still invoking analyzeHealth(hr, spo2, tempF) with 3 args.
function analyzeHealth(hr, spo2, tempF, motion = {}) {
  const indicators = [];
  let riskScore    = 0;

  const spo2Connected = spo2 !== -1 && spo2 != null;
  const {
    activityScore  = 0,
    posture        = "unknown",
    motionDetected = false,
  } = motion || {};

  // High activity means an elevated HR is expected exertion, not stress —
  // suppress the tachycardia/stress indicator above this threshold.
  const highActivity = activityScore > 50;

  if (hr > 100 && spo2Connected && spo2 >= 95 && tempF < 100.4 && !highActivity) {
    indicators.push("Stress detected");
    riskScore += 2;
  }
  if (tempF >= 100.4 && hr > 95) {
    indicators.push("Fever risk");
    riskScore += 3;
  }
  if (spo2Connected && spo2 < 92 && hr <= 100) {
    indicators.push("Respiratory concern");
    riskScore += 4;
  }
  if (!spo2Connected) {
    indicators.push("SpO₂ sensor disconnected");
    riskScore += 1;
  }

  // ── Motion-derived indicators (Part 5) ────────────────────────────────────
  if (activityScore > 60 && hr > 100) {
    indicators.push("Elevated activity");
    riskScore += 1;
  }
  if (activityScore > 70 && spo2Connected && spo2 < 94) {
    indicators.push("Exertional desaturation");
    riskScore += 3;
  }
  if (motionDetected === false && posture === "supine") {
    indicators.push("Prolonged immobility");
    riskScore += 1;
  }

  if (indicators.length === 0) {
    indicators.push("Normal");
  }

  return { indicators, riskScore };
}

module.exports = analyzeHealth;
