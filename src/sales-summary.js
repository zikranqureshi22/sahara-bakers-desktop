/* Sahara Bakers — Sales Summary (v2.1.0).
 * 3 tabs: Summary / Detailed / Breakdown. Date range (from/to) or a
 * single shift. Built ONLY against the frozen DB API (api-freeze.md
 * §4.9): DB.getSalesSummary / DB.salesInRange — plus read-only
 * DB.state.saleLines + products for the Breakdown tab, because the
 * freeze has NO getSalesBreakdown function (web getSalesBreakdown
 * actions.ts:9851 was not ported to db.js — see report note).
 * Tax is ALWAYS 0 — there is no tax system. Voided sales are excluded
 * from every total and counted separately; deleted sales come from
 * the deletedSales log via getSalesSummary. No cost/profit here.
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
function money(n) { return window.App.money(n); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }
function todayLocal() {
  try { if (DB._todayLocal) return DB._todayLocal(); } catch (e) { /* fall through */ }
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
function orderLabel(t) {
  if (t === 'takeaway') return 'Take Away';
  if (t === 'dine_in') return 'Dine-in';
  if (t === 'delivery') return 'Online Delivery';
  return t || '—';
}

let fromDate = todayLocal();
let toDate = todayLocal();
let shiftId = '';
let tab = 'summary';
let groupBy = 'item';

function salesInScope() {
  const sales = DB.salesInRange(fromDate, toDate);
  return shiftId ? sales.filter((s) => String(s.shiftId) === String(shiftId)) : sales;
}
function allSalesInScope() {
  const sales = DB.salesInRange(fromDate, toDate, undefined, { includeVoided: true });
  return shiftId ? sales.filter((s) => String(s.shiftId) === String(shiftId)) : sales;
}
/* Subtotal + discount are NOT in getSalesSummary's return, so they
 * are summed here from the same non-voided sales the summary uses. */
function subtotalDiscount() {
  let subtotal = 0, discount = 0;
  salesInScope().forEach((s) => {
    subtotal += Number(s.subtotal) || 0;
    discount += Number(s.discount) || 0;
  });
  return { subtotal, discount };
}
/* Breakdown rows (web getSalesBreakdown shape: label / qty / amount /
 * discount / total, sorted by amount desc). Item + category group
 * line-by-line (discount 0 at line level, web jaisa); payment /
 * order-type / cashier group sale-by-sale (amount = subtotal,
 * discount = sale discount, total = amount − discount). */
function breakdownRows() {
  const st = S();
  const sales = salesInScope();
  const saleIds = {};
  sales.forEach((s) => { saleIds[s.id] = true; });
  const products = {};
  (st.products || []).forEach((p) => { products[p.id] = p; });
  const linesBySale = {};
  (st.saleLines || []).forEach((l) => {
    if (!saleIds[l.saleId]) return;
    (linesBySale[l.saleId] = linesBySale[l.saleId] || []).push(l);
  });
  const map = {};
  function addRow(label, qty, amount, discount) {
    const cur = map[label] || { label: label, qty: 0, amount: 0, discount: 0, total: 0 };
    cur.qty += qty;
    cur.amount += amount;
    cur.discount += discount;
    cur.total = cur.amount - cur.discount;
    map[label] = cur;
  }
  if (groupBy === 'item' || groupBy === 'category') {
    sales.forEach((s) => {
      (linesBySale[s.id] || []).forEach((l) => {
        const p = products[l.itemId];
        const label = groupBy === 'category'
          ? ((p && p.category) || '—')
          : ((p && p.name) || ('Item ' + l.itemId));
        addRow(label, Number(l.quantity) || 0, (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0), 0);
      });
    });
  } else {
    sales.forEach((s) => {
      let qty = 0;
      (linesBySale[s.id] || []).forEach((l) => { qty += Number(l.quantity) || 0; });
      let label = '—';
      if (groupBy === 'payment') label = s.paymentMethod || '—';
      else if (groupBy === 'ordertype') label = orderLabel(s.orderType);
      else if (groupBy === 'cashier') label = s.cashierName || '—';
      addRow(label, qty, Number(s.subtotal) || 0, Number(s.discount) || 0);
    });
  }
  const rows = Object.keys(map).map((k) => map[k]);
  rows.sort((a, b) => b.amount - a.amount);
  return rows;
}

function renderSalesSummary(container) {
  container.innerHTML = '';
  const st = S();
  const shiftState = DB.getShiftState ? DB.getShiftState() : { openShift: null, history: [] };
  const allShifts = [];
  if (shiftState.openShift) allShifts.push(shiftState.openShift);
  (shiftState.history || []).forEach((h) => allShifts.push(h));

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Sales Summary</h1></div>'));
  wrap.appendChild(el('<p class="muted">Bikri ka hisaab — date ya shift chunein, phir tab dekhein. Void bills totals mein nahi aate.</p>'));

  /* ---------- Filter: date range + shift ---------- */
  const filterCard = el('<div class="card"><h2>Date / Shift Filter</h2></div>');
  const toolbar = el('<div class="toolbar">' +
    '<div class="field"><label>From Date</label><input id="ss-from" class="input" type="date" value="' + esc(fromDate) + '"></div>' +
    '<div class="field"><label>To Date</label><input id="ss-to" class="input" type="date" value="' + esc(toDate) + '"></div>' +
    '<div class="field"><label>Shift (optional)</label><select id="ss-shift" class="input">' +
    '<option value="">— Sab shifts (date range) —</option>' +
    allShifts.map((sh) => '<option value="' + esc(sh.id) + '"' + (String(sh.id) === String(shiftId) ? ' selected' : '') + '>' +
      esc((sh.cashierName || 'Cashier') + ' — ' + String(sh.startedAt || '').slice(0, 10) + (sh.status === 'open' ? ' (Open)' : ' (Closed)')) + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>&nbsp;</label><button type="button" class="btn btn-primary" id="ss-apply">Filter Lagayein</button> <button type="button" class="btn" id="ss-today">Aaj (Today)</button></div>' +
    '</div>');
  filterCard.appendChild(toolbar);
  wrap.appendChild(filterCard);
  toolbar.querySelector('#ss-shift').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) {
      const sh = allShifts.find((x) => String(x.id) === String(v));
      if (sh) {
        fromDate = String(sh.startedAt || '').slice(0, 10) || todayLocal();
        toDate = String(sh.endedAt || sh.startedAt || '').slice(0, 10) || todayLocal();
        toolbar.querySelector('#ss-from').value = fromDate;
        toolbar.querySelector('#ss-to').value = toDate;
      }
    }
  });
  toolbar.querySelector('#ss-apply').addEventListener('click', () => {
    const f = toolbar.querySelector('#ss-from').value;
    const t = toolbar.querySelector('#ss-to').value;
    if (!f || !t) { notify('Issue — From aur To date dono chunein', 'error'); return; }
    if (f > t) { notify('Issue — From date To date se baad ki nahi ho sakti', 'error'); return; }
    fromDate = f; toDate = t;
    shiftId = toolbar.querySelector('#ss-shift').value || '';
    renderSalesSummary(container);
  });
  toolbar.querySelector('#ss-today').addEventListener('click', () => {
    fromDate = todayLocal(); toDate = todayLocal(); shiftId = '';
    renderSalesSummary(container);
  });

  /* ---------- Tabs ---------- */
  const tabs = el('<div class="sum-tabs">' +
    '<button type="button" class="btn' + (tab === 'summary' ? ' btn-primary' : '') + '" data-tab="summary">Summary</button>' +
    '<button type="button" class="btn' + (tab === 'detailed' ? ' btn-primary' : '') + '" data-tab="detailed">Detailed — Bill List</button>' +
    '<button type="button" class="btn' + (tab === 'breakdown' ? ' btn-primary' : '') + '" data-tab="breakdown">Breakdown — Item-wise</button>' +
    '</div>');
  tabs.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.getAttribute('data-tab');
    renderSalesSummary(container);
  }));
  wrap.appendChild(tabs);

  if (tab === 'summary') {
    const sum = DB.getSalesSummary({ from: fromDate, to: toDate, shiftId: shiftId || undefined });
    const sd = subtotalDiscount();
    const stats = el('<div class="stat-grid"></div>');
    stats.appendChild(el('<div class="stat"><div class="stat-label">Bills</div><div class="stat-value">' + sum.bills + '</div><div class="muted">kul bills (void ke baghair)</div></div>'));
    stats.appendChild(el('<div class="stat"><div class="stat-label">Subtotal</div><div class="stat-value">' + money(sd.subtotal) + '</div><div class="muted">discount se pehle</div></div>'));
    stats.appendChild(el('<div class="stat"><div class="stat-label">Discount</div><div class="stat-value">' + money(sd.discount) + '</div><div class="muted">kul discount diya gaya</div></div>'));
    stats.appendChild(el('<div class="stat"><div class="stat-label">Service Charge</div><div class="stat-value">' + money(sum.serviceCharge) + '</div><div class="muted">kul service charge</div></div>'));
    stats.appendChild(el('<div class="stat"><div class="stat-label">Tax</div><div class="stat-value">' + money(0) + '</div><div class="muted">tax hamesha 0 — koi tax system nahi</div></div>'));
    stats.appendChild(el('<div class="stat"><div class="stat-label">Total Sales</div><div class="stat-value">' + money(sum.totalSales) + '</div><div class="muted">kul bikri (subtotal − discount + service charge)</div></div>'));
    wrap.appendChild(stats);

    const payCard = el('<div class="card"><h2>Payment-wise — Payment Ke Hisaab Se</h2></div>');
    const payKeys = Object.keys(sum.byPayment || {});
    if (payKeys.length === 0) payCard.appendChild(el('<p class="muted">Is range mein koi sale nahi hai.</p>'));
    else {
      const rows = payKeys.map((k) => '<tr><td><b>' + esc(k) + '</b></td><td class="r-right"><b>' + money(sum.byPayment[k]) + '</b></td></tr>').join('');
      payCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Payment Method</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    wrap.appendChild(payCard);

    const typeCard = el('<div class="card"><h2>Order Type-wise — Order Type Ke Hisaab Se</h2></div>');
    const typeKeys = Object.keys(sum.byOrderType || {});
    if (typeKeys.length === 0) typeCard.appendChild(el('<p class="muted">Is range mein koi sale nahi hai.</p>'));
    else {
      const rows = typeKeys.map((k) => '<tr><td><b>' + esc(orderLabel(k)) + '</b></td><td class="r-right"><b>' + money(sum.byOrderType[k]) + '</b></td></tr>').join('');
      typeCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Order Type</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    wrap.appendChild(typeCard);

    const voidCard = el('<div class="card"><h2>Void / Deleted — Void Aur Delete Kiye Gaye Bills</h2></div>');
    voidCard.appendChild(el('<p>Void bills: <b>' + sum.voidCount + '</b> — void amount: <b>' + money(sum.voidedTotal) + '</b> (totals mein nahi gine gaye)</p>'));
    voidCard.appendChild(el('<p>Deleted bills: <b>' + sum.deletedCount + '</b> — deleted amount: <b>' + money(sum.deletedTotal) + '</b> (Owner ne delete kiye)</p>'));
    wrap.appendChild(voidCard);
  }

  if (tab === 'detailed') {
    const sales = allSalesInScope().slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
    const dCard = el('<div class="card"><h2>Detailed — Har Bill</h2><p class="muted">Void bills mark hain — wo totals mein nahi aate.</p></div>');
    if (sales.length === 0) dCard.appendChild(el('<p class="muted">Is range mein koi bill nahi hai.</p>'));
    else {
      const rows = sales.map((s) => {
        const voided = !!s.voidedAt;
        return '<tr' + (voided ? ' class="void-row"' : '') + '><td><b>' + esc(DB.saleBillNo ? DB.saleBillNo(s) : ('SL-' + s.saleNo)) + '</b>' + (voided ? ' <span class="low-tag">Void</span>' : '') + '</td>' +
          '<td>' + esc(String(s.occurredAt || '').slice(0, 16).replace('T', ' ')) + '</td>' +
          '<td>' + esc(orderLabel(s.orderType)) + (s.tableNo ? ' — Table ' + s.tableNo : '') + '</td>' +
          '<td>' + esc(s.paymentMethod || '—') + '</td>' +
          '<td><b>' + money(s.total) + '</b></td>' +
          '<td>' + esc(s.cashierName || '') + '</td></tr>';
      }).join('');
      dCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Time</th><th>Order Type</th><th>Payment</th><th>Total</th><th>Cashier</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    wrap.appendChild(dCard);
  }

  if (tab === 'breakdown') {
    const bCard = el('<div class="card"><h2>Breakdown — Item-wise Bikri</h2></div>');
    const groupRow = el('<div class="toolbar"><div class="field"><label>Group By</label><select id="ss-group" class="input">' +
      '<option value="item"' + (groupBy === 'item' ? ' selected' : '') + '>Item</option>' +
      '<option value="category"' + (groupBy === 'category' ? ' selected' : '') + '>Category</option>' +
      '<option value="payment"' + (groupBy === 'payment' ? ' selected' : '') + '>Payment Method</option>' +
      '<option value="ordertype"' + (groupBy === 'ordertype' ? ' selected' : '') + '>Order Type</option>' +
      '<option value="cashier"' + (groupBy === 'cashier' ? ' selected' : '') + '>Cashier</option>' +
      '</select></div></div>');
    bCard.appendChild(groupRow);
    groupRow.querySelector('#ss-group').addEventListener('change', (e) => {
      groupBy = e.target.value;
      renderSalesSummary(container);
    });
    const rows = breakdownRows();
    if (rows.length === 0) bCard.appendChild(el('<p class="muted">Is range mein koi sale nahi hai.</p>'));
    else {
      const tQty = rows.reduce((a, r) => a + r.qty, 0);
      const tAmt = rows.reduce((a, r) => a + r.amount, 0);
      const tDisc = rows.reduce((a, r) => a + r.discount, 0);
      const tTot = rows.reduce((a, r) => a + r.total, 0);
      const body = rows.map((r) =>
        '<tr><td><b>' + esc(r.label) + '</b></td><td><b>' + r.qty + '</b></td><td class="r-right">' + money(r.amount) + '</td><td class="r-right">' + money(r.discount) + '</td><td class="r-right"><b>' + money(r.total) + '</b></td></tr>'
      ).join('');
      bCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>' + esc(groupBy === 'item' ? 'Item' : groupBy === 'category' ? 'Category' : groupBy === 'payment' ? 'Payment Method' : groupBy === 'ordertype' ? 'Order Type' : 'Cashier') + '</th><th>Qty</th><th class="r-right">Amount</th><th class="r-right">Discount</th><th class="r-right">Total</th></tr></thead><tbody>' + body +
        '<tr><td><b>Total</b></td><td><b>' + tQty + '</b></td><td class="r-right"><b>' + money(tAmt) + '</b></td><td class="r-right"><b>' + money(tDisc) + '</b></td><td class="r-right"><b>' + money(tTot) + '</b></td></tr>' +
        '</tbody></table></div>'));
      bCard.appendChild(el('<p class="muted">Amount = discount se pehle; Total = Amount − Discount. Item/Category rows mein discount 0 hota hai (discount bill-level hota hai).</p>'));
    }
    wrap.appendChild(bCard);
  }

  container.appendChild(wrap);
}

window.Screens['sales-summary'] = renderSalesSummary;
window.Screens.SalesSummary = renderSalesSummary;
})();
