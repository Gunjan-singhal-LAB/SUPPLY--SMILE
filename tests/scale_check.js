// Times the busiest screens on a large clinic (300 items, 3,000 batches, 33,000 entries) through the stand-in.
//   node tests/scale_check.js   (needs the stand-in running on 5090 with a clinic set up, e.g. by the browser test)
const vm = require('vm'), fs = require('fs'), path = require('path');
const BASE = 'http://127.0.0.1:5090';
(async () => {
  const st = await fetch(BASE + '/__state').then(r => r.json());
  const c = st.db.clinic, day = n => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
  const cats = ['Restorative', 'Endodontic', 'Surgical', 'Infection Control', 'General Consumables'];
  c.items = {}; c.batches = {}; c.txns = {}; c.reversals = null; c.flags = null; c.counts = null; c.reorder = null; c.kits = null;
  let bid = 0, tid = 0;
  for (let i = 1; i <= 300; i++) {
    c.items[i] = { name: 'Item ' + i, category: cats[i % 5], unit: 'piece', packSize: 1, minStock: 5, expires: i % 3 > 0, supplierId: 1 + (i % 4), mode: 'PROCEDURE', active: true };
    for (let k = 0; k < 10; k++) {
      bid++;
      c.batches[bid] = { itemId: i, batchNo: 'B' + bid, qty: k === 9 ? 20 : 0, cost: 50 + (i % 40), received: day(-700 + k * 70), ...(i % 3 ? { expiry: day(-600 + k * 90) } : {}) };
      tid++; c.txns[tid] = { type: 'IN', reason: 'PURCHASE', batchId: bid, itemId: i, qty: 120, date: day(-700 + k * 70), supplierId: 1 + (i % 4), by: 'asha', at: 1 };
    }
  }
  while (tid < 33000) {
    const b = 1 + (tid * 7919) % bid, bb = c.batches[b];
    tid++; c.txns[tid] = { type: 'OUT', reason: 'PROCEDURE_USE', batchId: b, itemId: bb.itemId, qty: 1 + tid % 3, date: day(-(tid % 700)), procedureId: 1 + tid % 6, group: 'g' + Math.floor(tid / 3), by: 'kavya', at: 1 };
  }
  c.counters = { ...c.counters, items: 300, batches: bid, txns: tid };
  await fetch(BASE + '/__state', { method: 'PUT', body: JSON.stringify(st) });
  const storage = new Map();
  const ctx = { console, fetch, URL, URLSearchParams, Intl, TextEncoder, setTimeout, Date, Math, JSON, Promise,
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    location: { href: BASE + '/home.html', origin: BASE },
    SUPPLY_SMILE_CONFIG: { firebaseApiKey: 'local-api-key', firebaseDatabaseUrl: BASE + '/rtdb', authUrl: BASE + '/identitytoolkit/v1', tokenUrl: BASE + '/securetoken/v1' } };
  ctx.window = ctx; vm.createContext(ctx);
  for (const f of ['fb-core.js', 'fb-inventory.js', 'backend.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js', f), 'utf8'), ctx);
  const SS = vm.runInContext('SS', ctx), core = vm.runInContext('SSCore', ctx);
  await SS.request('POST', '/api/login', { username: 'asha', password: 'demo1234' });
  for (const [m, u, d] of [['GET', '/api/alerts/counts'], ['GET', '/api/items'], ['GET', '/api/dashboard'], ['GET', '/api/dashboard/charts?days=30'],
    ['GET', '/api/dashboard/charts?days=90'], ['GET', '/api/items/7'], ['GET', '/api/reports/history'], ['GET', '/api/reports/stock'], ['GET', '/api/reorder'],
    ['GET', '/api/about'], ['POST', '/api/use', { procedureId: 1, lines: [{ itemId: 7, qty: 1 }] }]]) {
    core.db.clearCache();
    const t = Date.now(); const r = await SS.request(m, u, d);
    console.log(`${m} ${u.padEnd(34)} ${String(Date.now() - t).padStart(5)} ms  ${JSON.stringify(r).length / 1024 | 0} KB reply`);
  }
})();
