/* Sahara Bakers — Warehouse / Godown (v2.0.0).
 * The central godown (a REAL location, separate from the 3
 * branches): finish stock held here, raw stock held here, and the
 * entry point for a branch transfer. Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }

function renderWarehouse(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const warehouseId = window.App.warehouseBranchId();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Warehouse / Godown</h1><button type="button" class="btn btn-primary" id="warehouse-transfer-btn">Transfer to Branch</button></div>'));
  wrap.appendChild(el('<p class="muted">Central godown — Warehouse. Yahan ka stock branches ko bheja jata hai.</p>'));

  const fins = products.filter((p) => p.type === 'finished');
  const raws = products.filter((p) => p.type === 'raw');
  const finStock = fins.reduce((a, p) => a + (window.App.stockOf(p, warehouseId) || 0), 0);
  const rawStock = raws.reduce((a, p) => a + (window.App.stockOf(p, warehouseId) || 0), 0);
  const stats = el('<div class="stat-grid"></div>');
  stats.appendChild(el('<div class="stat"><div class="stat-label">Finish Stock (Godown)</div><div class="stat-value">' + finStock + '</div><div class="muted">tayyar cheezein godown mein</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Raw Stock (Godown)</div><div class="stat-value">' + rawStock + '</div><div class="muted">kacha maal godown mein</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Total Transfers</div><div class="stat-value">' + (st.transfers || []).length + '</div><div class="muted">godown se branches ko</div></div>'));
  wrap.appendChild(stats);

  const finCard = el('<div class="card"><h2>Finish Stock — Godown</h2></div>');
  const finRows = fins.map((p) => {
    const qty = window.App.stockOf(p, warehouseId);
    return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.unit || '') + '</td><td><b>' + qty + '</b></td><td>' + esc(window.App.moneyOrDash(p.price)) + '</td></tr>';
  }).join('');
  finCard.appendChild(el('<div class="table-wrap"><table id="warehouse-table"><thead><tr><th>Finish Item</th><th>Unit</th><th>Godown Stock</th><th>Price</th></tr></thead><tbody>' + finRows + '</tbody></table></div>'));
  wrap.appendChild(finCard);

  const rawCard = el('<div class="card"><h2>Raw Stock — Godown</h2></div>');
  const rawRows = raws.map((p) => {
    const qty = window.App.stockOf(p, warehouseId);
    return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.unit || '') + '</td><td><b>' + qty + '</b></td><td>' + esc(window.App.moneyOrDash(p.purchasePrice)) + '</td></tr>';
  }).join('');
  rawCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Raw Item</th><th>Unit</th><th>Godown Stock</th><th>Purchase Price</th></tr></thead><tbody>' + rawRows + '</tbody></table></div>'));
  wrap.appendChild(rawCard);

  wrap.querySelector('#warehouse-transfer-btn').addEventListener('click', () => window.App.go('transfer'));
  container.appendChild(wrap);
}

window.Screens.warehouse = renderWarehouse;
})();
