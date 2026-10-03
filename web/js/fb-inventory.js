// Supply Smile (Firebase) - part 2 of 3: everything the app does with stock.
//
// Each function takes the signed-in person (me) and the request (p), reads what it needs from
// Firebase, checks every rule, and saves all its changes in ONE multi-place update: either
// everything is saved or nothing is. Stock-changing saves also claim fresh entry numbers; if two
// people save at the same moment, Firebase's rules refuse the second one, and it is re-checked
// against the new stock and saved again.
//
// Replies have exactly the same shape as the original app's, so the pages did not change.
const SSInventory = (() => {
  const C = SSCore;
  const { fail, notFound, asMap, round2, txt, reqText, optText, toInt, toMoney, optId, optDate, bool, today, addDays, diffDays, TS } = C;
  const HttpError = C.HttpError;

  const CATEGORIES = ['Restorative', 'Endodontic', 'Prosthodontic', 'Orthodontic', 'Surgical', 'Medicines & Anaesthetics',
    'Infection Control', 'Impression Materials', 'Instruments & Burs', 'General Consumables'];
  const UNITS = ['piece', 'box', 'pack', 'kit', 'syringe', 'cartridge', 'bottle', 'tube', 'ml', 'g'];
  const COMMON_PROCEDURES = ['Scaling', 'Composite filling', 'Root canal treatment', 'Extraction', 'Crown preparation', 'Impression'];
  const REASON_LABEL = { PURCHASE: 'Purchase', OPENING: 'Opening stock', PROCEDURE_USE: 'Procedure use', ISSUE: 'General use',
    WASTAGE: 'Wastage', EXPIRED: 'Expired', COUNT: 'Stock count', CORRECTION: 'Correction' };
  const VERSION = '3.0 Firebase';

  // ---------------------------------------------------------------- reading
  const MAPS = ['items', 'batches', 'suppliers', 'procedures', 'people', 'flags', 'reorder', 'counts', 'counters', 'reversals', 'snapshots'];
  async function load(names, fresh = false) {
    const vals = await Promise.all(names.map(n => C.db.get('clinic/' + n, { fresh })));
    const out = {};
    names.forEach((n, i) => {
      if (n === 'settings') out.settings = vals[i] || {};
      else if (n === 'kits') { out.kits = {}; for (const [pid, k] of Object.entries(asMap(vals[i]))) out.kits[pid] = asMap(k); }
      else out[n] = MAPS.includes(n) ? asMap(vals[i]) : vals[i];
    });
    return out;
  }
  const rows = m => Object.entries(m || {}).map(([id, v]) => ({ ...v, id: /^\d+$/.test(id) ? Number(id) : id }));
  const txQuery = (child, q) => C.db.get('clinic/txns', { query: { orderBy: child, ...q } }).then(asMap);
  const txnsBetween = (s, e) => txQuery('date', { startAt: s, endAt: e });
  const txnsOfItem = id => txQuery('itemId', { equalTo: id });
  const txnsOfGroup = g => txQuery('group', { equalTo: g });
  const txnsOfSupplier = id => txQuery('supplierId', { equalTo: id });
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
  const nameCmp = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

  const nearDays = c => Number(c.settings && c.settings.nearExpiryDays) || 30;
  const clinicName = c => (c.settings && c.settings.clinicName) || 'Dental Clinic';
  const personName = (c, k) => (c.people[k] && c.people[k].fullName) || k || '';

  // Live stock of every item, worked out from its batches (the old v_items view).
  function vItems(c) {
    const t = today(), near = addDays(t, nearDays(c));
    const agg = {};
    for (const b of rows(c.batches)) {
      const a = agg[b.itemId] || (agg[b.itemId] = { qty: 0, nearest: null, expired: 0, nearB: 0, last: null });
      const ok = !b.expiry || b.expiry >= t;
      if (ok) a.qty += b.qty || 0;
      if (b.qty > 0 && b.expiry && (!a.nearest || b.expiry < a.nearest)) a.nearest = b.expiry;
      if (b.expiry && b.expiry < t && b.qty > 0) a.expired++;
      if (b.expiry && b.expiry >= t && b.expiry <= near && b.qty > 0) a.nearB++;
      if (!a.last || b.received > a.last.received || (b.received === a.last.received && b.id > a.last.id)) a.last = b;
    }
    const out = {};
    for (const i of rows(c.items)) {
      const a = agg[i.id] || { qty: 0, nearest: null, expired: 0, nearB: 0, last: null };
      const sup = i.supplierId ? c.suppliers[i.supplierId] : null;
      out[i.id] = { ...i, qty: a.qty, nearestExpiry: a.nearest, expiredBatches: a.expired, nearBatches: a.nearB,
        lastCost: a.last ? a.last.cost || 0 : 0, supplierName: sup ? sup.name : null };
    }
    return out;
  }
  const itemStatus = v => (v.qty === 0 ? 'OUT' : v.qty <= (v.minStock || 0) ? 'LOW' : v.expiredBatches > 0 ? 'EXPIRED'
    : v.nearBatches > 0 ? 'NEAR_EXPIRY' : 'IN_STOCK');
  const itemJson = v => ({ id: v.id, name: v.name, category: v.category, unit: v.unit, packSize: v.packSize,
    minStockLevel: v.minStock || 0, expires: v.expires !== false, defaultSupplierId: v.supplierId || null,
    supplierName: v.supplierName, active: v.active !== false, qty: v.qty, nearestExpiry: v.nearestExpiry,
    status: itemStatus(v), bulk: v.mode === 'BULK', lastCost: v.lastCost || 0 });
  const itemsList = (c, inactive = false) => Object.values(vItems(c)).filter(v => inactive || v.active !== false)
    .sort((a, b) => nameCmp(a.name, b.name)).map(itemJson);
  function itemOne(c, id) {
    const v = vItems(c)[id];
    if (!v) notFound('Item not found.');
    return itemJson(v);
  }
  function txnJson(c, t) {
    const b = c.batches[t.batchId] || {}, i = c.items[t.itemId] || {};
    const s = t.supplierId ? c.suppliers[t.supplierId] : null, pr = t.procedureId ? c.procedures[t.procedureId] : null;
    return { id: t.id, type: t.type, reason: t.reason, date: t.date, qty: t.qty, itemId: t.itemId, itemName: i.name || null,
      unit: i.unit || null, batchId: t.batchId, batchNo: b.batchNo || null, unitCost: b.cost || 0,
      supplierId: t.supplierId || null, supplierName: s ? s.name : null, invoiceNo: t.invoiceNo || null,
      procedureId: t.procedureId || null, procedureName: pr ? pr.name : null, note: t.note || null,
      userName: personName(c, t.by), createdAt: C.localTs(t.at), group: t.group || null };
  }
  const proceduresList = (c, inactive) => rows(c.procedures).filter(p => inactive || p.active !== false)
    .sort((a, b) => nameCmp(a.name, b.name)).map(p => ({ id: p.id, name: p.name, active: p.active !== false }));
  const requireAdmin = me => { if (me.role !== 'ADMIN') throw new HttpError('Only the Admin can do this.', 403); };

  // ---------------------------------------------------------------- saving
  // Read the entry counter FIRST, then the stock. Any save made by someone else after this read uses
  // the same next entry number, so Firebase refuses whichever of the two arrives second.
  async function stockSave(names, build) {
    for (let attempt = 0; ; attempt++) {
      const counters = asMap(await C.db.get('clinic/counters', { fresh: true }));
      const c = await load(names, true);
      c.counters = counters;
      const u = {};
      const alloc = (name, n = 1) => { const first = (Number(c.counters[name]) || 0) + 1; c.counters[name] = first + n - 1; u['counters/' + name] = c.counters[name]; return first; };
      const result = await build(c, u, alloc);             // may throw a form error (400/404): nothing is saved
      if (!Object.keys(u).length) return result();
      try {
        await C.db.patch('clinic', u);
        return result();
      } catch (e) {
        if (!e.denied || attempt >= 2) throw e.denied ? new HttpError('Stock changed meanwhile. Please save again.', 400) : e;
      }
    }
  }
  const newGroup = () => Math.random().toString(16).slice(2, 8) + Date.now().toString(16).slice(-6);
  function txnRecord(me, f) {
    const t = { type: f.type, reason: f.reason, batchId: f.batchId, itemId: f.itemId, qty: f.qty, date: f.date, by: me.key, at: TS };
    for (const k of ['supplierId', 'invoiceNo', 'procedureId', 'note', 'group']) if (f[k] !== null && f[k] !== undefined && f[k] !== '') t[k] = f[k];
    return t;
  }
  // adds an entry to the update and to the local copy (so replies show the new state)
  function addTxn(c, u, me, id, f) {
    const t = txnRecord(me, f);
    u['txns/' + id] = t;
    c.txns = c.txns || {};
    c.txns[id] = { ...t, at: C.serverNow() };
    return id;
  }
  function setBatchQty(c, u, id, qty) {
    c.batches[id] = { ...c.batches[id], qty };
    if (u['batches/' + id]) u['batches/' + id] = c.batches[id];      // a batch made in this same save
    else u[`batches/${id}/qty`] = qty;
  }
  const usable = (c, itemId) => rows(c.batches).filter(b => b.itemId === itemId && b.qty > 0 && (!b.expiry || b.expiry >= today()))
    .sort((a, b) => (!a.expiry) - (!b.expiry) || (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0) || a.id - b.id);

  // ---------------------------------------------------------------- settings & meta
  async function settingsSave(me, p) {
    requireAdmin(me);
    const u = {};
    if ('clinicName' in p) {
      const n = txt(p, 'clinicName');
      if (n === null) fail('Enter the clinic name.');
      u['clinic/settings/clinicName'] = n.slice(0, 80); u['public/clinicName'] = n.slice(0, 80);
    }
    if ('nearExpiryDays' in p) {
      const d = toInt(p.nearExpiryDays, 'Near-expiry warning', 1);
      if (d > 365) fail('Near-expiry warning can be at most 365 days.');
      u['clinic/settings/nearExpiryDays'] = d;
    }
    if (Object.keys(u).length) await C.db.patch('', u);
    const c = await load(['settings'], true);
    return { clinicName: clinicName(c), nearExpiryDays: nearDays(c) };
  }
  async function about() {
    const [c, keys, last] = await Promise.all([load(['items', 'batches']),
      C.db.get('clinic/txns', { query: { shallow: 'true' } }),
      C.db.get('clinic/txns', { query: { orderBy: '$key', limitToLast: 1 } })]);
    const lastT = Object.values(asMap(last))[0];
    return { version: VERSION, appFolder: 'Netlify (web pages)', database: 'Firebase Realtime Database',
      items: rows(c.items).filter(i => i.active !== false).length, batches: Object.keys(c.batches).length,
      entries: Object.keys(asMap(keys)).length, lastEntry: lastT ? C.localTs(lastT.at) : null, today: today(), phoneAddresses: [] };
  }
  async function meta() {
    const c = await load(['suppliers', 'procedures']);
    return { categories: CATEGORIES, units: UNITS,
      suppliers: rows(c.suppliers).filter(s => s.active !== false).sort((a, b) => nameCmp(a.name, b.name)).map(s => ({ id: s.id, name: s.name })),
      procedures: proceduresList(c, false) };
  }

  // ---------------------------------------------------------------- items
  async function itemsListApi(me, p) {
    const c = await load(['items', 'batches', 'suppliers', 'settings']);
    const s = txt(p, 'search'), cat = txt(p, 'category'), st = txt(p, 'status');
    return { items: itemsList(c, p.inactive === '1' || p.inactive === 1 || p.inactive === true)
      .filter(i => (!s || i.name.toLowerCase().includes(s.toLowerCase())) && (!cat || i.category === cat) && (!st || i.status === st)) };
  }
  function batchStatus(c, b) {
    const t = today();
    return b.expiry && b.expiry < t ? 'EXPIRED' : b.qty === 0 ? 'OUT' : b.expiry && b.expiry <= addDays(t, nearDays(c)) ? 'NEAR_EXPIRY' : 'IN_STOCK';
  }
  const batchOrder = (a, b) => (!a.expiry) - (!b.expiry) || (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0) || a.id - b.id;
  async function itemDetail(me, p) {
    const id = toInt(p.id, 'Item', 1);
    const [c, tx] = await Promise.all([load(['items', 'batches', 'suppliers', 'procedures', 'people', 'settings']), txnsOfItem(id)]);
    return { item: itemOne(c, id),
      batches: rows(c.batches).filter(b => b.itemId === id).sort(batchOrder).map(b => ({ id: b.id, batchNo: b.batchNo,
        expiryDate: b.expiry || null, qty: b.qty, unitCost: b.cost || 0, receivedDate: b.received, status: batchStatus(c, b) })),
      history: rows(tx).sort(byDateDesc).slice(0, 100).map(t => txnJson(c, t)) };
  }
  async function itemBatches(me, p) {
    const id = toInt(p.id, 'Item', 1), reason = txt(p, 'reason') || 'PROCEDURE_USE';
    const c = await load(['items', 'batches', 'suppliers', 'settings']);
    itemOne(c, id);
    const t = today(), near = addDays(t, nearDays(c));
    return { batches: rows(c.batches).filter(b => b.itemId === id && b.qty > 0 &&
        (reason === 'EXPIRED' ? b.expiry && b.expiry < t : !b.expiry || b.expiry >= t)).sort(batchOrder)
      .map(b => ({ id: b.id, batchNo: b.batchNo, expiryDate: b.expiry || null, qty: b.qty,
        daysLeft: b.expiry ? diffDays(b.expiry, t) : null, useFirst: !!(b.expiry && t <= b.expiry && b.expiry <= near) })) };
  }
  function itemClean(c, p) {
    const r = { name: reqText(p, 'name', 'Item name') };
    r.category = p.category;
    if (!CATEGORIES.includes(r.category)) fail('Choose a category from the list.');
    r.unit = p.unit;
    if (!UNITS.includes(r.unit)) fail('Choose a unit from the list.');
    r.packSize = toInt(p.packSize === undefined || p.packSize === null ? 1 : p.packSize, 'Pack size', 1);
    r.minStock = toInt(p.minStockLevel === undefined || p.minStockLevel === null ? 0 : p.minStockLevel, 'Minimum stock', 0);
    const sid = optId(p.defaultSupplierId);
    if (sid && !c.suppliers[sid]) fail('Supplier not found.');
    if (sid) r.supplierId = sid;
    r.expires = bool(p.expires, true);
    r.mode = bool(p.bulk, false) ? 'BULK' : 'PROCEDURE';
    return r;
  }
  const sameItem = (c, r, exceptId) => rows(c.items).some(i => i.id !== exceptId && i.name.toLowerCase() === r.name.toLowerCase() && i.category === r.category);
  async function itemCreate(me, p) {
    requireAdmin(me);
    return stockSave(['items', 'suppliers', 'batches', 'settings'], (c, u, alloc) => {
      const r = itemClean(c, p);
      if (sameItem(c, r)) fail('An item with this name already exists in this category.');
      const id = alloc('items');
      c.items[id] = { ...r, active: true }; u['items/' + id] = c.items[id];
      return () => itemOne(c, id);
    });
  }
  async function itemUpdate(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Item', 1);
    const c = await load(['items', 'suppliers', 'batches', 'settings'], true);
    itemOne(c, id);
    const keys = Object.keys(p).filter(k => k !== 'id');
    if (keys.length === 1 && keys[0] === 'active') {
      await C.db.patch('clinic', { [`items/${id}/active`]: bool(p.active, true) });
      c.items[id].active = bool(p.active, true);
      return itemOne(c, id);
    }
    const r = itemClean(c, p);
    if (sameItem(c, r, id)) fail('An item with this name already exists in this category.');
    const next = { ...r, active: c.items[id].active !== false };
    await C.db.put('clinic/items/' + id, next);
    c.items[id] = next;
    return itemOne(c, id);
  }

  // ---------------------------------------------------------------- suppliers
  const supplierJson = s => ({ id: s.id, name: s.name, contactPerson: s.contactPerson || null, phone: s.phone || null,
    email: s.email || null, address: s.address || null, active: s.active !== false });
  async function suppliersList() {
    const c = await load(['suppliers']);
    const list = rows(c.suppliers).filter(s => s.active !== false).sort((a, b) => nameCmp(a.name, b.name));
    const counts = await Promise.all(list.map(s => txnsOfSupplier(s.id)
      .then(m => Object.values(m).filter(t => t.type === 'IN' && t.reason === 'PURCHASE').length)));
    return { suppliers: list.map((s, i) => ({ ...supplierJson(s), deliveries: counts[i] })) };
  }
  function supplierOne(c, id) { const s = c.suppliers[id]; if (!s) notFound('Supplier not found.'); return supplierJson({ ...s, id }); }
  async function supplierDetail(me, p) {
    const id = toInt(p.id, 'Supplier', 1);
    const [c, tx] = await Promise.all([load(['suppliers', 'items', 'batches', 'procedures', 'people']), txnsOfSupplier(id)]);
    return { supplier: supplierOne(c, id),
      defaultFor: rows(c.items).filter(i => i.supplierId === id && i.active !== false).map(i => i.name).sort(nameCmp),
      purchases: rows(tx).filter(t => t.type === 'IN' && t.reason === 'PURCHASE').sort(byDateDesc).slice(0, 100).map(t => txnJson(c, t)) };
  }
  function supplierClean(p) {
    const s = { email: optText(p, 'email', 120) };
    if (s.email && !s.email.includes('@')) fail('Enter a valid email address.');
    s.name = reqText(p, 'name', 'Supplier name');
    s.contactPerson = optText(p, 'contactPerson', 100); s.phone = optText(p, 'phone', 20); s.address = optText(p, 'address');
    for (const k of Object.keys(s)) if (s[k] === null) delete s[k];
    return s;
  }
  const sameSupplier = (c, name, exceptId) => rows(c.suppliers).some(s => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());
  async function supplierCreate(me, p) {
    requireAdmin(me);
    return stockSave(['suppliers'], (c, u, alloc) => {
      const s = supplierClean(p);
      if (sameSupplier(c, s.name)) fail('A supplier with this name already exists.');
      const id = alloc('suppliers');
      c.suppliers[id] = { ...s, active: true }; u['suppliers/' + id] = c.suppliers[id];
      return () => supplierOne(c, id);
    });
  }
  async function supplierUpdate(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Supplier', 1);
    const c = await load(['suppliers'], true);
    supplierOne(c, id);
    const keys = Object.keys(p).filter(k => k !== 'id');
    if (keys.length === 1 && keys[0] === 'active') {
      await C.db.patch('clinic', { [`suppliers/${id}/active`]: bool(p.active, true) });
      c.suppliers[id].active = bool(p.active, true);
      return supplierOne(c, id);
    }
    const s = supplierClean(p);
    if (sameSupplier(c, s.name, id)) fail('A supplier with this name already exists.');
    const next = { ...s, active: c.suppliers[id].active !== false };
    await C.db.put('clinic/suppliers/' + id, next);
    c.suppliers[id] = next;
    return supplierOne(c, id);
  }

  // ---------------------------------------------------------------- procedures
  async function proceduresListApi(me) { requireAdmin(me); return { procedures: proceduresList(await load(['procedures']), true) }; }
  async function procedureCreate(me, p) {
    requireAdmin(me);
    const n = reqText(p, 'name', 'Procedure name', 80);
    return stockSave(['procedures'], (c, u, alloc) => {
      if (rows(c.procedures).some(x => x.name.toLowerCase() === n.toLowerCase())) fail('That procedure already exists.');
      const id = alloc('procedures');
      u['procedures/' + id] = { name: n, active: true };
      return () => ({ id, name: n, active: true });
    });
  }
  async function procedureUpdate(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Procedure', 1);
    const c = await load(['procedures'], true);
    if (!c.procedures[id]) notFound('Procedure not found.');
    const u = {};
    if ('name' in p) {
      const n = reqText(p, 'name', 'Procedure name', 80);
      if (rows(c.procedures).some(x => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) fail('That procedure already exists.');
      u[`procedures/${id}/name`] = n; c.procedures[id].name = n;
    }
    if ('active' in p) { u[`procedures/${id}/active`] = bool(p.active, true); c.procedures[id].active = bool(p.active, true); }
    if (Object.keys(u).length) await C.db.patch('clinic', u);
    return { id, name: c.procedures[id].name, active: c.procedures[id].active !== false };
  }

  // ---------------------------------------------------------------- receive (stock in)
  function inHeader(c, p) {
    const supplierId = optId(p.supplierId);
    if (!supplierId) fail('Choose the supplier.');
    if (!c.suppliers[supplierId]) fail('Supplier not found.');
    const date = optDate(p.txnDate, 'Date received') || today();
    if (date > today()) fail('Date received cannot be in the future.');
    return { supplierId, date, invoiceNo: optText(p, 'invoiceNo', 50) };
  }
  function inLine(c, l, date) {
    const itemId = toInt(l.itemId, 'Item', 1);
    const it = c.items[itemId];
    if (!it || it.active === false) notFound('Item not found.');
    const batchNo = reqText(l, 'batchNo', 'Batch number', 50);
    const packs = toInt(l.quantity, 'Quantity', 1);
    let expiry = optDate(l.expiryDate, 'Expiry date');
    if (it.expires !== false && !expiry) fail('Expiry date is required for this item.');
    if (expiry && expiry < date) fail('Expiry date is before the date received.');
    if (expiry && expiry < today()) fail('This expiry date has already passed, so the stock could not be used. Check the date on the pack (day-month-year).');
    const cost = toMoney(l.unitCost, 'Cost per unit');
    if (it.expires === false) expiry = null;
    return { itemId, batchNo, qty: packs * (it.packSize || 1), expiry, cost };
  }
  function insertIn(c, u, me, alloc, l, h, group) {
    const bid = alloc('batches');
    const b = { itemId: l.itemId, batchNo: l.batchNo, qty: l.qty, cost: l.cost, received: h.date };
    if (l.expiry) b.expiry = l.expiry;
    c.batches[bid] = b; u['batches/' + bid] = b;
    return addTxn(c, u, me, alloc('txns'), { type: 'IN', reason: 'PURCHASE', batchId: bid, itemId: l.itemId, qty: l.qty,
      date: h.date, supplierId: h.supplierId, invoiceNo: h.invoiceNo, group });
  }
  const IN_NEEDS = ['items', 'batches', 'suppliers', 'procedures', 'people', 'settings'];
  async function stockIn(me, p) {
    return stockSave(IN_NEEDS, (c, u, alloc) => {
      const h = inHeader(c, p), l = inLine(c, p, h.date);
      const tid = insertIn(c, u, me, alloc, l, h, null);
      return () => ({ ...txnJson(c, { ...c.txns[tid], id: tid }), itemQtyNow: itemOne(c, l.itemId).qty });
    });
  }
  async function stockInInvoice(me, p) {
    return stockSave(IN_NEEDS, (c, u, alloc) => {
      const h = inHeader(c, p);
      if (!Array.isArray(p.lines) || !p.lines.length) fail('Add at least one item.');
      const errs = [], good = [];
      p.lines.forEach((line, n) => {
        try { good.push(inLine(c, line && typeof line === 'object' ? line : {}, h.date)); } catch (e) {
          if (e.status === 400 || e.status === 404) errs.push({ line: n + 1, error: e.message }); else throw e;
        }
      });
      if (errs.length) fail(`Line ${errs[0].line}: ${errs[0].error}`, { lines: errs });
      const group = newGroup();
      let total = 0;
      for (const l of good) { insertIn(c, u, me, alloc, l, h, group); total += l.qty * l.cost; }
      return () => ({ group, count: good.length, date: h.date, value: round2(total),
        lines: good.map(l => ({ itemId: l.itemId, name: c.items[l.itemId].name, unit: c.items[l.itemId].unit, qty: l.qty,
          batchNo: l.batchNo, qtyNow: itemOne(c, l.itemId).qty })) });
    });
  }

  // ---------------------------------------------------------------- stock out (one line)
  async function stockOut(me, p) {
    return stockSave(IN_NEEDS, (c, u, alloc) => {
      const reason = p.reason;
      if (!['PROCEDURE_USE', 'WASTAGE', 'EXPIRED'].includes(reason)) fail('Choose a reason: procedure use, wastage or expired.');
      const bid = toInt(p.batchId, 'Batch', 1), b = c.batches[bid];
      if (!b) notFound('Batch not found.');
      if (txt(p, 'itemId') !== null && toInt(p.itemId, 'Item', 1) !== b.itemId) fail('This batch belongs to a different item.');
      let pid = optId(p.procedureId);
      if (reason === 'PROCEDURE_USE') {
        if (!pid) fail('Choose the procedure.');
        if (!c.procedures[pid]) fail('Procedure not found.');
        if (b.expiry && b.expiry < today()) fail('This batch has expired. Record it as Expired instead.');
      } else pid = null;
      const qty = toInt(p.quantity, 'Quantity', 1);
      if (qty > b.qty) fail(`Only ${b.qty} left in this batch.`);
      const d = optDate(p.txnDate, 'Date') || today();
      setBatchQty(c, u, bid, b.qty - qty);
      const tid = addTxn(c, u, me, alloc('txns'), { type: 'OUT', reason, batchId: bid, itemId: b.itemId, qty, date: d,
        procedureId: pid, note: optText(p, 'note') });
      return () => txnJson(c, { ...c.txns[tid], id: tid });
    });
  }
  async function stockRecent(me, p) {
    let lim = parseInt(p.limit, 10);
    lim = Math.max(1, Math.min(Number.isNaN(lim) ? 10 : lim, 100));
    const typ = p.type;
    const [c, last] = await Promise.all([load(['items', 'batches', 'suppliers', 'procedures', 'people']),
      C.db.get('clinic/txns', { query: { orderBy: '$key', limitToLast: Math.max(80, lim * 4) } })]);
    return { entries: rows(asMap(last)).filter(t => !['IN', 'OUT'].includes(typ) || t.type === typ)
      .sort(byDateDesc).slice(0, lim).map(t => txnJson(c, t)) };
  }

  // ---------------------------------------------------------------- undo & corrections
  // History is never edited: an opposite "Correction" entry is added, and the reversal is recorded
  // once (Firebase refuses a second one).
  function reverse(c, u, me, alloc, t, notePrefix, group) {
    if (t.reason === 'CORRECTION') fail('A correction cannot be reversed again.');
    if (c.reversals[t.id]) fail('This entry has already been reversed.');
    const b = c.batches[t.batchId];
    if (t.type === 'OUT') setBatchQty(c, u, t.batchId, b.qty + t.qty);
    else {
      if (b.qty < t.qty) fail(`Part of this delivery has already been used, so it can't be ${group ? 'undone' : 'reversed'}.`);
      setBatchQty(c, u, t.batchId, b.qty - t.qty);
    }
    const id = addTxn(c, u, me, alloc('txns'), { type: t.type === 'OUT' ? 'IN' : 'OUT', reason: 'CORRECTION', batchId: t.batchId,
      itemId: t.itemId, qty: t.qty, date: today(), note: `${notePrefix} entry #${t.id}`, group });
    c.reversals[t.id] = id; u['reversals/' + t.id] = id;
    return id;
  }
  async function serverTime(me) {
    const r = await C.db.put(`clinic/clock/${me.key}`, TS);
    if (typeof r === 'number') C.setClockOffset(r - Date.now());
    return typeof r === 'number' ? r : C.serverNow();
  }
  async function stockUndo(me, p) {
    const id = toInt(p.id, 'Entry', 1);
    const now = await serverTime(me);
    return stockSave(IN_NEEDS.concat('reversals'), async (c, u, alloc) => {
      const t = await C.db.get('clinic/txns/' + id, { fresh: true });
      if (!t) notFound('Entry not found.');
      if (t.by !== me.key) fail('Only the person who saved this entry can undo it.');
      if (now - t.at > 60e3) fail('Too late to undo. Ask the Admin to correct it.');
      const nid = reverse(c, u, me, alloc, { ...t, id }, 'Undo of', null);
      return () => txnJson(c, { ...c.txns[nid], id: nid });
    });
  }
  async function stockCorrect(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Entry', 1);
    return stockSave(IN_NEEDS.concat('reversals'), async (c, u, alloc) => {
      const t = await C.db.get('clinic/txns/' + id, { fresh: true });
      if (!t) notFound('Entry not found.');
      const nid = reverse(c, u, me, alloc, { ...t, id }, 'Correction of', null);
      return () => txnJson(c, { ...c.txns[nid], id: nid });
    });
  }

  // ---------------------------------------------------------------- procedure use / general use
  async function useRecord(me, p) {
    return stockSave(IN_NEEDS.concat('flags'), (c, u, alloc) => {
      const reason = p.reason || 'PROCEDURE_USE';
      if (!['PROCEDURE_USE', 'ISSUE'].includes(reason)) fail('Unknown kind of entry.');
      let pid = optId(p.procedureId);
      if (reason === 'PROCEDURE_USE') {
        if (!pid) fail('Choose the procedure.');
        if (!c.procedures[pid]) fail('Procedure not found.');
      } else pid = null;
      const d = optDate(p.txnDate, 'Date') || today();
      if (d > today()) fail('The date cannot be in the future.');
      if (!Array.isArray(p.lines) || !p.lines.length) fail('Add at least one item.');
      const seen = new Set(), lines = [], short = [];
      for (const line of p.lines) {
        if (!line || typeof line !== 'object') fail('Bad line.');
        const iid = toInt(line.itemId, 'Item', 1), q = toInt(line.qty, 'Quantity', 0);
        if (q === 0) continue;
        if (seen.has(iid)) fail('The same item is listed twice. Combine the quantities.');
        seen.add(iid);
        const it = c.items[iid];
        if (!it || it.active === false) notFound('Item not found.');
        const have = usable(c, iid).reduce((s, b) => s + b.qty, 0);
        const anyway = bool(line.usedAnyway, false);
        lines.push({ itemId: iid, name: it.name, unit: it.unit, qty: q, have });
        if (q > have && !anyway) short.push({ itemId: iid, name: it.name, unit: it.unit, have, want: q });
      }
      if (!lines.length) fail('All quantities are 0. Nothing to save.');
      if (short.length) {
        fail(`Only ${short[0].have} ${short[0].unit} of ${short[0].name} on record. If it was really used, tick 'Used anyway' and the difference will be flagged for a stock check.`, { short });
      }
      const group = newGroup(), note = optText(p, 'note'), saved = [], flags = [];
      for (const l of lines) {
        const missing = Math.max(0, l.qty - l.have);
        let left = l.qty - missing, taken = 0;
        for (const b of usable(c, l.itemId)) {
          if (!left) break;
          const take = Math.min(left, b.qty);
          setBatchQty(c, u, b.id, b.qty - take);
          addTxn(c, u, me, alloc('txns'), { type: 'OUT', reason, batchId: b.id, itemId: l.itemId, qty: take, date: d,
            procedureId: pid, note, group });
          left -= take; taken += take;
        }
        if (missing > 0) {
          const f = { itemId: l.itemId, qty: missing, date: d, group, by: me.key, at: TS };
          if (pid) f.procedureId = pid;
          u['flags/' + alloc('flags')] = f;
          flags.push({ name: l.name, qty: missing, unit: l.unit });
        }
        saved.push({ itemId: l.itemId, name: l.name, unit: l.unit, qty: l.qty, recorded: taken });
      }
      return () => ({ group, lines: saved, flags, date: d });
    });
  }
  // Undo a whole saved entry (a procedure, a general use, or an invoice): same person, within 2 minutes.
  async function useUndo(me, p) {
    const g = txt(p, 'group');
    const now = await serverTime(me);
    return stockSave(IN_NEEDS.concat('reversals', 'flags'), async (c, u, alloc) => {
      const tx = rows(await txnsOfGroup(g || '-'));
      const own = tx.filter(t => t.reason !== 'CORRECTION');
      const flags = rows(c.flags).filter(f => f.group === g);
      const first = own[0] || flags[0];
      if (!g || !first) notFound('Entry not found.');
      if (first.by !== me.key) fail('Only the person who saved this entry can undo it.');
      if (now - first.at > 120e3) fail('Too late to undo. Ask the Admin to correct it.');
      if (tx.some(t => t.reason === 'CORRECTION')) fail('This entry has already been undone.');
      for (const t of own.sort((a, b) => a.id - b.id)) reverse(c, u, me, alloc, t, 'Undo of', g);
      for (const f of flags) if (!f.resolvedAt) u['flags/' + f.id] = null;
      return () => ({ ok: true });
    });
  }

  // ---------------------------------------------------------------- stock flags
  function openFlags(c) {
    return rows(c.flags).filter(f => !f.resolvedAt && c.items[f.itemId]).sort(byDateDesc).map(f => ({ id: f.id, itemId: f.itemId,
      itemName: c.items[f.itemId].name, unit: c.items[f.itemId].unit, qty: f.qty, date: f.date,
      procedureName: f.procedureId && c.procedures[f.procedureId] ? c.procedures[f.procedureId].name : null, userName: personName(c, f.by) }));
  }
  async function flagsList() { return { flags: openFlags(await load(['flags', 'items', 'procedures', 'people'])) }; }
  async function flagResolve(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Flag', 1);
    const f = await C.db.get('clinic/flags/' + id, { fresh: true });
    if (!f || f.resolvedAt) notFound('This flag is already cleared.');
    await C.db.patch('clinic/flags/' + id, { resolvedAt: TS, resolvedBy: me.key, resolution: (txt(p, 'resolution') || 'Checked').slice(0, 120) });
    return { ok: true };
  }

  // ---------------------------------------------------------------- kits
  function kitsAll(c) {
    return rows(c.procedures).filter(pr => pr.active !== false).sort((a, b) => nameCmp(a.name, b.name)).map(pr => ({
      procedureId: pr.id, procedure: pr.name,
      lines: Object.entries(c.kits[pr.id] || {}).map(([iid, q]) => [c.items[iid], Number(iid), q])
        .filter(([i]) => i && i.active !== false).sort((a, b) => nameCmp(a[0].name, b[0].name))
        .map(([i, iid, q]) => ({ itemId: iid, name: i.name, unit: i.unit, qty: q, bulk: i.mode === 'BULK' })) }));
  }
  async function kitsList() { return { kits: kitsAll(await load(['procedures', 'kits', 'items'])) }; }
  async function kitSave(me, p) {
    requireAdmin(me);
    const pid = toInt(p.id, 'Procedure', 1);
    const c = await load(['procedures', 'kits', 'items'], true);
    if (!c.procedures[pid]) notFound('Procedure not found.');
    const kit = {};
    for (const line of Array.isArray(p.lines) ? p.lines : []) {
      const iid = toInt(line.itemId, 'Item', 1), q = toInt(line.qty, 'Quantity', 1);
      if (kit[iid]) fail('An item is listed twice in this kit.');
      if (!c.items[iid] || c.items[iid].active === false) notFound('Item not found.');
      kit[iid] = q;
    }
    await C.db.put('clinic/kits/' + pid, Object.keys(kit).length ? kit : null);
    c.kits[pid] = kit;
    return kitsAll(c).find(k => k.procedureId === pid);
  }

  // ---------------------------------------------------------------- stock count
  async function countSave(me, p) {
    requireAdmin(me);
    return stockSave(IN_NEEDS.concat('flags'), (c, u, alloc) => {
      const d = optDate(p.countDate, 'Count date') || today();
      if (d > today()) fail('The count date cannot be in the future.');
      const lines = Array.isArray(p.lines) ? p.lines : [];
      if (!lines.some(x => x && x.counted !== null && x.counted !== undefined && String(x.counted) !== '')) fail('Enter at least one counted quantity.');
      const cid = alloc('counts'), note = `Stock count #${cid}`, seen = new Set(), out = {};
      let changed = 0, vdiff = 0, n = 0;
      const vi = vItems(c);
      for (const line of lines) {
        if (line.counted === null || line.counted === undefined || String(line.counted) === '') continue;
        const iid = toInt(line.itemId, 'Item', 1), counted = toInt(line.counted, 'Counted quantity', 0);
        if (seen.has(iid)) continue;
        seen.add(iid);
        if (!vi[iid]) notFound('Item not found.');
        const sys = vi[iid].qty, cost = vi[iid].lastCost || 0;
        out[iid] = { system: sys, counted, cost };
        n++;
        const diff = counted - sys;
        if (diff) { changed++; vdiff += diff * cost; }
        if (diff < 0) {
          let left = -diff;
          for (const b of usable(c, iid)) {
            if (!left) break;
            const take = Math.min(left, b.qty);
            setBatchQty(c, u, b.id, b.qty - take);
            addTxn(c, u, me, alloc('txns'), { type: 'OUT', reason: 'COUNT', batchId: b.id, itemId: iid, qty: take, date: d, note });
            left -= take;
          }
        } else if (diff > 0) {
          const list = usable(c, iid);
          let target = list.length ? list.slice().sort((a, b) => (!b.expiry) - (!a.expiry) || (a.expiry < b.expiry ? 1 : a.expiry > b.expiry ? -1 : 0) || b.id - a.id)[0].id : null;
          if (!target) {
            target = alloc('batches');
            c.batches[target] = { itemId: iid, batchNo: 'COUNT-' + d, qty: 0, cost, received: d };
            u['batches/' + target] = c.batches[target];
          }
          setBatchQty(c, u, target, c.batches[target].qty + diff);
          addTxn(c, u, me, alloc('txns'), { type: 'IN', reason: 'COUNT', batchId: target, itemId: iid, qty: diff, date: d, note });
        }
        for (const f of rows(c.flags)) {
          if (f.itemId === iid && !f.resolvedAt) Object.assign(u, { [`flags/${f.id}/resolvedAt`]: TS, [`flags/${f.id}/resolvedBy`]: me.key, [`flags/${f.id}/resolution`]: note });
        }
      }
      const rec = { date: d, by: me.key, at: TS, lines: out };
      if (optText(p, 'note')) rec.note = optText(p, 'note');
      u['counts/' + cid] = rec;
      return () => ({ id: cid, itemsCounted: n, itemsChanged: changed, valueDifference: round2(vdiff) });
    });
  }
  function countSummary(c, id, x) {
    const lines = Object.values(asMap(x.lines));
    return { id, date: x.date, note: x.note || null, userName: personName(c, x.by), itemsCounted: lines.length,
      itemsChanged: lines.filter(l => l.counted !== l.system).length,
      valueDifference: round2(lines.reduce((s, l) => s + (l.counted - l.system) * (l.cost || 0), 0)) };
  }
  async function countsList(me) {
    requireAdmin(me);
    const c = await load(['counts', 'people']);
    return { counts: rows(c.counts).sort(byDateDesc).slice(0, 24).map(x => countSummary(c, x.id, x)) };
  }
  async function countDetail(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Count', 1);
    const c = await load(['counts', 'people', 'items']);
    const x = c.counts[id];
    if (!x) notFound('Count not found.');
    return { id, date: x.date, note: x.note || null, userName: personName(c, x.by),
      lines: Object.entries(asMap(x.lines)).map(([iid, l]) => ({ itemId: Number(iid), name: (c.items[iid] || {}).name || '?',
        unit: (c.items[iid] || {}).unit || '', system: l.system, counted: l.counted, diff: l.counted - l.system,
        valueDiff: round2((l.counted - l.system) * (l.cost || 0)) }))
        .sort((a, b) => (a.counted === a.system) - (b.counted === b.system) || nameCmp(a.name, b.name)) };
  }

  // ---------------------------------------------------------------- Excel import
  const IMP_KEYS = { itemname: 'name', name: 'name', item: 'name', category: 'category', unit: 'unit', packsize: 'packSize',
    minimumstock: 'minStock', minstock: 'minStock', min: 'minStock', minimum: 'minStock', expiresyn: 'expires', expires: 'expires',
    bulkconsumableyn: 'bulk', bulk: 'bulk', supplier: 'supplier', openingquantity: 'openingQty', openingqty: 'openingQty',
    qty: 'openingQty', quantity: 'openingQty', openingstock: 'openingQty', batchno: 'batchNo', batch: 'batchNo',
    expirydate: 'expiryDate', expiry: 'expiryDate', costperunitrs: 'unitCost', unitcost: 'unitCost', cost: 'unitCost',
    rate: 'unitCost', price: 'unitCost' };
  const impMatch = (v, opts) => { const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
    return opts.find(o => [o.toLowerCase(), o.toLowerCase() + 's', o.toLowerCase() + 'es'].includes(s)) || null; };
  const blank = v => v === null || v === undefined || String(v).trim() === '';
  function impNum(v, label, min, whole, errs) {
    if (blank(v)) return null;
    const s = String(v).trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) { errs.push(label + ' is not a number'); return null; }
    const n = Number(s);
    if (whole && n !== Math.trunc(n)) { errs.push(label + ' must be a whole number'); return null; }
    if (n < min) { errs.push(`${label} cannot be below ${min}`); return null; }
    return n;
  }
  function impDate(v, errs) {
    if (blank(v)) return null;
    if (typeof v === 'number') {                          // an Excel date cell: days since 30-12-1899
      if (v > 20000 && v < 80000) return addDays('1899-12-30', Math.trunc(v));
      errs.push('Expiry date not understood (use DD-MM-YYYY)'); return null;
    }
    const s = String(v).trim().slice(0, 10);
    let y, m, d, x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (x) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
    else {
      x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);              // Indian style: day first
      if (!x) { errs.push('Expiry date not understood (use DD-MM-YYYY)'); return null; }
      [d, m, y] = [Number(x[1]), Number(x[2]), x[3].length === 2 ? 2000 + Number(x[3]) : Number(x[3])];
    }
    const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (m < 1 || m > 12 || dt.toISOString().slice(0, 10) !== iso) { errs.push('Expiry date is not a real date'); return null; }
    return iso;
  }
  async function importItems(me, p) {
    requireAdmin(me);
    const checkOnly = bool(p.checkOnly, true);
    return stockSave(['items', 'suppliers', 'batches'], (c, u, alloc) => {
      const results = [], plan = [], seen = new Set();
      let n = 1;
      for (const raw of (Array.isArray(p.rows) ? p.rows : []).slice(0, 2000)) {
        n++;                                                               // row 1 is the header in Excel
        const r = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw)) { const key = IMP_KEYS[String(k).toLowerCase().replace(/[^a-z]/g, '')]; if (key) r[key] = v; }
        }
        const name = String(r.name === null || r.name === undefined ? '' : r.name).trim();
        if (!name && Object.values(r).every(blank)) continue;              // blank line
        const errs = [], notes = [];
        if (!name) errs.push('Item name is missing');
        let cat = impMatch(r.category, CATEGORIES);
        if (!cat) { if (!blank(r.category)) notes.push(`Category '${r.category}' not known, using General Consumables`); cat = 'General Consumables'; }
        const unit = impMatch(r.unit, UNITS);
        if (!unit) errs.push(`Unit '${r.unit === null || r.unit === undefined ? '' : r.unit}' not known (use: ${UNITS.join(', ')})`);
        let pack = impNum(r.packSize, 'Pack size', 1, true, errs), min = impNum(r.minStock, 'Minimum stock', 0, true, errs);
        const expires = blank(r.expires) ? true : ['y', 'yes', 'true', '1'].includes(String(r.expires).trim().toLowerCase());
        const bulk = blank(r.bulk) ? false : ['y', 'yes', 'true', '1'].includes(String(r.bulk).trim().toLowerCase());
        let qty = impNum(r.openingQty, 'Opening quantity', 0, true, errs), cost = impNum(r.unitCost, 'Cost per unit', 0, false, errs);
        const expiry = impDate(r.expiryDate, errs);
        pack = pack === null ? 1 : pack; min = min === null ? 0 : min; qty = qty === null ? 0 : qty; cost = cost === null ? 0 : cost;
        const supplier = String(r.supplier === null || r.supplier === undefined ? '' : r.supplier).trim();
        if (qty > 0 && expires && !expiry) errs.push('Expiry date is needed for opening stock of an item that expires');
        if (expiry && expiry < today()) errs.push('Expiry date has already passed');
        const key = name.toLowerCase() + '|' + cat;
        if (name && seen.has(key)) errs.push('Same item appears twice in the file');
        seen.add(key);
        const existing = rows(c.items).find(i => i.name.toLowerCase() === name.toLowerCase() && i.category === cat);
        const action = [existing ? 'item already exists' : 'new item'];
        if (qty > 0) action.push(`opening stock ${qty} ${unit || ''}`.trim());
        if (supplier && !rows(c.suppliers).some(s => s.name.toLowerCase() === supplier.toLowerCase())) action.push(`new supplier '${supplier}'`);
        results.push({ row: n, name, status: errs.length ? 'error' : notes.length ? 'note' : 'ok', messages: errs.concat(notes), action: action.join(', ') });
        if (!errs.length) plan.push({ name, cat, unit, pack, min, expires, bulk, qty, cost, expiry, supplier, itemId: existing ? existing.id : null,
          batch: String(r.batchNo === null || r.batchNo === undefined ? '' : r.batchNo).trim().slice(0, 50) || 'OPENING' });
      }
      const summary = { rows: results.length, ok: plan.length, errors: results.filter(x => x.status === 'error').length,
        newItems: plan.filter(x => !x.itemId).length, withStock: plan.filter(x => x.qty > 0).length };
      if (checkOnly || !plan.length) return () => ({ checkOnly: true, results, summary });
      for (const pl of plan) {
        let sid = null;
        if (pl.supplier) {
          const s = rows(c.suppliers).find(x => x.name.toLowerCase() === pl.supplier.toLowerCase());
          if (s) sid = s.id;
          else { sid = alloc('suppliers'); c.suppliers[sid] = { name: pl.supplier, active: true }; u['suppliers/' + sid] = c.suppliers[sid]; }
        }
        let iid = pl.itemId;
        if (!iid) {
          iid = alloc('items');
          c.items[iid] = { name: pl.name, category: pl.cat, unit: pl.unit, packSize: pl.pack, minStock: pl.min, expires: pl.expires,
            mode: pl.bulk ? 'BULK' : 'PROCEDURE', active: true };
          if (sid) c.items[iid].supplierId = sid;
          u['items/' + iid] = c.items[iid];
        }
        if (pl.qty > 0) {
          const bid = alloc('batches');
          const b = { itemId: iid, batchNo: pl.batch, qty: pl.qty, cost: round2(pl.cost), received: today() };
          if (pl.expires && pl.expiry) b.expiry = pl.expiry;
          c.batches[bid] = b; u['batches/' + bid] = b;
          addTxn(c, u, me, alloc('txns'), { type: 'IN', reason: 'OPENING', batchId: bid, itemId: iid, qty: pl.qty, date: today(),
            supplierId: sid, note: 'Excel import' });
        }
      }
      return () => ({ checkOnly: false, results, summary });
    });
  }

  // ---------------------------------------------------------------- reorder list
  const suggestedPacks = (qty, min, pack) => Math.max(1, Math.ceil(Math.max(min * 2 - qty, min, 1) / pack));
  function whatsappNumber(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    if (d.length === 10) d = '91' + d;
    return d.length >= 11 && d.length <= 15 ? d : null;
  }
  const urlencode = t => Array.from(new TextEncoder().encode(t)).map(b => (/[A-Za-z0-9_.~-]/.test(String.fromCharCode(b)) && b < 128
    ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
  function reorderState(c) {
    const vi = vItems(c);
    const lines = rows(c.reorder).filter(r => vi[r.id] && vi[r.id].active !== false).sort((a, b) => (a.at || 0) - (b.at || 0));
    const groups = {};
    for (const r of lines) {
      const v = vi[r.id], sid = v.supplierId || null;
      (groups[sid] || (groups[sid] = [])).push({ itemId: v.id, name: v.name, unit: v.unit, packSize: v.packSize, packs: r.packs,
        packLabel: v.packSize > 1 ? 'pack' : v.unit, inStock: v.qty, min: v.minStock || 0, status: itemStatus(v), addedBy: personName(c, r.by) });
    }
    const out = Object.entries(groups).map(([sid, ls]) => {
      const s = sid !== 'null' ? c.suppliers[sid] : null;
      const msg = (s && s.contactPerson ? `Hello ${s.contactPerson},` : 'Hello,') + `\nOrder from ${clinicName(c)}:\n\n` +
        ls.map((x, i) => `${i + 1}. ${x.name} – ${x.packs} ${x.packLabel}`).join('\n') + '\n\nPlease confirm availability and delivery date. Thank you.';
      const num = whatsappNumber(s && s.phone);
      return { supplierId: s ? Number(sid) : null, supplierName: s ? s.name : 'No supplier set', contact: s ? s.contactPerson || null : null,
        phone: s ? s.phone || null : null, lines: ls, message: msg, whatsapp: 'https://wa.me/' + (num || '') + '?text=' + urlencode(msg), hasNumber: !!num };
    }).sort((a, b) => a.supplierName.localeCompare(b.supplierName));
    const sugg = Object.values(vi).filter(v => v.active !== false && ['LOW', 'OUT'].includes(itemStatus(v)) && !c.reorder[v.id])
      .sort((a, b) => nameCmp(a.name, b.name)).map(v => ({ itemId: v.id, name: v.name, unit: v.unit, qty: v.qty, min: v.minStock || 0,
        status: itemStatus(v), supplierName: v.supplierName, packs: suggestedPacks(v.qty, v.minStock || 0, v.packSize || 1),
        packLabel: v.packSize > 1 ? 'pack' : v.unit, packSize: v.packSize }));
    return { groups: out, suggestions: sugg, itemIds: lines.map(r => r.id).sort((a, b) => a - b) };
  }
  const REORDER_NEEDS = ['reorder', 'items', 'batches', 'suppliers', 'people', 'settings'];
  async function reorderList() { return reorderState(await load(REORDER_NEEDS)); }
  async function reorderSet(me, p) {
    requireAdmin(me);
    const id = toInt(p.id, 'Item', 1);
    const c = await load(REORDER_NEEDS, true);
    const v = vItems(c)[id];
    if (!v || v.active === false) notFound('Item not found.');
    const packs = txt(p, 'packs') === null ? suggestedPacks(v.qty, v.minStock || 0, v.packSize || 1) : toInt(p.packs, 'Packs', 1);
    if (c.reorder[id]) await C.db.patch('clinic', { [`reorder/${id}/packs`]: packs });
    else await C.db.put('clinic/reorder/' + id, { packs, by: me.key, at: TS });
    return reorderList();
  }
  async function reorderRemove(me, p) {
    requireAdmin(me);
    await C.db.del('clinic/reorder/' + toInt(p.id, 'Item', 1));
    return reorderList();
  }
  async function reorderOrdered(me, p) {
    requireAdmin(me);
    const sid = optId(p.supplierId);
    const c = await load(['reorder', 'items'], true);
    const u = {};
    for (const r of rows(c.reorder)) if ((c.items[r.id] && c.items[r.id].supplierId || null) === sid) u['reorder/' + r.id] = null;
    if (Object.keys(u).length) await C.db.patch('clinic', u);
    return reorderList();
  }

  // ---------------------------------------------------------------- alerts & dashboard
  function batchAlerts(c, expired) {
    const t = today(), near = addDays(t, nearDays(c));
    return rows(c.batches).filter(b => c.items[b.itemId] && c.items[b.itemId].active !== false && b.qty > 0 && b.expiry &&
      (expired ? b.expiry < t : b.expiry >= t && b.expiry <= near)).sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
      .map(b => ({ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiry, qty: b.qty, itemId: b.itemId,
        itemName: c.items[b.itemId].name, unit: c.items[b.itemId].unit, daysLeft: diffDays(b.expiry, t) }));
  }
  const ALERT_NEEDS = ['items', 'batches', 'suppliers', 'settings', 'flags', 'procedures', 'people'];
  function alertLists(c) {
    const items = itemsList(c, false);
    return { low: items.filter(x => x.status === 'LOW'), out: items.filter(x => x.qty === 0), nearExpiry: batchAlerts(c, false),
      expired: batchAlerts(c, true), totalItems: items.length, flags: openFlags(c) };
  }
  const alertCounts = a => ({ totalItems: a.totalItems, low: a.low.length, out: a.out.length, nearExpiry: a.nearExpiry.length,
    expired: a.expired.length, flags: a.flags.length });
  async function alertCountsApi() { return alertCounts(alertLists(await load(ALERT_NEEDS))); }
  async function alertList(me, p) {
    const k = { low: 'low', out: 'out', 'near-expiry': 'nearExpiry', expired: 'expired' }[p.kind];
    if (!k) notFound('Unknown alert list.');
    return { rows: alertLists(await load(ALERT_NEEDS))[k] };
  }
  const USE_REASONS = ['PROCEDURE_USE', 'ISSUE', 'WASTAGE'];
  function topUsed(c, tx, s, e, lim) {
    const by = {};
    for (const t of tx) if (t.type === 'OUT' && USE_REASONS.includes(t.reason) && t.date >= s && t.date <= e) by[t.itemId] = (by[t.itemId] || 0) + t.qty;
    return Object.entries(by).filter(([iid]) => c.items[iid]).sort((a, b) => b[1] - a[1]).slice(0, lim)
      .map(([iid, q]) => ({ itemId: Number(iid), name: c.items[iid].name, unit: c.items[iid].unit, qty: q }));
  }
  async function dashboard(me) {
    const t = today();
    const [c, tx, recent] = await Promise.all([load(ALERT_NEEDS), txnsBetween(addDays(t, -30), t), stockRecent(me, { limit: 10 })]);
    const a = alertLists(c);
    return { counts: alertCounts(a), alerts: { low: a.low, out: a.out, nearExpiry: a.nearExpiry, expired: a.expired, flags: a.flags },
      topUsed: topUsed(c, rows(tx), addDays(t, -30), t, 5), recent: recent.entries };
  }
  const costOf = (c, t) => t.qty * ((c.batches[t.batchId] || {}).cost || 0);
  function movement(c, tx, days, s, e, item) {
    const step = days === 90 ? 7 : 1, buckets = [];
    for (let d = s; d <= e; d = addDays(d, step)) {
      const end = addDays(d, step - 1) < e ? addDays(d, step - 1) : e;
      buckets.push({ start: d, end, received: 0, used: 0, receivedQty: 0, usedQty: 0, receivedEntries: 0, usedEntries: 0 });
    }
    for (const t of tx) {
      if (t.date < s || t.date > e || t.reason === 'CORRECTION') continue;
      if (!((t.type === 'IN' && t.reason === 'PURCHASE') || ['PROCEDURE_USE', 'ISSUE', 'WASTAGE', 'EXPIRED'].includes(t.reason))) continue;
      if (item && t.itemId !== item) continue;
      const bk = buckets[Math.floor(diffDays(t.date, s) / step)];
      if (!bk) continue;
      if (t.type === 'IN') { bk.received += costOf(c, t); bk.receivedQty += t.qty; bk.receivedEntries++; } else { bk.used += costOf(c, t); bk.usedQty += t.qty; bk.usedEntries++; }
    }
    buckets.forEach(b => { b.received = round2(b.received); b.used = round2(b.used); });
    return { step: days === 90 ? 'week' : 'day', buckets };
  }
  function topItems(c, tx, lim, byQty) {
    const by = {};
    for (const t of tx) {
      if (t.type !== 'OUT' || !USE_REASONS.includes(t.reason) || !c.items[t.itemId]) continue;
      const x = by[t.itemId] || (by[t.itemId] = { qty: 0, value: 0, entries: 0 });
      x.qty += t.qty; x.value += costOf(c, t); x.entries++;
    }
    return Object.entries(by).sort((a, b) => (byQty ? b[1].qty - a[1].qty : b[1].value - a[1].value)).slice(0, lim)
      .map(([iid, x]) => ({ itemId: Number(iid), name: c.items[iid].name, unit: c.items[iid].unit, qty: x.qty, value: round2(x.value), entries: x.entries }));
  }
  async function dashboardCharts(me, p) {
    const d = ['7', '30', '90'].includes(String(p.days)) ? Number(p.days) : 30;
    const e = today(), s = addDays(e, -(d - 1)), pe = addDays(s, -1), ps = addDays(pe, -(d - 1));
    const [c, all] = await Promise.all([load(['items', 'batches', 'suppliers', 'settings', 'procedures']), txnsBetween(ps, e)]);
    const tx = rows(all), cur = tx.filter(t => t.date >= s), prevT = tx.filter(t => t.date <= pe);
    const sum = (list, f) => round2(list.filter(f).reduce((x, t) => x + costOf(c, t), 0));
    const isUse = t => t.type === 'OUT' && USE_REASONS.includes(t.reason);
    const used = sum(cur, isUse), prev = sum(prevT, isUse);
    const rec = cur.filter(t => t.type === 'IN' && t.reason === 'PURCHASE');
    const topQty = topItems(c, cur, 10, true);
    const pick = id => (c.items[id] ? { id: Number(id), name: c.items[id].name, unit: c.items[id].unit } : null);
    let item = /^\d+$/.test(String(p.item || '')) ? pick(Number(p.item)) : null;
    if (!item && topQty.length) item = pick(topQty[0].itemId);
    const vi = vItems(c), active = Object.values(vi).filter(v => v.active !== false);
    const goodBatch = b => c.items[b.itemId] && c.items[b.itemId].active !== false && (!b.expiry || b.expiry >= e);
    const bl = rows(c.batches);
    const byCat = {}, byProc = {};
    for (const t of cur.filter(isUse)) {
      const cat = (c.items[t.itemId] || {}).category;
      const x = byCat[cat] || (byCat[cat] = { value: 0, entries: 0 }); x.value += costOf(c, t); x.entries++;
      if (t.reason === 'PROCEDURE_USE' && t.procedureId && c.procedures[t.procedureId]) {
        const y = byProc[t.procedureId] || (byProc[t.procedureId] = { value: 0, groups: new Set() });
        y.value += costOf(c, t); y.groups.add(t.group || 'id' + t.id);
      }
    }
    const statusCount = {};
    active.forEach(v => { const st = itemStatus(v); statusCount[st] = (statusCount[st] || 0) + 1; });
    const exp = [0, 15, 30, 45, 60, 75].map(f => ({ from: f, to: f + 14, value: 0, batches: 0, contents: [] }));
    bl.filter(b => c.items[b.itemId] && c.items[b.itemId].active !== false && b.qty > 0 && b.expiry && b.expiry >= e && b.expiry <= addDays(e, 90))
      .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.id - b.id))
      .forEach(b => { const w = exp[Math.min(Math.floor(diffDays(b.expiry, e) / 15), 5)]; w.value += b.qty * (b.cost || 0); w.batches++;
        w.contents.push(`${b.qty} ${c.items[b.itemId].unit} ${c.items[b.itemId].name}`); });
    exp.forEach(w => { w.value = round2(w.value); });
    return {
      period: { days: d, start: s, end: e },
      kpis: { stockValue: round2(bl.filter(goodBatch).reduce((x, b) => x + b.qty * (b.cost || 0), 0)),
        usedValue: used, usedEntries: cur.filter(isUse).length, prevUsedValue: prev, receivedValue: round2(rec.reduce((x, t) => x + costOf(c, t), 0)),
        receivedEntries: rec.length, wastedValue: sum(cur, t => t.type === 'OUT' && ['WASTAGE', 'EXPIRED'].includes(t.reason)),
        itemsWithStock: new Set(bl.filter(b => goodBatch(b) && b.qty > 0).map(b => b.itemId)).size,
        batchesInStock: bl.filter(b => goodBatch(b) && b.qty > 0).length },
      movement: movement(c, cur, d, s, e, null), movementItem: item,
      movementForItem: item ? movement(c, cur, d, s, e, item.id) : null,
      byCategory: Object.entries(byCat).map(([k, x]) => ({ category: k, value: round2(x.value), entries: x.entries })).sort((a, b) => b.value - a.value),
      topItems: topItems(c, cur, 10, false), topItemsQty: topQty,
      byProcedure: Object.entries(byProc).map(([k, x]) => ({ procedure: c.procedures[k].name, value: round2(x.value), entries: x.groups.size }))
        .sort((a, b) => b.value - a.value),
      statusMix: ['IN_STOCK', 'LOW', 'NEAR_EXPIRY', 'OUT', 'EXPIRED'].map(st => ({ status: st, count: statusCount[st] || 0 })),
      expiry: exp };
  }

  // ---------------------------------------------------------------- reports
  async function report(me, p) {
    const kind = p.kind;
    if (!['stock', 'history', 'usage', 'purchases', 'expiry'].includes(kind)) notFound('Unknown report.');
    let s, e;
    if (['history', 'usage', 'purchases'].includes(kind)) {
      s = optDate(p.from, 'From date') || addDays(today(), -90);
      e = optDate(p.to, 'To date') || today();
      if (s > e) fail("'From' date is after 'To' date.");
    }
    const c = await load(['items', 'batches', 'suppliers', 'settings', 'procedures', 'people']);
    const t = today();
    if (kind === 'stock') {
      const value = {};
      for (const b of rows(c.batches)) if (!b.expiry || b.expiry >= t) value[b.itemId] = (value[b.itemId] || 0) + b.qty * (b.cost || 0);
      return { title: 'Current stock', columns: ['Item', 'Category', 'Quantity', 'Minimum', 'Value (₹)', 'Status'], statusColumn: 5,
        rows: Object.values(vItems(c)).filter(v => v.active !== false).sort((a, b) => nameCmp(a.name, b.name)).map(v => [v.name, v.category,
          `${v.qty} ${v.unit}`, v.minStock || 0,
          round2(value[v.id] || 0),
          itemStatus(v)]) };
    }
    if (kind === 'expiry') {
      return { title: 'Expiry', columns: ['Item', 'Batch', 'Expiry', 'Qty', 'Status'], statusColumn: 4,
        rows: rows(c.batches).filter(b => c.items[b.itemId] && c.items[b.itemId].active !== false && b.qty > 0 && b.expiry && b.expiry <= addDays(t, nearDays(c)))
          .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
          .map(b => [c.items[b.itemId].name, b.batchNo, b.expiry, `${b.qty} ${c.items[b.itemId].unit}`, b.expiry < t ? 'EXPIRED' : 'NEAR_EXPIRY']) };
    }
    const tx = rows(await txnsBetween(s, e)).filter(x => c.items[x.itemId]);
    const unit = x => c.items[x.itemId].unit;
    if (kind === 'history') {
      return { title: 'Stock history', columns: ['Date', 'Type', 'Item', 'Batch', 'Qty', 'Reason', 'Procedure / supplier', 'By'],
        rows: tx.sort(byDateDesc).map(x => [x.date, x.type, c.items[x.itemId].name, (c.batches[x.batchId] || {}).batchNo || '',
          `${x.qty} ${unit(x)}`, REASON_LABEL[x.reason], (x.procedureId && c.procedures[x.procedureId] ? c.procedures[x.procedureId].name : null) ||
          (x.supplierId && c.suppliers[x.supplierId] ? c.suppliers[x.supplierId].name : ''), personName(c, x.by)]) };
    }
    if (kind === 'usage') {
      const g = {};
      for (const x of tx) {
        if (x.type !== 'OUT' || x.reason !== 'PROCEDURE_USE' || !x.procedureId || !c.procedures[x.procedureId]) continue;
        const k = x.procedureId + '|' + x.itemId, r = g[k] || (g[k] = { pr: c.procedures[x.procedureId].name, x, qty: 0, n: 0 });
        r.qty += x.qty; r.n++;
      }
      return { title: 'Usage by procedure', columns: ['Procedure', 'Item', 'Quantity used', 'Entries'],
        rows: Object.values(g).sort((a, b) => nameCmp(a.pr, b.pr) || b.qty - a.qty)
          .map(r => [r.pr, c.items[r.x.itemId].name, `${r.qty} ${unit(r.x)}`, r.n]) };
    }
    return { title: 'Purchases', columns: ['Date', 'Supplier', 'Invoice', 'Item', 'Qty', 'Amount (₹)'],
      rows: tx.filter(x => x.type === 'IN' && x.reason === 'PURCHASE').sort(byDateDesc).map(x => [x.date,
        x.supplierId && c.suppliers[x.supplierId] ? c.suppliers[x.supplierId].name : '', x.invoiceNo || '', c.items[x.itemId].name,
        `${x.qty} ${unit(x)}`, round2(costOf(c, x))]) };
  }

  // ---------------------------------------------------------------- backups
  const DATA_NODES = ['settings', 'suppliers', 'procedures', 'items', 'batches', 'txns', 'kits', 'flags', 'counts', 'reorder', 'reversals', 'counters'];
  const pad = n => String(n).padStart(2, '0');
  function snapName(id, s) {
    const ts = C.localTs(s.at) || '0000-00-00 00:00:00';
    return `supplysmile-${ts.slice(0, 10)}_${ts.slice(11).replace(/:/g, '')}-${s.kind}-${id}.json`;
  }
  const snapInfo = (id, s) => ({ name: snapName(id, s), kind: s.kind, sizeKb: s.sizeKb || 1, createdAt: (C.localTs(s.at) || '').slice(0, 16).replace(' ', 'T') });
  async function snapshotData() {
    const vals = await Promise.all(DATA_NODES.concat('people').map(n => C.db.get('clinic/' + n, { fresh: true })));
    const tables = {};
    DATA_NODES.forEach((n, i) => { tables[n] = n === 'settings' ? vals[i] || {} : n === 'kits' ? Object.fromEntries(Object.entries(asMap(vals[i])).map(([k, v]) => [k, asMap(v)])) : asMap(vals[i]); });
    const people = asMap(vals[vals.length - 1]);
    return { app: 'Supply Smile', format: 'firebase-1', createdAt: C.localTs(C.serverNow()), tables,
      users: Object.entries(people).map(([k, x]) => ({ id: k, username: x.username, fullName: x.fullName })) };
  }
  const isToday = s => s.kind === 'daily' && (C.localTs(s.at) || '').slice(0, 10) === today();
  async function makeSnapshot(kind, data) {
    data = data || await snapshotData();
    const size = Math.max(1, Math.round(JSON.stringify(data).length / 1024));
    return stockSave(['snapshots'], (c, u, alloc) => {
      if (kind === 'daily' && rows(c.snapshots).some(isToday)) return () => null;      // another page or phone made it first
      const id = alloc('snapshots');
      c.snapshots[id] = { kind, at: C.serverNow(), sizeKb: size };
      u['snapshots/' + id] = { kind, at: TS, sizeKb: size }; u['snapshotData/' + id] = data;
      const keep = rows(c.snapshots).sort((a, b) => b.at - a.at || b.id - a.id).slice(30);
      for (const old of keep) { u['snapshots/' + old.id] = null; u['snapshotData/' + old.id] = null; }
      return () => snapInfo(id, c.snapshots[id]);
    });
  }
  let dailyRunning = null;
  async function ensureDailySnapshot(me) {
    if (me.role !== 'ADMIN') return null;
    if (!dailyRunning) {
      dailyRunning = (async () => {
        const c = await load(['snapshots']);
        if (!rows(c.snapshots).some(isToday)) await makeSnapshot('daily');
      })();
    }
    return dailyRunning;
  }
  async function backupsList(me) {
    requireAdmin(me);
    const c = await load(['snapshots'], true);
    return { folder: 'inside your Firebase database', keep: 30,
      backups: rows(c.snapshots).sort((a, b) => b.at - a.at || b.id - a.id).map(s => snapInfo(s.id, s)) };
  }
  async function backupNow(me) { requireAdmin(me); return makeSnapshot('manual'); }
  async function snapshotByName(name) {
    const m = /-(\d+)\.json$/.exec(String(name || ''));
    const id = m ? Number(m[1]) : null;
    const s = id ? await C.db.get('clinic/snapshots/' + id, { fresh: true }) : null;
    if (!s) notFound('Backup not found.');
    return { id, s };
  }
  async function backupGet(me, p) {
    requireAdmin(me);
    const { id, s } = await snapshotByName(p.name);
    return { name: snapName(id, s), data: cleanBackup(await C.db.get('clinic/snapshotData/' + id, { fresh: true })) };
  }
  // Firebase may hand lists back as arrays; a backup file always has id -> record maps.
  function cleanBackup(d) {
    if (!d || !d.tables) return d;
    const tables = {};
    for (const n of DATA_NODES) {
      const v = d.tables[n];
      tables[n] = n === 'settings' ? v || {} : n === 'kits' ? Object.fromEntries(Object.entries(asMap(v)).map(([k, x]) => [k, asMap(x)])) : asMap(v);
    }
    return { ...d, tables, users: Object.values(asMap(d.users)) };
  }
  // Replace all clinic data with a backup (people and sign-ins stay as they are).
  async function restoreData(me, d) {
    const t = d && d.tables;
    if (!d || d.app !== 'Supply Smile' || d.format !== 'firebase-1' || !t || typeof t !== 'object') fail('This is not a Supply Smile backup file.');
    const people = asMap(await C.db.get('clinic/people', { fresh: true }));
    const who = k => (k && people[k] ? k : me.key);
    const u = {};
    for (const n of DATA_NODES) {
      let v = n === 'settings' ? t[n] || {} : asMap(t[n]);
      if (n === 'kits') v = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asMap(x)]));
      if (['txns', 'flags', 'counts', 'reorder'].includes(n)) {
        v = Object.fromEntries(Object.entries(v).map(([k, x]) => {
          const y = { ...x, by: who(x.by) };
          if (y.resolvedBy) y.resolvedBy = who(y.resolvedBy);
          return [k, y];
        }));
      }
      u[n] = Object.keys(v).length ? v : null;
    }
    // counters never go below the numbers already used in the restored data
    const counters = { ...asMap(t.counters) };
    for (const n of ['items', 'batches', 'txns', 'suppliers', 'procedures', 'flags', 'counts']) {
      const max = Math.max(0, ...Object.keys(asMap(t[n])).map(Number).filter(Number.isFinite));
      counters[n] = Math.max(Number(counters[n]) || 0, max);
    }
    const snapCounter = await C.db.get('clinic/counters/snapshots', { fresh: true });
    counters.snapshots = Number(snapCounter) || 0;                 // backups themselves are kept as they are
    for (const k of Object.keys(counters)) if (!(Number(counters[k]) > 0)) delete counters[k];
    u.counters = Object.keys(counters).length ? counters : null;
    // 1) clear, 2) write: the database only accepts entry numbers on empty places
    await C.db.patch('clinic', Object.fromEntries(DATA_NODES.map(n => [n, null])));
    await C.db.patch('clinic', u);
    const name = (u.settings && u.settings.clinicName) || null;
    if (name) await C.db.patch('public', { clinicName: name });
  }
  async function backupRestore(me, p) {
    requireAdmin(me);
    const { id, s } = await snapshotByName(p.name);
    const data = await C.db.get('clinic/snapshotData/' + id, { fresh: true });
    const safety = await makeSnapshot('before-restore');
    await restoreData(me, data);
    return { restored: snapName(id, s), safetyCopy: safety.name };
  }
  async function backupUpload(me, p) {
    requireAdmin(me);
    const d = p.data;
    if (!d || d.app !== 'Supply Smile' || d.format !== 'firebase-1') fail('This is not a Supply Smile backup file.');
    const safety = await makeSnapshot('before-restore');
    const up = await makeSnapshot('uploaded', d);
    await restoreData(me, d);
    return { restored: up.name, safetyCopy: safety.name };
  }

  // ---------------------------------------------------------------- sample data (Settings -> Backups)
  async function loadDemo(me) {
    requireAdmin(me);
    const c0 = await load(['items'], true);
    if (Object.keys(c0.items).length) fail('The clinic already has items. Sample data is only for an empty clinic.');
    const t = today(), day = n => addDays(t, n);
    const people = asMap(await C.db.get('clinic/people', { fresh: true }));
    const staff = Object.keys(people).filter(k => people[k].role === 'STAFF' && people[k].active);
    const k = staff[0] || me.key, r = staff[1] || staff[0] || me.key;
    return stockSave(['items', 'batches', 'procedures', 'suppliers'], (c, u) => {
      const who = { key: me.key };
      const suppliers = [[1, 'Dentsply India', 'Rahul Mehta', '98450 11223', 'orders@dentsply.example', 'Indiranagar, Bengaluru'],
        [2, 'GC India Dental', 'Priya Nair', '98860 44517', 'sales@gcindia.example', 'Koramangala, Bengaluru'],
        [3, 'Prime Dental Supplies', 'Suresh Kumar', '99000 77310', 'prime@dental.example', 'Jayanagar, Bengaluru'],
        [4, 'MediCare Surgicals', 'Anita Rao', '97410 20988', 'anita@medicare.example', 'Rajajinagar, Bengaluru']];
      for (const [id, name, contactPerson, phone, email, address] of suppliers) {
        if (!rows(c.suppliers).some(s => s.name === name)) u['suppliers/' + id] = { name, contactPerson, phone, email, address, active: true };
      }
      COMMON_PROCEDURES.forEach((name, i) => { u['procedures/' + (i + 1)] = { name, active: true }; });
      for (const pr of rows(c.procedures)) if (pr.id > 6) u['procedures/' + pr.id] = null;
      const items = [[1, 'Composite resin A2', 'Restorative', 'syringe', 1, 5, true, 2], [2, 'Nitrile gloves (M)', 'Infection Control', 'box', 1, 10, false, 4],
        [3, 'Lidocaine 2% cartridges', 'Medicines & Anaesthetics', 'cartridge', 50, 50, true, 1], [4, 'K-files 15-40', 'Endodontic', 'pack', 1, 4, false, 1],
        [5, 'Gutta-percha points', 'Endodontic', 'pack', 1, 3, true, 1], [6, 'Alginate impression material', 'Impression Materials', 'pack', 1, 3, true, 2],
        [7, 'Face masks 3-ply', 'Infection Control', 'box', 1, 8, false, 4], [8, 'Glass ionomer cement', 'Restorative', 'kit', 1, 2, true, 2],
        [9, 'Silk suture 3-0', 'Surgical', 'piece', 12, 12, true, 4], [10, 'Diamond burs, assorted', 'Instruments & Burs', 'piece', 1, 10, false, 3],
        [11, 'Etchant gel 37%', 'Restorative', 'syringe', 1, 3, true, 2], [12, 'Chlorhexidine mouthwash', 'General Consumables', 'bottle', 1, 4, true, 3]];
      for (const [id, name, category, unit, packSize, minStock, expires, supplierId] of items) {
        u['items/' + id] = { name, category, unit, packSize, minStock, expires, supplierId, mode: [2, 7].includes(id) ? 'BULK' : 'PROCEDURE', active: true };
      }
      let bid = 0, tid = 0;
      const procs = [3, 2, 1, 4, 6, 5];
      const tx = (f, by) => { tid++; u['txns/' + tid] = { ...txnRecord({ key: by }, f) }; };
      const current = [[1, 'CR-2211', 184, 6, 4, 850, -110, 2, 'GC-5530'], [1, 'CR-2305', 22, 4, 2, 850, -210, 2, 'GC-5102'],
        [2, 'G-114', null, 20, 6, 420, -26, 4, 'MC/2291'], [3, 'L-5521', 337, 150, 120, 38, -39, 1, 'DS-88410'],
        [3, 'L-4410', -13, 50, 20, 36, -375, 1, 'DS-80011'], [4, 'KF-09', null, 6, 0, 610, -137, 1, 'DS-86120'],
        [5, 'GP-771', 459, 10, 8, 290, -68, 1, 'DS-87002'], [6, 'AL-300', 12, 6, 4, 540, -176, 2, 'GC-5009'],
        [7, 'M-88', null, 20, 15, 180, -26, 4, 'MC/2291'], [8, 'GI-12', 245, 3, 2, 1650, -110, 2, 'GC-5530'],
        [9, 'S-310', 125, 48, 36, 45, -89, 4, 'MC/2188'], [10, 'B-45', null, 30, 25, 95, -48, 3, 'PDS-1177'],
        [11, 'ET-19', 153, 6, 5, 320, -110, 2, 'GC-5530'], [12, 'CH-07', 48, 8, 6, 210, -121, 3, 'PDS-1102']];
      const bulk = id => [2, 7].includes(id);
      for (const [item, bno, exp, got, lft, cost, rec, sup, inv] of current) {
        bid++;
        const b = { itemId: item, batchNo: bno, qty: lft, cost, received: day(rec) };
        if (exp !== null) b.expiry = day(exp);
        u['batches/' + bid] = b;
        tx({ type: 'IN', reason: 'PURCHASE', batchId: bid, itemId: item, qty: got, date: day(rec), supplierId: sup, invoiceNo: inv }, who.key);
        const used = got - lft;
        if (used > 0) {
          const parts = Math.min(used, 8);
          for (let n = 0; n < parts; n++) {
            const q = Math.floor(used / parts) + (n < used % parts ? 1 : 0);
            const dd = Math.min(rec + Math.round((n + 1) * (-rec) / (parts + 1)), -1);
            tx({ type: 'OUT', reason: bulk(item) ? 'ISSUE' : 'PROCEDURE_USE', batchId: bid, itemId: item, qty: q, date: day(dd),
              procedureId: bulk(item) ? null : procs[(bid + n) % 6] }, n % 2 === 0 ? k : r);
          }
        }
      }
      const older = [[2, 'G-098', null, 12, 420, -70, 4, 'MC/2140'], [7, 'M-71', null, 10, 180, -70, 4, 'MC/2140'],
        [3, 'L-5102', 200, 100, 38, -84, 1, 'DS-87311'], [9, 'S-288', 60, 24, 45, -60, 4, 'MC/2170'],
        [10, 'B-40', null, 20, 95, -55, 3, 'PDS-1150'], [1, 'CR-2270', 90, 4, 850, -45, 2, 'GC-5300']];
      for (const [item, bno, exp, got, cost, rec, sup, inv] of older) {
        bid++;
        const b = { itemId: item, batchNo: bno, qty: 0, cost, received: day(rec) };
        if (exp !== null) b.expiry = day(exp);
        u['batches/' + bid] = b;
        tx({ type: 'IN', reason: 'PURCHASE', batchId: bid, itemId: item, qty: got, date: day(rec), supplierId: sup, invoiceNo: inv }, who.key);
        const parts = Math.min(got, 6);
        for (let n = 0; n < parts; n++) {
          const q = Math.floor(got / parts) + (n < got % parts ? 1 : 0);
          const dd = Math.min(rec + Math.round((n + 1) * (-rec) / (parts + 1)), -1);
          const waste = n === parts - 1 && item === 1;
          tx({ type: 'OUT', reason: waste ? 'WASTAGE' : bulk(item) ? 'ISSUE' : 'PROCEDURE_USE', batchId: bid, itemId: item, qty: q, date: day(dd),
            procedureId: waste || bulk(item) ? null : ((item + n) % 6) + 1 }, n % 2 === 1 ? k : r);
        }
      }
      u.kits = { 2: { 1: 1, 11: 1, 3: 1, 10: 1 }, 3: { 3: 2, 4: 1, 5: 1, 10: 1 }, 4: { 3: 2, 9: 1 }, 5: { 3: 2, 10: 2, 6: 1 }, 6: { 6: 1 }, 1: { 12: 1 } };
      for (const [k, v] of Object.entries({ items: 12, batches: bid, txns: tid, procedures: 6, suppliers: 4 })) {
        if (v > (Number(c.counters[k]) || 0)) u['counters/' + k] = v;                   // counters only ever go up
      }
      if (Number(c.counters.txns) > 0 || Number(c.counters.batches) > 0) fail('Sample data is only for a new, empty clinic.');
      return () => ({ ok: true, message: 'Sample data loaded: 12 items, 4 suppliers, 6 procedures with kits.' });
    });
  }

  return { VERSION, COMMON_PROCEDURES, load, ensureDailySnapshot, serverTime, settingsSave, about, meta,
    itemsListApi, itemDetail, itemBatches, itemCreate, itemUpdate, suppliersList, supplierDetail, supplierCreate, supplierUpdate,
    proceduresListApi, procedureCreate, procedureUpdate, stockIn, stockInInvoice, stockOut, stockRecent, stockUndo, stockCorrect,
    useRecord, useUndo, flagsList, flagResolve, kitsList, kitSave, countSave, countsList, countDetail, importItems,
    reorderList, reorderSet, reorderRemove, reorderOrdered, dashboard, dashboardCharts, alertCountsApi, alertList, report,
    backupsList, backupNow, backupGet, backupRestore, backupUpload, loadDemo };
})();
