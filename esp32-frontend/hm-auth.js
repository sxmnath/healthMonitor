"use strict";
// ─── auth.js — included on every protected page ───────────────────────────────
// Provides: getToken, setToken, clearToken, authFetch, requireAuth

const TOKEN_KEY = "hm_token";

// ── Token storage ─────────────────────────────────────────────────────────────
function getToken()          { return localStorage.getItem(TOKEN_KEY); }
function setToken(token)     { localStorage.setItem(TOKEN_KEY, token); }
function clearToken()        { localStorage.removeItem(TOKEN_KEY); }

// ── Auth guard — call at top of every protected page ──────────────────────────
// Redirects to /login if no valid token is stored.
function protectPage() {
  if (!getToken()) {
    document.documentElement.style.visibility = "hidden";
    window.location.replace("/login");
    return false;
  }
  return true;
}

function publicOnlyPage() {
  if (getToken()) {
    document.documentElement.style.visibility = "hidden";
    window.location.replace("/");
    return false;
  }
  return true;
}

// requireAuth: alias for backwards compatibility
function requireAuth() { return protectPage(); }

// ── Authenticated fetch wrapper ───────────────────────────────────────────────
// Drop-in replacement for fetch() that:
//   • Injects Authorization: Bearer <token> automatically
//   • Redirects to /login on 401 (expired / invalid token)
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.replace("/login");
    // Return a never-resolving promise so callers don't continue executing
    return new Promise(() => {});
  }

  return res;
}

// ── fetchCurrentUser() ────────────────────────────────────────────────────────
// Fetches /api/auth/me and populates the topbar user identity elements.
// Call once after DOMContentLoaded on every protected page.
async function fetchCurrentUser() {
  try {
    const res  = await authFetch("/api/auth/me");
    const data = await res.json();
    const user = data.user;
    if (!user) return;

    // Greeting — first name only to keep it compact
    const nameEl = document.getElementById("topbarUserName");
    if (nameEl) {
      nameEl.textContent = user.name ? user.name.split(" ")[0] : user.email;
    }

    // Avatar — swap icon for <img> if a profileImage URL is set
    const avatarEl = document.getElementById("topbarAvatar");
    if (avatarEl && user.profileImage) {
      avatarEl.innerHTML = `<img src="${user.profileImage}" alt="${user.name}" />`;
    }
  } catch (e) {
    // Non-fatal — topbar just stays as "…"
    console.warn("[fetchCurrentUser]", e.message);
  }
}


// ── Role utilities ────────────────────────────────────────────────────────────
// Decode the JWT payload locally — no API call, no library.
// The role in the token is set at login and matches the DB value.
// This is for UI gating only; the backend enforces roles authoritatively.
function getTokenPayload() {
  try {
    const token = getToken();
    if (!token) return null;
    // JWT is three base64url segments separated by dots — payload is index 1
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch (_) {
    return null;
  }
}

// Returns the role string from the token ("admin","doctor","nurse","viewer")
// or "viewer" as the safest default if token is missing or malformed.
function getRole() {
  return getTokenPayload()?.role || "viewer";
}

// Convenience checks
const Role = {
  ADMIN:  "admin",
  DOCTOR: "doctor",
  NURSE:  "nurse",
  VIEWER: "viewer",
};

// Returns true if the current user's role is in the allowed list
function hasRole(...roles) {
  return roles.includes(getRole());
}

// Hides an element by id if the current role is NOT in allowed roles.
// Uses display:none — element stays in DOM so layout isn't affected by
// removal; backend will reject unauthorised API calls regardless.
function gateElement(elementId, ...allowedRoles) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!hasRole(...allowedRoles)) {
    el.style.display = "none";
  }
}

// Apply all role gates for the patient dashboard page.
// Called once after DOM is ready.
function applyPatientPageGates() {
  const role = getRole();

  // ── Edit patient details button ──────────────────────────────────────────
  gateElement("editBtn",         Role.ADMIN, Role.DOCTOR, Role.NURSE);

  // ── Share with Family + Revoke — doctor/admin only ───────────────────────
  gateElement("shareFamilyBtn",  Role.ADMIN, Role.DOCTOR, Role.NURSE);
  gateElement("revokeAccessBtn", Role.ADMIN, Role.DOCTOR, Role.NURSE);
  gateElement("shareRevokeBtn",  Role.ADMIN, Role.DOCTOR, Role.NURSE);

  // ── Reset All Data button — doctor/admin only ─────────────────────────────
  gateElement("resetDataBtn",    Role.ADMIN, Role.DOCTOR);

  // ── Role indicator on page (optional debug badge) ────────────────────────
  // If a role badge element exists, populate it
  const badge = document.getElementById("currentRoleBadge");
  if (badge) badge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
}

// Apply all role gates for the ward overview page.
// Called once after DOM is ready. (Currently no role-gated elements on
// ward overview — placeholder for future use.)
function applyWardPageGates() {
  // No role-gated elements on ward overview yet
}

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() {
  clearToken();
  window.location.replace("/login");
}