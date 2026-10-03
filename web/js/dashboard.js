// Supply Smile dashboard: headline numbers, charts (Chart.js), stock health, to-do list.
// Everything under the period switch re-renders for 7 / 30 / 90 days.

const C = {
  used: '#2a78d6',        // categorical slot 1 (blue)  - consumption
  received: '#eb6834',    // categorical slot 2 (orange) - deliveries
  ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7'
};
// Status colours carry meaning (good / warning / serious / critical) and always come with an icon + label.
const HEALTH = {
  IN_STOCK: { color: '#0ca30c', icon: 'check-circle', label: 'In stock' },
  LOW: { color: '#fab219', icon: 'exclamation-triangle', label: 'Low stock' },
  NEAR_EXPIRY: { color: '#ec835a', icon: 'hourglass-split', label: 'Near expiry' },
  OUT: { color: '#d03b3b', icon: 'x-octagon', label: 'Out of stock' },
  EXPIRED: { color: '#d03b3b', icon: 'calendar-x', label: 'Has expired stock' }
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
// Short money for axes: ₹950, ₹15k, ₹1.2L (Indian lakh), never "T" which reads like trillion.
const inrShort = { format(v) {
  const a = Math.abs(v), trim = n => String(Number(n.toFixed(1)));
  if (a >= 1e5) return '₹' + trim(v / 1e5) + 'L';
  if (a >= 1e3) return '₹' + trim(v / 1e3) + 'k';
  return '₹' + Math.round(v);
} };
const shortDate = iso => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const charts = {};
const tables = {};    // chart name -> { head: [...], rows: [[...]] } for the table view

// ---------- Chart.js look: thin marks, hairline grid, white tooltip, value first ----------
function setupChartDefaults() {
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = C.ink2;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.animation.duration = reduceMotion ? 0 : 600;
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: '#ffffff', titleColor: C.ink2, bodyColor: C.ink, borderColor: 'rgba(11,11,11,.12)',
    borderWidth: 1, padding: 10, boxPadding: 5, cornerRadius: 8, usePointStyle: true,
    titleFont: { weight: 'normal', size: 12 }, bodyFont: { weight: '600', size: 13 }
  });
}
const moneyAxis = { beginAtZero: true, border: { display: false }, grid: { color: C.grid },
  ticks: { callback: v => inrShort.format(v), maxTicksLimit: 5, color: C.muted } };

function barOptions(horizontal, onPick, tooltipLabel) {
  const valueAxis = { ...moneyAxis, grid: { color: C.grid } };
  const catAxis = { grid: { display: false }, border: { color: C.axis },
    ticks: { color: C.ink2, autoSkip: false, callback(v) { const l = this.getLabelForValue(v); return l.length > 24 ? l.slice(0, 23) + '…' : l; } } };
  return {
    indexAxis: horizontal ? 'y' : 'x', maintainAspectRatio: false, responsive: true,
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipLabel } } },
    onHover: (e, els) => { e.native.target.style.cursor = els.length && onPick ? 'pointer' : 'default'; },
    onClick: (e, els) => { if (els.length && onPick) onPick(els[0].index); }
  };
}
function barDataset(values) {
  return { data: values, backgroundColor: C.used, hoverBackgroundColor: '#1c5cab', borderRadius: 4,
    borderSkipped: 'start', maxBarThickness: 22, categoryPercentage: 0.75, barPercentage: 0.9 };
}
function upsert(name, canvasId, config) {
  if (charts[name]) {
    charts[name].data = config.data;
    charts[name].options = config.options;
    charts[name].update();
  } else {
    charts[name] = new Chart(document.getElementById(canvasId), config);
  }
}
function emptyState(canvasId, isEmpty, text) {
  const box = document.getElementById(canvasId).parentElement;
  let msg = box.querySelector('.chart-empty');
  if (isEmpty && !msg) box.append(msg = el('div', { class: 'chart-empty', text }));
  if (!isEmpty && msg) msg.remove();
}

// ---------- table view twin for every chart ----------
function renderTable(name) {
  const card = document.getElementById('card-' + name), t = tables[name];
  card.querySelector('.table-view').replaceChildren(el('div', { class: 'table-responsive' },
    el('table', { class: 'table table-stack table-sm mb-0' },
      el('thead', {}, el('tr', {}, ...t.head.map(h => el('th', { text: h })))),
      el('tbody', {}, ...(t.rows.length ? t.rows.map(r => tr(...r)) : [emptyRow(t.head.length, 'No data for this period.')])))));
}
document.addEventListener('click', e => {
  const btn = e.target.closest('.view-toggle');
  if (!btn) return;
  const card = document.getElementById('card-' + btn.dataset.card);
  const showTable = btn.getAttribute('aria-pressed') !== 'true';
  card.querySelector('.chart-box').classList.toggle('d-none', showTable);
  card.querySelector('.table-view').classList.toggle('d-none', !showTable);
  btn.setAttribute('aria-pressed', String(showTable));
  btn.title = showTable ? 'Show as chart' : 'Show as table';
  btn.setAttribute('aria-label', btn.title);
  btn.firstElementChild.className = 'bi ' + (showTable ? 'bi-bar-chart' : 'bi-table');
  if (showTable) renderTable(btn.dataset.card);
});

// ---------- headline numbers (count up) ----------
function countUp(node, to, fmt) {
  if (reduceMotion) { node.textContent = fmt(to); return; }
  const start = performance.now(), dur = 700;
  const step = now => {
    const p = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - p, 3);
    node.textContent = fmt(Math.round(to * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// ---------- ₹ value or quantity ----------
let MODE = 'qty';    // 'value' = rupees, 'qty' = units / entries / batches
const countAxis = { beginAtZero: true, border: { display: false }, grid: { color: C.grid },
  ticks: { precision: 0, maxTicksLimit: 5, color: C.muted } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Writes "54 cartridge" at the end of each bar: needed when bars mix units.
const barEndLabels = {
  id: 'barEndLabels',
  afterDatasetsDraw(chart, args, opts) {
    if (!opts || !opts.labels) return;
    const ctx = chart.ctx, meta = chart.getDatasetMeta(0);
    ctx.save(); ctx.fillStyle = C.ink2; ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    meta.data.forEach((bar, i) => { if (opts.labels[i]) ctx.fillText(opts.labels[i], bar.x + 6, bar.y); });
    ctx.restore();
  }
};

function renderKpis(d, counts) {
  const k = d.kpis, days = d.period.days, qty = MODE === 'qty';
  let delta = '';
  if (k.prevUsedValue > 0) {
    const pct = Math.round((k.usedValue - k.prevUsedValue) / k.prevUsedValue * 100);
    delta = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs previous ${days} days`;
  }
  const soon = d.expiry.filter(w => w.from < ME.nearExpiryDays);
  const atRisk = soon.reduce((s, w) => s + w.value, 0);
  const num = v => String(v), money = v => inr.format(v);
  const reorder = counts.low + counts.out, expiring = counts.nearExpiry + counts.expired;
  const tiles = [
    qty ? { label: 'Items in stock', icon: 'box-seam', value: k.itemsWithStock, fmt: num,
            sub: `of ${counts.totalItems} items · ${k.batchesInStock} batches`, href: 'items.html' }
        : { label: 'Stock value', icon: 'wallet2', value: k.stockValue, fmt: money,
            sub: `${counts.totalItems} items, as of today`, href: 'reports.html?report=stock' },
    qty ? { label: 'Stock Out entries', icon: 'graph-down-arrow', value: k.usedEntries, fmt: num,
            sub: `${inr.format(k.usedValue)} worth used`, href: 'reports.html?report=history' }
        : { label: 'Used', icon: 'graph-down-arrow', value: k.usedValue, fmt: money,
            sub: delta || `${plural(k.usedEntries, 'entry', 'entries')}`, href: 'reports.html?report=usage' },
    { label: 'To reorder', icon: 'cart-plus', value: reorder, fmt: num, tone: reorder ? 'warn' : 'ok',
      sub: reorder ? `${counts.low} low · ${counts.out} out of stock` : 'Nothing to reorder', href: 'items.html?status=REORDER' },
    { label: 'Expiry risk', icon: 'hourglass-split', value: expiring, fmt: num, tone: counts.expired ? 'bad' : (counts.nearExpiry ? 'warn' : 'ok'),
      sub: expiring ? `${counts.expired} expired · ${counts.nearExpiry} within ${ME.nearExpiryDays} days${qty ? '' : ' · ' + inr.format(atRisk)}` : 'No batches at risk',
      href: 'reports.html?report=expiry' }
  ];
  $('kpis').replaceChildren(...tiles.map(t => {
    const valueNode = el('div', { class: 'kpi-value' });
    const node = el('div', { class: 'col-6 col-xl-3' },
      el('a', { class: `card kpi ${t.tone ? 'kpi-' + t.tone : ''}`, href: t.href, 'aria-label': `${t.label}: ${t.fmt(t.value)}. ${t.sub}` },
        el('div', { class: 'kpi-label' }, el('i', { class: 'bi bi-' + t.icon }), el('span', { text: t.label })),
        valueNode, el('div', { class: 'kpi-sub', text: t.sub })));
    countUp(valueNode, t.value, t.fmt);
    return node;
  }));
}

// ---------- charts ----------
function renderMovement(d) {
  const qty = MODE === 'qty', item = d.movementItem;
  const src = qty && d.movementForItem ? d.movementForItem : d.movement;
  const b = src.buckets, byWeek = src.step === 'week';
  const labels = b.map(x => byWeek ? `${shortDate(x.start)}–${shortDate(x.end)}` : shortDate(x.start));
  const per = byWeek ? 'week' : 'day';
  $('movement-item').classList.toggle('d-none', !qty);
  $('movement-sub').textContent = qty && item
    ? `${item.name}, in ${item.unit}s per ${per}`
    : `Rupee value per ${per}`;
  const usedKey = qty ? 'usedQty' : 'used', recKey = qty ? 'receivedQty' : 'received';
  const fmt = v => qty ? `${v} ${item ? item.unit : ''}` : inr.format(v);
  // Paired bars: a delivery lands on one day, so bars show it honestly (a smoothed line would not).
  const bars = (label, key, color, hover) => ({ label, data: b.map(x => x[key]), backgroundColor: color,
    hoverBackgroundColor: hover, borderRadius: 4, borderSkipped: 'start', maxBarThickness: byWeek ? 16 : 9,
    categoryPercentage: 0.8, barPercentage: 0.9, pointStyle: 'rect' });
  upsert('movement', 'c-movement', {
    type: 'bar',
    data: { labels, datasets: [bars('Used', usedKey, C.used, '#1c5cab'), bars('Received', recKey, C.received, '#c9521f')] },
    options: {
      maintainAspectRatio: false, responsive: true, interaction: { mode: 'index', intersect: false },
      scales: { y: qty ? countAxis : moneyAxis, x: { grid: { display: false }, border: { color: C.axis },
        ticks: { maxTicksLimit: byWeek ? 7 : 8, maxRotation: 0, color: C.muted, callback(v) { return this.getLabelForValue(v).split('–')[0]; } } } },
      plugins: {
        legend: { align: 'start', labels: { usePointStyle: true, pointStyle: 'rect', boxWidth: 10, boxHeight: 10, color: C.ink2, padding: 14 } },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.y)}  ${c.dataset.label}` } }
      }
    }
  });
  emptyState('c-movement', b.every(x => !x[usedKey] && !x[recKey]), qty ? 'No movement of this item in this period.' : 'No stock movement in this period.');
  tables.movement = { head: [byWeek ? 'Week' : 'Day', qty ? `Used (${item ? item.unit : 'units'})` : 'Used (₹)', qty ? `Received (${item ? item.unit : 'units'})` : 'Received (₹)'],
    rows: b.map((x, i) => [labels[i], qty ? x[usedKey] : inr.format(x.used), qty ? x[recKey] : inr.format(x.received)]) };
}

function renderCategory(d) {
  const rows = [...d.byCategory], qty = MODE === 'qty';
  if (qty) rows.sort((a, b) => b.entries - a.entries);
  $('category-sub').textContent = qty
    ? 'Stock Out entries per category'
    : 'Value used per category';
  const opts = barOptions(true, i => location.href = 'items.html?category=' + encodeURIComponent(rows[i].category),
    c => qty ? `${plural(c.parsed.x, 'entry', 'entries')} · ${inr.format(rows[c.dataIndex].value)}`
             : `${inr.format(c.parsed.x)} · ${plural(rows[c.dataIndex].entries, 'entry', 'entries')}`);
  if (qty) opts.scales.x = { ...countAxis };
  upsert('category', 'c-category', { type: 'bar',
    data: { labels: rows.map(r => r.category), datasets: [barDataset(rows.map(r => qty ? r.entries : r.value))] }, options: opts });
  emptyState('c-category', !rows.length, 'No usage in this period.');
  tables.category = { head: ['Category', 'Entries', 'Value used'], rows: rows.map(r => [r.category, r.entries, inr.format(r.value)]) };
}

function renderItems(d) {
  const qty = MODE === 'qty', rows = qty ? d.topItemsQty : d.topItems;
  $('items-sub').textContent = qty
    ? 'By quantity used, in each item\'s own unit'
    : 'By value used';
  const opts = barOptions(true, i => location.href = 'item.html?id=' + rows[i].itemId,
    c => qty ? `${rows[c.dataIndex].qty} ${rows[c.dataIndex].unit} · ${inr.format(rows[c.dataIndex].value)}`
             : `${inr.format(c.parsed.x)} · ${rows[c.dataIndex].qty} ${rows[c.dataIndex].unit}`);
  if (qty) {
    // Different units: label every bar with its unit and leave room for the label.
    const max = Math.max(1, ...rows.map(r => r.qty));
    opts.scales.x = { ...countAxis, suggestedMax: Math.ceil(max * 1.5) };
    opts.plugins.barEndLabels = { labels: rows.map(r => `${r.qty} ${r.unit}`) };
  } else opts.plugins.barEndLabels = { labels: null };
  if (charts.items) { charts.items.destroy(); delete charts.items; }
  charts.items = new Chart($('c-items'), { type: 'bar', plugins: [barEndLabels],
    data: { labels: rows.map(r => r.name), datasets: [barDataset(rows.map(r => qty ? r.qty : r.value))] }, options: opts });
  emptyState('c-items', !rows.length, 'No usage in this period.');
  tables.items = { head: ['Item', 'Quantity used', 'Entries', 'Value used'], rows: rows.map(r => [r.name, `${r.qty} ${r.unit}`, r.entries, inr.format(r.value)]) };
}

function renderProcedure(d) {
  const rows = [...d.byProcedure], qty = MODE === 'qty';
  if (qty) rows.sort((a, b) => b.entries - a.entries);
  $('procedure-title').textContent = qty ? 'Stock Out entries by procedure' : 'Material cost by procedure';
  $('procedure-sub').textContent = qty
    ? 'How often materials were recorded per procedure'
    : 'Materials recorded against each procedure';
  const opts = barOptions(true, () => location.href = 'reports.html?report=usage',
    c => qty ? `${plural(c.parsed.x, 'entry', 'entries')} · ${inr.format(rows[c.dataIndex].value)}`
             : `${inr.format(c.parsed.x)} · ${plural(rows[c.dataIndex].entries, 'entry', 'entries')}`);
  if (qty) opts.scales.x = { ...countAxis };
  upsert('procedure', 'c-procedure', { type: 'bar',
    data: { labels: rows.map(r => r.procedure), datasets: [barDataset(rows.map(r => qty ? r.entries : r.value))] }, options: opts });
  emptyState('c-procedure', !rows.length, 'No procedures recorded in this period.');
  tables.procedure = { head: ['Procedure', 'Entries', 'Material cost'], rows: rows.map(r => [r.procedure, r.entries, inr.format(r.value)]) };
}

function renderExpiry(d) {
  const rows = d.expiry, qty = MODE === 'qty';
  const labels = rows.map(w => `${w.from}–${w.to} d`);
  $('expiry-sub').textContent = qty ? 'Batches expiring in the next 90 days'
                                    : 'Stock value expiring in the next 90 days';
  const opts = barOptions(false, () => location.href = 'reports.html?report=expiry',
    c => qty ? plural(c.parsed.y, 'batch', 'batches') + ` · ${inr.format(rows[c.dataIndex].value)}`
             : `${inr.format(c.parsed.y)} · ${plural(rows[c.dataIndex].batches, 'batch', 'batches')}`);
  if (qty) opts.scales.y = { ...countAxis };
  opts.plugins.tooltip.callbacks.title = items => `Expiring in ${rows[items[0].dataIndex].from}–${rows[items[0].dataIndex].to} days`;
  opts.plugins.tooltip.callbacks.afterBody = items => rows[items[0].dataIndex].contents;
  opts.plugins.tooltip.bodyFont = { weight: '600', size: 13 };
  opts.plugins.tooltip.footerFont = { weight: 'normal' };
  upsert('expiry', 'c-expiry', { type: 'bar',
    data: { labels, datasets: [barDataset(rows.map(w => qty ? w.batches : w.value))] }, options: opts });
  emptyState('c-expiry', rows.every(w => !w.batches), 'Nothing expires in the next 90 days.');
  tables.expiry = { head: ['Expires in', 'What', 'Batches', 'Value'],
    rows: rows.map((w, i) => [labels[i].replace(' d', ' days'), w.contents.join(', ') || '-', w.batches, inr.format(w.value)]) };
}

function renderHealth(mix) {
  const total = mix.reduce((s, m) => s + m.count, 0) || 1;
  const shown = mix.filter(m => m.count);
  $('health-bar').replaceChildren(...shown.map(m => el('button', {
    class: 'seg', type: 'button', style: `flex:${m.count} 1 0;background:${HEALTH[m.status].color}`,
    title: `${HEALTH[m.status].label}: ${m.count}`, 'aria-label': `${HEALTH[m.status].label}: ${m.count} items`,
    onclick: () => location.href = 'items.html?status=' + m.status })));
  $('health-legend').replaceChildren(...mix.map(m => el('a', { href: 'items.html?status=' + m.status },
    el('span', { class: 'sw', style: `background:${HEALTH[m.status].color}` }),
    el('i', { class: 'bi bi-' + HEALTH[m.status].icon }),
    el('span', { text: HEALTH[m.status].label }),
    el('span', { class: 'small text-secondary ms-2', text: Math.round(m.count / total * 100) + '%' }),
    el('span', { class: 'cnt', text: String(m.count) }))));
  const good = (mix.find(m => m.status === 'IN_STOCK') || { count: 0 }).count;
  $('health-sub').textContent = `${good} of ${total} items healthy, as of today`;
}

// ---------- needs-attention list and latest entries ----------
let todoAll = false;
let ON_LIST = new Set();      // items already on the reorder list (kept in the database)
function renderTodo(A, isAdmin) {
  const box = $('todo');
  box.replaceChildren();
  const rows = [];
  (A.flags || []).forEach(f => rows.push({ icon: 'flag', cls: 'ic-danger',
    text: `Check stock of ${f.itemName}`, sub: `${f.qty} ${f.unit} used on ${fmtDate(f.date)} while the system showed too little · ${f.userName}`,
    action: isAdmin ? el('a', { class: 'btn btn-sm btn-outline-danger', href: 'count.html?item=' + f.itemId, text: 'Count it' })
                    : el('span', { class: 'small text-secondary', text: 'Admin will check' }) }));
  A.expired.forEach(b => rows.push({ icon: 'calendar-x', cls: 'ic-danger',
    text: `Write off ${b.itemName}, batch ${b.batchNo}`, sub: `${b.qty} ${b.unit} expired on ${fmtDate(b.expiryDate)}`,
    action: el('a', { class: 'btn btn-sm btn-danger', href: `stock-out.html?item=${b.itemId}&batch=${b.batchId}&reason=EXPIRED`, text: 'Write off' }) }));
  [...A.out, ...A.low].forEach(i => {
    const on = ON_LIST.has(i.id);
    rows.push({ icon: i.qty === 0 ? 'x-octagon' : 'exclamation-triangle', cls: i.qty === 0 ? 'ic-danger' : 'ic-warn', done: on,
      text: `Reorder ${i.name}`, sub: `${i.qty} of ${i.minStockLevel} ${i.unit} left · ${i.supplierName || 'no supplier set'}`,
      action: isAdmin
        ? el('button', { class: 'btn btn-sm ' + (on ? 'btn-success' : 'btn-outline-primary'), type: 'button',
            onclick: async () => {
              try {
                const r = on ? await api.del('/api/reorder/' + i.id) : await api.put('/api/reorder/' + i.id, {});
                ON_LIST = new Set(r.itemIds);
                toast(on ? `${i.name} removed from the reorder list.` : `${i.name} added to the reorder list.`, 'secondary');
                renderTodo(A, isAdmin);
              } catch (e) { showError(e); } } },
            el('i', { class: 'bi ' + (on ? 'bi-check2 me-1' : 'bi-cart-plus me-1') }), on ? 'On list' : 'Add to list')
        : el('span', { class: 'small text-secondary', text: 'Tell the Admin' }) });
  });
  A.nearExpiry.forEach(b => rows.push({ icon: 'hourglass-split', cls: 'ic-info',
    text: `Use ${b.itemName} batch ${b.batchNo} first`, sub: `${b.qty} ${b.unit} · expires in ${b.daysLeft} days`,
    action: el('a', { class: 'btn btn-sm btn-outline-primary', href: `stock-out.html?item=${b.itemId}&batch=${b.batchId}`, text: 'Use now' }) }));
  const open = rows.filter(r => !r.done).length;
  $('todo-title').textContent = open ? `Needs attention · ${open}` : 'Needs attention';
  if (!rows.length) box.append(el('div', { class: 'todo' }, el('span', { class: 'ic ic-info' }, el('i', { class: 'bi bi-emoji-smile' })),
    el('div', { class: 'todo-text', text: 'All clear. Nothing needs attention today.' })));

  const LIMIT = 5, extra = rows.length - LIMIT;
  rows.forEach((r, n) => box.append(el('div', { class: 'todo' + (r.done ? ' done' : '') + (n >= LIMIT && !todoAll ? ' d-none' : '') },
    el('span', { class: 'ic ' + r.cls }, el('i', { class: 'bi bi-' + r.icon })),
    el('div', { class: 'flex-grow-1' }, el('div', { class: 'todo-text fw-semibold small', text: r.text }),
      el('div', { class: 'small text-secondary', text: r.sub })),
    r.action)));
  if (extra > 0) box.append(el('button', { class: 'btn btn-link btn-sm todo-more', type: 'button',
    text: todoAll ? 'Show fewer' : `Show ${extra} more`, onclick: () => { todoAll = !todoAll; renderTodo(A, isAdmin); } }));
  $('reorder-count').textContent = String(ON_LIST.size);
  return open;
}

// ---------- start ----------
startPage(async me => {
  const h = new Date().getHours();
  $('hello').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}, ${me.fullName}`;
  const isAdmin = me.role === 'ADMIN';
  if (!window.Chart) {
    document.querySelectorAll('.chart-box').forEach(b => b.append(el('div', { class: 'chart-empty', text: 'Charts did not load. Reload the page (Ctrl+F5).' })));
  } else setupChartDefaults();

  let period = 30;
  try { period = Number(sessionStorage.getItem('dcims-period')) || 30; } catch (e) { /* ignore */ }
  const radio = document.querySelector(`input[name=period][value="${period}"]`);
  if (radio) radio.checked = true;

  const [dash, counts, rl] = await Promise.all([api.get('/api/dashboard'), api.get('/api/alerts/counts'), api.get('/api/reorder')]);
  ON_LIST = new Set(rl.itemIds);
  const open = renderTodo(dash.alerts, isAdmin);
  const longDate = new Date(me.today + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('today-line').textContent = `${longDate} · ${open ? open + ' thing' + (open === 1 ? '' : 's') + ' need attention' : 'all clear today'}`;

  dash.recent.slice(0, 10).forEach(t => $('recent').append(el('li', {},
    el('span', { class: 'rl-ic ' + (t.type === 'IN' ? 'in' : 'out'), title: t.type === 'IN' ? 'Stock In' : 'Stock Out' },
      el('i', { class: 'bi ' + (t.type === 'IN' ? 'bi-arrow-down-left' : 'bi-arrow-up-right') })),
    el('div', { class: 'min-w-0 flex-grow-1' },
      el('div', { class: 'rl-name text-truncate', text: t.itemName }),
      el('div', { class: 'rl-sub text-truncate', text: `${t.procedureName || REASON_LABEL[t.reason]} · ${t.userName}` })),
    el('div', { class: 'text-end flex-shrink-0' },
      el('div', { class: 'rl-qty ' + (t.type === 'IN' ? 'in' : 'out'), text: `${t.type === 'IN' ? '+' : '−'}${t.qty} ${t.unit}` }),
      el('div', { class: 'rl-sub', text: shortDate(t.date) })))));
  if (!dash.recent.length) $('recent').append(el('li', { class: 'text-secondary small', text: 'No entries yet.' }));

  let last = null;   // latest chart data, so switching ₹/Quantity needs no refetch
  function renderAll() {
    if (!last) return;
    renderKpis(last, counts);
    renderHealth(last.statusMix);
    if (window.Chart) { renderMovement(last); renderExpiry(last); renderCategory(last); renderItems(last); renderProcedure(last); }
    document.querySelectorAll('.view-toggle').forEach(btn => { if (btn.getAttribute('aria-pressed') === 'true') renderTable(btn.dataset.card); });
  }
  async function loadCharts(days) {
    $('scoped').classList.add('is-loading');         // keep the old render while fetching
    try {
      const item = $('movement-item').value;
      last = await api.get('/api/dashboard/charts?days=' + days + (item ? '&item=' + item : ''));
      if (last.movementItem && !$('movement-item').value) $('movement-item').value = String(last.movementItem.id);
      renderAll();
    } catch (e) { showError(e); }
    finally { $('scoped').classList.remove('is-loading'); }
  }
  const currentDays = () => Number(document.querySelector('input[name=period]:checked').value);
  document.querySelectorAll('input[name=period]').forEach(r => r.addEventListener('change', () => {
    try { sessionStorage.setItem('dcims-period', r.value); } catch (e) { /* ignore */ }
    loadCharts(currentDays());
  }));
  // ₹ Value / Quantity switch
  try { MODE = sessionStorage.getItem('dcims-mode') === 'value' ? 'value' : 'qty'; } catch (e) { /* ignore */ }
  $(MODE === 'qty' ? 'm-qty' : 'm-value').checked = true;
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => {
    MODE = r.value;
    try { sessionStorage.setItem('dcims-mode', MODE); } catch (e) { /* ignore */ }
    renderAll();
  }));
  // Item picker for the quantity view of the movement chart
  const { items: allItems } = await api.get('/api/items');
  fillSelect($('movement-item'), allItems.map(i => [i.id, `${i.name} (${i.unit})`]));
  $('movement-item').value = '';
  $('movement-item').addEventListener('change', () => loadCharts(currentDays()));
  await loadCharts(period);
});
