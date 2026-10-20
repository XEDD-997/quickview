/* StatePharma Quick View for iPhone (and any phone browser).
 * Reads the Quick View data file made by the Planning App, keeps it on this phone and works offline.
 * It never sends anything anywhere: the page's security policy only lets it talk to its own address.
 * The rules (order stages, on order, notices, availability) are the same as the Android app's.
 */
(() => {
'use strict';

const VERSION = '1.0.1';
const FORMAT = 1;                       // highest data file format this version understands
const MAIN_WH = { SPW002: 'Main warehouse', SPW003: 'IGMH store' };
const CANCELLED = new Set(['deleted', 'reversed', 'rejected', 'draft - rejected']);
const FINISHED = new Set(['completed', 'closed']);
const ACTIVE = new Set(['released', 'pending approval', 'draft - reviewing', 'draft - approved', 'draft']);
const RULES = [
  { id: 'NO_PO', title: 'PR without a PO', tone: 'bad' },
  { id: 'PO_OVERDUE', title: 'PO not delivered in time', tone: 'bad' },
  { id: 'APPROVAL', title: 'PR waiting for approval', tone: 'warn' },
  { id: 'PARTIAL', title: 'Partly received, then stalled', tone: 'warn' },
];

// ------------------------------------------------------------------ small helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const mf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (v) => (v == null || Number.isNaN(v) ? '-' : nf.format(v));
const fmtMoney = (v) => (v == null ? '-' : 'MVR ' + mf.format(v));
const fmtPct = (part, whole) => (whole > 0 ? Math.round((part * 100) / whole) + '%' : '-');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function today() { return new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); }   // Maldives
function dayNum(iso) { const t = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z'); return Number.isNaN(t) ? null : t / 864e5; }
function daysBetween(a, b) { if (!a || !b) return null; const x = dayNum(a), y = dayNum(b); return x == null || y == null ? null : Math.round(y - x); }
function show(iso) { if (!iso) return '-'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return y && m && d ? `${+d} ${MONTHS[+m - 1]} ${y}` : '-'; }
function showTime(iso) { if (!iso || iso.length < 16) return show(iso); return show(iso) + ' ' + iso.slice(11, 16); }
function ago(iso) {
  const d = daysBetween(iso, today());
  if (d == null) return '-';
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}
function addMonths(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function expiryStatus(exp, t) {
  if (!exp) return 'none';
  const e = String(exp).slice(0, 10);
  if (e < t) return 'expired';
  if (e < addMonths(t, 3)) return 'short';
  if (e <= addMonths(t, 6)) return 'near';
  return 'ok';
}
const EXPIRY = { expired: ['Expired', 'bad'], short: ['Under 3 months', 'bad'], near: ['3-6 months', 'warn'], ok: ['OK', 'good'], none: ['No expiry', 'neutral'] };
const STOCK = { in_stock: ['In stock', 'good'], on_order: ['On order', 'info'], out_of_stock: ['Out of stock', 'bad'] };
function stageTone(s) { return s === 'Received' ? 'good' : s === 'Partly received' ? 'warn' : s === 'Cancelled' ? 'bad' : s.startsWith('PO') ? 'info' : 'neutral'; }
const pill = (text, tone = 'neutral') => `<span class="pill p-${tone}">${esc(text)}</span>`;
function prKey(s) {
  if (!s) return null;
  const t = String(s).toUpperCase().trim();
  let m = t.match(/PR\s*[-/_]?\s*(\d+)/);
  if (m) return 'PR-' + String(+m[1]).padStart(5, '0');
  m = t.match(/^(\d+)(\.0+)?$/);
  return m ? 'PR-' + String(+m[1]).padStart(5, '0') : null;
}
function poKey(s) {
  if (!s) return null;
  const t = String(s).trim().toUpperCase();
  if (!t || ['0', '0.0', 'NONE', 'NAN', '-'].includes(t)) return null;
  let m = t.match(/^(\d+)(\.0+)?$/);
  if (m) return 'PO-' + String(+m[1]).padStart(5, '0');
  m = t.match(/^PO\s*[-/_]?\s*(\d+)$/);
  return m ? 'PO-' + String(+m[1]).padStart(5, '0') : t;
}
/** Business unit from the PR's PBU: ConsumablePlanning -> CP. */
function unitOf(pbu) {
  const u = String(pbu || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!u) return '-';
  if (u === 'CONSUMABLEPLANNING' || u === 'CP') return 'CP';
  return u;
}
function minOf(arr) { let m = null; for (const v of arr) if (v != null && (m == null || v < m)) m = v; return m; }
function maxOf(arr) { let m = null; for (const v of arr) if (v != null && (m == null || v > m)) m = v; return m; }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------ icons
const P = {
  today: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  stock: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  products: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  orders: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 8H6M10 20.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zM18 20.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  back: 'M15 5l-7 7 7 7',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  chev: 'M9 6l6 6-6 6',
  x: 'M6 6l12 12M18 6 6 18',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  share: 'M12 3v12M7 8l5-5 5 5M5 12v8h14v-8',
};
const icon = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n]}"/></svg>`;

// ------------------------------------------------------------------ storage on this phone
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('quickview', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
  };
})();

const store = {
  get(k, d) { try { const v = localStorage.getItem('qv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('qv.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const DEFAULTS = { noPoDays: 5, approvalDays: 3, localDays: 14, foreignDays: 30, partialDays: 14, pbus: ['ConsumablePlanning', 'CD'], showPrices: true };
let settings = Object.assign({}, DEFAULTS, store.get('settings', {}));

// ------------------------------------------------------------------ reading the data file
async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This phone\'s browser is too old to open the data file. Update iOS (16.4 or newer) and try again.');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

async function decode(bytes) {
  const b = new Uint8Array(bytes);
  if (b[0] === 0x50 && b[1] === 0x4b) {
    throw new Error('That\'s an Excel file. Pick "Quick View data.spqv" from the SharePoint Quick View folder instead.');
  }
  let txt;
  if (b[0] === 0x1f && b[1] === 0x8b) txt = await gunzip(b);
  else txt = new TextDecoder().decode(b);
  let pack;
  try { pack = JSON.parse(txt); } catch { throw new Error('That file isn\'t a Quick View data file. Pick "Quick View data.spqv".'); }
  if (!pack || pack.kind !== 'statepharma-quickview' || !pack.tables) throw new Error('That file isn\'t a Quick View data file. Pick "Quick View data.spqv".');
  if ((pack.format || 1) > FORMAT) throw new Error('This data file is from a newer Planning App. Close Quick View and open it again to get the latest version, then load the file again.');
  return pack;
}

function table(pack, name) {
  const t = pack.tables[name];
  if (!t || !t.cols || !t.rows) return [];
  const cols = t.cols;
  return t.rows.map((r) => { const o = {}; for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i] ?? null; return o; });
}

// ------------------------------------------------------------------ working it all out (same rules as the Android app)
let M = null;        // the model built from the loaded file

function buildModel(pack) {
  const products = table(pack, 'products'), stock = table(pack, 'stock'), prLines = table(pack, 'pr_lines');
  const receipts = table(pack, 'receipts'), planningRows = table(pack, 'planning'), statusRows = table(pack, 'status_sheet');
  const pending = table(pack, 'pending_inbound'), priceRows = table(pack, 'prices');

  // items: one per product code
  const items = new Map();
  const add = (code, o) => { if (code && !items.has(code)) items.set(code, Object.assign({ code, sto: null, description: null, uom: null, group: null, mainWh: 0, igmh: 0, otherLoc: 0, total: 0, onOrder: 0, mwOnOrder: 0, igOnOrder: 0 }, o)); };
  for (const p of products) add(p.code, { sto: p.sto, description: p.description, uom: p.uom, group: p.product_group, lastCost: p.last_cost, avgCost: p.avg_cost });
  const stockBy = new Map();
  for (const s of stock) {
    if (!s.code) continue;
    if (!items.has(s.code)) add(s.code, { sto: s.sto, description: s.description });
    const it = items.get(s.code);
    if (!it.sto && s.sto) it.sto = s.sto;
    if (!it.description && s.description) it.description = s.description;
    const q = +s.qty || 0;
    if (s.location_code === 'SPW002') it.mainWh += q; else if (s.location_code === 'SPW003') it.igmh += q; else it.otherLoc += q;
    let arr = stockBy.get(s.code); if (!arr) stockBy.set(s.code, (arr = [])); arr.push(s);
  }
  for (const l of prLines) if (l.code && !items.has(l.code)) add(l.code, { description: l.description });
  for (const r of receipts) if (r.code && !items.has(r.code)) add(r.code, { description: r.description });
  for (const it of items.values()) {
    it.total = it.mainWh + it.igmh + it.otherLoc;
    if (!it.description) it.description = it.code;
    it.search = (it.code + ' ' + (it.sto || '') + ' ' + it.description).toLowerCase();
  }

  // receipts
  const recQty = new Map(), recLast = new Map(), poSupplier = new Map(), poGroup = new Map(), recByPo = new Map();
  for (const r of receipts) {
    if (!r.po) continue;
    const k = r.po + '|' + (r.code || '');
    recQty.set(k, (recQty.get(k) || 0) + (+r.qty || 0));
    if (r.date && (!recLast.has(k) || r.date > recLast.get(k))) recLast.set(k, r.date);
    if (r.supplier && (!poSupplier.has(r.po) || r.supplier > poSupplier.get(r.po))) poSupplier.set(r.po, r.supplier);
    if (r.vendor_group && (!poGroup.has(r.po) || r.vendor_group > poGroup.get(r.po))) poGroup.set(r.po, r.vendor_group);
    let a = recByPo.get(r.po); if (!a) recByPo.set(r.po, (a = [])); a.push(r);
  }
  const received = (po, code) => (po ? recQty.get(po + '|' + (code || '')) || 0 : 0);

  // status sheet
  const ss = new Map();
  for (const s of statusRows) if (s.pr) ss.set(s.pr, { status: s.status, cpCode: s.cp_code, vendor: s.vendor, completion: s.completion, title: s.title || null });

  // PR lines
  const byPr = new Map(), prsByCode = new Map(), prsByPo = new Map();
  for (const l of prLines) {
    if (!l.pr) continue;
    let a = byPr.get(l.pr); if (!a) byPr.set(l.pr, (a = [])); a.push(l);
    if (l.code) { let s = prsByCode.get(l.code); if (!s) prsByCode.set(l.code, (s = new Set())); s.add(l.pr); }
    if (l.po) { let s = prsByPo.get(l.po); if (!s) prsByPo.set(l.po, (s = new Set())); s.add(l.pr); }
  }

  // on order: Pending Inbound when it's there (same as DATA.xlsx MAIN), else open PO lines minus receipts
  if (pending.length) {
    for (const p of pending) {
      const it = items.get(p.code); if (!it) continue;
      if (p.warehouse_code === 'SPW002') it.mwOnOrder += +p.balance || 0;
      else if (p.warehouse_code === 'SPW003') it.igOnOrder += +p.balance || 0;
    }
    for (const it of items.values()) it.onOrder = it.mwOnOrder + it.igOnOrder;
  } else {
    for (const l of prLines) {
      if (!l.code || !l.po) continue;
      const st = (l.status || '').toLowerCase().trim();
      if (st && (CANCELLED.has(st) || FINISHED.has(st))) continue;
      const left = (+l.po_qty || 0) - received(l.po, l.code);
      const it = items.get(l.code);
      if (left > 0 && it) it.onOrder += left;
    }
  }

  // orders: one per PR
  const orders = new Map();
  for (const [pr, lines] of byPr) {
    const statuses = [...new Set(lines.map((l) => (l.status || '').toLowerCase().trim()).filter(Boolean))].sort();
    const withPo = lines.filter((l) => l.po);
    const pos = [...new Set(withPo.map((l) => l.po))].sort();
    const ordered = withPo.reduce((a, l) => a + (+l.po_qty || 0), 0);
    const seen = new Set(); let got = 0;
    for (const l of withPo) { const k = l.po + '|' + l.code; if (!seen.has(k)) { seen.add(k); got += received(l.po, l.code); } }
    const prDate = minOf(lines.map((l) => l.pr_date)), poDate = minOf(lines.map((l) => l.po_date));
    const s = ss.get(pr);
    const allCancelled = statuses.length > 0 && statuses.every((x) => CANCELLED.has(x));
    let stage;
    if (allCancelled) stage = 'Cancelled';
    else if (!pos.length) stage = statuses.length ? 'PR ' + statuses.join(', ') : 'PR';
    else if (ordered > 0 && got >= ordered) stage = 'Received';
    else if (got > 0) stage = 'Partly received';
    else if (poDate) stage = 'PO issued';
    else stage = 'PO in draft';
    const currency = (lines.find((l) => l.currency && String(l.currency).trim()) || {}).currency || null;
    const groups = pos.map((p) => poGroup.get(p)).filter(Boolean).join(' ').toUpperCase();
    const foreign = (currency != null && currency !== 'MVR') || groups.includes('USD') || groups.includes('EUR');
    const supplier = (s && s.vendor) || (lines.find((l) => l.supplier) || {}).supplier || pos.map((p) => poSupplier.get(p)).find(Boolean) || null;
    const lastReceipt = maxOf(withPo.map((l) => recLast.get(l.po + '|' + (l.code || ''))));
    const finished = statuses.length > 0 && statuses.every((x) => FINISHED.has(x) || CANCELLED.has(x));
    const pbu = (lines.find((l) => l.pbu) || {}).pbu || null;
    const o = {
      pr, prDate, po: pos.join(', ') || null, pos, poDate, supplier, pbu, unit: unitOf(pbu), statuses: statuses.join(', ') || null, statusSet: new Set(statuses),
      stage, cpStatus: s ? s.status : null, cpCode: s ? s.cpCode : null, title: s ? s.title : null, completion: s ? s.completion : null, lines: lines.length,
      firstItem: (lines.find((l) => l.description) || {}).description || null, orderedQty: ordered > 0 ? ordered : null,
      receivedQty: got > 0 ? got : null, lastReceipt, expected: minOf(lines.map((l) => l.expected)), currency, foreignVendor: foreign,
      isOpen: !(stage === 'Received' || stage === 'Cancelled' || finished),
    };
    o.search = [pr, supplier, s && s.cpCode, s && s.title, ...pos, ...lines.flatMap((l) => [l.code, l.description])].filter(Boolean).join(' ').toLowerCase();
    orders.set(pr, o);
  }
  const orderList = [...orders.values()].sort((a, b) => (b.prDate || '').localeCompare(a.prDate || ''));
  const unitCounts = new Map();
  for (const o of orderList) unitCounts.set(o.unit, (unitCounts.get(o.unit) || 0) + 1);

  // planning (Master Sheet) and prices
  const planning = new Map();
  for (const p of planningRows) planning.set(p.code, p);
  const prices = new Map();
  for (const p of priceRows) prices.set(p.code, p);

  // stock-maintained items, for availability and the Stock tab
  const maintained = [];
  for (const p of planning.values()) {
    if (String(p.stock_maintained || '').trim().toUpperCase() !== 'YES') continue;
    const it = items.get(p.code) || { code: p.code, description: p.code, mainWh: 0, igmh: 0, onOrder: 0, total: 0 };
    const avail = (it.mainWh || 0) + (it.igmh || 0);
    const lower = +p.lower_stock || 0;
    const out = avail <= 0, below = lower > 0 && avail < lower, onOrder = (it.onOrder || 0) > 0;
    const needs = (out || below) && !onOrder;
    const state = needs ? 'needs' : out ? 'out_on_order' : below ? 'below_on_order' : 'ok';
    maintained.push({ it, p, avail, lower, out, below, onOrder, needs, state, ess: String(p.essentiality || '').trim().toUpperCase(), sheet: p.sheet || '' });
  }
  const sheets = [...new Set(maintained.map((m) => m.sheet).filter(Boolean))];

  return { pack, items, stockBy, recByPo, received, ss, byPr, prsByCode, prsByPo, orders, orderList, unitCounts, planning, prices, maintained, sheets, hasPending: pending.length > 0 };
}

function availability() {
  if (!M.maintained.length) return null;
  const a = { items: 0, available: 0, mainWh: 0, igmh: 0, outOfStock: 0, outButOnOrder: 0, belowLower: 0, needs: 0 };
  for (const m of M.maintained) {
    a.items++;
    if (m.avail > 0) a.available++;
    if ((m.it.mainWh || 0) > 0) a.mainWh++;
    if ((m.it.igmh || 0) > 0) a.igmh++;
    if (m.out) { a.outOfStock++; if (m.onOrder) a.outButOnOrder++; }
    if (m.below) a.belowLower++;
    if (m.needs) a.needs++;
  }
  return a;
}

function followedPrs() {
  if (M.ss.size) {
    const done = ['completed', 'cancelled', 'deferred', 'closed'];
    const out = new Set();
    for (const [pr, v] of M.ss) { const s = (v.status || '').toLowerCase(); if (!done.some((d) => s.includes(d))) out.add(pr); }
    return out;
  }
  const teams = new Set(settings.pbus.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const t = today();
  return new Set(M.orderList.filter((o) => teams.has((o.pbu || '').toLowerCase()) && (daysBetween(o.prDate, t) ?? 0) <= 120).map((o) => o.pr));
}

function noticeOrders(rule, followed) {
  const t = today(), s = settings, hits = [];
  for (const o of M.orderList) {
    if (!followed.has(o.pr) || o.stage === 'Cancelled') continue;
    const st = o.statusSet, sincePr = daysBetween(o.prDate, t);
    if (rule === 'NO_PO') { if (!o.po && [...st].some((x) => ACTIVE.has(x)) && sincePr != null && sincePr >= s.noPoDays) hits.push([o, sincePr]); }
    else if (rule === 'APPROVAL') { if (!o.po && st.has('pending approval') && sincePr != null && sincePr >= s.approvalDays) hits.push([o, sincePr]); }
    else if (rule === 'PO_OVERDUE') {
      const sincePo = daysBetween(o.poDate, t), limit = o.foreignVendor ? s.foreignDays : s.localDays;
      if (o.po && sincePo != null && o.isOpen && o.stage !== 'Received' && sincePo > limit) hits.push([o, sincePo]);
    } else if (rule === 'PARTIAL') {
      const idle = daysBetween(o.lastReceipt, t);
      if (o.stage === 'Partly received' && o.isOpen && o.poDate && idle != null && idle >= s.partialDays) hits.push([o, idle]);
    }
  }
  return hits.sort((a, b) => b[1] - a[1]).map((h) => Object.assign(h[0], { days: h[1] }));
}

function recentReceipts(days = 7) {
  const since = new Date(Date.parse(today() + 'T00:00:00Z') - days * 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const rows of M.recByPo.values()) for (const r of rows) if (r.date && r.date >= since) out.push(r);
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (a.po || '').localeCompare(b.po || ''));
}

function itemStatus(it) { return (it.mainWh || 0) + (it.igmh || 0) > 0 ? 'in_stock' : (it.onOrder || 0) > 0 ? 'on_order' : 'out_of_stock'; }

// ------------------------------------------------------------------ navigation
const TABS = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'stock', label: 'Stock', icon: 'stock' },
  { id: 'products', label: 'Products', icon: 'products' },
  { id: 'orders', label: 'Orders', icon: 'orders' },
  { id: 'data', label: 'Data', icon: 'data' },
];
let lastTab = 'today';
const scrollMemo = new Map();
const ui = {
  stock: { f: 'needs', sheet: '', q: '', limit: 60 },
  products: { q: '' },
  orders: { q: '', open: true, rule: null, unit: store.get('unit', 'CDCP'), limit: 100 },
  allLoc: false, allBatch: false,
};

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [path, query] = h.split('?');
  const parts = path.split('/');
  return { name: parts[0] || 'today', arg: parts.slice(1).join('/'), query: new URLSearchParams(query || '') };
}
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
function back() { if (history.length > 1 && sessionStorage.getItem('qv.inapp')) history.back(); else go('#/' + lastTab); }

function renderTabs(active) {
  $('#tabs').innerHTML = TABS.map((t) => `<button type="button" class="${t.id === active ? 'on' : ''}" data-go="#/${t.id}" aria-label="${t.label}"><span class="ic">${icon(t.icon)}</span>${t.label}</button>`).join('');
}

function render() {
  const r = route();
  const key = location.hash || '#/today';
  const isTab = TABS.some((t) => t.id === r.name);
  if (isTab) lastTab = r.name;
  renderTabs(isTab ? r.name : lastTab);
  const v = $('#view');
  if (booting) { v.innerHTML = `<div class="loading"><div class="spinner"></div>Opening your data…</div>`; return; }
  try {
    if (r.name === 'p') v.innerHTML = viewProduct(r.arg);
    else if (r.name === 'o') v.innerHTML = viewOrder(r.arg);
    else if (r.name === 'stock') { if (r.query.get('f')) { ui.stock.f = r.query.get('f'); ui.stock.limit = 60; } v.innerHTML = viewStock(); }
    else if (r.name === 'products') v.innerHTML = viewProducts();
    else if (r.name === 'orders') { ui.orders.rule = r.query.get('rule') || null; v.innerHTML = viewOrders(); }
    else if (r.name === 'data') v.innerHTML = viewData();
    else v.innerHTML = viewToday();
  } catch (e) {
    console.error(e);
    v.innerHTML = `<div class="card"><div class="card-head"><div class="h"><h3>Something went wrong</h3><p>${esc(e.message || e)}</p></div></div><button class="btn secondary" data-go="#/data">Go to Data</button></div>`;
  }
  requestAnimationFrame(() => window.scrollTo(0, scrollMemo.get(key) || 0));
}

window.addEventListener('scroll', () => { scrollMemo.set(location.hash || '#/today', window.scrollY); }, { passive: true });
window.addEventListener('hashchange', () => { sessionStorage.setItem('qv.inapp', '1'); render(); });

// ------------------------------------------------------------------ shared bits of the screens
function title(text, extra = '') { return `<div class="title-row"><h1>${esc(text)}</h1>${extra}</div>`; }
function topbar(text, extra = '') { return `<div class="topbar"><button class="icon-btn" data-act="back" aria-label="Back">${icon('back')}</button><h2>${esc(text)}</h2>${extra || '<span style="width:44px"></span>'}</div>`; }
function card(head, body, opts = {}) {
  const h = head ? `<div class="card-head"><div class="h"><h3>${esc(head)}</h3>${opts.sub ? `<p>${esc(opts.sub)}</p>` : ''}</div>${opts.trail || ''}</div>` : '';
  return `<section class="card ${opts.cls || ''}">${h}${body}</section>`;
}
function noData() {
  return `<div class="hero-empty"><img src="icons/apple-touch-icon.png" alt=""><h2>No data yet</h2>
    <p>Load the Quick View data file from SharePoint to get started. Everything stays on this phone.</p>
    <button class="btn" data-act="pick">${icon('upload')}Load the data file</button></div>`;
}
function kv(k, v, tone) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v"${tone ? ` style="color:var(--${tone})"` : ''}>${v}</span></div>`; }
function orderRow(o, extra = '') {
  const meta2 = ['PR ' + show(o.prDate), o.poDate ? 'PO ' + show(o.poDate) : null, o.orderedQty != null ? `${fmtQty(o.receivedQty || 0)} of ${fmtQty(o.orderedQty)} received` : null].filter(Boolean).join(' · ');
  return `<button class="row" data-go="#/o/${encodeURIComponent(o.pr)}">
    <div class="main"><div class="t1 strong">${esc([o.pr, o.po].filter(Boolean).join('  ·  '))}</div>
    ${o.title ? `<div class="t strong">${esc(o.title)}</div>` : ''}
    <div class="t">${esc(o.firstItem || '-')}${o.lines > 1 ? ` <span class="muted">(+${o.lines - 1} more)</span>` : ''}</div>
    <div class="m">${esc([o.unit !== '-' ? o.unit : null, o.supplier || 'Supplier not set yet'].filter(Boolean).join(' · '))}</div><div class="m">${esc(meta2)}</div></div>
    <div class="end">${pill(o.stage, stageTone(o.stage))}${o.cpStatus ? pill(o.cpStatus, 'info') : ''}${extra}</div></button>`;
}

// ------------------------------------------------------------------ Today
function viewToday() {
  if (!M) return title('Today') + noData();
  const pk = M.pack;
  const stale = daysBetween(pk.made, today()) >= 2;
  let h = title('Today', `<button class="icon-btn" data-act="pick" aria-label="Load newer data">${icon('refresh')}</button>`);
  h += `<p class="sub">Data from ${esc(ago(pk.made))}${pk.made ? ' · ' + esc(showTime(pk.made)) : ''}</p>`;
  if (stale) h += `<div class="banner warn">${icon('warn')}<div>This data is ${esc(ago(pk.made))}. Load the newest file from SharePoint.</div><button class="act" data-act="pick">Load</button></div>`;

  const a = availability();
  if (!a) {
    h += card('Stock availability', `<p class="empty">The Master Sheet isn't in this data file, so availability of stock-maintained items can't be shown.</p>`);
  } else {
    h += card('Stock availability', `
      <div class="tiles">
        <button class="tile t-good" data-go="#/stock?f=all">${icon('chev', 'go')}<span class="v">${fmtPct(a.available, a.items)}</span><span class="l">Available</span><span class="s">${fmtQty(a.available)} of ${fmtQty(a.items)} items</span></button>
        <button class="tile t-bad" data-go="#/stock?f=out">${icon('chev', 'go')}<span class="v">${fmtQty(a.outOfStock)}</span><span class="l">Out of stock</span><span class="s">${fmtQty(a.outButOnOrder)} of them on order</span></button>
        <button class="tile t-info" data-go="#/stock?f=nomw">${icon('chev', 'go')}<span class="v">${fmtPct(a.mainWh, a.items)}</span><span class="l">Main warehouse</span><span class="s">in stock at SPW002</span></button>
        <button class="tile t-info" data-go="#/stock?f=noig">${icon('chev', 'go')}<span class="v">${fmtPct(a.igmh, a.items)}</span><span class="l">IGMH store</span><span class="s">in stock at SPW003</span></button>
      </div>
      <div class="pills" style="margin-top:12px">
        <button class="pill p-${a.needs ? 'bad' : 'good'}" data-go="#/stock?f=needs">${fmtQty(a.needs)} need a PR</button>
        <button class="pill p-${a.belowLower ? 'warn' : 'good'}" data-go="#/stock?f=below">${fmtQty(a.belowLower)} below lower stock level</button>
      </div>`, { sub: 'Stock-maintained items, from the Master Sheet · tap to see the items' });
  }

  const followed = followedPrs();
  const rows = RULES.map((r) => {
    const n = noticeOrders(r.id, followed).length;
    return `<button class="row" data-go="#/orders?rule=${r.id}"><div class="main"><div class="t1">${esc(r.title)}</div></div>${pill(fmtQty(n), n === 0 ? 'good' : r.tone)}</button>`;
  }).join('');
  h += card('Order notices', M.byPr.size ? `<div class="rows">${rows}</div>` : `<p class="empty">The PRs and POs report isn't in this data file.</p>`,
    { sub: M.ss.size ? 'Following the Status Sheet\'s PRs' : 'Following PRs of ' + settings.pbus.join(', ') });

  const rec = recentReceipts(7);
  const recRows = rec.slice(0, 10).map((r) => {
    const it = M.items.get(r.code);
    return `<button class="row" data-go="#/p/${encodeURIComponent(r.code || '')}"><div class="main"><div class="t">${esc(r.description || (it && it.description) || r.code || '-')}</div>
      <div class="m">${esc([r.po, show(r.date), r.supplier].filter(Boolean).join(' · '))}</div></div><span class="num">${fmtQty(r.qty)}</span></button>`;
  }).join('');
  h += card('Received in the last 7 days', rec.length ? `<div class="rows">${recRows}</div>` : `<p class="empty">Nothing received in the last 7 days.</p>`, { trail: pill(fmtQty(rec.length), 'info') });
  return h;
}

// ------------------------------------------------------------------ Stock (what's required)
const STOCK_FILTERS = [
  { id: 'needs', label: 'Needs a PR', test: (m) => m.needs },
  { id: 'out', label: 'Out of stock', test: (m) => m.out },
  { id: 'outorder', label: 'Out, on order', test: (m) => m.out && m.onOrder },
  { id: 'below', label: 'Below lower level', test: (m) => m.below },
  { id: 'nomw', label: 'Out at main warehouse', test: (m) => (m.it.mainWh || 0) <= 0 },
  { id: 'noig', label: 'Out at IGMH', test: (m) => (m.it.igmh || 0) <= 0 },
  { id: 'all', label: 'All', test: () => true },
];
const ESS = { E: 0, V: 1, N: 2 };
function stockList() {
  const f = STOCK_FILTERS.find((x) => x.id === ui.stock.f) || STOCK_FILTERS[0];
  const words = ui.stock.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = M.maintained.filter((m) => (!ui.stock.sheet || m.sheet === ui.stock.sheet) && f.test(m) &&
    (!words.length || words.every((w) => ((m.it.search || m.it.code.toLowerCase()) + ' ' + (m.p.supplier || '') + ' ' + (m.p.brand || '')).toLowerCase().includes(w))));
  const rank = { needs: 0, out_on_order: 1, below_on_order: 2, ok: 3 };
  list.sort((a, b) => rank[a.state] - rank[b.state] || (ESS[a.ess] ?? 3) - (ESS[b.ess] ?? 3) ||
    (a.lower ? a.avail / a.lower : 9) - (b.lower ? b.avail / b.lower : 9) || b.lower - a.lower || String(a.it.description).localeCompare(String(b.it.description)));
  return list;
}
function stockRow(m) {
  const it = m.it, p = m.p;
  const dot = m.needs ? 'bad' : m.out ? 'info' : m.below ? 'warn' : 'good';
  const z = (v) => `<b class="${(v || 0) <= 0 ? 'zero' : ''}">${fmtQty(v || 0)}</b>`;
  const status = m.needs ? pill('Needs a PR', 'bad') : m.out ? pill('Out, on order', 'info') : m.below ? pill('Below level, on order', 'warn') : pill('In stock', 'good');
  return `<button class="row srow" data-go="#/p/${encodeURIComponent(it.code)}"><span class="dot d-${dot}"></span><div class="main">
    <div class="t">${esc(it.description)}</div>
    <div class="m">${esc([it.code, p.supplier, m.ess ? 'Essentiality ' + m.ess : null].filter(Boolean).join(' · '))}</div>
    <div class="facts"><span>Main WH ${z(it.mainWh)}</span><span>IGMH ${z(it.igmh)}</span><span>On order <b>${fmtQty(it.onOrder || 0)}</b></span>${m.lower ? `<span>Lower level <b>${fmtQty(m.lower)}</b></span>` : ''}${p.pr_qty ? `<span>PR qty <b>${fmtQty(p.pr_qty)}</b></span>` : ''}</div>
    <div class="pills">${status}</div></div></button>`;
}
function stockResults() {
  const list = stockList();
  const shown = list.slice(0, ui.stock.limit);
  return `<p class="muted small" style="margin:2px 2px 8px">${fmtQty(list.length)} item${list.length === 1 ? '' : 's'}${list.length > shown.length ? ` · first ${shown.length} shown` : ''}</p>
    ${list.length ? `<section class="card list-card"><div class="rows">${shown.map(stockRow).join('')}</div>${list.length > shown.length ? `<button class="more" data-act="stockmore">Show more</button>` : ''}</section>` : `<section class="card"><p class="empty">Nothing here${ui.stock.q ? ' for that search' : ''}.</p></section>`}`;
}
function viewStock() {
  if (!M) return title('Stock') + noData();
  if (!M.maintained.length) return title('Stock') + card(null, `<p class="empty">The Master Sheet isn't in this data file, so stock-maintained items can't be listed.</p>`);
  const counts = {};
  for (const f of STOCK_FILTERS) counts[f.id] = M.maintained.filter((m) => (!ui.stock.sheet || m.sheet === ui.stock.sheet) && f.test(m)).length;
  let h = title('Stock', `<button class="icon-btn" data-act="copystock" aria-label="Copy this list">${icon('copy')}</button>`);
  h += `<p class="sub">Stock-maintained items · what needs ordering first</p>`;
  if (M.sheets.length > 1) {
    h += `<div class="seg">${['', ...M.sheets].map((s) => `<button type="button" class="${ui.stock.sheet === s ? 'on' : ''}" data-act="sheet" data-v="${esc(s)}">${esc(s ? s.replace('Lab & Consumables', 'Consumables').replace('Machine & Devices', 'Equipment') : 'All')}</button>`).join('')}</div>`;
  }
  h += `<div class="chips">${STOCK_FILTERS.map((f) => `<button type="button" class="chip ${ui.stock.f === f.id ? 'on' : ''}" data-act="sf" data-v="${f.id}">${esc(f.label)}<span class="c">${fmtQty(counts[f.id])}</span></button>`).join('')}</div>`;
  h += searchBox('stockq', ui.stock.q, 'Search these items, supplier, brand');
  h += `<div id="stockres">${stockResults()}</div>`;
  return h;
}
function searchBox(id, value, placeholder) {
  return `<div class="search">${icon('products', 'lens')}<input id="${id}" type="search" inputmode="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(value)}">${value ? `<button class="icon-btn clear" data-act="clear" data-v="${id}" aria-label="Clear">${icon('x')}</button>` : ''}</div>`;
}

// ------------------------------------------------------------------ Products
function searchItems(q, limit = 50) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const up = q.trim().toUpperCase();
  const out = [];
  for (const it of M.items.values()) if (words.every((w) => it.search.includes(w))) out.push(it);
  const r = (it) => (it.code === up || String(it.sto || '').toUpperCase() === up ? 0 : it.code.startsWith(up) ? 1 : 2);
  out.sort((a, b) => r(a) - r(b) || (((a.mainWh + a.igmh) === 0) - ((b.mainWh + b.igmh) === 0)) || a.description.length - b.description.length);
  return out.slice(0, limit);
}
function itemRow(it) {
  const st = itemStatus(it);
  return `<button class="row" data-go="#/p/${encodeURIComponent(it.code)}"><div class="main"><div class="t">${esc(it.description)}</div>
    <div class="m">${esc([it.code, it.sto ? 'STO ' + it.sto : null, it.uom].filter(Boolean).join(' · '))}</div></div>
    <div class="end">${pill(STOCK[st][0], STOCK[st][1])}<span class="num small">${fmtQty(it.mainWh + it.igmh)}</span></div></button>`;
}
function productResults() {
  const q = ui.products.q.trim();
  if (!q) {
    const recent = store.get('recent', []).map((c) => M.items.get(c)).filter(Boolean);
    return recent.length ? card('Recently opened', `<div class="rows">${recent.map(itemRow).join('')}</div>`, { cls: 'list-card' })
      : `<p class="muted" style="padding:8px 4px">Search by SPA code, STO code or name.</p>`;
  }
  const res = searchItems(q);
  return res.length ? `<section class="card list-card"><div class="rows">${res.map(itemRow).join('')}</div></section>` : `<section class="card"><p class="empty">No products match.</p></section>`;
}
function viewProducts() {
  if (!M) return title('Products') + noData();
  return title('Products') + searchBox('prodq', ui.products.q, 'SPA code, STO code or name') + `<div id="prodres">${productResults()}</div>`;
}

function viewProduct(code) {
  if (!M) return topbar(code) + noData();
  const it = M.items.get(code);
  if (!it) return topbar(code) + card(null, `<p class="empty">${esc(code)} isn't in the loaded data.</p>`);
  const recent = store.get('recent', []).filter((c) => c !== code); recent.unshift(code); store.set('recent', recent.slice(0, 12));
  const t = today();
  const st = itemStatus(it);
  const plan = M.planning.get(code);
  const mm = M.maintained.find((m) => m.it.code === code);
  let h = topbar(code);
  if (mm && mm.needs) h += `<div class="banner warn">${icon('warn')}<div><b>Needs a PR.</b> ${mm.out ? 'Out of stock' : 'Below the lower stock level'} and nothing is on order.</div></div>`;
  h += card(null, `<h2 style="margin:0 0 4px;font-size:22px;line-height:1.25">${esc(it.description)}</h2>
    <div class="muted">${esc([it.code, it.sto ? 'STO ' + it.sto : null, it.uom, it.group].filter(Boolean).join(' · '))}</div>
    <div class="pills" style="margin:10px 0 12px">${pill(STOCK[st][0], STOCK[st][1])}</div>
    <div class="tiles three">
      <div class="tile t-${it.mainWh > 0 ? 'good' : 'bad'}"><span class="v">${fmtQty(it.mainWh)}</span><span class="l">Main WH</span><span class="s">SPW002</span></div>
      <div class="tile t-${it.igmh > 0 ? 'good' : 'bad'}"><span class="v">${fmtQty(it.igmh)}</span><span class="l">IGMH</span><span class="s">SPW003</span></div>
      <div class="tile t-info"><span class="v">${fmtQty(it.onOrder)}</span><span class="l">On order</span><span class="s">&nbsp;</span></div>
    </div><p class="muted" style="margin:10px 0 0">All locations: ${fmtQty(it.total)} ${esc(it.uom || '')}</p>`);

  // where it is
  const rows = M.stockBy.get(code) || [];
  const locs = new Map(); let costQ = 0, costV = 0;
  const batches = [...rows].sort((a, b) => (a.expiry == null) - (b.expiry == null) || String(a.expiry || '').localeCompare(String(b.expiry || '')) || String(a.location_name || '').localeCompare(String(b.location_name || '')));
  for (const s of batches) {
    const lc = s.location_code || '';
    const name = MAIN_WH[lc] || s.location_name || lc;
    const es = expiryStatus(s.expiry, t), q = +s.qty || 0;
    const l = locs.get(lc) || { code: lc, name, isMain: lc in MAIN_WH, qty: 0, batches: 0, exp3: 0, expired: 0 };
    l.qty += q; l.batches++; if (es === 'short') l.exp3 += q; if (es === 'expired') l.expired += q;
    locs.set(lc, l);
    if (+s.unit_cost > 0) { costQ += q; costV += q * s.unit_cost; }
  }
  if (it.mainWh > 0 && !locs.has('SPW002')) locs.set('SPW002', { code: 'SPW002', name: 'Main warehouse', isMain: true, qty: it.mainWh, batches: 0, exp3: 0, expired: 0 });
  if (it.igmh > 0 && !locs.has('SPW003')) locs.set('SPW003', { code: 'SPW003', name: 'IGMH store', isMain: true, qty: it.igmh, batches: 0, exp3: 0, expired: 0 });
  const locList = [...locs.values()].sort((a, b) => b.isMain - a.isMain || b.qty - a.qty);
  const locShown = ui.allLoc ? locList : locList.slice(0, 8);
  h += card('Where it is', locList.length ? `<div class="rows">${locShown.map((l) => `<div class="row"><div class="main"><div class="t1"${l.isMain ? ' style="font-weight:700"' : ''}>${esc(l.name)}</div>
      <div class="pills" style="margin-top:3px"><span class="muted small">${esc(l.code)}</span>${l.exp3 > 0 ? pill(fmtQty(l.exp3) + ' under 3 months', 'bad') : ''}${l.expired > 0 ? pill(fmtQty(l.expired) + ' expired', 'bad') : ''}</div></div>
      <span class="num">${fmtQty(l.qty)}</span></div>`).join('')}</div>${!ui.allLoc && locList.length > 8 ? `<button class="more" data-act="allloc">Show all (${locList.length})</button>` : ''}`
    : `<p class="empty">No stock at any location.</p>`, { trail: pill(String(locList.length)) });

  // batches
  const bShown = ui.allBatch ? batches.slice(0, 300) : batches.slice(0, 6);
  h += card('Batches and expiry', batches.length ? `<div class="rows">${bShown.map((b) => {
    const es = expiryStatus(b.expiry, t);
    const name = MAIN_WH[b.location_code] || b.location_name || b.location_code;
    return `<div class="row"><div class="main"><div class="t1">${esc([b.batch, name].filter(Boolean).join(' · '))}</div>
      <div class="pills" style="margin-top:3px"><span class="muted small">${b.expiry ? esc(show(b.expiry)) : 'No expiry date'}</span>${pill(EXPIRY[es][0], EXPIRY[es][1])}</div></div><span class="num">${fmtQty(b.qty)}</span></div>`;
  }).join('')}</div>${!ui.allBatch && batches.length > 6 ? `<button class="more" data-act="allbatch">Show all (${batches.length})</button>` : ''}`
    : `<p class="empty">No batches in the loaded stock report.</p>`, { trail: pill(String(batches.length)) });

  // orders
  const prs = [...(M.prsByCode.get(code) || [])].map((p) => M.orders.get(p)).filter((o) => o && o.stage !== 'Cancelled')
    .sort((a, b) => (b.prDate || '').localeCompare(a.prDate || '')).slice(0, 30);
  h += card('Orders', prs.length ? `<div class="rows">${prs.map((o) => orderRow(o)).join('')}</div>` : `<p class="empty">No orders for this item in the loaded data.</p>`,
    { sub: `${prs.filter((o) => o.isOpen).length} open`, trail: pill(String(prs.length)) });

  // prices
  if (settings.showPrices) {
    const pr = M.prices.get(code);
    const unit = costQ > 0 ? costV / costQ : null;
    if (pr || unit != null || it.avgCost != null || it.lastCost != null) {
      const cost = unit ?? it.avgCost;
      const line = (label, v) => {
        const below = v != null && v > 0 && cost != null && cost > 0 && v < cost;
        return kv(label, fmtMoney(v) + (below ? ' ' + pill('Below cost', 'bad') : ''), below ? 'bad' : null);
      };
      h += card('Prices', line('General', pr && pr.general) + line('IGMH (Ithaa)', pr && pr.igmh) + line('MOH', pr && pr.moh) +
        `<div class="divider"></div>` + kv('Unit cost (stock)', fmtMoney(unit)) + kv('Average cost', fmtMoney(it.avgCost)) + kv('Last cost', fmtMoney(it.lastCost)));
    }
  }
  // planning
  if (plan) {
    const f = [['Stock maintained', plan.stock_maintained], ['Essentiality', plan.essentiality], ['Supplier', plan.supplier], ['Brand', plan.brand],
      ['Lead time (months)', plan.lead_time], ['Lower stock level', plan.lower_stock != null ? fmtQty(plan.lower_stock) : null],
      ['PR quantity', plan.pr_qty != null ? fmtQty(plan.pr_qty) : null], ['Stock status', plan.stock_status]];
    h += card('Planning', f.filter((x) => x[1] != null && x[1] !== '').map((x) => kv(x[0], esc(x[1]))).join(''), { sub: plan.sheet });
  }
  return h;
}

// ------------------------------------------------------------------ Orders
function unitMatch(o) {
  const u = ui.orders.unit;
  if (u === 'ALL') return true;
  if (u === 'CDCP') return o.unit === 'CD' || o.unit === 'CP';
  return o.unit === u;
}
function orderResults() {
  const s = ui.orders;
  let list, note = '';
  if (s.rule) {
    list = noticeOrders(s.rule, followedPrs()).filter(unitMatch);
  } else {
    const t = s.q.trim(), up = t.toUpperCase();
    let byNumber = null;
    if (up.startsWith('PR') || (up && /^\d+$/.test(up))) { const k = prKey(up); if (k) byNumber = (o) => o.pr === k; }
    else if (up.startsWith('PO')) { const k = poKey(up); if (k) byNumber = (o) => o.pos.some((p) => p.includes(k)); }
    if (byNumber) list = M.orderList.filter(byNumber);
    else {
      const words = t.toLowerCase().split(/\s+/).filter(Boolean);
      list = M.orderList.filter((o) => o.stage !== 'Cancelled' && (!s.open || o.isOpen) && unitMatch(o) && words.every((w) => o.search.includes(w)));
    }
  }
  const shown = list.slice(0, s.rule ? 300 : s.limit);
  if (!s.rule && list.length > shown.length) note = ` · newest ${shown.length} shown`;
  return `<p class="muted small" style="margin:2px 2px 8px">${fmtQty(list.length)} found${note}</p>` +
    (list.length ? `<section class="card list-card"><div class="rows">${shown.map((o) => orderRow(o, s.rule && o.days != null ? `<span class="muted small">${o.days} days</span>` : '')).join('')}</div>${!s.rule && list.length > shown.length ? `<button class="more" data-act="ordmore">Show more</button>` : ''}</section>`
      : `<section class="card"><p class="empty">No orders match.</p></section>`);
}
function viewOrders() {
  if (!M) return title('Orders') + noData();
  const s = ui.orders;
  const others = [...M.unitCounts.entries()].filter(([u]) => u !== 'CD' && u !== 'CP' && u !== '-').sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const units = [['CDCP', 'CD + CP'], ['CD', 'CD'], ['CP', 'CP'], ['ALL', 'All units'], ...others.map((u) => [u, u])];
  let h = title('Orders');
  h += `<div class="chips">${units.map(([id, label]) => `<button type="button" class="chip ${s.unit === id ? 'on' : ''}" data-act="unit" data-v="${esc(id)}">${esc(label)}</button>`).join('')}</div>`;
  if (s.rule) {
    const r = RULES.find((x) => x.id === s.rule);
    h += `<div class="chips"><button type="button" class="chip on" data-act="norule">${esc(r ? r.title : s.rule)} ${icon('x')}</button></div>`;
    h += `<p class="muted small" style="margin:-4px 2px 8px">Notice list · tap the chip to see all orders</p>`;
  } else {
    h += searchBox('ordq', s.q, 'PR or PO number, title, supplier, item…');
    h += `<label class="toggle-row"><span class="switch"><input type="checkbox" id="openonly" ${s.open ? 'checked' : ''}><span></span></span>Open only</label>`;
    const followed = followedPrs();
    h += `<div class="chips">${RULES.map((r) => { const n = noticeOrders(r.id, followed).filter(unitMatch).length; return `<button type="button" class="chip" data-act="rule" data-v="${r.id}">${esc(r.title)}<span class="c">${fmtQty(n)}</span></button>`; }).join('')}</div>`;
  }
  h += `<div id="ordres">${orderResults()}</div>`;
  return h;
}

function viewOrder(number) {
  if (!M) return topbar(number) + noData();
  const up = number.trim().toUpperCase();
  let pr, others = [];
  if (up.startsWith('PO')) {
    const po = poKey(up);
    const prs = [...(M.prsByPo.get(po) || [])].sort();
    pr = prs[0]; others = prs.slice(1);
  } else pr = prKey(up);
  const o = pr && M.orders.get(pr);
  if (!o) return topbar(number) + card(null, `<p class="empty">${esc(number)} isn't in the loaded data.</p>`);
  const lines = (M.byPr.get(pr) || []).map((l) => {
    const it = M.items.get(l.code);
    return { code: l.code, description: l.description || (it && it.description), uom: it && it.uom, reqQty: l.req_qty, po: l.po, poQty: l.po_qty,
      expected: l.expected, amount: settings.showPrices ? l.amount : null, received: l.po ? M.received(l.po, l.code) : null };
  });
  const recs = o.pos.flatMap((p) => M.recByPo.get(p) || []).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!others.length && o.pos.length) others = [...new Set(o.pos.flatMap((p) => [...(M.prsByPo.get(p) || [])]))].filter((x) => x !== pr).sort();

  let head = `<div class="pills" style="margin:0 0 8px">${pill(o.stage, stageTone(o.stage))}${o.cpStatus ? pill(o.cpStatus, 'info') : ''}${pill(o.foreignVendor ? 'Foreign' : 'Local')}${o.unit !== '-' ? pill(o.unit) : ''}</div>`;
  if (o.title) head += `<p style="margin:0 0 10px;font-weight:650;line-height:1.35">${esc(o.title)}</p>`;
  head += kv('PR', esc(o.pr)) + kv('PO', esc(o.po || 'Not yet')) + kv('Supplier', esc(o.supplier || '-')) + kv('Unit (PBU)', esc(o.pbu || '-')) + kv('PR date', show(o.prDate)) + kv('PO date', show(o.poDate));
  if (o.expected) head += kv('Expected', show(o.expected));
  head += kv('Last receipt', show(o.lastReceipt)) + kv('Entution status', esc(o.statuses || '-'));
  if (o.cpCode) head += kv('Status Sheet code', esc(o.cpCode));
  if (o.completion != null) head += kv('Completion', fmtQty(o.completion) + '%');
  head += kv('Currency', esc(o.currency || '-')) + kv('Lines', String(o.lines));
  if (o.orderedQty) {
    const got = o.receivedQty || 0;
    head += `<div class="progress"><i style="width:${Math.min(100, (got / o.orderedQty) * 100).toFixed(1)}%"></i></div><p class="muted small" style="margin:6px 0 0">${fmtQty(got)} of ${fmtQty(o.orderedQty)} received</p>`;
  }
  let h = topbar(number) + card(null, head);
  h += card('Items', `<div class="rows">${lines.slice(0, 300).map((l) => `<button class="row" ${l.code ? `data-go="#/p/${encodeURIComponent(l.code)}"` : ''}><div class="main">
      <div class="t">${esc(l.description || l.code || '-')}</div><div class="m">${esc([l.code, l.uom, l.po].filter(Boolean).join(' · '))}</div>${l.amount > 0 ? `<div class="m">${fmtMoney(l.amount)}</div>` : ''}</div>
      <div class="end">${l.po ? `<span class="num">${fmtQty(l.received || 0)} / ${fmtQty(l.poQty)}</span><span class="muted small">received</span>` : `<span class="num">${fmtQty(l.reqQty)}</span><span class="muted small">requested</span>`}</div></button>`).join('')}</div>
      ${lines.length > 300 ? '<p class="muted small">First 300 lines shown.</p>' : ''}`, { trail: pill(String(lines.length)) });
  h += card('Receipts', recs.length ? `<div class="rows">${recs.slice(0, 200).map((r) => {
    const it = M.items.get(r.code);
    return `<button class="row" data-go="#/p/${encodeURIComponent(r.code || '')}"><div class="main"><div class="t1">${esc(r.description || (it && it.description) || r.code || '-')}</div>
      <div class="m">${esc([show(r.date), r.po, r.code].filter(Boolean).join(' · '))}</div></div><span class="num">${fmtQty(r.qty)}</span></button>`;
  }).join('')}</div>` : `<p class="empty">Nothing received yet.</p>`, { trail: pill(String(recs.length)) });
  if (others.length) h += card('Also on the same PO', `<div class="rows">${others.slice(0, 30).map((x) => `<button class="row" data-go="#/o/${encodeURIComponent(x)}"><div class="main"><div class="t1">${esc(x)}</div></div>${icon('chev', 'go')}</button>`).join('')}</div>`);
  return h;
}

// ------------------------------------------------------------------ Data
function standalone() { return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; }
function viewData() {
  let h = title('Data');
  const link = (M && M.pack.sharepoint) || store.get('sharepoint', '');
  h += card('Get the latest data', `
    <p class="muted" style="margin:0 0 14px">The Planning App puts a fresh <b>Quick View data.spqv</b> in the SharePoint Quick View folder after each run. Load it here; it stays on this phone.</p>
    <div class="btns">
      <button class="btn" data-act="pick">${icon('upload')}Load the data file</button>
      ${link ? `<button class="btn secondary" data-act="openlink">${icon('link')}Open the SharePoint folder</button>` : ''}
    </div>
    <ol class="steps">
      <li>Tap <b>Load the data file</b>, then <b>Browse</b> › <b>OneDrive</b>.</li>
      <li>Open the APP folder (under Shared, or My files if you added a shortcut) › <b>Quick View</b> › tap the file.</li>
      <li>Next time the picker usually opens in that folder: one tap.</li>
    </ol>
    <p class="muted small" style="margin:10px 0 0">No OneDrive app? Use <b>Open the SharePoint folder</b>, download the file, then load it from Recents.</p>`);

  if (M) {
    const pk = M.pack;
    const old = daysBetween(pk.made, today()) >= 2;
    let b = kv('Made', esc(showTime(pk.made)) + ' ' + pill(ago(pk.made), old ? 'warn' : 'good'));
    if (pk.as_of) b += kv('Reports as of', show(pk.as_of));
    if (pk.by) b += kv('Made by', esc(pk.by));
    b += `<div class="divider"></div>`;
    b += `<div class="rows" style="margin:0 -18px">${(pk.imports || []).map((i) => `<div class="row"><div class="main"><div class="t1">${esc(i.title || i.kind)}</div>
      <div class="m">${esc([i.file, i.file_date ? ago(i.file_date) : null].filter(Boolean).join(' · '))}</div></div><span class="num small">${fmtQty(i.rows)} rows</span></div>`).join('')}</div>`;
    if (!(pk.imports || []).some((i) => i.kind === 'status_sheet')) b += `<p class="muted small" style="margin:6px 0 0">No Status Sheet in this file: notices follow the units chosen below.</p>`;
    h += card('On this phone', b);
  }

  if (!standalone()) {
    h += card('Put Quick View on your Home Screen', `<p class="muted" style="margin:0">In Safari tap ${icon('share', '')} <b>Share</b> › <b>Add to Home Screen</b>. It then opens full screen like an app, works offline and keeps your data.</p>`.replace('<svg class=""', '<svg style="width:18px;height:18px;vertical-align:-3px"'));
  }

  const s = settings;
  const num = (id, label, v) => `<div class="field"><label for="${id}">${label}</label><input type="number" inputmode="numeric" id="${id}" value="${v}" min="0" max="365"></div>`;
  h += card('Settings', `
    ${num('s_nopo', 'PR without a PO after (days)', s.noPoDays)}
    ${num('s_appr', 'PR waiting for approval after (days)', s.approvalDays)}
    ${num('s_local', 'Local PO delivery limit (days)', s.localDays)}
    ${num('s_foreign', 'Foreign PO delivery limit (days)', s.foreignDays)}
    ${num('s_partial', 'Partly received, idle for (days)', s.partialDays)}
    <div class="field col"><label for="s_pbus">Units (PBU) to follow when there's no Status Sheet, comma separated</label><input class="wide" type="text" id="s_pbus" value="${esc(s.pbus.join(', '))}"></div>
    <div class="field"><label for="s_prices">Show prices</label><span class="switch"><input type="checkbox" id="s_prices" ${s.showPrices ? 'checked' : ''}><span></span></span></div>
    <div class="field col"><label for="s_link">SharePoint folder link (filled in from the data file)</label><input class="wide" type="url" id="s_link" value="${esc(store.get('sharepoint', ''))}" placeholder="${esc((M && M.pack.sharepoint) || 'https://…sharepoint.com/…')}"></div>
    <button class="btn" data-act="save" style="margin-top:8px">Save</button>`, { sub: 'Order notices and what\'s shown' });

  if (M) h += card('Remove data', `<button class="btn danger" data-act="clearall">Remove all data from this phone</button>`);
  h += card('About', `<p style="margin:0;font-weight:650">StatePharma Quick View ${VERSION}</p><p class="muted" style="margin:4px 0 12px">Works offline. Your data stays on this phone; this page can't send it anywhere.</p>
    <button class="btn secondary" data-act="checkupdate">${icon('refresh')}Check for a new version</button>`);
  return h;
}

// ------------------------------------------------------------------ actions
async function loadFile(file) {
  if (!file) return;
  $('#view').innerHTML = `<div class="loading"><div class="spinner"></div>Reading ${esc(file.name)}…</div>`;
  try {
    const bytes = await file.arrayBuffer();
    const pack = await decode(bytes);
    const model = buildModel(pack);
    await DB.set('pack', new Uint8Array(bytes));
    await DB.set('meta', { name: file.name, loaded: new Date().toISOString(), made: pack.made });
    M = model;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    toast(`Loaded data from ${ago(pack.made)} (${showTime(pack.made)})`);
    scrollMemo.clear();
    go('#/today');
    render();
  } catch (e) {
    console.error(e);
    render();
    toast(e.message || String(e));
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}

const ACTIONS = {
  back,
  pick() { const p = $('#picker'); p.value = ''; p.click(); },
  openlink() { const l = (M && M.pack.sharepoint) || store.get('sharepoint', ''); if (l) window.open(l, '_blank', 'noopener'); },
  sf(el) { ui.stock.f = el.dataset.v; ui.stock.limit = 60; history.replaceState(null, '', '#/stock'); $('#view').innerHTML = viewStock(); },
  sheet(el) { ui.stock.sheet = el.dataset.v; ui.stock.limit = 60; $('#view').innerHTML = viewStock(); },
  stockmore() { ui.stock.limit += 100; $('#stockres').innerHTML = stockResults(); },
  copystock() {
    const list = stockList();
    const rows = [['SPA code', 'Description', 'Main WH', 'IGMH', 'On order', 'Lower level', 'PR qty', 'Supplier'].join('\t')]
      .concat(list.map((m) => [m.it.code, m.it.description, m.it.mainWh || 0, m.it.igmh || 0, m.it.onOrder || 0, m.lower || '', m.p.pr_qty || '', m.p.supplier || ''].join('\t')));
    copyText(rows.join('\n')).then(() => toast(`Copied ${list.length} items - paste into Excel or Teams`), () => toast('Couldn\'t copy on this phone'));
  },
  unit(el) { ui.orders.unit = el.dataset.v; store.set('unit', ui.orders.unit); ui.orders.limit = 100; $('#view').innerHTML = viewOrders(); },
  rule(el) { go('#/orders?rule=' + el.dataset.v); },
  norule() { ui.orders.rule = null; go('#/orders'); },
  ordmore() { ui.orders.limit += 100; $('#ordres').innerHTML = orderResults(); },
  allloc() { ui.allLoc = true; render(); },
  allbatch() { ui.allBatch = true; render(); },
  clear(el) {
    const id = el.dataset.v;
    if (id === 'stockq') { ui.stock.q = ''; $('#view').innerHTML = viewStock(); }
    if (id === 'prodq') { ui.products.q = ''; $('#view').innerHTML = viewProducts(); }
    if (id === 'ordq') { ui.orders.q = ''; $('#view').innerHTML = viewOrders(); }
    const inp = $('#' + id); if (inp) inp.focus();
  },
  save() {
    const n = (id, d) => { const v = parseInt($('#' + id).value, 10); return Number.isFinite(v) && v >= 0 ? v : d; };
    settings = {
      noPoDays: n('s_nopo', 5), approvalDays: n('s_appr', 3), localDays: n('s_local', 14), foreignDays: n('s_foreign', 30), partialDays: n('s_partial', 14),
      pbus: $('#s_pbus').value.split(',').map((x) => x.trim()).filter(Boolean), showPrices: $('#s_prices').checked,
    };
    store.set('settings', settings);
    store.set('sharepoint', $('#s_link').value.trim());
    toast('Saved');
    render();
  },
  async clearall() {
    if (!confirm('Remove all data from this phone? You can load the file again any time.')) return;
    await DB.del('pack'); await DB.del('meta'); M = null; store.set('recent', []);
    toast('Data removed'); go('#/today'); render();
  },
  async checkupdate() {
    if (!('serviceWorker' in navigator)) { toast('Updates come automatically when you open the page.'); return; }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { toast('You have the latest version'); return; }
    await reg.update().catch(() => {});
    setTimeout(() => { if (!waitingWorker) toast(`You have the latest version (${VERSION})`); }, 1500);
  },
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a && ACTIONS[a.dataset.act]) { e.preventDefault(); ACTIONS[a.dataset.act](a); return; }
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); if (g.closest('#tabs') && route().name === g.dataset.go.slice(2)) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; } go(g.dataset.go); }
});
let typing;
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'stockq' || id === 'prodq' || id === 'ordq') {
    clearTimeout(typing);
    typing = setTimeout(() => {
      if (id === 'stockq') { ui.stock.q = e.target.value; ui.stock.limit = 60; $('#stockres').innerHTML = stockResults(); }
      if (id === 'prodq') { ui.products.q = e.target.value; $('#prodres').innerHTML = productResults(); }
      if (id === 'ordq') { ui.orders.q = e.target.value; ui.orders.limit = 100; $('#ordres').innerHTML = orderResults(); }
    }, 160);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'openonly') { ui.orders.open = e.target.checked; $('#ordres').innerHTML = orderResults(); }
  if (e.target.id === 'picker') loadFile(e.target.files && e.target.files[0]);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[type=search]')) e.target.blur(); });

// ------------------------------------------------------------------ new versions of the page
let waitingWorker = null;
function offerUpdate(w) {
  waitingWorker = w;
  $('#update').hidden = false;
}
$('#updateBtn').addEventListener('click', () => { if (waitingWorker) waitingWorker.postMessage('skipWaiting'); else location.reload(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

// ------------------------------------------------------------------ start
let booting = true;
render();
(async () => {
  try {
    const bytes = await DB.get('pack');
    if (bytes) M = buildModel(await decode(bytes));
  } catch (e) {
    console.error(e);
    toast('The saved data couldn\'t be opened. Load the file again.');
  }
  booting = false;
  render();
})();
})();
