// Ponugoti Hospital – shared client utilities

(function () {
  // Inject Tabler Icons
  if (!document.querySelector('link[href*="tabler-icons"]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css';
    document.head.appendChild(l);
  }

  const cfg = window.PONUGOTI_CONFIG;
  if (!cfg) {
    document.body.innerHTML = "<pre style='padding:24px'>Configuration missing. Reload the page.</pre>";
    return;
  }

  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ponugoti-hospital-auth' },
  });
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
    .from('profiles').select('id, full_name, role').eq('id', user.id).maybeSingle();
  if (error || !data) return { id: user.id, full_name: user.email, role: 'reception' };
  return data;
}

async function requireAuth() {
  const user = await getSessionUser();
  if (!user) { window.location.href = 'login.html'; return null; }
  return user;
}

async function signOut() {
  await window.sb.auth.signOut();
  window.location.href = 'login.html';
}

// ---------- UI helpers ----------
function $(sel, root)  { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()}`;
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(value) { return value ? new Date(value).toISOString() : null; }

function ageFromDob(dobIso) {
  if (!dobIso) return '';
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showMsg(container, kind, text) {
  if (!container) return;
  container.innerHTML = `<div class="msg ${kind}">${escapeHtml(text)}</div>`;
}

function clearMsg(container) { if (container) container.innerHTML = ''; }

function fmtMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  });
}

function moneyValue(value) {
  const n = Number(String(value || '0').replace(/,/g,''));
  return isFinite(n) ? n : 0;
}

function statusBadge(status) {
  const cls = String(status || '').toLowerCase().replace(/[^a-z0-9]+/g,'-');
  return `<span class="badge ${escapeHtml(cls)}">${escapeHtml(status || 'Unknown')}</span>`;
}

function currentDateInput() { return new Date().toISOString().slice(0,10); }

function getInitials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase();
}

// ---------- Role helpers ----------
const ROLE_LABELS = {
  admin: 'Admin', doctor: 'Doctor', nurse: 'Nurse',
  lab: 'Lab Tech', reception: 'Reception',
};

function canEditPatient(role)       { return ['admin','doctor','nurse','reception'].includes(role); }
function canEditAdmission(role)     { return ['admin','doctor','nurse','reception'].includes(role); }
function canEditInvestigation(role) { return ['admin','doctor','nurse','lab'].includes(role); }
function canEditBilling(role)       { return ['admin','doctor','nurse','reception'].includes(role); }
function canEditInsurance(role)     { return ['admin','doctor','nurse','reception'].includes(role); }
function canDeleteAdmin(role)       { return role === 'admin'; }

// ---------- Sidebar render ----------
async function renderTopbar(activePage) {
  const profile = await getCurrentProfile();
  const cfg = window.PONUGOTI_CONFIG;

  document.body.classList.add('has-sidebar');

  const initials = getInitials(profile ? profile.full_name : '');

  const navItems = [
    { page: 'dashboard',    href: 'dashboard.html',    icon: 'ti-layout-dashboard', label: 'Dashboard'   },
    { page: 'new-patient',  href: 'new-patient.html',  icon: 'ti-user-plus',        label: 'New Patient' },
    { page: 'billing',      href: 'billing.html',      icon: 'ti-receipt',          label: 'Billing'     },
    { page: 'insurance',    href: 'insurance.html',    icon: 'ti-shield-check',     label: 'Insurance'   },
    { page: 'discharge',    href: 'discharge.html',    icon: 'ti-report-medical',   label: 'Discharge'   },
    { page: 'admin',        href: 'admin.html',        icon: 'ti-users',            label: 'Staff'       },
  ];

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar no-print';
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <div class="sidebar-logo">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect x="9" y="2" width="6" height="20" rx="2"/>
          <rect x="2" y="9" width="20" height="6" rx="2"/>
        </svg>
      </div>
      <div class="hospital-name">${escapeHtml(cfg.HOSPITAL_NAME)}</div>
      <div class="hospital-sub">${escapeHtml(cfg.HOSPITAL_TAGLINE)}</div>
    </div>
    <nav class="sidebar-nav">
      <div class="sidebar-section">Menu</div>
      ${navItems.map(item => `
        <a href="${item.href}" data-page="${item.page}">
          <span class="nav-icon"><i class="ti ${item.icon}"></i></span>
          ${escapeHtml(item.label)}
        </a>
      `).join('')}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="sidebar-avatar">${escapeHtml(initials)}</div>
        <div class="sidebar-user-info">
          <div class="sidebar-user-name">${escapeHtml(profile ? profile.full_name : '')}</div>
          <div class="sidebar-user-role">${escapeHtml(ROLE_LABELS[profile ? profile.role : 'reception'] || (profile ? profile.role : ''))}</div>
        </div>
        <button class="sidebar-logout" id="topbar-logout" title="Sign out">
          <i class="ti ti-logout"></i>
        </button>
      </div>
    </div>
  `;

  document.body.prepend(sidebar);

  sidebar.querySelectorAll('.sidebar-nav a').forEach(a => {
    if (a.dataset.page === activePage) a.classList.add('active');
  });

  sidebar.querySelector('#topbar-logout').addEventListener('click', signOut);

  return profile;
}
