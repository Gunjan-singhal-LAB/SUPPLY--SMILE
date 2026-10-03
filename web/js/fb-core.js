// Supply Smile (Firebase) - part 1 of 3: connection to Firebase.
//
// Sign-in uses Firebase Authentication and data lives in Firebase Realtime Database.
// Both are reached through their standard REST addresses (no large SDK needed), which also
// keeps the site's strict security policy simple.
//
// Needs js/config.js loaded first.
const SSCore = (() => {
  const cfg = window.SUPPLY_SMILE_CONFIG || {};
  const configured = !!(cfg.firebaseApiKey && cfg.firebaseDatabaseUrl &&
    !/YOUR-/.test(String(cfg.firebaseApiKey) + String(cfg.firebaseDatabaseUrl)));
  const DB = String(cfg.firebaseDatabaseUrl || '').replace(/\/+$/, '');
  const AUTH_URL = cfg.authUrl || 'https://identitytoolkit.googleapis.com/v1';
  const TOKEN_URL = cfg.tokenUrl || 'https://securetoken.googleapis.com/v1';
  const DOMAIN = cfg.userEmailDomain || 'users.supplysmile.app';

  // ---------- errors (same status codes the pages expect) ----------
  class HttpError extends Error {
    constructor(message, status, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
  }
  const fail = (msg, extra) => { throw new HttpError(msg, 400, extra || {}); };
  const notFound = msg => { throw new HttpError(msg, 404); };
  const offline = () => new HttpError('Cannot reach Supply Smile. Check the internet connection and try again.', 0);
  const notConfigured = () => new HttpError('Supply Smile is not connected to its database yet. Put your Firebase details in js/config.js (see the deploy guide).', 503);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // ---------- Firebase Authentication ----------
  // Usernames become sign-in names like kavya@users.supplysmile.app (no email is ever sent).
  const emailOf = (username, suffix) => `${username}${suffix ? '.' + suffix : ''}@${DOMAIN}`;
  const randomSuffix = () => Math.random().toString(36).slice(2, 8);

  async function authCall(op, body) {
    if (!configured) throw notConfigured();
    let r;
    try {
      r = await fetch(`${AUTH_URL}/accounts:${op}?key=${encodeURIComponent(cfg.firebaseApiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw offline(); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = String((j.error && j.error.message) || 'ERROR').split(' ')[0];
      throw new HttpError(code, r.status === 400 ? 400 : r.status, { authCode: code });
    }
    return j;
  }
  const sessionFrom = j => ({ uid: j.localId || j.user_id, email: j.email, idToken: j.idToken || j.id_token,
    refreshToken: j.refreshToken || j.refresh_token, expiresAt: Date.now() + (Number(j.expiresIn || j.expires_in || 3600) - 120) * 1000 });

  let tokens = null;
  try { tokens = JSON.parse(store.get('ss-auth') || 'null'); } catch (e) { tokens = null; }
  const saveTokens = t => { tokens = t; if (t) store.set('ss-auth', JSON.stringify(t)); else store.del('ss-auth'); };

  async function refresh() {
    if (!tokens || !tokens.refreshToken) return null;
    let r;
    try {
      r = await fetch(`${TOKEN_URL}/token?key=${encodeURIComponent(cfg.firebaseApiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokens.refreshToken) });
    } catch (e) { throw offline(); }
    if (!r.ok) { saveTokens(null); return null; }
    const j = await r.json();
    saveTokens({ ...sessionFrom(j), email: tokens.email });
    return tokens;
  }
  async function idToken() {
    if (!tokens) return null;
    if (Date.now() > tokens.expiresAt) await refresh();
    return tokens ? tokens.idToken : null;
  }

  // ---------- Realtime Database (REST) ----------
  let cache = new Map();                    // path+query -> {at, promise}: joins identical reads made together
  const CACHE_MS = 2500;
  const clearCache = () => { cache = new Map(); };

  async function dbFetch(method, path, { body, query, auth = true } = {}) {
    if (!configured) throw notConfigured();
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) params.set(k, typeof v === 'string' && k !== 'shallow' ? JSON.stringify(v) : String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = auth ? await idToken() : null;
      if (tok) params.set('auth', tok);
      let r;
      try {
        r = await fetch(`${DB}/${path.replace(/^\/+/, '')}.json?${params}`, {
          method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          body: body !== undefined ? JSON.stringify(body) : undefined });
      } catch (e) { throw offline(); }
      if (r.ok) return r.status === 204 ? null : r.json();
      const j = await r.json().catch(() => ({}));
      const msg = String(j.error || '');
      if (r.status === 401 && /expired/i.test(msg) && attempt === 0 && await refresh()) continue;
      if (r.status === 401 || /permission/i.test(msg)) throw new HttpError('Permission denied', 403, { denied: true });
      throw new HttpError(msg || 'The database did not accept this.', 400);
    }
    throw new HttpError('Please sign in.', 401);
  }
  const db = {
    get(path, opts = {}) {
      const key = path + JSON.stringify(opts.query || {});
      const hit = cache.get(key);
      if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
      const promise = dbFetch('GET', path, { query: opts.query, auth: opts.auth !== false });
      cache.set(key, { at: Date.now(), promise });
      promise.catch(() => cache.delete(key));
      return promise;
    },
    async patch(path, updates, opts = {}) { clearCache(); return dbFetch('PATCH', path, { body: updates, auth: opts.auth !== false }); },
    async put(path, value) { clearCache(); return dbFetch('PUT', path, { body: value }); },
    async del(path) { clearCache(); return dbFetch('DELETE', path); },
    clearCache
  };
  const TS = { '.sv': 'timestamp' };

  // Firebase turns lists with keys 0,1,2... into arrays; this turns them back into id -> value maps.
  function asMap(v) {
    if (v === null || v === undefined) return {};
    if (Array.isArray(v)) { const o = {}; v.forEach((x, i) => { if (x !== null && x !== undefined) o[i] = x; }); return o; }
    return typeof v === 'object' ? v : {};
  }
  // A username can contain a dot, which a database key cannot.
  const ukey = username => String(username).replace(/\./g, ',');

  // ---------- clinic time (India by default) ----------
  let clockOffset = Number(store.get('ss-clock')) || 0;         // server time - this device's time
  const setClockOffset = ms => { clockOffset = ms; store.set('ss-clock', String(ms)); };
  const serverNow = () => Date.now() + clockOffset;
  let TZ = 'Asia/Kolkata';
  const setTimezone = tz => { if (tz) TZ = tz; };
  function parts(ms) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return o;
  }
  const today = () => { const p = parts(serverNow()); return `${p.year}-${p.month}-${p.day}`; };
  const localTs = ms => { if (!ms) return null; const p = parts(ms); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
  const toUTC = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const addDays = (iso, n) => new Date(toUTC(iso) + n * 86400e3).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 86400e3);     // a - b

  // ---------- input checks (same messages as before) ----------
  const round2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const txt = (p, k) => { const v = p && p[k]; if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };
  function reqText(p, k, label, max = 120) {
    const v = txt(p, k);
    if (v === null) fail(label + ' is required.');
    if (v.length > max) fail(`${label} is too long (max ${max} characters).`);
    return v;
  }
  const optText = (p, k, max = 255) => { const v = txt(p, k); return v === null ? null : v.slice(0, max); };
  function toInt(v, label, min) {
    if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'object') fail(label + ' must be a whole number.');
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (!/^-?\d+(\.0+)?$/.test(s)) fail(label + ' must be a whole number.');
    const n = Math.trunc(Number(s));
    if (min !== undefined && min !== null && n < min) fail(`${label} must be at least ${min}.`);
    return n;
  }
  function toMoney(v, label) {
    if (v === null || v === undefined) return 0;
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (s === '') return 0;
    if (!/^-?\d+(\.\d+)?$/.test(s)) fail(label + ' must be a number.');
    if (Number(s) < 0) fail(label + ' cannot be negative.');
    return round2(Number(s));
  }
  function optId(v) {
    if (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '0') return null;
    return toInt(v, 'Id', 1);
  }
  function isoDate(v, label) {
    const s = String(v === null || v === undefined ? '' : v).trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) fail(label + ' must be a date (YYYY-MM-DD).');
    const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = new Date(toUTC(iso));
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) fail(label + ' must be a date (YYYY-MM-DD).');
    return iso;
  }
  const optDate = (v, label) => (v === null || v === undefined || String(v).trim() === '' ? null : isoDate(v, label));
  const bool = (v, dflt) => (v === null || v === undefined || v === '' ? dflt : v === true || v === 'true' || v === 1 || v === '1');

  return { cfg, configured, HttpError, fail, notFound, offline, notConfigured, store, emailOf, randomSuffix, authCall,
    sessionFrom, saveTokens, getTokens: () => tokens, refresh, db, TS, asMap, ukey,
    serverNow, setClockOffset, setTimezone, today, localTs, addDays, diffDays,
    round2, txt, reqText, optText, toInt, toMoney, optId, isoDate, optDate, bool };
})();
