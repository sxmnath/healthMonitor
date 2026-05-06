// Auth guard — redirects to /login if no token stored
if (typeof requireAuth === "function" && !requireAuth()) throw new Error("redirect");

const PATIENTS_API = "/api/patients";

// Active ward filter — empty string means all wards
let _activeWard = "";

function setWardWsStatus(state) {
  // WS status reflected via patient-count-pill border color
  const pill = document.getElementById("patientCount")?.closest(".patient-count-pill");
  const colors = { connected: "#3dab6e", disconnected: "#e05c5c", connecting: "#e09a3c" };
  if (pill) pill.style.borderColor = colors[state] || colors.connecting;
}

function timeAgo(dateStr) {
  const secs = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (secs < 10)   return "just now";
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function buildCard(patient, index) {
  const { patient_id, name, vitals, fusion, status, lastSeen,
          roomNo, ward, age, gender, bloodType, physician } = patient;

  const badgeClass = `badge-${status}`;
  const badgeLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const insight    = fusion?.indicators?.[0] || "Normal";
  const spo2Display = vitals.spo2 === -1 ? "—" : vitals.spo2;
  const tempF       = vitals.temperatureF != null ? vitals.temperatureF : "--";

  // Build meta line from available profile fields
  const metaParts = [];
  if (age)       metaParts.push(`${age} yrs`);
  if (gender)    metaParts.push(gender);
  if (bloodType) metaParts.push(`Blood: ${bloodType}`);
  const metaLine = metaParts.join(" · ") || "—";

  // Room / ward
  const locationParts = [];
  if (roomNo) locationParts.push(`Room ${roomNo}`);
  if (ward)   locationParts.push(ward);
  const locationLine = locationParts.join(" · ") || "—";

  const card = document.createElement("a");
  card.className = `patient-card status-${status}`;
  card.href = `/patient?id=${encodeURIComponent(patient_id)}`;
  card.style.animationDelay = `${index * 70}ms`;

  card.innerHTML = `
    <div class="card-top">
      <div class="card-name-block">
        <div class="patient-avatar-sm"><i class="fa-solid fa-user-injured"></i></div>
        <div>
          <div class="patient-name">${name}</div>
          <div class="patient-meta-line">${metaLine}</div>
        </div>
      </div>
      <div class="card-badges">
        <span class="pid-badge">${patient_id}</span>
        <span class="status-badge ${badgeClass}">${badgeLabel}</span>
      </div>
    </div>

    <div class="card-location">
      <i class="fa-solid fa-location-dot"></i>
      <span>${locationLine}</span>
      ${physician ? `<span class="card-physician"><i class="fa-solid fa-user-doctor"></i> ${physician}</span>` : ""}
    </div>

    <div class="vitals-row">
      <div class="vital-chip">
        <i class="fa-solid fa-heart-pulse chip-icon chip-icon-hr"></i>
        <span class="chip-val">${vitals.heartRate ?? "--"}</span>
        <span class="chip-unit">bpm</span>
      </div>
      <div class="vital-chip ${vitals.spo2 === -1 ? "chip-nc" : ""}">
        <i class="fa-solid fa-lungs chip-icon chip-icon-spo2"></i>
        <span class="chip-val">${spo2Display}</span>
        <span class="chip-unit">${vitals.spo2 === -1 ? "N/C" : "SpO₂ %"}</span>
      </div>
      <div class="vital-chip">
        <i class="fa-solid fa-temperature-half chip-icon chip-icon-temp"></i>
        <span class="chip-val">${tempF}</span>
        <span class="chip-unit">°F</span>
      </div>
    </div>

    <div class="insight-row">
      <i class="fa-solid fa-brain"></i>
      <span>${insight}</span>
    </div>

    <div class="card-footer">
      <span class="last-seen"><i class="fa-regular fa-clock"></i> ${timeAgo(lastSeen)}</span>
      <span class="view-btn">View <i class="fa-solid fa-arrow-right"></i></span>
    </div>`;

  return card;
}

function renderPatients(patients) {
  const grid = document.getElementById("patientGrid");
  grid.innerHTML = "";

  if (!patients.length) {
    const emptyMsg = _activeWard
      ? `No patients found in <strong>${_activeWard}</strong>.`
      : "No patients connected yet. Waiting for ESP32 devices…";
    grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-plug-circle-xmark"></i><p>${emptyMsg}</p></div>`;
    return;
  }

  patients.forEach((p, i) => grid.appendChild(buildCard(p, i)));

  document.getElementById("patientCount").textContent  = patients.length;
  document.getElementById("countCritical").textContent = patients.filter(p => p.status === "critical").length;
  document.getElementById("countWarning").textContent  = patients.filter(p => p.status === "warning").length;
  document.getElementById("countStable").textContent   = patients.filter(p => p.status === "stable").length;
  document.getElementById("wardUpdated").textContent        = new Date().toLocaleTimeString();
  const footer = document.getElementById("wardFooterUpdated");
  if (footer) footer.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
}

async function fetchPatients(ward) {
  if (ward !== undefined) _activeWard = ward;
  const url = _activeWard
    ? `${PATIENTS_API}?ward=${encodeURIComponent(_activeWard)}`
    : PATIENTS_API;
  try {
    const res  = await authFetch(url);
    const data = await res.json();
    renderPatients(Array.isArray(data) ? data : []);
  } catch (e) { console.warn("Failed to fetch patients:", e.message); }
}

function onWardChange(value) {
  fetchPatients(value);
}

document.addEventListener("DOMContentLoaded", () => {
  fetchCurrentUser();
  setWardWsStatus("connecting");
  fetchPatients();

  // Sidebar collapse — same behaviour as patient page
  document.getElementById("wardSidebarToggle")?.addEventListener("click", () => {
    document.getElementById("wardSidebar")?.classList.toggle("collapsed");
  });

  const socket = io();
  socket.on("connect",             () => setWardWsStatus("connected"));
  socket.on("disconnect",          () => setWardWsStatus("disconnected"));
  socket.on("patient-list-update", () => fetchPatients());

  setInterval(fetchPatients, 5000);
});
