/* Sahara Bakers — Reports (v2.0.0, Owner-only).
 * Production reports, branch reports and complete history, with a
 * date-range filter. Backup info is shown here too (the backup
 * actions themselves live in Settings). Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function money(n) { return window.App.money(n); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }

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

  const stats = el('<div class="stat-grid"></div>');
  stats.appendChild(el('<div class="stat"><div class="stat-label">Productions (range)</div><div class="stat-value">' + prods.length + '</div><div class="muted">kul production cost ' + money(prods.reduce((a, p) => a + (Number(p.totalCost) || 0), 0)) + '</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Transfers (range)</div><div class="stat-value">' + transfers.length + '</div><div class="muted">kul ' + transfers.reduce((a, t) => a + (t.items || []).reduce((x, it) => x + (Number(it.qty) || 0), 0), 0) + ' units bheje gaye</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Stock Movements (range)</div><div class="stat-value">' + moves.length + '</div><div class="muted">complete history entries</div></div>'));
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
