"use strict";
/**
 * FHIR R4 serialisation for ABDM (Ayushman Bharat Digital Mission).
 *
 * Maps healthMonitor SensorData readings to FHIR Observation resources and
 * wraps them — alongside a Composition resource — in a "document" Bundle,
 * which is the shape the ABDM Health Repository expects from a HIP push.
 *
 * LOINC codes used:
 *   Heart rate (ECG-primary)  → 8867-4
 *   SpO2                      → 59408-5
 *   Temperature               → 8310-5
 */

const LOINC = {
  heartRate: { code: "8867-4",  display: "Heart rate" },
  spo2:      { code: "59408-5", display: "Oxygen saturation in Arterial blood" },
  tempF:     { code: "8310-5",  display: "Body temperature" },
};

function toFhirObservation(reading, patientAbhaId, field, precomputedHrValue) {
  const isTemp = field === "tempF";
  const isHr   = field === "heartRate";

  const valueQuantity = isTemp
    ? {
        value:  Number((((reading.temperatureF - 32) * 5) / 9).toFixed(2)),
        unit:   "Cel", system: "http://unitsofmeasure.org", code: "Cel",
      }
    : isHr
    ? { value: precomputedHrValue, unit: "beats/min", system: "http://unitsofmeasure.org", code: "/min" }
    : { value: reading.spo2, unit: "%", system: "http://unitsofmeasure.org", code: "%" };

  return {
    resourceType: "Observation",
    id: `${reading._id}-${field}`,
    status: "final",
    subject: { identifier: { system: "https://healthid.ndhm.gov.in", value: patientAbhaId } },
    effectiveDateTime: new Date(reading.time).toISOString(),
    code: { coding: [{ system: "http://loinc.org", ...LOINC[field] }] },
    valueQuantity,
  };
}

// Same ECG-primary / legacy-fallback rule the dashboard uses:
//   ecgHeartRate is a real number  → use it (ECG primary)
//   ecgHeartRate === -1 (leads off)→ null — no reliable reading, omit the observation
//   ecgHeartRate is null/undefined → fall back to legacy MAX30102 heartRate
function resolveHrValue(reading) {
  if (reading.ecgHeartRate == null) return reading.heartRate ?? null;
  if (reading.ecgHeartRate === -1)  return null;
  return reading.ecgHeartRate;
}

// One SensorData document → up to 3 Observation resources.
// Skips fields that are missing or hold the "not connected" sentinel (-1).
function readingToObservations(reading, abhaId) {
  const obs = [];
  const hrValue = resolveHrValue(reading);

  if (hrValue != null)                                obs.push(toFhirObservation(reading, abhaId, "heartRate", hrValue));
  if (reading.spo2 != null && reading.spo2 !== -1)     obs.push(toFhirObservation(reading, abhaId, "spo2"));
  if (reading.temperatureF != null)                    obs.push(toFhirObservation(reading, abhaId, "tempF"));
  return obs;
}

/**
 * Builds the full document Bundle for a discharge push: a Composition
 * (the clinical document header) plus one Observation per vital per
 * reading, referenced from the Composition's "Vitals" section.
 */
function buildBundle(patient, readings) {
  const abhaId = patient.abhaNumber;
  const observations = readings.flatMap(r => readingToObservations(r, abhaId));

  const composition = {
    resourceType: "Composition",
    status: "final",
    type: {
      coding: [{ system: "http://snomed.info/sct", code: "371530004", display: "Clinical consultation report" }],
    },
    subject: { identifier: { system: "https://healthid.ndhm.gov.in", value: abhaId } },
    date: new Date().toISOString(),
    title: `Discharge Summary — ${patient.name || patient.patient_id}`,
    section: [
      {
        title: "Vitals",
        code: { coding: [{ system: "http://loinc.org", code: "8716-3", display: "Vital signs" }] },
        entry: observations.map(o => ({ reference: `Observation/${o.id}` })),
      },
    ],
  };

  return {
    resourceType: "Bundle",
    type: "document",
    timestamp: new Date().toISOString(),
    entry: [
      { resource: composition },
      ...observations.map(o => ({ resource: o })),
    ],
  };
}

module.exports = { buildBundle, readingToObservations };
