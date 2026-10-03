// Supply Smile (Firebase) - part 3 of 3: sign-in, users, and the address table.
//
// The pages still ask for the same addresses as the original app (for example GET /api/items).
// This file answers each one with the matching function in js/fb-inventory.js and returns the
// same JSON, so the pages did not need to change.
//
// Needs js/config.js, js/fb-core.js and js/fb-inventory.js loaded first.
const SS = (() => {
  const C = SSCore, INV = SSInventory;
  const { HttpError, fail, store, db, asMap, ukey, TS } = C;
  const IDLE_MINUTES = 30, KEEP_HOURS = 12;
  const USERNAME_RE = /^[a-z0-9._-]+$/;

  // ---------- who is signed in ----------
  let meCache = null;                                   // { key, username, fullName, role } for this page
  async function currentPerson(fresh) {
    const t = C.getTokens();
    if (!t) throw new HttpError('Please sign in.', 401);
    if (meCache && !fresh) return meCache;
    let key, person;
    try {
      key = await db.get('clinic/uids/' + t.uid, { fresh });
      person = key ? await db.get('clinic/people/' + key, { fresh }) : null;
    } catch (e) {
      if (e.denied) throw new HttpError('Please sign in.', 401);
      throw e;
    }
    if (!person || person.active !== true) throw new HttpError('Please sign in.', 401);
    meCache = { key, username: person.username, fullName: person.fullName, role: person.role };
    return meCache;
  }

  // Signed-out rules: 30 minutes without use, or 12 hours with "Keep me signed in".
  async function ensureSession() {
    if (!C.configured) throw C.notConfigured();
    if (!C.getTokens()) throw new HttpError('Please sign in.', 401);
    const now = Date.now(), keep = store.get('ss-keep') === '1';
    const last = Number(store.get('ss-last')) || now, loginAt = Number(store.get('ss-login-at')) || now;
    if (keep ? now - loginAt > KEEP_HOURS * 3600e3 : now - last > IDLE_MINUTES * 60e3) {
      signOutLocal();
      throw new HttpError('Please sign in.', 401);
    }
    store.set('ss-last', String(now));
    const me = await currentPerson();
    return me;
  }
  function signOutLocal() {
    C.saveTokens(null); meCache = null; db.clearCache();
    ['ss-last', 'ss-login-at', 'ss-keep'].forEach(store.del);
  }
  function startSession(keep) {
    const now = String(Date.now());
    store.set('ss-login-at', now); store.set('ss-last', now); store.set('ss-keep', keep ? '1' : '');
  }

  async function me() {
    const m = await ensureSession();
    const s = (await db.get('clinic/settings')) || {};
    C.setTimezone(s.timezone);
    INV.ensureDailySnapshot(m).catch(() => {});        // today's automatic backup (Admin, first use of the day)
    return { id: m.key, username: m.username, fullName: m.fullName, role: m.role, clinicName: s.clinicName || 'Dental Clinic',
      nearExpiryDays: Number(s.nearExpiryDays) || 30, today: C.today(), version: INV.VERSION,
      keepSignedIn: store.get('ss-keep') === '1', sessionMinutes: IDLE_MINUTES };
  }

  // The sign-in name for a username (it changes when the Admin resets a password).
  async function loginEmail(username) {
    let email = null;
    try { email = await db.get('clinic/logins/' + ukey(username), { auth: false, fresh: true }); } catch (e) { if (e.status === 0) throw e; }
    return email || C.emailOf(username);
  }
  // Makes a new sign-in account without signing the current person out.
  async function createAccount(username, password) {
    for (let i = 0; i < 3; i++) {
      const email = C.emailOf(username, i ? C.randomSuffix() : '');
      try { return { email, s: C.sessionFrom(await C.authCall('signUp', { email, password, returnSecureToken: true })) }; } catch (e) {
        if (e.authCode === 'EMAIL_EXISTS') continue;                 // an old account with that name: use a new sign-in name
        if (e.authCode && e.authCode.startsWith('WEAK_PASSWORD')) fail('Password must be at least 8 characters.');
        if (e.authCode === 'OPERATION_NOT_ALLOWED') fail('Turn on Email/Password sign-in in Firebase (Authentication > Sign-in method).');
        throw e;
      }
    }
    fail('Could not create the sign-in account. Try again.');
  }
  const dropAccount = s => C.authCall('delete', { idToken: s.idToken }).catch(() => {});

  // ---------- actions that involve sign-in accounts ----------
  const special = {
    async login(p) {
      if (!C.configured) throw C.notConfigured();
      const username = String(p.username || '').trim().toLowerCase();
      let s;
      try {
        s = await C.authCall('signInWithPassword', { email: await loginEmail(username), password: String(p.password || ''), returnSecureToken: true });
      } catch (e) {
        if (e.status === 0) throw e;
        if (e.authCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw new HttpError('Too many attempts. Wait a few minutes and try again.', 401);
        throw new HttpError('Wrong username or password.', 401);
      }
      C.saveTokens(C.sessionFrom(s));
      meCache = null;
      startSession(!!p.keepSignedIn);
      try {
        const m = await me();
        INV.serverTime({ key: m.id }).catch(() => {});             // learn the server clock once
        return m;
      } catch (e) {
        signOutLocal();
        if (e.status === 401) throw new HttpError('This account is not active. Ask the clinic Admin.', 401);
        throw e;
      }
    },
    async logout() { signOutLocal(); return { ok: true }; },
    me,
    async changePassword(p) {
      const m = await ensureSession();
      if (String(p.newPassword || '').length < 8) fail('Password must be at least 8 characters.');
      let s;
      try {
        s = await C.authCall('signInWithPassword', { email: await loginEmail(m.username), password: String(p.currentPassword || ''), returnSecureToken: true });
      } catch (e) { if (e.status === 0) throw e; fail('Current password is not correct.'); }
      const r = await C.authCall('update', { idToken: s.idToken, password: String(p.newPassword), returnSecureToken: true });
      C.saveTokens({ ...C.sessionFrom(r), email: s.email });
      return { ok: true };
    },
    async setupStatus() {
      if (!C.configured) throw C.notConfigured();
      const pub = await db.get('public', { auth: false, fresh: true });
      const done = !!(pub && pub.setupDone);
      return { needed: !done, clinicName: done ? pub.clinicName || 'Dental Clinic' : null };
    },
    async setup(p) {
      if (!C.configured) throw C.notConfigured();
      const username = String(p.username || '').trim().toLowerCase();
      const code = String(p.setupCode || '').trim();
      const clinic = C.txt(p, 'clinicName'), fullName = C.txt(p, 'fullName');
      if (!clinic) fail('Enter the clinic name.');
      if (!fullName) fail('Full name is required.');
      if (!USERNAME_RE.test(username)) fail('Username can use letters, numbers, dot, dash and underscore only.');
      if (String(p.password || '').length < 8) fail('The password needs at least 8 characters.');
      if (!code || /[.$#[\]/]/.test(code)) fail('The setup code is not correct.');
      if ((await special.setupStatus()).needed === false) fail('Supply Smile is already set up. Sign in instead.');
      const { email, s } = await createAccount(username, String(p.password));
      const key = ukey(username), today = C.today();
      const u = {
        ['setup/' + code]: s.uid,
        'public/setupDone': true, 'public/clinicName': clinic.slice(0, 80),
        ['clinic/people/' + key]: { username, fullName: fullName.slice(0, 100), role: 'ADMIN', active: true, createdAt: TS },
        ['clinic/uids/' + s.uid]: key,
        ['clinic/logins/' + key]: email,
        'clinic/settings': { clinicName: clinic.slice(0, 80), nearExpiryDays: 30, timezone: 'Asia/Kolkata', setupDone: today }
      };
      if (p.commonProcedures !== false) {
        INV.COMMON_PROCEDURES.forEach((name, i) => { u['clinic/procedures/' + (i + 1)] = { name, active: true }; });
        u['clinic/counters/procedures'] = INV.COMMON_PROCEDURES.length;
      }
      try {
        const prev = C.getTokens();
        C.saveTokens(s);                                  // the new Admin writes the first records
        try { await db.patch('', u); } catch (e) { C.saveTokens(prev); throw e; }
      } catch (e) {
        await dropAccount(s);
        if (e.denied) fail('The setup code is not correct.');
        throw e;
      }
      meCache = null;
      startSession(false);
      return { ok: true };
    },
    async about() {
      await ensureSession();
      return { ...(await INV.about()), phoneAddresses: [location.origin] };
    },
    // ---------- users (Admin) ----------
    async usersList() {
      const m = await ensureSession();
      if (m.role !== 'ADMIN') throw new HttpError('Only the Admin can do this.', 403);
      const people = asMap(await db.get('clinic/people'));
      return { users: Object.entries(people).map(([k, x]) => ({ id: k, username: x.username, fullName: x.fullName, role: x.role, active: x.active === true }))
        .sort((a, b) => a.role.localeCompare(b.role) || a.fullName.localeCompare(b.fullName)) };
    },
    async addUser(p) {
      const m = await ensureSession();
      if (m.role !== 'ADMIN') throw new HttpError('Only the Admin can do this.', 403);
      const role = p.role || 'STAFF';
      const username = C.reqText(p, 'username', 'Username', 50).toLowerCase();
      const fullName = C.reqText(p, 'fullName', 'Full name', 100);
      if (!['ADMIN', 'STAFF'].includes(role)) fail('Role must be Admin or Staff.');
      if (!USERNAME_RE.test(username)) fail('Username can use letters, numbers, dot, dash and underscore only.');
      if (String(p.password || '').length < 8) fail('Password must be at least 8 characters.');
      const key = ukey(username);
      if (await db.get('clinic/people/' + key, { fresh: true })) fail('That username is already taken.');
      const { email, s } = await createAccount(username, String(p.password));
      try {
        await db.patch('clinic', { ['people/' + key]: { username, fullName, role, active: true, createdAt: TS },
          ['uids/' + s.uid]: key, ['logins/' + key]: email });
      } catch (e) { await dropAccount(s); throw e; }
      return { id: key, username, fullName, role, active: true };
    },
    async userUpdate(p) {
      const m = await ensureSession();
      if (m.role !== 'ADMIN') throw new HttpError('Only the Admin can do this.', 403);
      const people = asMap(await db.get('clinic/people', { fresh: true }));
      const key = String(p.id || ''), x = people[key];
      if (!x) C.notFound('User not found.');
      const role = p.role || x.role, active = p.active === undefined || p.active === null ? x.active === true : C.bool(p.active, true);
      if (!['ADMIN', 'STAFF'].includes(role)) fail('Role must be Admin or Staff.');
      if (x.role === 'ADMIN' && (role !== 'ADMIN' || !active) &&
          !Object.entries(people).some(([k, y]) => k !== key && y.role === 'ADMIN' && y.active === true)) fail('Keep at least one active Admin.');
      if (key === m.key && !active) fail("You can't deactivate your own account.");
      const u = { [`people/${key}/role`]: role, [`people/${key}/active`]: active };
      let newAccount = null;
      if (C.txt(p, 'password') !== null) {
        if (String(p.password).length < 8) fail('Password must be at least 8 characters.');
        // A new sign-in account with the new password replaces the old one (the old one stops working).
        newAccount = await createAccount(x.username, String(p.password));
        const uids = asMap(await db.get('clinic/uids', { fresh: true }));
        for (const [uid, k] of Object.entries(uids)) if (k === key) u['uids/' + uid] = null;
        u['uids/' + newAccount.s.uid] = key;
        u['logins/' + key] = newAccount.email;
      }
      try { await db.patch('clinic', u); } catch (e) { if (newAccount) await dropAccount(newAccount.s); throw e; }
      if (key === m.key) meCache = null;
      return { id: key, username: x.username, fullName: x.fullName, role, active };
    }
  };

  // ---------- address -> function ----------
  const R = (method, path, fn, open) => {
    const names = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    return { method, re, names, fn, open };
  };
  const ROUTES = [
    R('POST', '/api/login', special.login, true), R('POST', '/api/logout', special.logout, true),
    R('GET', '/api/me', special.me, true), R('PUT', '/api/me/password', special.changePassword, true),
    R('GET', '/api/setup', special.setupStatus, true), R('POST', '/api/setup', special.setup, true),
    R('GET', '/api/about', special.about, true), R('GET', '/api/meta', INV.meta), R('PUT', '/api/settings', INV.settingsSave),
    R('GET', '/api/items', INV.itemsListApi), R('POST', '/api/items', INV.itemCreate),
    R('GET', '/api/items/:id', INV.itemDetail), R('PUT', '/api/items/:id', INV.itemUpdate),
    R('GET', '/api/items/:id/batches', INV.itemBatches),
    R('GET', '/api/suppliers', INV.suppliersList), R('POST', '/api/suppliers', INV.supplierCreate),
    R('GET', '/api/suppliers/:id', INV.supplierDetail), R('PUT', '/api/suppliers/:id', INV.supplierUpdate),
    R('GET', '/api/procedures', INV.proceduresListApi), R('POST', '/api/procedures', INV.procedureCreate),
    R('PUT', '/api/procedures/:id', INV.procedureUpdate),
    R('GET', '/api/users', special.usersList, true), R('POST', '/api/users', special.addUser, true),
    R('PUT', '/api/users/:id', special.userUpdate, true),
    R('POST', '/api/stock/in', INV.stockIn), R('POST', '/api/stock/in/invoice', INV.stockInInvoice),
    R('POST', '/api/stock/out', INV.stockOut), R('GET', '/api/stock/recent', INV.stockRecent),
    R('POST', '/api/stock/:id/undo', INV.stockUndo), R('POST', '/api/stock/:id/correct', INV.stockCorrect),
    R('POST', '/api/use', INV.useRecord), R('POST', '/api/use/:group/undo', INV.useUndo),
    R('GET', '/api/kits', INV.kitsList), R('PUT', '/api/kits/:id', INV.kitSave),
    R('GET', '/api/flags', INV.flagsList), R('POST', '/api/flags/:id/resolve', INV.flagResolve),
    R('GET', '/api/counts', INV.countsList), R('POST', '/api/counts', INV.countSave), R('GET', '/api/counts/:id', INV.countDetail),
    R('POST', '/api/import/items', INV.importItems),
    R('GET', '/api/reorder', INV.reorderList), R('POST', '/api/reorder/ordered', INV.reorderOrdered),
    R('PUT', '/api/reorder/:id', INV.reorderSet), R('DELETE', '/api/reorder/:id', INV.reorderRemove),
    R('GET', '/api/dashboard', INV.dashboard), R('GET', '/api/dashboard/charts', INV.dashboardCharts),
    R('GET', '/api/alerts/counts', INV.alertCountsApi), R('GET', '/api/alerts/:kind', INV.alertList),
    R('GET', '/api/reports/:kind', INV.report),
    R('GET', '/api/backups', INV.backupsList), R('POST', '/api/backups', INV.backupNow),
    R('POST', '/api/backups/upload', INV.backupUpload), R('POST', '/api/demo', INV.loadDemo),
    R('GET', '/api/backups/:name', INV.backupGet), R('POST', '/api/backups/:name/restore', INV.backupRestore)
  ];

  async function request(method, url, data) {
    const u = new URL(url, location.href);
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      const m = u.pathname.match(r.re);
      if (!m) continue;
      const p = Object.fromEntries(u.searchParams.entries());
      r.names.forEach((n, i) => { p[n] = decodeURIComponent(m[i + 1]); });
      Object.assign(p, data || {});
      try {
        if (r.open) return await r.fn(p);
        const who = await ensureSession();
        return await r.fn(who, p);
      } catch (e) {
        if (e.denied) {                                  // the database refused: not signed in / not active any more?
          meCache = null;
          try { await currentPerson(true); } catch (x) { throw new HttpError('Please sign in.', 401); }
          throw new HttpError('This change was not allowed.', 403);
        }
        throw e;
      }
    }
    throw new HttpError('Unknown address: ' + method + ' ' + u.pathname, 404);
  }

  return { request, configured: C.configured, signOutLocal, HttpError };
})();
