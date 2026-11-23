/* Sahara Bakers — KOT / Kitchen Order Ticket (v2.1.0).
 * Functions only — KOT has NO screen of its own. Worker B's pos.js
 * calls exactly this contract:
 *   window.Screens.Kot.printKot(saleId)      — KOT for one sale
 *   window.Screens.Kot.printLastKot()        — KOT for the latest sale
 * The KOT is a kitchen ticket: order no, order type / table, cashier,
 * time, lines qty × item, remarks (only when settings.kotRemarks is
 * on). NO prices anywhere on a KOT — the sale bill (with prices) is
 * Screens.SaleBill's job, never duplicated here.
 * Printing reuses the existing 80mm path (App.showBillPreviewHtml /
 * App.printReceiptHtml, same as transfer-bill.js), and honours
 * settings.kotEnabled — when KOT printing is off, a notice is shown
 * instead of printing. Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
/* Sahara circular logo as a base64 data URL (src/receipt-logo.js) —
 * prints offline, no file read at print time. Missing module = no
 * logo; the business-name text line is used instead so the KOT never
 * loses its header. */
let RECEIPT_LOGO = '';
try { RECEIPT_LOGO = require('./receipt-logo.js'); } catch (e1) { try { RECEIPT_LOGO = require('./src/receipt-logo.js'); } catch (e2) { RECEIPT_LOGO = ''; } }
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function notify(m, t) { window.App.notify(m, t); }
function esc(s) { return window.esc(s); }
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}

const ORDER_TYPE_LABELS = {
  takeaway: 'Take Away',
  dine_in: 'Dine-in',
  delivery: 'Online Delivery',
  roadside: 'Road Side'
};
function orderTypeLabel(t) {
  return ORDER_TYPE_LABELS[t] || String(t || '—');
}
function locationName(sale) {
  if (sale.branchId == null || sale.branchId === '') return 'Warehouse Counter';
  try {
    if (window.App && window.App.branchName) {
      const n = window.App.branchName(sale.branchId);
      if (n) return n;
    }
  } catch (e) { /* fall through to DB lookup */ }
  const b = (S().branches || []).find((x) => String(x.id) === String(sale.branchId));
  return b ? (b.name || '') : ('Branch ' + sale.branchId);
}

/* KOT HTML for one sale (or null when the sale does not exist).
 * Kitchen ticket only — no price, no total, no payment info. */
function kotHtml(saleId) {
  const bill = DB.getSaleBill ? DB.getSaleBill(saleId) : null;
  if (!bill || !bill.sale) return null;
  const sale = bill.sale;
  const st = S();
  const settings = st.settings || {};
  const showRemarks = settings.kotRemarks !== false; // default on
  const totalQty = (bill.lines || []).reduce((a, l) => a + (Number(l.quantity) || 0), 0);
  const logoHtml = RECEIPT_LOGO
    ? '<div class="r-center"><img class="r-logo" src="' + RECEIPT_LOGO + '" alt="Sahara Bakers"></div>'
    : '<div class="r-center r-bold">' + esc(settings.businessName || 'Sahara Bakers') + '</div>';
  const linesHtml = (bill.lines || []).map((l) =>
    '<tr><td><b>' + esc(l.name || 'Item') + '</b></td>' +
    '<td class="r-right"><b>× ' + esc(String(l.quantity)) + ' ' + esc(l.unit || '') + '</b></td></tr>'
  ).join('');
  return '' +
    logoHtml +
    '<div class="r-center r-bold">' + esc(settings.businessName || 'Sahara Bakers') + '</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center r-bold">KOT — KITCHEN ORDER TICKET</div>' +
    '<div>Order No: <b>#' + esc(sale.orderNo != null ? String(sale.orderNo) : '—') + '</b></div>' +
    '<div>Bill No: <b>' + esc(DB.saleBillNo ? DB.saleBillNo(sale) : ('SL-' + String(sale.saleNo || '').padStart(4, '0'))) + '</b></div>' +
    '<div>Order: ' + esc(orderTypeLabel(sale.orderType)) + (sale.tableNo != null ? ' · Table ' + esc(sale.tableNo) : '') + '</div>' +
    '<div>Date / Time: ' + esc(fmtDate(sale.occurredAt)) + '</div>' +
    (sale.cashierName ? '<div>Cashier: ' + esc(sale.cashierName) + '</div>' : '') +
    '<div>From: ' + esc(locationName(sale)) + '</div>' +
    '<div class="r-line"></div>' +
    '<table><tbody>' + linesHtml + '</tbody></table>' +
    '<div class="r-line"></div>' +
    '<table><tr><td class="r-bold">TOTAL QTY</td><td class="r-right r-bold">' + totalQty + '</td></tr></table>' +
    (showRemarks && sale.note
      ? '<div class="r-line"></div><div>Remarks: ' + esc(sale.note) + '</div>'
      : '') +
    '<div class="r-line"></div>' +
    '<div class="r-center">Kitchen copy — no prices</div>';
}

/* Print the KOT for one sale. Respects settings.kotEnabled. */
function printKot(saleId) {
  const settings = (S().settings || {});
  if (settings.kotEnabled === false) {
    notify('Issue — KOT print band hai — Settings Hub (POS Settings) se KOT print on karein', 'error');
    return false;
  }
  const html = kotHtml(saleId);
  if (!html) {
    notify('Issue — Sale nahi mili — KOT print nahi ho saka', 'error');
    return false;
  }
  if (window.App.showBillPreviewHtml) {
    return window.App.showBillPreviewHtml(html, function () { return window.App.printReceiptHtml(html); });
  }
  return false;
}

/* Print the KOT for the latest (most recent, non-voided) sale. */
function printLastKot() {
  const sales = ((S().sales || []).filter((s) => !s.voidedAt)).slice()
    .sort((a, b) => Number(b.id) - Number(a.id));
  if (sales.length === 0) {
    notify('Issue — Abhi tak koi sale nahi hui — KOT print karne ke liye pehle sale karein', 'error');
    return false;
  }
  return printKot(sales[0].id);
}

window.Screens.Kot = {
  printKot: printKot,
  printLastKot: printLastKot,
  kotHtml: kotHtml
};
/* Same functions on App, like transfer-bill.js does for its bill. */
window.App.printKot = printKot;
window.App.printLastKot = printLastKot;
window.App.kotHtml = kotHtml;
})();
