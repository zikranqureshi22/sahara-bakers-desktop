/* Sahara Bakers — Reports (v2.0.0, Owner-only).
 * Production reports, branch reports and complete history, with a
 * date-range filter. Backup info is shown here too (the backup
 * actions themselves live in Settings). v2.1.0: CSV export per
 * table (Production PB, Transfers SB, Movements, Sales SL) via
 * Blob download, a Print button (window.print), and a new Sales
 * section (non-voided sales in range). Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function money(n) { return window.App.money(n); }
function notify(m, t) { window.App.notify(m, t); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }

// ---- CSV helpers (v2.1.0) ----
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach((r) => lines.push(r.map(csvCell).join(',')));
  return '\ufeff' + lines.join('\r\n');
}
function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function saleBillNo(s) {
  if (DB.saleBillNo) return DB.saleBillNo(s);
  return 'SL-' + String(s.saleNo || s.id || '').padStart(4, '0');
}
function transferBillNo(t) {
  if (window.App.transferBillNo) return window.App.transferBillNo(t);
  return 'SB-' + String(t.id || '').padStart(4, '0');
}
function csvStamp() { return new Date().toISOString().slice(0, 10); }

let fromDate = '';
let toDate = '';

function inRange(iso) {
  const d = String(iso || '').slice(0, 10);
  if (!d) return false;
  if (fromDate && d < fromDate) return false;
  if (toDate && d > toDate) return false;
  return true;
}

function renderReports(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const branches = st.branches || [];

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Reports</h1><span class="muted">Owner only</span></div>'));

  const filterRow = el('<div class="card"><h2>Date Filter</h2><div class="toolbar">' +
    '<div class="field"><label>From Date</label><input id="rep-from" class="input" type="date" value="' + esc(fromDate) + '"></div>' +
    '<div class="field"><label>To Date</label><input id="rep-to" class="input" type="date" value="' + esc(toDate) + '"></div>' +
    '<div class="field"><label>&nbsp;</label><button type="button" class="btn btn-primary" id="rep-apply">Filter Lagayein</button> <button type="button" class="btn" id="rep-clear">Clear</button></div>' +
    '</div></div>');
  wrap.appendChild(filterRow);

  const prods = (st.productions || []).filter((p) => !fromDate && !toDate ? true : inRange(p.date));
  const transfers = (st.transfers || []).filter((t) => !fromDate && !toDate ? true : inRange(t.date));
  const moves = (st.stockMovements || []).filter((m) => !fromDate && !toDate ? true : inRange(m.date));
  // v2.1.0 — Sales section: non-voided sales in range (frozen DB.salesInRange).
  const sales = DB.salesInRange
    ? DB.salesInRange(fromDate || null, toDate || null)
    : (st.sales || []).filter((s) => !s.voidedAt && (!fromDate && !toDate ? true : inRange(s.occurredAt)));

  // ---- Export + Print toolbar (v2.1.0) ----
  const exportRow = el('<div class="card"><h2>Export / Print</h2><p class="muted">CSV Excel mein khulta hai. Print se report print ya "Save as PDF" karein.</p><div class="btn-row">' +
    '<button type="button" class="btn btn-primary" id="rep-print">Print</button>' +
    '<button type="button" class="btn" id="rep-csv-production">Production CSV</button>' +
    '<button type="button" class="btn" id="rep-csv-transfers">Transfers CSV</button>' +
    '<button type="button" class="btn" id="rep-csv-movements">Movements CSV</button>' +
    '<button type="button" class="btn" id="rep-csv-sales">Sales CSV</button>' +
    '</div></div>');
  wrap.appendChild(exportRow);
  exportRow.querySelector('#rep-print').addEventListener('click', () => { window.print(); });
  exportRow.querySelector('#rep-csv-production').addEventListener('click', () => {
    downloadCsv('sahara-production-' + csvStamp() + '.csv', toCsv(
      ['Bill No', 'Finish', 'Finish Qty', 'Raw Used', 'Total Cost', 'Cost Known', 'Created By', 'Date'],
      prods.map((pr) => [pr.billNo || '', pr.finishName || '', pr.finishQty, (pr.lines || []).map((l) => (l.name || '') + ' ' + l.qty + ' ' + (l.unit || '')).join('; '), pr.totalCost, pr.costKnown ? 'Yes' : 'No', pr.createdBy || '', String(pr.date || '').slice(0, 10)])
    ));
    notify('Ho Gaya ✓ — Production CSV download ho gaya (' + prods.length + ' rows)', 'success');
  });
  exportRow.querySelector('#rep-csv-transfers').addEventListener('click', () => {
    downloadCsv('sahara-transfers-' + csvStamp() + '.csv', toCsv(
      ['Bill No', 'From', 'To', 'Items', 'Total Qty', 'Sent By', 'Date'],
      transfers.map((t) => [transferBillNo(t), window.App.branchName(t.fromBranchId), window.App.branchName(t.toBranchId), (t.items || []).map((it) => { const p = products.find((x) => String(x.id) === String(it.productId)); return (p ? p.name : ('Item ' + it.productId)) + ' x ' + it.qty; }).join('; '), (t.items || []).reduce((a, it) => a + (Number(it.qty) || 0), 0), t.createdBy || '', String(t.date || '').slice(0, 10)])
    ));
    notify('Ho Gaya ✓ — Transfers CSV download ho gaya (' + transfers.length + ' rows)', 'success');
  });
  exportRow.querySelector('#rep-csv-movements').addEventListener('click', () => {
    downloadCsv('sahara-movements-' + csvStamp() + '.csv', toCsv(
      ['Item', 'Type', 'Qty', 'Branch', 'Reason', 'User', 'Date'],
      moves.map((m) => [m.productName || '', (Number(m.qty) || 0) > 0 ? 'In' : 'Out', Math.abs(Number(m.qty) || 0), window.App.branchName(m.branchId), m.reason || '', m.user || '', String(m.date || '').slice(0, 16).replace('T', ' ')])
    ));
    notify('Ho Gaya ✓ — Movements CSV download ho gaya (' + moves.length + ' rows)', 'success');
  });
  exportRow.querySelector('#rep-csv-sales').addEventListener('click', () => {
    downloadCsv('sahara-sales-' + csvStamp() + '.csv', toCsv(
      ['Bill No', 'Date', 'Order Type', 'Table', 'Payment', 'Subtotal', 'Discount', 'Delivery', 'Service Charge', 'Total', 'Cashier'],
      sales.map((s) => [saleBillNo(s), String(s.occurredAt || '').slice(0, 10), s.orderType || '', s.tableNo == null ? '' : s.tableNo, s.paymentMethod || '', s.subtotal, s.discount, s.deliveryCharges, s.serviceCharge, s.total, s.cashierName || ''])
    ));
    notify('Ho Gaya ✓ — Sales CSV download ho gaya (' + sales.length + ' rows)', 'success');
  });

  const stats = el('<div class="stat-grid"></div>');
  stats.appendChild(el('<div class="stat"><div class="stat-label">Productions (range)</div><div class="stat-value">' + prods.length + '</div><div class="muted">kul production cost ' + money(prods.reduce((a, p) => a + (Number(p.totalCost) || 0), 0)) + '</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Transfers (range)</div><div class="stat-value">' + transfers.length + '</div><div class="muted">kul ' + transfers.reduce((a, t) => a + (t.items || []).reduce((x, it) => x + (Number(it.qty) || 0), 0), 0) + ' units bheje gaye</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Stock Movements (range)</div><div class="stat-value">' + moves.length + '</div><div class="muted">complete history entries</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Sales (range)</div><div class="stat-value">' + sales.length + '</div><div class="muted">kul sales ' + money(sales.reduce((a, s) => a + (Number(s.total) || 0), 0)) + '</div></div>'));
  wrap.appendChild(stats);

  // ---- Production report ----
  const pCard = el('<div class="card"><h2>Production Report</h2></div>');
  if (prods.length === 0) pCard.appendChild(el('<p class="muted">Is range mein koi production nahi hai.</p>'));
  else {
    const rows = prods.map((pr) => {
      const used = (pr.lines || []).map((l) => esc(l.name) + ' ' + l.qty + ' ' + esc(l.unit || '')).join(', ');
      return '<tr><td><b>' + esc(pr.billNo || '') + '</b></td><td>' + esc(pr.finishName || '') + ' <b>' + pr.finishQty + ' ' + esc(pr.finishUnit || '') + '</b></td><td>' + used + '</td><td><b>' + (pr.costKnown ? money(pr.totalCost) : money(pr.totalCost) + ' *') + '</b></td><td>' + esc(pr.createdBy || '') + '</td><td class="muted">' + esc(String(pr.date || '').slice(0, 10)) + '</td></tr>';
    }).join('');
    pCard.appendChild(el('<div class="table-wrap"><table id="rep-production-table"><thead><tr><th>Bill No</th><th>Finish</th><th>Raw Used</th><th>Total Cost</th><th>Banane Wala</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(pCard);

  // ---- Sales report (v2.1.0) ----
  const sCard = el('<div class="card"><h2>Sales Report</h2></div>');
  if (sales.length === 0) sCard.appendChild(el('<p class="muted">Is range mein koi sale nahi hai.</p>'));
  else {
    const rows = sales.map((s) => '<tr><td><b>' + esc(saleBillNo(s)) + '</b></td><td>' + esc(s.orderType || '') + (s.tableNo != null ? ' · Table ' + s.tableNo : '') + '</td><td>' + esc(s.paymentMethod || '') + '</td><td>' + money(s.subtotal) + '</td><td>' + money(s.discount) + '</td><td>' + money(s.deliveryCharges) + '</td><td><b>' + money(s.total) + '</b></td><td>' + esc(s.cashierName || '') + '</td><td class="muted">' + esc(String(s.occurredAt || '').slice(0, 16).replace('T', ' ')) + '</td></tr>').join('');
    sCard.appendChild(el('<div class="table-wrap"><table id="rep-sales-table"><thead><tr><th>Bill No</th><th>Order</th><th>Payment</th><th>Subtotal</th><th>Discount</th><th>Delivery</th><th>Total</th><th>Cashier</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(sCard);

  // ---- Branch report: per-branch sent so far + current stock ----
  const bCard = el('<div class="card"><h2>Branch Report</h2></div>');
  const bRows = branches.map((b) => {
    const sent = transfers.filter((t) => String(t.toBranchId) === String(b.id));
    const sentQty = sent.reduce((a, t) => a + (t.items || []).reduce((x, it) => x + (Number(it.qty) || 0), 0), 0);
    const curStock = products.reduce((a, p) => a + (window.App.stockOf(p, b.id) || 0), 0);
    return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + sent.length + ' transfers</td><td><b>' + sentQty + '</b> units bheje gaye</td><td><b>' + curStock + '</b> units maujooda stock</td></tr>';
  }).join('');
  bCard.appendChild(el('<div class="table-wrap"><table id="rep-branch-table"><thead><tr><th>Branch</th><th>Transfers</th><th>Sent So Far</th><th>Current Stock</th></tr></thead><tbody>' + bRows + '</tbody></table></div>'));
  wrap.appendChild(bCard);

  // ---- Complete history ----
  const hCard = el('<div class="card"><h2>Complete History</h2></div>');
  const recent = moves.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 50);
  if (recent.length === 0) hCard.appendChild(el('<p class="muted">Is range mein koi history nahi hai.</p>'));
  else {
    const rows = recent.map((m) => {
      const q = Number(m.qty) || 0;
      return '<tr><td>' + esc(m.productName || '') + '</td><td>' + (q > 0 ? 'Aaya' : 'Gaya') + '</td><td><b>' + Math.abs(q) + '</b></td><td>' + esc(window.App.branchName(m.branchId)) + '</td><td>' + esc(m.reason || '') + '</td><td>' + esc(m.user || '') + '</td><td class="muted">' + esc(String(m.date || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
    }).join('');
    hCard.appendChild(el('<div class="table-wrap"><table id="rep-history-table"><thead><tr><th>Item</th><th>Type</th><th>Miqdaar</th><th>Branch</th><th>Wajah</th><th>User</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(hCard);

  // ---- Backup info ----
  const info = DB.backupInfo ? DB.backupInfo() : { lastBackup: null, count: 0 };
  const bkCard = el('<div class="card"><h2>Backup Info</h2><p class="muted">Aakhri backup: ' + (info.lastBackup ? esc(new Date(info.lastBackup).toLocaleString('en-GB')) : 'abhi tak koi backup nahi') + ' — kul ' + info.count + ' backups (aakhri 7 rakhe jate hain). Backup actions Settings mein hain.</p></div>');
  wrap.appendChild(bkCard);

  filterRow.querySelector('#rep-apply').addEventListener('click', () => {
    fromDate = filterRow.querySelector('#rep-from').value || '';
    toDate = filterRow.querySelector('#rep-to').value || '';
    renderReports(container);
  });
  filterRow.querySelector('#rep-clear').addEventListener('click', () => {
    fromDate = ''; toDate = '';
    renderReports(container);
  });

  container.appendChild(wrap);
}

window.Screens.reports = renderReports;
})();
