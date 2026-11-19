/* Sahara Bakers — Branch Transfer Bill (v2.0.0).
 * When stock goes from the Warehouse (godown) to a branch, a thermal
 * bill is generated: shown automatically as a preview modal right
 * after the transfer is created (same flow as RARA), re-printable
 * later from the transfer history (Bill button).
 * The bill uses the 80mm thermal layout (Sahara circular logo on top,
 * 15px, measured-height printing) and the same preview modal + print
 * path (ui.js showBillPreviewHtml / printReceiptHtml), so preview and
 * printed bill always match.
 * Bill content: Bill No (SB-XXXX), date/time, From Warehouse → To
 * branch, Sent By, Received By, Issued By, then ALL items — Item |
 * Qty × Price = Line Total — then TOTAL ITEMS and GRAND TOTAL /
 * STOCK VALUE. Prices are the item's CURRENT price: a price that
 * is blank (null) is NEVER invented — the line shows the quantity and
 * no invented amount, and the bill carries a plain note so the Owner
 * knows to set the price in Items > Edit Item.
 * Read-only — no transfer record is ever changed.
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
function branchName(id) {
  // The Warehouse is a real location separate from the 3 branches:
  // its bill name is always "Warehouse", never a branch name. This
  // local check runs before the App.branchName fallback so the From
  // line can never read "Branch 1" even if the App helper is absent.
  if (String(id) === 'warehouse') return 'Warehouse';
  try {
    if (window.App && window.App.branchName) {
      const n = window.App.branchName(id);
      if (n) return n;
    }
  } catch (e) { /* fall through to DB lookup */ }
  const b = DB.branchById ? DB.branchById(id) : (S().branches || []).find((x) => String(x.id) === String(id));
  return b ? (b.name || '') : ('Branch ' + id);
}
function transferBillNo(t) {
  return 'SB-' + String(t.id == null ? '' : t.id).padStart(4, '0');
}
function transferDate(t) { return t.date || t.createdAt || t.timestamp || ''; }

function transferBillHtml(transfer) {
  const st = S();
  const vals = DB.transferBillValues
    ? DB.transferBillValues(transfer, st.products)
    : { rows: [], totals: { qty: 0, value: 0, valueKnown: true }, priceMissing: false };
  const logoHtml = RECEIPT_LOGO
    ? '<div class="r-center"><img class="r-logo" src="' + RECEIPT_LOGO + '" alt="Sahara Bakers"></div>'
    : '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>';
  const rows = vals.rows.map((r) =>
    '<tr><td>' + esc(r.name) + '<br><small>Qty ' + r.qty + ' ' + esc(r.unit || '') + (r.price != null ? ' · ' + money(r.price) : ' · price blank') + '</small></td>' +
    '<td class="r-right">' + (r.lineValue != null ? money(r.lineValue) : '—') + '</td></tr>'
  ).join('');
  return '' +
    logoHtml +
    '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center r-bold">Branch Transfer Bill</div>' +
    '<div>Bill No: <b>' + esc(transferBillNo(transfer)) + '</b></div>' +
    '<div>Date: ' + esc(fmtDate(transferDate(transfer))) + '</div>' +
    '<div>From: ' + esc(branchName(transfer.fromBranchId)) + '</div>' +
    '<div>To: ' + esc(branchName(transfer.toBranchId)) + '</div>' +
    (transfer.createdBy ? '<div>Sent By: ' + esc(transfer.createdBy) + '</div>' : '') +
    (transfer.issuedBy ? '<div>Issued By: ' + esc(transfer.issuedBy) + '</div>' : '') +
    (transfer.receivedBy ? '<div>Received By: ' + esc(transfer.receivedBy) + '</div>' : '') +
    '<div class="r-line"></div>' +
    '<table><thead><tr><th>Item</th><th class="r-right">Total</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="r-line"></div>' +
    '<table>' +
    '<tr><td class="r-bold">TOTAL ITEMS</td><td class="r-right r-bold">' + vals.totals.qty + '</td></tr>' +
    '<tr><td class="r-bold">GRAND TOTAL / STOCK VALUE</td><td class="r-right r-bold">' + (vals.totals.valueKnown ? money(vals.totals.value) : money(vals.totals.value) + ' *') + '</td></tr>' +
    '</table>' +
    (vals.priceMissing
      ? '<div class="r-line"></div><div>Note: kuch items ki price abhi blank hai — Product Details mein price set karein, warna total value poori nahi dikhegi. (* = kuch lines ki price blank hai)</div>'
      : '') +
    '<div class="r-line"></div>' +
    '<div class="r-center">Sahara Bakers — Godown Stock</div>';
}

/* Show the transfer bill in the SAME preview modal as other bills
 * (ui.js showBillPreviewHtml): the preview renders exactly what
 * printing uses. */
function showTransferBill(transfer) {
  if (!transfer) return false;
  if (window.App.showBillPreviewHtml) {
    return window.App.showBillPreviewHtml(transferBillHtml(transfer), function () { return printTransferBill(transfer); });
  }
  return false;
}

/* Print via the SAME measured-height thermal path (ui.js
 * printReceiptHtml): 80mm wide, one page of exactly the bill height,
 * falling back to the print dialog when no printer is set. */
async function printTransferBill(transfer) {
  if (!transfer) return false;
  if (window.App.printReceiptHtml) return window.App.printReceiptHtml(transferBillHtml(transfer));
  return false;
}

window.App.showTransferBill = showTransferBill;
window.App.printTransferBill = printTransferBill;
window.App.transferBillHtml = transferBillHtml;
window.App.transferBillNo = transferBillNo;
})();
