/* Sahara Bakers — Sale History (v2.1.0).
 * Counter sales list (SL-...) with date filter + search by bill no /
 * customer / cashier, bill detail view, re-print via sale-bill.js,
 * Void (DB.voidSale — row stays, VOID stamp, stock returns, sale
 * leaves every total) and Delete (Owner-only, DB.deleteSale — row
 * removed, snapshot in the Deleted Sales log). Voided bills show a
 * VOID stamp and are excluded from the totals footer (DB handles
 * totals; this UI only displays them). KOT re-print calls
 * window.Screens.Kot (Worker D) behind a typeof guard.
 * Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function notify(m, t) { window.App.notify(m, t); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }
function money(n) { return window.App.money(n); }
function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}
function billNo(sale) {
  try { if (DB.saleBillNo) return DB.saleBillNo(sale); } catch (e) { /* fall through */ }
  return 'SL-' + String(sale.saleNo == null ? (sale.id || '') : sale.saleNo).padStart(4, '0');
}
function typeLabel(sale) {
  try { if (window.App.saleOrderTypeLabel) return window.App.saleOrderTypeLabel(sale); } catch (e) { /* fall through */ }
  if (sale.note && String(sale.note).indexOf('Road Side') !== -1) return 'Road Side';
  if (sale.orderType === 'dine_in') return 'Dine-in' + (sale.tableNo != null ? ' — Table ' + sale.tableNo : '');
  if (sale.orderType === 'delivery') return 'Online Delivery';
  return 'Take Away';
}
function khataName(sale) {
  if (sale.customerId == null) return '';
  const c = (S().khataCustomers || []).find((x) => String(x.id) === String(sale.customerId));
  return c ? c.name : '';
}

var P = { date: '', q: '', selectedId: null, showDeleted: false };
var containerEl = null;

function filteredSales() {
  const q = String(P.q || '').trim().toLowerCase();
  return (S().sales || [])
    .slice()
    .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))
    .filter((s) => {
      if (P.date && String(s.occurredAt || '').slice(0, 10) !== P.date) return false;
      if (!q) return true;
      if (billNo(s).toLowerCase().indexOf(q) !== -1) return true;
      if (String(s.cashierName || '').toLowerCase().indexOf(q) !== -1) return true;
      if (khataName(s).toLowerCase().indexOf(q) !== -1) return true;
      return false;
    });
}

function renderSalesHistory(container) {
  containerEl = container;
  container.innerHTML = '';
  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Sale History</h1></div>'));
  wrap.appendChild(el('<p class="muted">Counter sales (SL-…) — bill dekhein, dobara print karein, void ya delete karein. Void bills par VOID stamp lagta hai aur wo totals se bahar ho jate hain.</p>'));
  wrap.appendChild(el('<div id="sh-detail"></div>'));
  wrap.appendChild(el('<div id="sh-list"></div>'));
  wrap.appendChild(el('<div id="sh-deleted"></div>'));
  container.appendChild(wrap);
  drawDetail();
  drawList();
  drawDeleted();
}

function drawDetail() {
  const host = containerEl && containerEl.querySelector('#sh-detail');
  if (!host) return;
  host.innerHTML = '';
  if (P.selectedId == null) return;
  const bill = DB.getSaleBill ? DB.getSaleBill(P.selectedId) : null;
  if (!bill || !bill.sale) { P.selectedId = null; return; }
  const sale = bill.sale;
  const card = el('<div class="card"><h2>Bill Detail — ' + esc(billNo(sale)) + (sale.voidedAt ? ' <span class="void-stamp">VOID</span>' : '') + '</h2></div>');
  const lines = (bill.lines || []).map((l) =>
    '<tr><td>' + esc(l.name) + '</td><td>' + l.quantity + ' ' + esc(l.unit || '') + '</td><td>' + money(l.unitPrice) + '</td><td><b>' + money((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0)) + '</b></td></tr>'
  ).join('');
  card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>' + lines + '</tbody></table></div>'));
  const khata = khataName(sale);
  const infoRows = [
    ['Order Type', typeLabel(sale)],
    ['Order No (shift)', sale.orderNo == null ? '—' : String(sale.orderNo)],
    ['Cashier', sale.cashierName || '—'],
    ['Location', sale.branchId == null ? 'Warehouse Counter' : window.App.branchName(sale.branchId)],
    ['Date/Time', fmtDateTime(sale.occurredAt)],
    ['Payment', sale.paymentMethod || '—'],
    ['Khata Customer', khata || '—'],
    ['Subtotal', money(sale.subtotal)],
    ['Discount', '− ' + money(sale.discount)],
    ['Delivery Charges', money(sale.deliveryCharges)],
    ['Service Charge', money(sale.serviceCharge)],
    ['Total', money(sale.total)],
    ['Amount Paid', money(sale.amountPaid)],
    ['Balance Due', money(Math.max(0, (Number(sale.total) || 0) - (Number(sale.amountPaid) || 0)))],
    ['Note', sale.note || '—'],
  ].map((kv) => '<tr><td><b>' + esc(kv[0]) + '</b></td><td>' + esc(kv[1]) + '</td></tr>').join('');
  card.appendChild(el('<div class="table-wrap"><table><tbody>' + infoRows + '</tbody></table></div>'));
  if (sale.voidedAt) {
    card.appendChild(el('<p><b>Voided:</b> ' + esc(fmtDateTime(sale.voidedAt)) + (sale.voidedBy ? ' — ' + esc(sale.voidedBy) : '') + ' — stock wapas aa gaya, sale totals se bahar hai.</p>'));
  }
  const actions = el('<div class="form-actions"></div>');
  const reprintBtn = el('<button type="button" class="btn btn-primary">Re-print Bill</button>');
  reprintBtn.addEventListener('click', () => {
    if (window.Screens && window.Screens.SaleBill) window.Screens.SaleBill.showBill(sale.id);
    else if (window.App.showSaleBill) window.App.showSaleBill(sale.id);
  });
  actions.appendChild(reprintBtn);
  const kotBtn = el('<button type="button" class="btn">Print KOT</button>');
  kotBtn.addEventListener('click', () => {
    if (window.Screens && window.Screens.Kot && typeof window.Screens.Kot.printKot === 'function') window.Screens.Kot.printKot(sale.id);
    else notify('Issue — KOT abhi tayyar nahi hai — kitchen ticket baad mein aayega', 'error');
  });
  actions.appendChild(kotBtn);
  if (!sale.voidedAt) {
    const voidBtn = el('<button type="button" class="btn">Void Sale</button>');
    voidBtn.addEventListener('click', async () => {
      const ok = await window.App.confirmDialog('Sale Void Karein?', billNo(sale) + ' void ho jayegi — stock wapas aa jayega aur sale totals se bahar ho jayegi. Ye record rehta hai, delete nahi hota.');
      if (!ok) return;
      const res = DB.voidSale(sale.id, window.App.user);
      if (!res.ok) { notify('Issue — ' + (res.message || 'Void nahi ho saki'), 'error'); return; }
      window.App.save();
      notify('Ho Gaya ✓ — Sale ' + billNo(sale) + ' void ho gayi — stock wapas aa gaya', 'success');
      drawDetail(); drawList();
    });
    actions.appendChild(voidBtn);
  }
  const delBtn = el('<button type="button" class="btn btn-danger">Delete Sale</button>');
  delBtn.addEventListener('click', async () => {
    if (!window.App.user || window.App.user.role !== 'Owner') {
      notify('Issue — Sirf Owner sale delete kar sakta hai.', 'error');
      return;
    }
    const ok = await window.App.confirmDialog('Sale Delete Karein?', billNo(sale) + ' hamesha ke liye delete ho jayegi — stock wapas aa jayega aur Deleted Sales log mein record rahega. Ye wapas nahi aayegi.');
    if (!ok) return;
    const res = DB.deleteSale(sale.id, window.App.user);
    if (!res.ok) { notify('Issue — ' + (res.message || 'Delete nahi ho saki'), 'error'); return; }
    window.App.save();
    P.selectedId = null;
    notify('Ho Gaya ✓ — Sale ' + billNo(sale) + ' delete ho gayi — Deleted Sales log mein record hai', 'success');
    drawDetail(); drawList(); drawDeleted();
  });
  actions.appendChild(delBtn);
  const backBtn = el('<button type="button" class="btn">Close</button>');
  backBtn.addEventListener('click', () => { P.selectedId = null; drawDetail(); });
  actions.appendChild(backBtn);
  card.appendChild(actions);
  host.appendChild(card);
}

function drawList() {
  const host = containerEl && containerEl.querySelector('#sh-list');
  if (!host) return;
  host.innerHTML = '';
  const card = el('<div class="card"><h2>Sales</h2></div>');
  // Filters: date + search.
  const filters = el('<div class="form-row"></div>');
  const dateIn = el('<input class="input" type="date" id="sh-date" value="' + esc(P.date) + '">');
  dateIn.addEventListener('change', () => { P.date = dateIn.value; drawList(); });
  const qIn = el('<input class="input" type="text" id="sh-q" placeholder="Search — bill no (SL-0001), customer ya cashier" value="' + esc(P.q) + '">');
  qIn.addEventListener('input', () => { P.q = qIn.value; drawListBody(); });
  const clearBtn = el('<button type="button" class="btn btn-sm">Clear</button>');
  clearBtn.addEventListener('click', () => { P.date = ''; P.q = ''; drawList(); });
  filters.appendChild(dateIn); filters.appendChild(qIn); filters.appendChild(clearBtn);
  card.appendChild(filters);
  card.appendChild(el('<div id="sh-list-body"></div>'));
  host.appendChild(card);
  drawListBody();
}
function drawListBody() {
  const body = containerEl && containerEl.querySelector('#sh-list-body');
  if (!body) return;
  body.innerHTML = '';
  const sales = filteredSales();
  // Totals footer — voided sales excluded (DB handles totals; the
  // UI only displays the non-voided sum of the filtered list).
  const live = sales.filter((s) => !s.voidedAt);
  const totalSum = live.reduce((a, s) => a + (Number(s.total) || 0), 0);
  body.appendChild(el('<p class="muted">Sales: <b>' + live.length + '</b> (voided: ' + (sales.length - live.length) + ') · Total (voided ke baghair): <b>' + money(totalSum) + '</b></p>'));
  if (sales.length === 0) {
    body.appendChild(el('<p class="muted">Koi sale nahi mili — date ya search badlein.</p>'));
    return;
  }
  const rows = sales.map((s) => {
    const khata = khataName(s);
    return '<tr><td><b>' + esc(billNo(s)) + '</b>' + (s.voidedAt ? ' <span class="void-stamp">VOID</span>' : '') + '</td>' +
      '<td>' + esc(typeLabel(s)) + '</td>' +
      '<td>' + esc(s.cashierName || '—') + (khata ? '<br><small>Khata: ' + esc(khata) + '</small>' : '') + '</td>' +
      '<td>' + esc(s.paymentMethod || '') + '</td>' +
      '<td><b>' + money(s.total) + '</b></td>' +
      '<td class="muted">' + esc(fmtDateTime(s.occurredAt)) + '</td>' +
      '<td><button type="button" class="btn btn-sm" data-view="' + esc(s.id) + '">Bill</button></td></tr>';
  }).join('');
  body.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Type</th><th>Cashier</th><th>Payment</th><th>Total</th><th>Date</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  body.querySelectorAll('button[data-view]').forEach((btn) => btn.addEventListener('click', () => {
    P.selectedId = btn.getAttribute('data-view');
    drawDetail();
    const d = containerEl.querySelector('#sh-detail');
    if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function drawDeleted() {
  const host = containerEl && containerEl.querySelector('#sh-deleted');
  if (!host) return;
  host.innerHTML = '';
  const card = el('<div class="card"><h2>Deleted Sales Log</h2></div>');
  const toggle = el('<button type="button" class="btn btn-sm">' + (P.showDeleted ? 'Chhupayein' : 'Dikhaein') + '</button>');
  toggle.addEventListener('click', () => { P.showDeleted = !P.showDeleted; drawDeleted(); });
  card.appendChild(toggle);
  if (P.showDeleted) {
    const dels = (S().deletedSales || []).slice().sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
    if (dels.length === 0) card.appendChild(el('<p class="muted">Koi deleted sale nahi hai.</p>'));
    else {
      const rows = dels.map((d) =>
        '<tr><td><b>SL-' + String(d.saleNo).padStart(4, '0') + '</b></td><td>' + esc(d.orderType || '') + '</td><td>' + esc(d.paymentMethod || '') + '</td><td><b>' + money(d.total) + '</b></td><td>' + esc(d.deletedBy || '') + '</td><td class="muted">' + esc(fmtDateTime(d.deletedAt)) + '</td></tr>'
      ).join('');
      card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Type</th><th>Payment</th><th>Total</th><th>Deleted By</th><th>Deleted At</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
  }
  host.appendChild(card);
}

window.Screens['sales-history'] = renderSalesHistory;
window.Screens.SalesHistory = renderSalesHistory;
})();
