// Ponugoti Hospital - shared client utilities.
// Loaded on every page after config.js + supabase-js.

(function () {
  const cfg = window.PONUGOTI_CONFIG;
  if (!cfg) {
    document.body.innerHTML =
      "<pre style='padding:24px'>Configuration missing. Reload the page.</pre>";
    return;
  }

  // Supabase client (singleton)
  window.sb = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "ponugoti-hospital-auth",
      },
    }
  );
})();

// ---------- Auth helpers ----------
async function getSessionUser() {
  const { data } = await window.sb.auth.getSession();
  return data.session ? data.session.user : null;
}

async function getCurrentProfile() {
  const user = await getSessionUser();
  if (!user) return null;
  const { data, error } = await window.sb
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    console.error("profile load failed", error);
    return { id: user.id, full_name: user.email, role: "reception" };
  }
  if (!data) {
    return { id: user.id, full_name: user.email, role: "reception" };
  }
  return data;
}

async function requireAuth() {
  const user = await getSessionUser();
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  return user;
}

async function signOut() {
  await window.sb.auth.signOut();
  window.location.href = "login.html";
}

// ---------- UI helpers ----------
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ageFromDob(dobIso) {
  if (!dobIso) return "";
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showMsg(container, kind, text) {
  if (!container) return;
  container.innerHTML = `<div class="msg ${kind}">${escapeHtml(text)}</div>`;
}

function clearMsg(container) {
  if (container) container.innerHTML = "";
}

// ---------- Role helpers ----------
const ROLE_LABELS = {
  admin: "Admin",
  doctor: "Doctor",
  nurse: "Nurse",
  lab: "Lab Technician",
  reception: "Reception",
};

function canEditPatient(role) {
  return ["admin", "doctor", "nurse", "reception"].includes(role);
}
function canEditAdmission(role) {
  return ["admin", "doctor", "nurse", "reception"].includes(role);
}
function canEditInvestigation(role) {
  return ["admin", "doctor", "nurse", "lab"].includes(role);
}
function canDeleteAdmin(role) {
  return role === "admin";
}

// ---------- Topbar render ----------
async function renderTopbar(activePage) {
  const profile = await getCurrentProfile();
  const cfg = window.PONUGOTI_CONFIG;
  const el = document.createElement("div");
  el.className = "topbar no-print";
  el.innerHTML = `
    <div class="brand">
      ${escapeHtml(cfg.HOSPITAL_NAME)}
      <small>${escapeHtml(cfg.HOSPITAL_TAGLINE)}</small>
    </div>
    <nav>
      <a href="dashboard.html" data-page="dashboard">Patients</a>
      <a href="new-patient.html" data-page="new-patient">New Patient</a>
      <a href="admin.html" data-page="admin">Staff</a>
    </nav>
    <div class="spacer"></div>
    <div class="user-chip">
      <strong>${escapeHtml(profile ? profile.full_name : "")}</strong>
      <small><span class="badge role">${escapeHtml(ROLE_LABELS[profile ? profile.role : "reception"] || profile.role)}</span></small>
    </div>
    <button class="logout" id="topbar-logout">Sign out</button>
  `;
  document.body.prepend(el);
  $$('.topbar nav a').forEach((a) => {
    if (a.dataset.page === activePage) a.classList.add("active");
  });
  $('#topbar-logout').addEventListener("click", signOut);
  return profile;
}
