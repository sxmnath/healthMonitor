"use strict";
const PDFDocument = require("pdfkit");

/**
 * Generates a discharge summary PDF — the local, always-works half of the
 * "Discharge & Export" action (the ABHA push is the networked half, see
 * utils/abdm.js + utils/fhir.js).
 *
 * @param {Object} patient  - Patient document (lean or full mongoose doc)
 * @param {Array}  readings - SensorData docs for the stay, oldest → newest
 * @param {Array}  alerts   - Alert docs for the stay, newest → oldest
 * @returns {Promise<Buffer>}
 */
function generateDischargeSummary(patient, readings = [], alerts = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header ────────────────────────────────────────────────────────────
    doc.fontSize(20).fillColor("#1a1a2e").text("healthMonitor", { continued: true });
    doc.fillColor("#e8547a").text("  Discharge Summary");
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor("#666666").text(`Generated ${new Date().toLocaleString()}`);
    doc.moveDown();
    doc.strokeColor("#e2e8f0").moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();

    // ── Patient details ──────────────────────────────────────────────────
    doc.fontSize(13).fillColor("#0f172a").text("Patient Details");
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#334155");
    const row = (label, val) => doc.text(`${label}: ${val || "\u2014"}`);
    row("Name",                patient.name);
    row("Patient ID",          patient.patient_id);
    row("Age / Gender",        `${patient.age || "\u2014"} / ${patient.gender || "\u2014"}`);
    row("Blood Type",          patient.bloodType);
    row("Ward / Room",         `${patient.ward || "\u2014"} / ${patient.roomNo || "\u2014"}`);
    row("Attending Physician", patient.physician);
    row("Diagnosis",           patient.diagnosis);
    row("ABHA Number",         patient.abhaNumber ? `${patient.abhaNumber}${patient.abhaLinked ? " (linked)" : " (not verified)"}` : "Not linked");
    doc.moveDown();

    // ── Vitals summary ───────────────────────────────────────────────────
    doc.fontSize(13).fillColor("#0f172a").text("Vitals Summary");
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#334155");

    if (readings.length) {
      const hrVals = readings
        .map(r => {
          if (r.ecgHeartRate == null) return r.heartRate ?? null;   // legacy device, no ECG field sent
          if (r.ecgHeartRate === -1)  return null;                  // leads off — no reliable reading
          return r.ecgHeartRate;                                    // ECG primary
        })
        .filter(v => v != null);
      const spo2Vals = readings.map(r => r.spo2).filter(v => v != null && v !== -1);
      const tempVals = readings.map(r => r.temperatureF).filter(v => v != null);
      const stat = arr => (arr.length
        ? { min: Math.min(...arr), max: Math.max(...arr), avg: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) }
        : null);
      const hrS = stat(hrVals), spo2S = stat(spo2Vals), tempS = stat(tempVals);

      doc.text(`Readings recorded: ${readings.length}`);
      doc.text(`Session start: ${new Date(patient.admittedAt || readings[0].time).toLocaleString()}`);
      doc.text(`Session end: ${new Date(readings[readings.length - 1].time).toLocaleString()}`);
      doc.moveDown(0.4);
      if (hrS)   doc.text(`Heart Rate (ECG-primary):  min ${hrS.min}  ·  avg ${hrS.avg}  ·  max ${hrS.max} bpm`);
      if (spo2S) doc.text(`SpO2:                      min ${spo2S.min}  ·  avg ${spo2S.avg}  ·  max ${spo2S.max} %`);
      if (tempS) doc.text(`Temperature:               min ${tempS.min}  ·  avg ${tempS.avg}  ·  max ${tempS.max} \u00B0F`);
    } else {
      doc.fillColor("#94a3b8").text("No vitals recorded during this stay.");
    }
    doc.moveDown();

    // ── Alerts during stay ───────────────────────────────────────────────
    doc.fontSize(13).fillColor("#0f172a").text("Alerts During Stay");
    doc.moveDown(0.4);
    doc.fontSize(10);
    if (alerts.length) {
      alerts.slice(0, 30).forEach(a => {
        doc.fillColor(a.severity === "critical" ? "#dc2626" : "#d97706")
           .text(`[${a.severity.toUpperCase()}] ${new Date(a.createdAt).toLocaleString()} \u2014 ${a.message}`);
      });
      if (alerts.length > 30) doc.fillColor("#94a3b8").text(`\u2026and ${alerts.length - 30} more.`);
    } else {
      doc.fillColor("#94a3b8").text("No alerts recorded during this stay.");
    }

    // ── Footer ────────────────────────────────────────────────────────────
    doc.moveDown(2);
    doc.fontSize(8).fillColor("#94a3b8").text(
      "This summary was generated automatically by healthMonitor. It is not a substitute for clinical judgement.",
      { align: "center" }
    );

    doc.end();
  });
}

module.exports = { generateDischargeSummary };
