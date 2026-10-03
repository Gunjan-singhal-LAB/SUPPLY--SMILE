// The same checks as the original app's 33 tests, run against the Firebase version through the
// local Firebase stand-in (tests/firebase_local.js), which enforces database.rules.json.
// Plus Firebase-specific checks: direct database access, two people saving at once, the setup code.
//
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CODE = 'test-code';
let PORT, BASE, server, baseState;

function startServer(port, rulesFile) {
  const p = spawn(process.execPath, [path.join(__dirname, 'firebase_local.js'), String(port)], {
    env: { ...process.env, RULES_FILE: rulesFile }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(ok => p.stdout.once('data', () => ok(p)));
}
const http = (method, p, body) => fetch(BASE + p, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(r => r.json());

// A browser-like copy of the app's three backend files, with its own storage (like one phone).
function client(base = BASE) {
  const storage = new Map();
  const ctx = { console, fetch, URL, URLSearchParams, Intl, TextEncoder, setTimeout, Date, Math, JSON, Promise,
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    location: { href: base + '/home.html', origin: base } };
  ctx.window = ctx;
  ctx.SUPPLY_SMILE_CONFIG = { firebaseApiKey: 'local-api-key', firebaseDatabaseUrl: base + '/rtdb',
    authUrl: base + '/identitytoolkit/v1', tokenUrl: base + '/securetoken/v1', userEmailDomain: 'users.supplysmile.app' };
  vm.createContext(ctx);
  for (const f of ['fb-core.js', 'fb-inventory.js', 'backend.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js', f), 'utf8'), ctx, { filename: f });
  const SS = vm.runInContext('SS', ctx), core = vm.runInContext('SSCore', ctx);
  const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));            // objects from the sandbox -> plain ones
  const req = async (m, u, d) => plain(await SS.request(m, u, d));
  const api = {
    SS, core,
    call: (method, url, data) => req(method, url, data),
    get: url => req('GET', url), post: (url, d) => req('POST', url, d), put: (url, d) => req('PUT', url, d),
    login: (username, password = 'demo1234') => req('POST', '/api/login', { username, password }),
    async err(p) {
      try { await p; } catch (e) { return Object.assign(plain({ ...e }), { message: e.message, status: e.status }); }
      throw new Error('expected an error');
    },
    async item(name) { return (await api.get('/api/items')).items.find(i => i.name === name); },
    async kit(name) { return (await api.get('/api/kits')).kits.find(k => k.procedure === name); },
    token: () => core.getTokens().idToken
  };
  return api;
}
const TODAY = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);     // clinic time (India)
const addDays = n => new Date(Date.parse(TODAY()) + n * 86400e3).toISOString().slice(0, 10);

test.before(async () => {
  const rules = fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8').replace("$code === 'CHANGE-ME'", `$code === '${CODE}'`);
  const rulesFile = path.join(os.tmpdir(), 'ss-test-rules.json');
  fs.writeFileSync(rulesFile, rules);
  PORT = 5200 + Math.floor(Math.random() * 500); BASE = `http://127.0.0.1:${PORT}`;
  server = await startServer(PORT, rulesFile);
  const a = client();
  await a.post('/api/setup', { setupCode: CODE, clinicName: 'Smile Dental Clinic', fullName: 'Dr. Asha Rao', username: 'asha', password: 'demo1234' });
  await a.post('/api/users', { fullName: 'Kavya S', username: 'kavya', role: 'STAFF', password: 'demo1234' });
  await a.post('/api/users', { fullName: 'Ramesh B', username: 'ramesh', role: 'STAFF', password: 'demo1234' });
  await a.post('/api/demo');
  baseState = await http('GET', '/__state');
  baseState.db.clinic.snapshots = null; baseState.db.clinic.snapshotData = null;       // no backups yet
  if (baseState.db.clinic.counters) delete baseState.db.clinic.counters.snapshots;
});
test.after(() => server && server.kill());
test.beforeEach(async () => { await http('PUT', '/__state', baseState); });

// ---------------------------------------------------------------- basics
test('needs sign-in; the Welcome check works signed out', async () => {
  const api = client();
  assert.equal((await api.err(api.get('/api/items'))).status, 401);
  assert.equal((await api.get('/api/setup')).needed, false);
});
test('dashboard counts match the sample data', async () => {
  const api = client(); await api.login('asha');
  assert.deepEqual(await api.get('/api/alerts/counts'), { totalItems: 12, low: 2, out: 1, nearExpiry: 2, expired: 1, flags: 0 });
});
test('stock in creates a batch and converts packs', async () => {
  const api = client(); await api.login('asha');
  const lido = await api.item('Lidocaine 2% cartridges');
  const r = await api.post('/api/stock/in', { itemId: lido.id, supplierId: 1, batchNo: 'NEW-1', quantity: 2, txnDate: TODAY(), expiryDate: addDays(400) });
  assert.equal(r.qty, 100); assert.equal(r.itemQtyNow, lido.qty + 100);
  assert.equal((await api.item('Lidocaine 2% cartridges')).qty, lido.qty + 100);
});
test('stock in needs expiry for expiring items', async () => {
  const api = client(); await api.login('asha');
  const resin = await api.item('Composite resin A2');
  const e = await api.err(api.post('/api/stock/in', { itemId: resin.id, supplierId: 2, batchNo: 'X', quantity: 1, txnDate: TODAY() }));
  assert.equal(e.status, 400); assert.match(e.message, /Expiry date is required/);
});
test('stock out blocks taking more than the batch has', async () => {
  const api = client(); await api.login('asha');
  const lido = await api.item('Lidocaine 2% cartridges');
  const b = (await api.get(`/api/items/${lido.id}/batches`)).batches[0];
  const e = await api.err(api.post('/api/stock/out', { itemId: lido.id, batchId: b.id, quantity: b.qty + 1, reason: 'WASTAGE' }));
  assert.equal(e.status, 400); assert.equal(e.message, `Only ${b.qty} left in this batch.`);
});
test('expired batch hidden and blocked for procedures', async () => {
  const api = client(); await api.login('asha');
  const lido = await api.item('Lidocaine 2% cartridges');
  const usable = (await api.get(`/api/items/${lido.id}/batches`)).batches;
  const expired = (await api.get(`/api/items/${lido.id}/batches?reason=EXPIRED`)).batches;
  assert.deepEqual(usable.map(b => b.batchNo), ['L-5521']);
  assert.deepEqual(expired.map(b => b.batchNo), ['L-4410']);
  assert.equal((await api.err(api.post('/api/stock/out', { batchId: expired[0].id, quantity: 1, reason: 'PROCEDURE_USE', procedureId: 1 }))).status, 400);
});
test('soonest expiry first', async () => {
  const api = client(); await api.login('asha');
  const resin = await api.item('Composite resin A2');
  const b = (await api.get(`/api/items/${resin.id}/batches`)).batches;
  assert.equal(b[0].batchNo, 'CR-2305'); assert.ok(b[0].useFirst);
});
test('stock out then undo restores the quantity (once)', async () => {
  const api = client(); await api.login('kavya');
  const gloves = await api.item('Nitrile gloves (M)');
  const b = (await api.get(`/api/items/${gloves.id}/batches`)).batches[0];
  const saved = await api.post('/api/stock/out', { itemId: gloves.id, batchId: b.id, quantity: 2, reason: 'PROCEDURE_USE', procedureId: 1 });
  assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty - 2);
  await api.post(`/api/stock/${saved.id}/undo`);
  assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty);
  assert.equal((await api.err(api.post(`/api/stock/${saved.id}/undo`))).status, 400);
});
test('low and out statuses', async () => {
  const api = client(); await api.login('asha');
  assert.equal((await api.item('Nitrile gloves (M)')).status, 'LOW');
  assert.equal((await api.item('K-files 15-40')).status, 'OUT');
});
test('staff cannot do admin actions', async () => {
  const api = client(); await api.login('kavya');
  assert.equal((await api.err(api.post('/api/items', { name: 'x' }))).status, 403);
  assert.equal((await api.err(api.post('/api/suppliers', { name: 'x' }))).status, 403);
  assert.equal((await api.err(api.get('/api/users'))).status, 403);
  assert.equal((await api.err(api.post('/api/stock/1/correct'))).status, 403);
});
test('admin adds an item; a duplicate is refused', async () => {
  const api = client(); await api.login('asha');
  const d = { name: 'Prophy paste', category: 'General Consumables', unit: 'pack', packSize: 1, minStockLevel: 2, expires: true, defaultSupplierId: 3 };
  assert.equal((await api.post('/api/items', d)).name, 'Prophy paste');
  const e = await api.err(api.post('/api/items', d));
  assert.equal(e.status, 400); assert.match(e.message, /already exists/);
});
test('the last admin cannot be removed', async () => {
  const api = client(); const me = await api.login('asha');
  const e = await api.err(api.put('/api/users/' + me.id, { role: 'STAFF' }));
  assert.equal(e.status, 400); assert.match(e.message, /at least one active Admin/);
});
test('every report returns rows', async () => {
  const api = client(); await api.login('asha');
  for (const k of ['stock', 'history', 'usage', 'purchases', 'expiry']) assert.ok((await api.get('/api/reports/' + k)).rows.length, k);
});
test('dashboard charts', async () => {
  const api = client(); await api.login('asha');
  for (const [days, buckets] of [[7, 7], [30, 30], [90, 13]]) {
    const d = await api.get('/api/dashboard/charts?days=' + days);
    assert.equal(d.period.days, days); assert.equal(d.movement.buckets.length, buckets); assert.ok(d.kpis.stockValue > 0);
  }
  const d = await api.get('/api/dashboard/charts?days=30');
  assert.equal(d.statusMix.reduce((s, m) => s + m.count, 0), 12);
  assert.ok(d.topItems.length && d.byCategory.length && d.byProcedure.length);
  assert.equal(d.expiry.length, 6);
});
test('stock in shows the new total and refuses an expired batch', async () => {
  const api = client(); await api.login('asha');
  const gloves = await api.item('Nitrile gloves (M)');
  assert.equal((await api.post('/api/stock/in', { itemId: gloves.id, supplierId: 1, batchNo: 'G-NEW', quantity: 3, txnDate: TODAY() })).itemQtyNow, gloves.qty + 3);
  const e = await api.err(api.post('/api/stock/in', { itemId: gloves.id, supplierId: 1, batchNo: 'OLD', quantity: 1, txnDate: addDays(-30), expiryDate: addDays(-5) }));
  assert.equal(e.status, 400); assert.match(e.message, /already passed/);
  assert.equal((await api.get('/api/about')).items, 12);
});

// ---------------------------------------------------------------- daily work
test('a kit records the whole patient in one save, and undo', async () => {
  const api = client(); await api.login('kavya');
  const rct = await api.kit('Root canal treatment');
  assert.equal(Object.fromEntries(rct.lines.map(l => [l.name, l.qty]))['Lidocaine 2% cartridges'], 2);
  const before = (await api.item('Lidocaine 2% cartridges')).qty;
  const lines = rct.lines.filter(l => l.name !== 'K-files 15-40').map(l => ({ itemId: l.itemId, qty: l.qty }));
  const r = await api.post('/api/use', { procedureId: rct.procedureId, lines });
  assert.equal(r.lines.length, 3); assert.equal(r.flags.length, 0);
  assert.equal((await api.item('Lidocaine 2% cartridges')).qty, before - 2);
  await api.post(`/api/use/${r.group}/undo`);
  assert.equal((await api.item('Lidocaine 2% cartridges')).qty, before);
  assert.equal((await api.err(api.post(`/api/use/${r.group}/undo`))).status, 400);
});
test('use spills over batches, soonest expiry first', async () => {
  const api = client(); await api.login('asha');
  const resin = await api.item('Composite resin A2');
  await api.post('/api/use', { procedureId: 2, lines: [{ itemId: resin.id, qty: 3 }] });
  const b = Object.fromEntries((await api.get(`/api/items/${resin.id}/batches`)).batches.map(x => [x.batchNo, x.qty]));
  assert.ok(!('CR-2305' in b)); assert.equal(b['CR-2211'], 3);
});
test('short stock is blocked unless "Used anyway", which flags it', async () => {
  const api = client(); await api.login('asha');
  const kf = await api.item('K-files 15-40');
  const body = { procedureId: 3, lines: [{ itemId: kf.id, qty: 1 }] };
  const e = await api.err(api.post('/api/use', body));
  assert.equal(e.status, 400); assert.match(e.message, /Used anyway/); assert.equal(e.short[0].have, 0);
  body.lines[0].usedAnyway = true;
  assert.equal((await api.post('/api/use', body)).flags[0].qty, 1);
  const flags = (await api.get('/api/flags')).flags;
  assert.equal(flags[0].itemName, 'K-files 15-40');
  assert.equal((await api.get('/api/alerts/counts')).flags, 1);
  await api.post(`/api/flags/${flags[0].id}/resolve`);
  assert.deepEqual((await api.get('/api/flags')).flags, []);
});
test('general use needs no procedure and counts as usage', async () => {
  const api = client(); await api.login('ramesh');
  const gloves = await api.item('Nitrile gloves (M)');
  assert.ok(gloves.bulk);
  await api.post('/api/use', { reason: 'ISSUE', lines: [{ itemId: gloves.id, qty: 1 }] });
  assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty - 1);
  assert.ok((await api.get('/api/reports/history')).rows.some(r => r[5] === 'General use'));
});
test('admin edits a kit; staff cannot', async () => {
  const api = client(); await api.login('kavya');
  assert.equal((await api.err(api.put('/api/kits/1', { lines: [] }))).status, 403);
  await api.login('asha');
  const masks = await api.item('Face masks 3-ply');
  const k = await api.put('/api/kits/1', { lines: [{ itemId: masks.id, qty: 1 }] });
  assert.deepEqual(k.lines.map(l => l.name), ['Face masks 3-ply']);
});
test('stock count adjusts both ways and clears flags', async () => {
  const api = client(); await api.login('asha');
  const [gloves, burs, kf] = [await api.item('Nitrile gloves (M)'), await api.item('Diamond burs, assorted'), await api.item('K-files 15-40')];
  await api.post('/api/use', { procedureId: 3, lines: [{ itemId: kf.id, qty: 1, usedAnyway: true }] });
  const r = await api.post('/api/counts', { lines: [{ itemId: gloves.id, counted: gloves.qty - 2 }, { itemId: burs.id, counted: burs.qty + 3 },
    { itemId: kf.id, counted: 2 }, { itemId: 1, counted: '' }] });
  assert.equal(r.itemsCounted, 3); assert.equal(r.itemsChanged, 3);
  assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty - 2);
  assert.equal((await api.item('Diamond burs, assorted')).qty, burs.qty + 3);
  assert.equal((await api.item('K-files 15-40')).qty, 2);
  assert.deepEqual((await api.get('/api/flags')).flags, []);
  const detail = await api.get('/api/counts/' + r.id);
  assert.equal(Object.fromEntries(detail.lines.map(l => [l.name, l.diff]))['Nitrile gloves (M)'], -2);
  assert.equal((await api.get('/api/counts')).counts[0].itemsChanged, 3);
});
test('import checks first, then saves the valid rows', async () => {
  const api = client(); await api.login('asha');
  const exp = addDays(300), dmy = `${exp.slice(8, 10)}-${exp.slice(5, 7)}-${exp.slice(0, 4)}`;
  const rows = [
    { 'Item name': 'Cotton rolls', Category: 'general consumables', Unit: 'packs', 'Minimum stock': '5', 'Expires (Y/N)': 'N',
      'Bulk consumable (Y/N)': 'Y', Supplier: 'New Dental Mart', 'Opening quantity': '12', 'Cost per unit (Rs)': '60' },
    { 'Item name': 'Articaine 4%', Category: 'Medicines & Anaesthetics', Unit: 'cartridge', 'Opening quantity': '100', 'Expiry date': dmy,
      'Cost per unit (Rs)': '55', 'Batch no': 'AR-1' },
    { 'Item name': 'Bad row', Unit: 'crate' },
    { 'Item name': 'Composite resin A2', Category: 'Restorative', Unit: 'syringe', 'Opening quantity': '2', 'Expiry date': dmy },
    {}];
  let r = await api.post('/api/import/items', { rows, checkOnly: true });
  assert.ok(r.checkOnly); assert.deepEqual(r.summary, { rows: 4, ok: 3, errors: 1, newItems: 2, withStock: 3 });
  assert.equal((await api.get('/api/items')).items.length, 12);
  r = await api.post('/api/import/items', { rows, checkOnly: false });
  assert.equal(r.checkOnly, false);
  const cotton = await api.item('Cotton rolls');
  assert.equal(cotton.qty, 12); assert.ok(cotton.bulk); assert.equal(cotton.supplierName, 'New Dental Mart');
  const arti = await api.item('Articaine 4%');
  assert.equal(arti.qty, 100); assert.equal(arti.nearestExpiry, exp);
  assert.equal((await api.get('/api/items')).items.filter(i => i.name === 'Composite resin A2').length, 1);
});
test('import reads Excel date numbers', async () => {
  const api = client(); await api.login('asha');
  const r = await api.post('/api/import/items', { checkOnly: false, rows: [{ 'Item name': 'Articaine 4%', Category: 'Medicines & Anaesthetics',
    Unit: 'cartridge', 'Opening quantity': 10, 'Expiry date': 46568 }] });
  assert.equal(r.summary.ok, 1);
  assert.equal((await api.item('Articaine 4%')).nearestExpiry, '2027-06-30');
});
test('staff cannot count or import', async () => {
  const api = client(); await api.login('kavya');
  assert.equal((await api.err(api.post('/api/counts', {}))).status, 403);
  assert.equal((await api.err(api.post('/api/import/items', {}))).status, 403);
});
test('an invoice saves all lines or none, and can be undone', async () => {
  const api = client(); await api.login('asha');
  const [resin, lido] = [await api.item('Composite resin A2'), await api.item('Lidocaine 2% cartridges')];
  const exp = addDays(400);
  const bad = { supplierId: 2, invoiceNo: 'GC-9', lines: [{ itemId: resin.id, batchNo: 'CR-9', quantity: 2, expiryDate: exp }, { itemId: lido.id, batchNo: 'L-9', quantity: 1 }] };
  const e = await api.err(api.post('/api/stock/in/invoice', bad));
  assert.equal(e.status, 400); assert.deepEqual(e.lines, [{ line: 2, error: 'Expiry date is required for this item.' }]);
  assert.equal((await api.item('Composite resin A2')).qty, resin.qty);
  bad.lines[1].expiryDate = exp;
  const r = await api.post('/api/stock/in/invoice', bad);
  assert.equal(r.count, 2);
  assert.equal((await api.item('Composite resin A2')).qty, resin.qty + 2);
  assert.equal((await api.item('Lidocaine 2% cartridges')).qty, lido.qty + 50);
  await api.post(`/api/use/${r.group}/undo`);
  assert.equal((await api.item('Lidocaine 2% cartridges')).qty, lido.qty);
});
test('the reorder list is shared and builds the WhatsApp message', async () => {
  const api = client(); await api.login('asha');
  const gloves = await api.item('Nitrile gloves (M)');
  assert.ok((await api.get('/api/reorder')).suggestions.some(s => s.itemId === gloves.id));
  let data = await api.put('/api/reorder/' + gloves.id, {});
  const g = data.groups[0];
  assert.equal(g.supplierName, 'MediCare Surgicals'); assert.equal(g.lines[0].packs, 14);
  assert.ok(g.whatsapp.startsWith('https://wa.me/919741020988?text=')); assert.match(g.message, /Nitrile gloves/);
  assert.ok(g.whatsapp.includes('%0AOrder%20from%20Smile%20Dental%20Clinic'));
  data = await api.put('/api/reorder/' + gloves.id, { packs: 5 });
  assert.equal(data.groups[0].lines[0].packs, 5);
  const k = client(); await k.login('kavya');
  assert.deepEqual((await k.get('/api/reorder')).itemIds, [gloves.id]);
  assert.equal((await k.err(k.put('/api/reorder/' + gloves.id, {}))).status, 403);
  assert.deepEqual((await api.post('/api/reorder/ordered', { supplierId: g.supplierId })).groups, []);
});
test('an account the Admin did not add cannot use the app', async () => {
  const r = await fetch(`${BASE}/identitytoolkit/v1/accounts:signUp?key=local-api-key`, { method: 'POST',
    body: JSON.stringify({ email: 'stranger@users.supplysmile.app', password: 'demo1234', returnSecureToken: true }) }).then(x => x.json());
  assert.ok(r.idToken);
  const api = client();
  const e = await api.err(api.login('stranger'));
  assert.equal(e.status, 401); assert.match(e.message, /not active/);
  // and straight at the database with its own token
  const items = await fetch(`${BASE}/rtdb/clinic/items.json?auth=${r.idToken}`);
  assert.equal(items.status, 401);
});
test('backup and restore', async () => {
  const api = client(); await api.login('asha');
  const b = await api.post('/api/backups');
  const gloves = await api.item('Nitrile gloves (M)');
  await api.post('/api/use', { reason: 'ISSUE', lines: [{ itemId: gloves.id, qty: 2 }] });
  assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty - 2);
  const r = await api.post(`/api/backups/${encodeURIComponent(b.name)}/restore`);
  assert.equal(r.restored, b.name); assert.match(r.safetyCopy, /before-restore/);
  assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty);
  const names = (await api.get('/api/backups')).backups.map(x => x.name);
  assert.ok(names.includes(b.name) && names.includes(r.safetyCopy));
  const data = (await api.get('/api/backups/' + encodeURIComponent(b.name))).data;
  assert.equal(data.app, 'Supply Smile'); assert.equal(Object.keys(data.tables.items).length, 12);
  await api.post('/api/use', { reason: 'ISSUE', lines: [{ itemId: gloves.id, qty: 1 }] });   // new entries still get fresh numbers
  const r2 = await api.post('/api/backups/upload', { data });
  assert.match(r2.restored, /uploaded/); assert.equal((await api.item('Nitrile gloves (M)')).qty, gloves.qty);
  assert.equal((await api.err(api.post('/api/backups/upload', { data: { app: 'other' } }))).status, 400);
  assert.equal((await api.err(api.get('/api/backups/..%2Fx'))).status, 404);
  const k = client(); await k.login('kavya');
  assert.equal((await k.err(k.get('/api/backups'))).status, 403);
});
test('the daily backup is made once', async () => {
  const api = client(); await api.login('asha');
  await api.get('/api/me'); await api.get('/api/me');
  await new Promise(ok => setTimeout(ok, 1500));
  assert.equal((await api.get('/api/backups')).backups.filter(b => b.kind === 'daily').length, 1);
});
test('admin changes clinic settings; staff cannot', async () => {
  const api = client(); await api.login('asha');
  assert.deepEqual(await api.put('/api/settings', { clinicName: 'Smile Care Jayanagar', nearExpiryDays: 45 }), { clinicName: 'Smile Care Jayanagar', nearExpiryDays: 45 });
  assert.equal((await api.get('/api/me')).nearExpiryDays, 45);
  assert.equal((await api.get('/api/setup')).clinicName, 'Smile Care Jayanagar');
  assert.equal((await api.err(api.put('/api/settings', { nearExpiryDays: 0 }))).status, 400);
  const k = client(); await k.login('kavya');
  assert.equal((await k.err(k.put('/api/settings', { clinicName: 'X' }))).status, 403);
});
test('admin adds staff, resets a password, deactivates', async () => {
  const api = client(); await api.login('asha');
  const u = await api.post('/api/users', { username: 'Nisha', fullName: 'Nisha K', role: 'STAFF', password: 'abcd1234' });
  assert.equal(u.fullName, 'Nisha K'); assert.equal(u.role, 'STAFF'); assert.ok(u.active);
  assert.equal((await api.err(api.post('/api/users', { username: 'nisha', fullName: 'N', password: 'abcd1234' }))).message, 'That username is already taken.');
  const n = client(); await n.login('nisha', 'abcd1234');
  await api.put('/api/users/' + u.id, { password: 'newpass99' });
  const n2 = client();
  assert.equal((await n2.err(n2.login('nisha', 'abcd1234'))).status, 401);
  assert.equal((await n2.login('nisha', 'newpass99')).username, 'nisha');
  assert.equal((await n.err(n.get('/api/items'))).status, 401);            // the old sign-in stops working
  await api.put('/api/users/' + u.id, { active: false });
  assert.equal((await n2.err(n2.get('/api/me'))).status, 401);
});
test('a user changes their own password', async () => {
  const api = client(); await api.login('kavya');
  assert.equal((await api.err(api.put('/api/me/password', { currentPassword: 'wrong123', newPassword: 'kavya5678' }))).message, 'Current password is not correct.');
  await api.put('/api/me/password', { currentPassword: 'demo1234', newPassword: 'kavya5678' });
  assert.equal((await client().login('kavya', 'kavya5678')).username, 'kavya');
});

test('admin corrects a used entry; it cannot be reversed twice', async () => {
  const api = client(); await api.login('asha');
  const burs = await api.item('Diamond burs, assorted');
  const out = (await api.get('/api/items/' + burs.id)).history.find(h => h.type === 'OUT');
  const c = await api.post(`/api/stock/${out.id}/correct`);
  assert.equal(c.reason, 'CORRECTION'); assert.equal(c.note, `Correction of entry #${out.id}`);
  assert.equal((await api.item('Diamond burs, assorted')).qty, burs.qty + out.qty);
  assert.equal((await api.err(api.post(`/api/stock/${out.id}/correct`))).message, 'This entry has already been reversed.');
  assert.equal((await api.err(api.post(`/api/stock/${c.id}/correct`))).message, 'A correction cannot be reversed again.');
});

// ---------------------------------------------------------------- Firebase-specific
test('the database itself refuses direct changes that skip the rules', async () => {
  const k = client(); await k.login('kavya');
  const tok = k.token(), put = (p, v) => fetch(`${BASE}/rtdb/${p}.json?auth=${tok}`, { method: 'PUT', body: JSON.stringify(v) }).then(r => r.status);
  assert.equal(await put('clinic/items/1/minStock', 0), 401);                  // staff: items are Admin-only
  assert.equal(await put('clinic/settings/clinicName', 'X'), 401);
  assert.equal(await put('clinic/people/kavya/role', 'ADMIN'), 401);           // cannot make herself Admin
  assert.equal(await put('clinic/txns/1', { type: 'IN', reason: 'PURCHASE', batchId: 1, itemId: 1, qty: 1, date: TODAY(), by: 'kavya', at: 1 }), 401); // history can't be overwritten
  assert.equal(await put('clinic/batches/1/qty', -5), 401);                    // stock can't go negative
  assert.equal((await fetch(`${BASE}/rtdb/clinic/items.json`)).status, 401);   // nothing is readable signed out
  assert.equal((await fetch(`${BASE}/rtdb/clinic/logins.json`)).status, 401);  // the list of sign-in names isn't either
});
test('two people saving at the same moment: both are recorded correctly', async () => {
  const a = client(), k = client();
  await a.login('asha'); await k.login('kavya');
  const burs = await a.item('Diamond burs, assorted');
  const results = await Promise.all([
    a.post('/api/use', { procedureId: 2, lines: [{ itemId: burs.id, qty: 2 }] }),
    k.post('/api/use', { procedureId: 3, lines: [{ itemId: burs.id, qty: 3 }] }),
    k.post('/api/stock/in', { itemId: burs.id, supplierId: 3, batchNo: 'B-99', quantity: 4 })]);
  assert.equal(results.length, 3);
  assert.equal((await a.item('Diamond burs, assorted')).qty, burs.qty - 2 - 3 + 4);
  const hist = (await a.get('/api/items/' + burs.id)).history;
  assert.equal(new Set(hist.map(h => h.id)).size, hist.length);                // no entry overwritten
});
test('first-time setup: only with the right code, only once', async () => {
  await http('PUT', '/__state', { db: null, users: {} });
  const api = client();
  assert.equal((await api.get('/api/setup')).needed, true);
  const f = { clinicName: 'Sai Dental Care', fullName: 'Dr. Meera', username: 'meera', password: 'demo1234' };
  assert.equal((await api.err(api.post('/api/setup', { ...f, setupCode: 'wrong' }))).message, 'The setup code is not correct.');
  assert.equal((await api.get('/api/setup')).needed, true);
  await api.post('/api/setup', { ...f, setupCode: CODE });
  const me = await api.get('/api/me');
  assert.equal(me.clinicName, 'Sai Dental Care'); assert.equal(me.role, 'ADMIN');
  assert.equal((await api.get('/api/meta')).procedures.length, 6);
  assert.deepEqual(await client().get('/api/setup'), { needed: false, clinicName: 'Sai Dental Care' });
  const other = client();
  assert.equal((await other.err(other.post('/api/setup', { ...f, username: 'x2', setupCode: CODE }))).status, 400);
});
test('the unchanged default setup code is never accepted', async () => {
  const port = PORT + 1000, base = `http://127.0.0.1:${port}`;
  const s2 = await startServer(port, path.join(ROOT, 'database.rules.json'));
  try {
    const api = client(base);
    const e = await api.err(api.post('/api/setup', { clinicName: 'X', fullName: 'Y', username: 'yy', password: 'demo1234', setupCode: 'CHANGE-ME' }));
    assert.equal(e.message, 'The setup code is not correct.');
  } finally { s2.kill(); }
});
