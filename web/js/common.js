// Supply Smile front end - shared helpers, API calls and the page shell (top bar + side menu).
// Every page includes this file, then calls startPage(async me => { ... }).

// ---------- labels and small helpers ----------
const REASON_LABEL = {
  PURCHASE: 'Purchase', OPENING: 'Opening stock', PROCEDURE_USE: 'Procedure use', ISSUE: 'General use',
  WASTAGE: 'Wastage', EXPIRED: 'Expired', COUNT: 'Stock count', CORRECTION: 'Correction'
};
const STATUS = {
  IN_STOCK: { label: 'In stock', cls: 'text-bg-success', icon: 'check-circle' },
  LOW: { label: 'Low', cls: 'text-bg-warning', icon: 'exclamation-triangle' },
  OUT: { label: 'Out', cls: 'text-bg-danger', icon: 'x-octagon' },
  // Own colour so it is not mistaken for "Low" (it is an expiry warning, not a reorder)
  NEAR_EXPIRY: { label: 'Near expiry', cls: 'badge-near', icon: 'hourglass-split' },
  EXPIRED: { label: 'Expired', cls: 'text-bg-danger', icon: 'calendar-x' }
};

function fmtDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}
function badge(status) {
  const s = STATUS[status] || { label: status, cls: 'text-bg-secondary' };
  return el('span', { class: `badge ${s.cls}` }, s.icon ? el('i', { class: `bi bi-${s.icon} me-1` }) : null, s.label);
}
// Builds DOM safely: data always goes in as text, never as HTML.
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === '') continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
function tr(...cells) {
  return el('tr', {}, ...cells.map(c => el('td', {}, c instanceof Node ? c : String(c ?? ''))));
}
function emptyRow(cols, text) {
  return el('tr', {}, el('td', { colspan: String(cols), class: 'text-secondary', text }));
}
function fillSelect(select, options, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(el('option', { value: '', text: placeholder }));
  options.forEach(([value, label]) => select.append(el('option', { value: String(value), text: label })));
}
const $ = id => document.getElementById(id);
const todayIso = () => (ME && ME.today) || new Date().toISOString().slice(0, 10);

// ---------- phone-friendly tables ----------
// Tables marked .table-stack turn into cards on phones; each cell shows its column name (data-label).
function labelStackTables(root = document) {
  root.querySelectorAll('table.table-stack').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (!td.hasAttribute('data-label')) td.setAttribute('data-label', td.colSpan > 1 ? '' : (heads[i] || ''));
    }));
  });
}
new MutationObserver(() => labelStackTables()).observe(document.documentElement, { childList: true, subtree: true });

// ---------- API ----------
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const api = {
  // Every call goes to Firebase through js/backend.js (same addresses and replies as the original server).
  async request(method, url, data) {
    LAST_SERVER_CONTACT = Date.now();           // every call counts as activity
    try {
      return await SS.request(method, url, data);
    } catch (e) {
      if (e.status === 401 && !url.endsWith('/api/login')) {
        location.href = 'login.html?expired=1';
        throw new ApiError('Please sign in.', 401);
      }
      const err = new ApiError(e.message || 'Something went wrong.', e.status || 0);
      err.lines = e.lines; err.short = e.short;  // per-line details for forms
      throw err;
    }
  },
  get(url) { return this.request('GET', url); },
  post(url, data = {}) { return this.request('POST', url, data); },
  put(url, data = {}) { return this.request('PUT', url, data); },
  del(url) { return this.request('DELETE', url); }
};

// ---------- toast (with optional action such as Undo) ----------
function toast(message, kind = 'success', action) {
  let box = $('toast-box');
  if (!box) {
    box = el('div', { id: 'toast-box', class: 'toast-container position-fixed bottom-0 end-0 p-3', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const row = el('div', { class: 'd-flex align-items-center' }, el('div', { class: 'toast-body flex-grow-1', text: message }));
  const t = el('div', { class: `toast align-items-center text-bg-${kind} border-0`, role: 'status' }, row);
  if (action) {
    row.append(el('button', {
      class: 'btn btn-sm btn-light fw-semibold me-2', type: 'button', text: action.label,
      onclick: () => { bootstrap.Toast.getInstance(t).hide(); action.fn(); }
    }));
  }
  row.append(el('button', { class: 'btn-close btn-close-white me-2', type: 'button', 'data-bs-dismiss': 'toast', 'aria-label': 'Close' }));
  box.append(t);
  new bootstrap.Toast(t, { delay: action ? (action.seconds || 10) * 1000 : 3500 }).show();
  t.addEventListener('hidden.bs.toast', () => t.remove());
}
function showError(e) { toast(e.message || String(e), 'danger'); }


// ---------- page shell: app-style navigation ----------
// Every screen of the app, used by the Home icon grid, the desktop icon rail and the phone tab bar.
const APPS = [
  { key: 'use', href: 'use.html', icon: 'clipboard2-pulse', label: 'Procedure use', short: 'Procedure', color: '#0f766e', desc: 'Materials used in a procedure' },
  { key: 'receive', href: 'stock-in.html', icon: 'box-arrow-in-down', label: 'Receive', color: '#2563eb', desc: 'Record a delivery' },
  { key: 'writeoff', href: 'stock-out.html?reason=WASTAGE', icon: 'trash3', label: 'Write off', color: '#dc2626', desc: 'Wastage and expired stock' },
  { key: 'items', href: 'items.html', icon: 'box-seam', label: 'Items', color: '#0891b2', desc: 'Stock of every item' },
  { key: 'reorder', href: 'reorder.html', icon: 'cart-plus', label: 'Reorder', color: '#d97706', desc: 'Order list, send on WhatsApp' },
  { key: 'count', href: 'count.html', icon: 'clipboard-check', label: 'Stock count', color: '#059669', desc: 'Count the shelf, fix differences', admin: true },
  { key: 'dashboard', href: 'index.html', icon: 'speedometer2', label: 'Dashboard', color: '#0e7490', desc: 'Charts and trends' },
  { key: 'reports', href: 'reports.html', icon: 'file-earmark-bar-graph', label: 'Reports', color: '#4f46e5', desc: 'PDF and Excel' },
  { key: 'suppliers', href: 'suppliers.html', icon: 'truck', label: 'Suppliers', color: '#64748b', desc: 'Contacts' },
  { key: 'kits', href: 'kits.html', icon: 'collection', label: 'Kits', color: '#be185d', desc: 'What each procedure uses', admin: true },
  { key: 'import', href: 'import.html', icon: 'file-earmark-spreadsheet', label: 'Import Excel', color: '#15803d', desc: 'Load items and opening stock', admin: true },
  { key: 'settings', href: 'settings.html', icon: 'gear', label: 'Settings', color: '#475569', desc: 'Users, procedures', admin: true }
];
const RAIL = ['home', 'use', 'receive', 'items', 'count', 'dashboard', 'reports', 'settings'];
const TABS = ['home', 'use', 'receive', 'items', 'dashboard'];
const HOME = { key: 'home', href: 'home.html', icon: 'grid-3x3-gap-fill', label: 'Home', color: '#0f766e' };
let ME = null;
let LAST_SERVER_CONTACT = Date.now();

// Without "Keep me signed in", the server signs out after sessionMinutes of no activity.
// Two minutes before that, offer to stay signed in instead of losing work silently.
function startIdleWatch(me) {
  if (me.keepSignedIn || !me.sessionMinutes) return;
  const limit = me.sessionMinutes * 60000, warnAt = limit - 120000;
  let modal = null, tick = null;
  setInterval(() => {
    const idle = Date.now() - LAST_SERVER_CONTACT;
    if (idle >= limit) { location.href = 'login.html?expired=1'; return; }
    if (idle >= warnAt && !modal) {
      const count = el('strong', { text: '2:00' });
      const box = el('div', { class: 'modal fade', tabindex: '-1', 'aria-labelledby': 'idle-title' },
        el('div', { class: 'modal-dialog modal-dialog-centered modal-sm' }, el('div', { class: 'modal-content' },
          el('div', { class: 'modal-body text-center p-4' },
            el('i', { class: 'bi bi-hourglass-split fs-2 text-warning' }),
            el('h2', { class: 'h5 mt-2', id: 'idle-title', text: 'Still there?' }),
            el('p', { class: 'small text-secondary mb-3' }, 'You will be signed out in ', count, ' to keep the stock records safe.'),
            el('button', { class: 'btn btn-primary w-100', type: 'button', onclick: async () => {
              try { await api.get('/api/me'); } catch (e) { /* redirected */ }
              bootstrap.Modal.getInstance(box).hide(); } }, 'Stay signed in'),
            el('button', { class: 'btn btn-link btn-sm mt-1', type: 'button', onclick: logout }, 'Sign out now')))));
      document.body.append(box);
      modal = new bootstrap.Modal(box, { backdrop: 'static' });
      box.addEventListener('hidden.bs.modal', () => { clearInterval(tick); box.remove(); modal = null; });
      modal.show();
      tick = setInterval(() => {
        const left = Math.max(0, limit - (Date.now() - LAST_SERVER_CONTACT));
        count.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      }, 1000);
    }
  }, 15000);
}

// Numbers shown on icons: what needs doing, from the alert counts.
function appBadges(counts) {
  const reorder = counts.low + counts.out;
  return {
    items: reorder ? { n: reorder, cls: 'warn', title: `${reorder} to reorder` } : null,
    reorder: reorder ? { n: reorder, cls: 'warn', title: `${reorder} to reorder` } : null,
    writeoff: counts.expired ? { n: counts.expired, cls: 'bad', title: `${counts.expired} expired to write off` } : null,
    count: counts.flags ? { n: counts.flags, cls: 'bad', title: `${counts.flags} flagged for a stock check` } : null
  };
}
function currentAppKey() {
  const page = location.pathname.split('/').pop() || 'home.html';
  const q = new URLSearchParams(location.search);
  if (page === 'use.html') return 'use';
  if (page === 'reorder.html' || (page === 'items.html' && q.get('status') === 'REORDER')) return 'reorder';
  if (page === 'stock-out.html') return 'writeoff';
  if (page === 'item.html') return 'items';
  if (page === 'home.html' || page === '') return 'home';
  const a = APPS.find(x => x.href.split('?')[0] === page);
  return a ? a.key : '';
}
function navLink(app, active, badgeInfo, cls) {
  return el('a', { class: cls + (active ? ' active' : ''), href: app.href, 'aria-current': active ? 'page' : null,
    title: badgeInfo ? `${app.label} · ${badgeInfo.title}` : app.label },
    el('span', { class: 'nav-ic' }, el('i', { class: 'bi bi-' + app.icon }),
      badgeInfo ? el('span', { class: 'nav-badge ' + badgeInfo.cls, text: String(badgeInfo.n), 'aria-label': badgeInfo.title }) : null),
    el('span', { class: 'nav-label', text: app.short || app.label }));
}

function buildShell(me, counts) {
  const isAdmin = me.role === 'ADMIN';
  const current = currentAppKey();
  const badges = appBadges(counts);
  const byKey = k => k === 'home' ? HOME : APPS.find(a => a.key === k);
  const allowed = a => a && (!a.admin || isAdmin);

  const top = $('topbar');
  top.className = 'app-top sticky-top';
  const initials = me.fullName.replace(/^Dr\.?\s*/i, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  top.append(el('div', { class: 'app-top-inner' },
    el('a', { class: 'app-brand', href: 'home.html', 'aria-label': 'Home' },
      el('img', { class: 'app-logo', src: 'icons/icon.svg', alt: '' }),
      el('span', {}, el('span', { class: 'fw-bold', text: 'Supply Smile' }),
        el('span', { class: 'app-clinic d-none d-sm-inline', text: me.clinicName }))),
    el('div', { class: 'dropdown ms-auto' },
      el('button', { class: 'app-user', type: 'button', 'data-bs-toggle': 'dropdown', 'aria-expanded': 'false', 'aria-label': 'Account' },
        el('span', { class: 'app-avatar', text: initials }),
        el('span', { class: 'd-none d-sm-inline text-start lh-sm' },
          el('span', { class: 'd-block fw-semibold small', text: me.fullName }),
          el('span', { class: 'd-block app-role', text: isAdmin ? 'Admin' : 'Staff' })),
        el('i', { class: 'bi bi-chevron-down small opacity-75' })),
      el('ul', { class: 'dropdown-menu dropdown-menu-end shadow' },
        el('li', {}, el('span', { class: 'dropdown-item-text small text-secondary', text: `${me.fullName} · ${isAdmin ? 'Admin' : 'Staff'}` })),
        el('li', {}, el('button', { class: 'dropdown-item', type: 'button', onclick: openPasswordDialog },
          el('i', { class: 'bi bi-key me-2' }), 'Change password')),
        el('li', {}, el('hr', { class: 'dropdown-divider' })),
        el('li', {}, el('button', { class: 'dropdown-item text-danger', type: 'button', onclick: logout },
          el('i', { class: 'bi bi-box-arrow-right me-2' }), 'Log out'))))));

  // Desktop / tablet: slim icon rail on the left.
  const side = $('sidebar');
  side.className = 'app-rail';
  side.setAttribute('aria-label', 'Main');
  side.replaceChildren(...RAIL.map(byKey).filter(allowed).map(a => navLink(a, a.key === current, badges[a.key], 'rail-link')),
    el('div', { class: 'rail-foot', text: me.version ? 'v' + me.version.split(' ')[0] : '' }));

  // Phone: tab bar at the bottom, like an app.
  const tabs = el('nav', { class: 'app-tabbar', 'aria-label': 'Main' },
    ...TABS.map(byKey).filter(allowed).map(a => navLink(a, a.key === current, badges[a.key], 'tab-link')));
  document.body.append(tabs);
  document.body.classList.add('has-tabbar');

  document.querySelectorAll('.admin-only').forEach(e => { if (!isAdmin) e.classList.add('d-none'); });
}

async function logout() {
  try { await api.post('/api/logout'); } catch (e) { /* ignore */ }
  location.href = 'login.html';
}

function openPasswordDialog() {
  let m = $('pw-modal');
  if (!m) {
    m = el('div', { class: 'modal fade', id: 'pw-modal', tabindex: '-1', 'aria-labelledby': 'pw-title', 'aria-hidden': 'true' },
      el('div', { class: 'modal-dialog' }, el('form', { class: 'modal-content', id: 'pw-form', novalidate: true },
        el('div', { class: 'modal-header' }, el('h2', { class: 'modal-title fs-5', id: 'pw-title', text: 'Change password' }),
          el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' })),
        el('div', { class: 'modal-body' },
          el('label', { class: 'form-label', for: 'pw-current', text: 'Current password' }),
          el('input', { class: 'form-control mb-3', id: 'pw-current', type: 'password', autocomplete: 'current-password', required: true }),
          el('label', { class: 'form-label', for: 'pw-new', text: 'New password (at least 8 characters)' }),
          el('input', { class: 'form-control', id: 'pw-new', type: 'password', autocomplete: 'new-password', minlength: '8', required: true }),
          el('div', { class: 'text-danger small mt-2', id: 'pw-error', role: 'alert' })),
        el('div', { class: 'modal-footer' },
          el('button', { type: 'button', class: 'btn btn-light', 'data-bs-dismiss': 'modal', text: 'Cancel' }),
          el('button', { type: 'submit', class: 'btn btn-primary', text: 'Change password' })))));
    document.body.append(m);
    $('pw-form').addEventListener('submit', async e => {
      e.preventDefault();
      $('pw-error').textContent = '';
      try {
        await api.put('/api/me/password', { currentPassword: $('pw-current').value, newPassword: $('pw-new').value });
        bootstrap.Modal.getInstance(m).hide();
        e.target.reset();
        toast('Password changed.');
      } catch (err) { $('pw-error').textContent = err.message; }
    });
  }
  bootstrap.Modal.getOrCreateInstance(m).show();
}

// Loads the signed-in user and alert counts, builds the shell, then runs the page.
async function startPage(render) {
  try {
    const [me, counts] = await Promise.all([api.get('/api/me'), api.get('/api/alerts/counts')]);
    ME = me;
    buildShell(me, counts);
    startIdleWatch(me);
    await render(me);
  } catch (e) {
    if (e.status === 401) return;           // already redirecting to login
    const main = document.querySelector('main');
    if (main) main.prepend(el('div', { class: 'alert alert-danger', role: 'alert', text: e.message }));
  }
}

// Installable app + fast start: cache the app's own files (data always comes live from the database).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
