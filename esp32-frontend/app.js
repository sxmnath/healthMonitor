const API = "http://10.119.198.71:3000/api/dashboard"; //same ip as device ip in arduino code

function healthLabel(score) {
  if (score <= 1) return "Normal";
  if (score <= 3) return "Mild Risk";
  if (score <= 6) return "Moderate Risk";
  return "High Risk";
}

const explanations = {
  "Stress detected":
    "Elevated heart rate with normal oxygen suggests stress.",
  "Fever risk":
    "High temperature with increased heart rate suggests fever.",
  "Respiratory concern":
    "Low oxygen saturation may indicate breathing issues.",
  "Normal":
    "All vitals are within healthy ranges."
};

const deviceNameMap = {
  "ESP32_01": "Patient 1",
  "ESP32_02": "Patient 2"
};

async function loadDashboard() {
  const res = await fetch(API);
  const data = await res.json();

  // Patient name
    const patient =
    deviceNameMap[data.deviceId] || data.deviceId;

  document.getElementById("patientName").innerText =
    `Health Monitor — ${patient}`;

// Status (with color coding)
const statusCard = document.getElementById("statusCard");
const label = healthLabel(data.fusion.riskScore);

statusCard.innerText = label;

statusCard.style.color =
  label === "Normal" ? "#16a34a" :
  label === "Mild Risk" ? "#ca8a04" :
  label === "Moderate Risk" ? "#ea580c" :
  "#dc2626";


  // Vitals
  document.getElementById("hr").innerText =
    `HR: ${data.vitals.heartRate} bpm`;
  document.getElementById("spo2").innerText =
    `SpO₂: ${data.vitals.spo2} %`;
  document.getElementById("temp").innerText =
    `Temp: ${data.vitals.temperature} °C`;

  // Fusion cards
  document.getElementById("fusion").innerHTML = "";
  data.fusion.indicators.forEach(i => {
    const div = document.createElement("div");
    div.innerText = `${i} — ${explanations[i]}`;
    document.getElementById("fusion").appendChild(div);
  });

  // Time
  document.getElementById("updated").innerText =
    `Last updated: ${new Date(data.time).toLocaleTimeString()}`;
}

setInterval(loadDashboard, 3000);
loadDashboard();
