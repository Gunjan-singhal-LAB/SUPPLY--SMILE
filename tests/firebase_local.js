#!/usr/bin/env node
// A small local stand-in for Firebase, for testing Supply Smile without a Firebase account.
//
// It serves web/ and answers the same REST addresses the app uses:
//   /identitytoolkit/v1/accounts:signUp | :signInWithPassword | :update | :delete   (Firebase Auth)
//   /securetoken/v1/token                                                          (token refresh)
//   /rtdb/<path>.json   GET / PUT / PATCH / DELETE, with ?auth=, orderBy, startAt, endAt, equalTo,
//                       limitToFirst, limitToLast, shallow                          (Realtime Database REST)
// Every database read and write is checked against ../database.rules.json, like the real service.
//
//   node tests/firebase_local.js <port> [state.json]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 5090);
const STATE_FILE = process.argv[3] || null;
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const RULES = JSON.parse(fs.readFileSync(process.env.RULES_FILE || path.join(ROOT, 'database.rules.json'), 'utf8')).rules;
const API_KEY = 'local-api-key';

// ---------------------------------------------------------------- state
let state = { db: null, users: {} };                 // users: uid -> { email, pw }
if (STATE_FILE && fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const save = () => { if (STATE_FILE) fs.writeFileSync(STATE_FILE, JSON.stringify(state)); };
const hash = pw => crypto.createHash('sha256').update('salt:' + pw).digest('hex');

// ---------------------------------------------------------------- tree helpers
const segs = p => String(p || '').split('/').filter(Boolean);
function getAt(tree, parts) {
  let n = tree;
  for (const k of parts) { if (n === null || typeof n !== 'object') return null; n = n[k] === undefined ? null : n[k]; }
  return n === undefined ? null : n;
}
function prune(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) v = Object.fromEntries(v.map((x, i) => [String(i), x]));
  if (typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null) out[k] = p; }
  return Object.keys(out).length ? out : null;
}
function setAt(tree, parts, value) {
  if (!parts.length) return prune(value);
  const root = tree && typeof tree === 'object' ? { ...tree } : {};
  const [k, ...rest] = parts;
  const child = setAt(root[k] === undefined ? null : root[k], rest, value);
  if (child === null) delete root[k]; else root[k] = child;
  return Object.keys(root).length ? root : null;
}
const clone = v => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
function serverValues(v, now) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return now;
    const o = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) o[k] = serverValues(x, now);
    return o;
  }
  return v;
}
// The real service returns objects whose keys are mostly 0..n as arrays; the app must cope with that.
function arrayify(v) {
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  const out = {};
  for (const k of keys) out[k] = arrayify(v[k]);
  if (keys.length && keys.every(k => /^(0|[1-9]\d*)$/.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (max < 2 * keys.length) { const a = new Array(max + 1).fill(null); for (const k of keys) a[Number(k)] = out[k]; return a; }
  }
  return out;
}

// ---------------------------------------------------------------- rules
Object.assign(String.prototype, {
  contains(s) { return this.includes(s); },
  beginsWith(s) { return this.startsWith(s); },
});
class Snap {
  constructor(tree, parts) { this.tree = tree; this.parts = parts; }
  val() { return clone(getAt(this.tree, this.parts)); }
  child(p) { return new Snap(this.tree, [...this.parts, ...segs(String(p))]); }
  parent() { return new Snap(this.tree, this.parts.slice(0, -1)); }
  exists() { return getAt(this.tree, this.parts) !== null; }
  hasChild(p) { return this.child(p).exists(); }
  hasChildren(list) {
    const v = getAt(this.tree, this.parts);
    if (!v || typeof v !== 'object') return false;
    return list ? list.every(k => this.child(k).exists()) : Object.keys(v).length > 0;
  }
  isNumber() { return typeof getAt(this.tree, this.parts) === 'number'; }
  isString() { return typeof getAt(this.tree, this.parts) === 'string'; }
  isBoolean() { return typeof getAt(this.tree, this.parts) === 'boolean'; }
  getPriority() { return null; }
}
function evalRule(expr, env) {
  if (expr === true || expr === false) return expr;
  const names = Object.keys(env);
  try {
    // eslint-disable-next-line no-new-func
    return new Function(...names, `"use strict"; return (${expr});`)(...names.map(n => env[n])) === true;
  } catch (e) { return false; }                       // like Firebase: an error counts as "no"
}
// rule nodes along a path, with the $variables bound on the way
function ruleChain(parts) {
  const chain = [{ node: RULES, vars: {} }];
  let node = RULES, vars = {};
  for (const k of parts) {
    if (!node) { chain.push({ node: null, vars }); continue; }
    let next = node[k];
    if (next === undefined) {
      const w = Object.keys(node).find(x => x.startsWith('$'));
      if (w) { next = node[w]; vars = { ...vars, [w]: k }; } else next = null;
    }
    node = next || null;
    chain.push({ node, vars });
  }
  return chain;
}
const envFor = (auth, oldTree, newTree, parts, vars, now) => ({
  auth, now, root: new Snap(oldTree, []), data: new Snap(oldTree, parts), newData: new Snap(newTree, parts), ...vars,
});
function canRead(auth, parts) {
  const chain = ruleChain(parts);
  return chain.some((c, i) => c.node && c.node['.read'] !== undefined &&
    evalRule(c.node['.read'], envFor(auth, state.db, state.db, parts.slice(0, i), c.vars, Date.now())));
}
function canWrite(auth, parts, oldTree, newTree, now) {
  const chain = ruleChain(parts);
  return chain.some((c, i) => c.node && c.node['.write'] !== undefined &&
    evalRule(c.node['.write'], envFor(auth, oldTree, newTree, parts.slice(0, i), c.vars, now)));
}
function validates(auth, parts, oldTree, newTree, now) {
  // ancestors of the written place, then everything written below it
  const chain = ruleChain(parts);
  for (let i = 0; i < chain.length; i++) {
    const p = parts.slice(0, i);
    if (getAt(newTree, p) === null) continue;
    const c = chain[i];
    if (c.node && c.node['.validate'] !== undefined && !evalRule(c.node['.validate'], envFor(auth, oldTree, newTree, p, c.vars, now))) return false;
  }
  const walk = (p, node, vars) => {
    const v = getAt(newTree, p);
    if (v === null || typeof v !== 'object' || !node) return true;
    for (const k of Object.keys(v)) {
      let next = node[k], nv = vars;
      if (next === undefined) {
        const w = Object.keys(node).find(x => x.startsWith('$'));
        if (w) { next = node[w]; nv = { ...vars, [w]: k }; } else next = null;
      }
      if (!next) continue;
      const cp = [...p, k];
      if (next['.validate'] !== undefined && getAt(newTree, cp) !== null &&
          !evalRule(next['.validate'], envFor(auth, oldTree, newTree, cp, nv, now))) return false;
      if (!walk(cp, next, nv)) return false;
    }
    return true;
  };
  const last = chain[chain.length - 1];
  return walk(parts, last.node, last.vars);
}
function indexed(parts, child) {
  const node = ruleChain(parts).pop().node;
  const idx = node && node['.indexOn'];
  return Array.isArray(idx) ? idx.includes(child) : idx === child;
}

// ---------------------------------------------------------------- auth tokens
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = uid => 'h.' + b64({ uid, email: state.users[uid].email, exp: Date.now() + 3600e3 }) + '.s';
function authFrom(tok) {
  if (!tok) return null;
  try {
    const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
    if (p.exp < Date.now() || !state.users[p.uid]) return 'expired';
    return { uid: p.uid, provider: 'password', token: { email: p.email, email_verified: false } };
  } catch (e) { return 'expired'; }
}
const session = uid => ({ kind: 'identitytoolkit', localId: uid, email: state.users[uid].email, idToken: tokenFor(uid),
  refreshToken: 'r-' + uid, expiresIn: '3600', registered: true });
const authErr = (res, message) => send(res, 400, { error: { code: 400, message, errors: [{ message, domain: 'global', reason: 'invalid' }] } });

// ---------------------------------------------------------------- http
function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,DELETE,OPTIONS', 'Cache-Control': 'no-store' });
  res.end(data);
}
const readBody = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => ok(d)); });
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff' };

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  // ---------- test helpers (no rules) ----------
  if (u.pathname === '/__reset') { state = { db: null, users: {} }; save(); return send(res, 200, { ok: true }); }
  if (u.pathname === '/__state') {
    if (req.method === 'GET') return send(res, 200, state);
    state = JSON.parse(await readBody(req)); save(); return send(res, 200, { ok: true });
  }
  if (u.pathname === '/__db') {
    if (req.method === 'GET') return send(res, 200, getAt(state.db, segs(u.searchParams.get('path'))));
    const body = JSON.parse(await readBody(req) || 'null');
    state.db = setAt(state.db, segs(u.searchParams.get('path')), body); save(); return send(res, 200, { ok: true });
  }
  // ---------- config for the pages ----------
  if (u.pathname === '/js/config.js') {
    const js = `window.SUPPLY_SMILE_CONFIG = { firebaseApiKey: '${API_KEY}', firebaseDatabaseUrl: 'http://127.0.0.1:${PORT}/rtdb',
      authUrl: 'http://127.0.0.1:${PORT}/identitytoolkit/v1', tokenUrl: 'http://127.0.0.1:${PORT}/securetoken/v1',
      userEmailDomain: 'users.supplysmile.app' };`;
    return send(res, 200, js, 'application/javascript');
  }
  // ---------- Firebase Auth ----------
  if (u.pathname.startsWith('/identitytoolkit/v1/accounts:')) {
    if (u.searchParams.get('key') !== API_KEY) return authErr(res, 'API key not valid. Please pass a valid API key.');
    const b = JSON.parse(await readBody(req) || '{}');
    const op = u.pathname.split(':')[1];
    if (op === 'signUp') {
      const email = String(b.email || '').toLowerCase();
      if (Object.values(state.users).some(x => x.email === email)) return authErr(res, 'EMAIL_EXISTS');
      if (String(b.password || '').length < 6) return authErr(res, 'WEAK_PASSWORD : Password should be at least 6 characters');
      const uid = crypto.randomBytes(14).toString('base64url');
      state.users[uid] = { email, pw: hash(b.password) }; save();
      return send(res, 200, session(uid));
    }
    if (op === 'signInWithPassword') {
      const uid = Object.keys(state.users).find(k => state.users[k].email === String(b.email || '').toLowerCase());
      if (!uid || state.users[uid].pw !== hash(b.password || '')) return authErr(res, 'INVALID_LOGIN_CREDENTIALS');
      return send(res, 200, session(uid));
    }
    const a = authFrom(b.idToken);
    if (!a || a === 'expired') return authErr(res, 'INVALID_ID_TOKEN');
    if (op === 'update') {
      if (b.password) {
        if (String(b.password).length < 6) return authErr(res, 'WEAK_PASSWORD : Password should be at least 6 characters');
        state.users[a.uid].pw = hash(b.password); save();
      }
      return send(res, 200, session(a.uid));
    }
    if (op === 'delete') { delete state.users[a.uid]; save(); return send(res, 200, { kind: 'identitytoolkit#DeleteAccountResponse' }); }
    return authErr(res, 'UNKNOWN');
  }
  if (u.pathname === '/securetoken/v1/token') {
    const b = new URLSearchParams(await readBody(req));
    const uid = String(b.get('refresh_token') || '').slice(2);
    if (!state.users[uid]) return send(res, 400, { error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } });
    return send(res, 200, { id_token: tokenFor(uid), refresh_token: 'r-' + uid, expires_in: '3600', user_id: uid });
  }
  // ---------- Realtime Database REST ----------
  if (u.pathname.startsWith('/rtdb')) {
    if (!u.pathname.endsWith('.json')) return send(res, 400, { error: 'Missing .json' });
    const parts = segs(decodeURIComponent(u.pathname.slice(5, -5)));
    const auth = authFrom(u.searchParams.get('auth'));
    if (auth === 'expired') return send(res, 401, { error: 'Auth token is expired' });
    const now = Date.now();
    if (req.method === 'GET') {
      if (!canRead(auth, parts)) return send(res, 401, { error: 'Permission denied' });
      let v = getAt(state.db, parts);
      const q = k => (u.searchParams.has(k) ? JSON.parse(u.searchParams.get(k)) : undefined);
      if (u.searchParams.get('shallow') === 'true') {
        if (v && typeof v === 'object') v = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'object' ? true : x]));
        return send(res, 200, v);
      }
      const orderBy = q('orderBy');
      if (orderBy === undefined) return send(res, 200, arrayify(v));
      if (orderBy !== '$key' && orderBy !== '$value' && !indexed(parts, orderBy)) {
        return send(res, 400, { error: `Index not defined, add ".indexOn": "${orderBy}", for path "/${parts.join('/')}", to the rules` });
      }
      let rows = Object.entries(v && typeof v === 'object' ? v : {}).map(([k, x]) => [k, x,
        orderBy === '$key' ? k : orderBy === '$value' ? x : (x && typeof x === 'object' ? (x[orderBy] === undefined ? null : x[orderBy]) : null)]);
      const cmp = (a, b) => {
        const rank = x => (x === null ? 0 : typeof x === 'boolean' ? 1 : typeof x === 'number' ? 2 : 3);
        if (orderBy === '$key') {
          const na = /^-?\d+$/.test(a), nb = /^-?\d+$/.test(b);
          if (na && nb) return Number(a) - Number(b);
          if (na !== nb) return na ? -1 : 1;
          return a < b ? -1 : a > b ? 1 : 0;
        }
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return a < b ? -1 : a > b ? 1 : 0;
      };
      rows.sort((a, b) => cmp(a[2], b[2]) || (a[0] < b[0] ? -1 : 1));
      const eq = q('equalTo'), sa = q('startAt'), ea = q('endAt');
      if (eq !== undefined) rows = rows.filter(r => cmp(r[2], eq) === 0);
      if (sa !== undefined) rows = rows.filter(r => cmp(r[2], sa) >= 0);
      if (ea !== undefined) rows = rows.filter(r => cmp(r[2], ea) <= 0);
      if (q('limitToFirst') !== undefined) rows = rows.slice(0, q('limitToFirst'));
      if (q('limitToLast') !== undefined) rows = rows.slice(-q('limitToLast'));
      return send(res, 200, Object.fromEntries(rows.map(r => [r[0], r[1]])));
    }
    let writes;
    const body = serverValues(JSON.parse(await readBody(req) || 'null'), now);
    if (req.method === 'PUT') writes = [[parts, body]];
    else if (req.method === 'DELETE') writes = [[parts, null]];
    else if (req.method === 'PATCH') {
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'Invalid data; couldn\'t parse JSON object.' });
      writes = Object.entries(body).map(([k, x]) => [[...parts, ...segs(k)], x]);
      const keys = writes.map(w => w[0].join('/'));
      if (keys.some(a => keys.some(b => a !== b && b.startsWith(a + '/')))) {
        return send(res, 400, { error: 'Invalid data; a path in the update is an ancestor of another path' });
      }
    } else return send(res, 405, { error: 'Method not allowed' });
    const oldTree = state.db;
    let newTree = oldTree;
    for (const [p, x] of writes) newTree = setAt(newTree, p, x);
    for (const [p] of writes) {
      if (!canWrite(auth, p, oldTree, newTree, now) || !validates(auth, p, oldTree, newTree, now)) {
        if (process.env.DEBUG_RULES) console.error('DENIED', req.method, p.join('/'), canWrite(auth, p, oldTree, newTree, now) ? '(validate)' : '(write)');
        return send(res, 401, { error: 'Permission denied' });
      }
    }
    state.db = newTree; save();
    if (req.method === 'DELETE') return send(res, 200, null);
    if (req.method === 'PUT') return send(res, 200, getAt(newTree, parts));
    return send(res, 200, body);
  }
  // ---------- the site ----------
  let file = decodeURIComponent(u.pathname === '/' ? '/login.html' : u.pathname);
  file = path.normalize(path.join(WEB, file));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); send(res, 500, { error: String(e) }); }))
  .listen(PORT, '127.0.0.1', () => console.log(`Firebase stand-in on http://127.0.0.1:${PORT}`));
