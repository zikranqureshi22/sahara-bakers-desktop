/* Sahara Bakers — POS Dashboard (v2.1.0).
 * One day's counter sales: date picker (default today), totals +
 * bill list. Built ONLY against the frozen DB API (api-freeze.md
 * §4.9): DB.getPosDashboard / DB.salesInRange (subtotal + discount
 * are NOT in getPosDashboard's return, so they are summed here from
 * the same day's non-voided sales) / DB.getSaleBill / DB.saleBillNo.
 * NEVER shows cost/profit — web getPosDashboard (actions.ts:10050)
 * has none either. NO order-type breakdown on this screen (removed
 * per v50 cleanup) and NO Start/Close Shift buttons (they live on
 * the Sale screen / Shifts screen).
 * Bill click: shows the bill detail inline (DB.getSaleBill). If
 * Worker B's sale-bill module is loaded, its Print path is used
 * (guarded typeof checks); otherwise the built-in 80mm receipt
 * preview/print is used.
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
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(11, 16) || String(iso);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}

let dashDate = todayLocal();
let selectedSaleId = null;

/* 80mm sale-bill receipt (fallback print path, used only when Worker
 * B's sale-bill module is not loaded yet). */
function saleBillHtml(bill) {
  const st = S();
  const sale = bill.sale;
  const lines = bill.lines || [];
  const rows = lines.map((l) =>
    '<tr><td>' + esc(l.name || ('Item ' + l.itemId)) + '<br><small>Qty ' + l.quantity + ' ' + esc(l.unit || '') + ' · ' + money(l.unitPrice) + '</small></td>' +
    '<td class="r-right">' + money((Number(l.unitPrice) || 0) * (Number(l.quantity) || 0)) + '</td></tr>'
  ).join('');
  return '' +
    '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center r-bold">Sale Bill</div>' +
    '<div>Bill No: <b>' + esc(DB.saleBillNo ? DB.saleBillNo(sale) : ('SL-' + sale.saleNo)) + '</b></div>' +
    '<div>Date: ' + esc(fmtDateTime(sale.occurredAt)) + '</div>' +
    '<div>Order: ' + esc(orderLabel(sale.orderType)) + (sale.tableNo ? ' — Table ' + sale.tableNo : '') + '</div>' +
    '<div>Payment: ' + esc(sale.paymentMethod || '—') + '</div>' +
    (sale.cashierName ? '<div>Cashier: ' + esc(sale.cashierName) + '</div>' : '') +
    '<div class="r-line"></div>' +
    '<table><thead><tr><th>Item</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="r-line"></div>' +
    '<table>' +
    '<tr><td>Subtotal</td><td class="r-right">' + money(sale.subtotal) + '</td></tr>' +
    '<tr><td>Discount</td><td class="r-right">− ' + money(sale.discount) + '</td></tr>' +
    '<tr><td>Service Charge</td><td class="r-right">' + money(sale.serviceCharge) + '</td></tr>' +
    (sale.deliveryCharges ? '<tr><td>Delivery Charges</td><td class="r-right">' + money(sale.deliveryCharges) + '</td></tr>' : '') +
    '<tr><td class="r-bold">TOTAL</td><td class="r-right r-bold">' + money(sale.total) + '</td></tr>' +
    '</table>' +
    '<div class="r-line"></div>' +
    '<div class="r-center">Sahara Bakers — Shukriya</div>';
}

function renderPosDashboard(container) {
  container.innerHTML = '';
  const dash = DB.getPosDashboard({ date: dashDate });
  /* Subtotal + discount are not returned by getPosDashboard — sum
   * them from the same day's non-voided sales. */
  let subtotal = 0, discount = 0;
  DB.salesInRange(dashDate, dashDate).forEach((s) => {
    subtotal += Number(s.subtotal) || 0;
    discount += Number(s.discount) || 0;
  });

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>POS Dashboard</h1></div>'));
  wrap.appendChild(el('<p class="muted">Us din ki counter bikri — date chunein. Cost/profit yahan nahi dikhaye jate.</p>'));

  const filterCard = el('<div class="card"><h2>Date</h2></div>');
  const toolbar = el('<div class="toolbar">' +
    '<div class="field"><label>Date</label><input id="pd-date" class="input" type="date" value="' + esc(dashDate) + '"></div>' +
    '<div class="field"><label>&nbsp;</label><button type="button" class="btn btn-primary" id="pd-apply">Dekhein</button> <button type="button" class="btn" id="pd-today">Aaj (Today)</button></div>' +
    '</div>');
  filterCard.appendChild(toolbar);
  wrap.appendChild(filterCard);
  toolbar.querySelector('#pd-apply').addEventListener('click', () => {
    const v = toolbar.querySelector('#pd-date').value;
    if (!v) { notify('Issue — Date chunein', 'error'); return; }
    dashDate = v; selectedSaleId = null;
    renderPosDashboard(container);
  });
  toolbar.querySelector('#pd-today').addEventListener('click', () => {
    dashDate = todayLocal(); selectedSaleId = null;
    renderPosDashboard(container);
  });

  const stats = el('<div class="stat-grid"></div>');
  stats.appendChild(el('<div class="stat"><div class="stat-label">Kul Sale (Total Sales)</div><div class="stat-value">' + money(dash.totalSales) + '</div><div class="muted">' + esc(dashDate) + '</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Bills</div><div class="stat-value">' + dash.bills + '</div><div class="muted">kul bills us din</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Subtotal</div><div class="stat-value">' + money(subtotal) + '</div><div class="muted">discount se pehle</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Discounts</div><div class="stat-value">' + money(discount) + '</div><div class="muted">kul discount diya gaya</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Service Charge</div><div class="stat-value">' + money(dash.serviceCharge) + '</div><div class="muted">kul service charge</div></div>'));
  wrap.appendChild(stats);

  const payCard = el('<div class="card"><h2>Payment-wise — Payment Ke Hisaab Se</h2></div>');
  const payKeys = Object.keys(dash.byPayment || {});
  if (payKeys.length === 0) payCard.appendChild(el('<p class="muted">Is din koi sale nahi hui.</p>'));
  else {
    const rows = payKeys.map((k) => '<tr><td><b>' + esc(k) + '</b></td><td class="r-right"><b>' + money(dash.byPayment[k]) + '</b></td></tr>').join('');
    payCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Payment Method</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(payCard);

  /* ---------- Bill list for the day ---------- */
  const listCard = el('<div class="card"><h2>Bills — ' + esc(dashDate) + '</h2><p class="muted">Bill par click karein to uski detail khulegi.</p></div>');
  const bills = dash.sales || [];
  if (bills.length === 0) listCard.appendChild(el('<p class="muted">Is din koi bill nahi hai.</p>'));
  else {
    const rows = bills.map((b) =>
      '<tr class="pd-bill-row" data-sale="' + esc(b.id) + '" style="cursor:pointer"><td><b>' + esc(b.billNo || ('SL-' + b.saleNo)) + '</b></td>' +
      '<td>' + esc(fmtTime(b.time)) + '</td>' +
      '<td>' + esc(b.paymentMethod || '—') + '</td>' +
      '<td>' + esc(orderLabel(b.orderType)) + (b.tableNo ? ' — Table ' + b.tableNo : '') + '</td>' +
      '<td>' + esc(b.cashierName || '') + '</td>' +
      '<td class="r-right"><b>' + money(b.total) + '</b></td></tr>'
    ).join('');
    listCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Time</th><th>Payment</th><th>Order</th><th>Cashier</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    listCard.querySelectorAll('tr[data-sale]').forEach((tr) => tr.addEventListener('click', () => {
      selectedSaleId = Number(tr.getAttribute('data-sale'));
      renderPosDashboard(container);
    }));
  }
  wrap.appendChild(listCard);

  /* ---------- Bill detail (inline) ---------- */
  if (selectedSaleId != null) {
    const bill = DB.getSaleBill ? DB.getSaleBill(selectedSaleId) : null;
    const dCard = el('<div class="card"><h2>Bill Detail</h2></div>');
    if (!bill || !bill.sale) {
      dCard.appendChild(el('<p class="muted">Bill nahi mila.</p>'));
    } else {
      const sale = bill.sale;
      dCard.appendChild(el('<p><b>' + esc(DB.saleBillNo ? DB.saleBillNo(sale) : ('SL-' + sale.saleNo)) + '</b> — ' +
        esc(fmtDateTime(sale.occurredAt)) + ' — ' + esc(orderLabel(sale.orderType)) + (sale.tableNo ? ' — Table ' + sale.tableNo : '') +
        ' — ' + esc(sale.paymentMethod || '—') + (sale.cashierName ? ' — Cashier: ' + esc(sale.cashierName) : '') + '</p>'));
      const lines = bill.lines || [];
      if (lines.length === 0) dCard.appendChild(el('<p class="muted">Is bill ki lines nahi milin.</p>'));
      else {
        const rows = lines.map((l) =>
          '<tr><td>' + esc(l.name || ('Item ' + l.itemId)) + '</td><td><b>' + l.quantity + '</b> ' + esc(l.unit || '') + '</td><td class="r-right">' + money(l.unitPrice) + '</td><td class="r-right"><b>' + money((Number(l.unitPrice) || 0) * (Number(l.quantity) || 0)) + '</b></td></tr>'
        ).join('');
        dCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th class="r-right">Price</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
      }
      dCard.appendChild(el('<p>Subtotal: <b>' + money(sale.subtotal) + '</b> &nbsp; Discount: <b>' + money(sale.discount) + '</b> &nbsp; Service Charge: <b>' + money(sale.serviceCharge) + '</b>' +
        (sale.deliveryCharges ? ' &nbsp; Delivery: <b>' + money(sale.deliveryCharges) + '</b>' : '') +
        ' &nbsp; <b>Total: ' + money(sale.total) + '</b></p>'));
      if (sale.voidedAt) dCard.appendChild(el('<p><span class="low-tag">Void</span> — ye bill void hai, totals mein nahi gina gaya.</p>'));
      const actions = el('<div class="form-actions"></div>');
      const printBtn = el('<button type="button" class="btn btn-primary">Print Bill</button>');
      printBtn.addEventListener('click', () => {
        /* Worker B's sale-bill module wins when loaded; otherwise
         * the built-in 80mm receipt preview/print is used. */
        try {
          if (window.App && typeof window.App.showSaleBill === 'function') { window.App.showSaleBill(sale); return; }
        } catch (e) { /* fall through to built-in print */ }
        try {
          if (typeof window.Screens.SaleBill === 'function') {
            const r = window.Screens.SaleBill(sale);
            if (r !== false) return;
          }
        } catch (e) { /* fall through to built-in print */ }
        const html = saleBillHtml(bill);
        if (window.App.showBillPreviewHtml) {
          window.App.showBillPreviewHtml(html, function () { return window.App.printReceiptHtml(html); });
        } else {
          try { window.print(); } catch (e) { notify('Issue — Print nahi ho saka', 'error'); }
        }
      });
      const closeBtn = el('<button type="button" class="btn">Close Detail</button>');
      closeBtn.addEventListener('click', () => { selectedSaleId = null; renderPosDashboard(container); });
      actions.appendChild(printBtn); actions.appendChild(closeBtn);
      dCard.appendChild(actions);
    }
    wrap.appendChild(dCard);
  }

  container.appendChild(wrap);
}

window.Screens['pos-dashboard'] = renderPosDashboard;
window.Screens.PosDashboard = renderPosDashboard;
})();
