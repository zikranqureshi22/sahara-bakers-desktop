/* Sahara Bakers — Sale Bill (v2.1.0).
 * 80mm thermal Sale Bill SL-0001... for a completed counter sale.
 * Follows the transfer-bill.js pattern exactly: the bill is shown in
 * the same preview modal (ui.js showBillPreviewHtml) and printed via
 * the same measured-height path (printReceiptHtml), so preview and
 * printed bill always match. Read-only — no sale record is changed.
 * Bill content: Bill No (SL-...), Order No (per-shift), order type +
 * table, cashier, date/time, location (Warehouse Counter / branch),
 * lines qty x price = line total (prices stamped at sale time),
 * subtotal, discount, delivery charges, service charge, total,
 * payment method, amount paid / balance due, Khata customer if any,
 * and a VOID stamp when the sale was voided.
 * Road Side is NOT a separate orderType (API freeze §c.1): a Road
 * Side sale is stored as orderType 'takeaway' with a 'Road Side'
 * note marker — the label below reads that marker back.
 * Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
/* Sahara circular logo as a base64 data URL (src/receipt-logo.js) —
 * prints offline, no file read at print time. Missing module = no
 * logo; the business-name text line is used instead so the bill never
 * loses its header. */
let RECEIPT_LOGO = '';
try { RECEIPT_LOGO = require('./receipt-logo.js'); } catch (e1) { try { RECEIPT_LOGO = require('./src/receipt-logo.js'); } catch (e2) { RECEIPT_LOGO = ''; } }
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function money(n) { return window.App.money(n); }
function esc(s) { return window.esc(s); }
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}
function saleBillNo(sale) {
  try { if (DB.saleBillNo) return DB.saleBillNo(sale); } catch (e) { /* fall through */ }
  return 'SL-' + String(sale.saleNo == null ? (sale.id || '') : sale.saleNo).padStart(4, '0');
}
/* Order-type label for display. Road Side is recognised from the
 * note marker (freeze §c.1), never from a separate orderType value. */
function orderTypeLabel(sale) {
  if (sale.note && String(sale.note).indexOf('Road Side') !== -1) return 'Road Side';
  if (sale.orderType === 'dine_in') return 'Dine-in' + (sale.tableNo != null ? ' — Table ' + sale.tableNo : '');
  if (sale.orderType === 'delivery') return 'Online Delivery';
  return 'Take Away';
}
function locationName(sale) {
  if (sale.branchId == null) return 'Warehouse Counter';
  try { if (window.App && window.App.branchName) return window.App.branchName(sale.branchId); } catch (e) { /* fall through */ }
  const b = (S().branches || []).find((x) => String(x.id) === String(sale.branchId));
  return b ? b.name : ('Branch ' + sale.branchId);
}
function khataCustomerName(sale) {
  if (sale.customerId == null) return '';
  const c = (S().khataCustomers || []).find((x) => String(x.id) === String(sale.customerId));
  return c ? c.name : '';
}

function resolveBill(saleIdOrSale) {
  if (!saleIdOrSale) return null;
  const id = (typeof saleIdOrSale === 'object') ? saleIdOrSale.id : saleIdOrSale;
  if (DB.getSaleBill) return DB.getSaleBill(id);
  return null;
}

function saleBillHtml(saleIdOrSale) {
  const bill = resolveBill(saleIdOrSale);
  if (!bill || !bill.sale) return '<div class="r-center r-bold">Sale nahi mili.</div>';
  const sale = bill.sale;
  const st = S();
  const lines = bill.lines || [];
  const logoHtml = RECEIPT_LOGO
    ? '<div class="r-center"><img class="r-logo" src="' + RECEIPT_LOGO + '" alt="Sahara Bakers"></div>'
    : '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>';
  const rows = lines.map((l) =>
    '<tr><td>' + esc(l.name) + '<br><small>' + l.quantity + ' × ' + money(l.unitPrice) + '</small></td>' +
    '<td class="r-right">' + money((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0)) + '</td></tr>'
  ).join('');
  const khataName = khataCustomerName(sale);
  const balanceDue = Math.max(0, (Number(sale.total) || 0) - (Number(sale.amountPaid) || 0));
  const khataBalance = (sale.paymentMethod === 'Khata' && sale.customerId != null && DB.khataBalance)
    ? DB.khataBalance(sale.customerId) : null;
  // The note line shows the Road Side marker as the order type
  // already; show any remaining note text without repeating it.
  const noteText = String(sale.note || '').replace(/^Road Side( — )?/, '').trim();
  return '' +
    logoHtml +
    '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center r-bold">Sale Bill</div>' +
    (sale.voidedAt
      ? '<div class="r-center r-void">VOID — YE BILL VOID HO CHUKA HAI</div>'
      : '') +
    '<div>Bill No: <b>' + esc(saleBillNo(sale)) + '</b></div>' +
    '<div>Order No: <b>' + esc(String(sale.orderNo == null ? '—' : sale.orderNo)) + '</b></div>' +
    '<div>Date: ' + esc(fmtDate(sale.occurredAt)) + '</div>' +
    '<div>Order Type: ' + esc(orderTypeLabel(sale)) + '</div>' +
    '<div>Location: ' + esc(locationName(sale)) + '</div>' +
    (sale.cashierName ? '<div>Cashier: ' + esc(sale.cashierName) + '</div>' : '') +
    (sale.recordedBy ? '<div>Recorded By: ' + esc(sale.recordedBy) + '</div>' : '') +
    (khataName ? '<div>Khata Customer: ' + esc(khataName) + '</div>' : '') +
    (noteText ? '<div>Note: ' + esc(noteText) + '</div>' : '') +
    '<div class="r-line"></div>' +
    '<table><thead><tr><th>Item</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="r-line"></div>' +
    '<table>' +
    '<tr><td>Subtotal</td><td class="r-right">' + money(sale.subtotal) + '</td></tr>' +
    '<tr><td>Discount</td><td class="r-right">− ' + money(sale.discount) + '</td></tr>' +
    '<tr><td>Delivery Charges</td><td class="r-right">' + money(sale.deliveryCharges) + '</td></tr>' +
    '<tr><td>Service Charge</td><td class="r-right">' + money(sale.serviceCharge) + '</td></tr>' +
    '<tr><td class="r-bold">TOTAL</td><td class="r-right r-bold">' + money(sale.total) + '</td></tr>' +
    '<tr><td>Payment: ' + esc(sale.paymentMethod || '') + '</td><td class="r-right">' + money(sale.amountPaid) + ' paid</td></tr>' +
    (balanceDue > 0 ? '<tr><td class="r-bold">Balance Due</td><td class="r-right r-bold">' + money(balanceDue) + '</td></tr>' : '') +
    (khataBalance != null ? '<tr><td>Khata Balance (total)</td><td class="r-right">' + money(khataBalance) + '</td></tr>' : '') +
    '</table>' +
    (sale.voidedAt
      ? '<div class="r-line"></div><div>Voided: ' + esc(fmtDate(sale.voidedAt)) + (sale.voidedBy ? ' — ' + esc(sale.voidedBy) : '') + '</div>'
      : '') +
    '<div class="r-line"></div>' +
    '<div class="r-center">Shukriya — phir tashreef laein</div>' +
    '<div class="r-center">Sahara Bakers</div>';
}

/* Show the sale bill in the SAME preview modal as other bills
 * (ui.js showBillPreviewHtml): the preview renders exactly what
 * printing uses. Accepts a sale id or a sale object (pos.js passes
 * the sale straight from DB.createSale — no second fetch). */
function showSaleBill(saleIdOrSale) {
  const bill = resolveBill(saleIdOrSale);
  if (!bill || !bill.sale) {
    if (window.App && window.App.notify) window.App.notify('Issue — Sale nahi mili', 'error');
    return false;
  }
  if (window.App.showBillPreviewHtml) {
    return window.App.showBillPreviewHtml(saleBillHtml(bill.sale), function () { return printSaleBill(bill.sale); });
  }
  return false;
}

/* Print via the SAME measured-height thermal path (ui.js
 * printReceiptHtml): 80mm wide, one page of exactly the bill height,
 * falling back to the print dialog when no printer is set. */
async function printSaleBill(saleIdOrSale) {
  const bill = resolveBill(saleIdOrSale);
  if (!bill || !bill.sale) return false;
  if (window.App.printReceiptHtml) return window.App.printReceiptHtml(saleBillHtml(bill.sale));
  return false;
}

window.Screens.SaleBill = { showBill: showSaleBill, printBill: printSaleBill };
window.App.showSaleBill = showSaleBill;
window.App.printSaleBill = printSaleBill;
window.App.saleBillHtml = saleBillHtml;
window.App.saleBillNo = saleBillNo;
window.App.saleOrderTypeLabel = orderTypeLabel;
})();
