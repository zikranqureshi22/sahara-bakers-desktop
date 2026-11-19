/* Sahara Bakers — Dashboard (v2.0.0).
 * TWO dashboards by role:
 *  - Owner: full overview — total raw stock, total finish stock,
 *    total warehouse stock, per-branch stock, total production,
 *    total transfers, production + branch reports, complete history.
 *  - Manager: daily ops only — quick actions to Raw Material, Finish
 *    Goods, Production, Warehouse, Stock Transfer, Billing and Stock
 *    History. Owner-only areas (Reports, Backup, Logins, Settings)
 *    are hidden from Manager.
 * Wrapped in an IIFE.
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

function todayISO() { return new Date().toISOString().slice(0, 10); }

function renderDashboard(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const movements = st.stockMovements || [];
  const branches = st.branches || [];
  const today = todayISO();
  const isOwner = window.App.user && window.App.user.role === 'Owner';
  const warehouseId = window.App.warehouseBranchId();

  const raws = products.filter((p) => p.type === 'raw');
  const fins = products.filter((p) => p.type === 'finished');
  const totalRaw = raws.reduce((a, p) => a + (window.App.totalStock(p) || 0), 0);
  const totalFin = fins.reduce((a, p) => a + (window.App.totalStock(p) || 0), 0);
  const whStock = products.reduce((a, p) => a + (window.App.stockOf(p, warehouseId) || 0), 0);
  const totalProd = (st.productions || []).length;
  const totalTransfers = (st.transfers || []).length;
  let aajAaya = 0, aajGaya = 0;
  movements.forEach((m) => {
    if (String(m.date || '').slice(0, 10) !== today) return;
    const q = Number(m.qty) || 0;
    if (q > 0) aajAaya += q;
    else aajGaya += Math.abs(q);
  });
  const lowItems = window.App.lowStockProducts ? window.App.lowStockProducts() : [];
  const lowCount = lowItems.length;

  const wrap = el('<div></div>');
  wrap.appendChild(el(
    '<div class="screen-head"><h1>' + (isOwner ? 'Owner Dashboard' : 'Manager Dashboard') + '</h1>' +
    '<span class="muted">' + esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + '</span></div>'
  ));

  // Low-stock banner (top of Dashboard): item names with
  // "Stock Dekhein" / "Band Karein". Only when notifications are ON.
  if (lowCount > 0) {
    const banner = el(
      '<div class="warning-banner" id="low-stock-banner">' +
      '<b>Kam Stock:</b> ' + esc(lowItems.slice(0, 8).map((p) => p.name).join(', ')) +
      (lowCount > 8 ? ' aur ' + (lowCount - 8) + ' items' : '') +
      ' <span class="btn-row" style="margin-top:8px">' +
      '<button type="button" class="btn btn-sm btn-primary" id="low-stock-go">View Stock</button>' +
      '<button type="button" class="btn btn-sm" id="low-stock-close">Close</button>' +
      '</span></div>'
    );
    banner.querySelector('#low-stock-go').addEventListener('click', () => window.App.go('stock'));
    banner.querySelector('#low-stock-close').addEventListener('click', () => banner.remove());
    wrap.appendChild(banner);
  }

  const stats = el('<div class="stat-grid" id="dashboard-stats"></div>');
  const stat = (label, value, sub) => el(
    '<div class="stat"><div class="stat-label">' + esc(label) + '</div>' +
    '<div class="stat-value">' + esc(value) + '</div>' +
    (sub ? '<div class="muted">' + esc(sub) + '</div>' : '') + '</div>'
  );
  if (isOwner) {
    stats.appendChild(stat('Total Items', String(products.length), totalRaw + totalFin + ' units kul stock'));
    stats.appendChild(stat('Total Raw Stock', String(totalRaw), raws.length + ' raw items'));
    stats.appendChild(stat('Total Finish Stock', String(totalFin), fins.length + ' finish items'));
    stats.appendChild(stat('Warehouse Stock', String(whStock), 'godown mein kul stock'));
    stats.appendChild(stat('Total Production', String(totalProd), 'productions ab tak'));
    stats.appendChild(stat('Total Transfers', String(totalTransfers), 'warehouse se branches ko'));
    stats.appendChild(stat('Received Today', String(aajAaya), 'units aaj godown mein aaye'));
    stats.appendChild(stat('Sent Today', String(aajGaya), 'units aaj gaye (transfer / stock out)'));
    stats.appendChild(stat('Low Stock', String(lowCount), lowCount > 0 ? 'items limit se neeche hain' : 'Koi item limit se neeche nahi'));
  } else {
    stats.appendChild(stat('Total Items', String(products.length), totalRaw + totalFin + ' units kul stock'));
    stats.appendChild(stat('Total Raw Stock', String(totalRaw), raws.length + ' raw items'));
    stats.appendChild(stat('Total Finish Stock', String(totalFin), fins.length + ' finish items'));
    stats.appendChild(stat('Received Today', String(aajAaya), 'units aaj aaye'));
    stats.appendChild(stat('Sent Today', String(aajGaya), 'units aaj gaye'));
    stats.appendChild(stat('Low Stock', String(lowCount), lowCount > 0 ? 'items limit se neeche hain' : 'Koi item limit se neeche nahi'));
  }
  wrap.appendChild(stats);

  // Daily jobs — the 3 things done every day (SmartPOS: big, clear,
  // plain words). English title + Roman Urdu supporting line.
  const jobs = el('<div class="daily-jobs">' +
    '<button type="button" class="btn btn-primary daily-job" id="dj-in">Stock In<small>Maal godown mein aaya</small></button>' +
    '<button type="button" class="btn btn-primary daily-job" id="dj-out">Transfer to Branch<small>Maal branch ko bhejo</small></button>' +
    '<button type="button" class="btn daily-job" id="dj-stock">View Stock<small>Godown aur branch stock dekho</small></button>' +
    '</div>');
  jobs.querySelector('#dj-in').addEventListener('click', () => window.App.go('stockio'));
  jobs.querySelector('#dj-out').addEventListener('click', () => window.App.go('transfer'));
  jobs.querySelector('#dj-stock').addEventListener('click', () => window.App.go('stock'));
  wrap.appendChild(jobs);

  // Quick actions — the main work in 1–2 taps (bilingual buttons).
  const actions = el('<div class="card"><h2>' + (isOwner ? 'Jaldi Kaam' : 'Roz Ka Kaam — Daily Ops') + '</h2><div class="btn-row">' +
    '<button type="button" class="btn btn-primary btn-bilingual" id="qa-raw">Raw Material<span class="btn-sub">Kacha maal</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="qa-finished">Finish Goods<span class="btn-sub">Tayyar cheezein</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="qa-production">Production<span class="btn-sub">Tayyar karna</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="qa-warehouse">Warehouse<span class="btn-sub">Godown</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="qa-transfer">Stock Transfer<span class="btn-sub">Branch ko bhejo</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="qa-billing">Billing<span class="btn-sub">Bill dekho</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="qa-stock">Stock History<span class="btn-sub">Stock history</span></button>' +
    (isOwner ? '<button type="button" class="btn btn-bilingual" id="qa-reports">Reports<span class="btn-sub">Report dekho</span></button>' : '') +
    '</div></div>');
  actions.querySelector('#qa-raw').addEventListener('click', () => window.App.go('raw'));
  actions.querySelector('#qa-finished').addEventListener('click', () => window.App.go('finished'));
  actions.querySelector('#qa-production').addEventListener('click', () => window.App.go('production'));
  actions.querySelector('#qa-warehouse').addEventListener('click', () => window.App.go('warehouse'));
  actions.querySelector('#qa-transfer').addEventListener('click', () => window.App.go('transfer'));
  actions.querySelector('#qa-billing').addEventListener('click', () => window.App.go('billing'));
  actions.querySelector('#qa-stock').addEventListener('click', () => window.App.go('stock'));
  if (isOwner) actions.querySelector('#qa-reports').addEventListener('click', () => window.App.go('reports'));
  wrap.appendChild(actions);

  // Owner: per-branch stock overview + production/branch reports.
  if (isOwner) {
    const bCard = el('<div class="card"><h2>Per-Branch Stock</h2></div>');
    const bRows = branches.map((b) => {
      const stock = products.reduce((a, p) => a + (window.App.stockOf(p, b.id) || 0), 0);
      const sent = (st.transfers || []).filter((t) => String(t.toBranchId) === String(b.id));
      const sentQty = sent.reduce((a, t) => a + (t.items || []).reduce((x, it) => x + (Number(it.qty) || 0), 0), 0);
      return '<tr><td><b>' + esc(b.name) + '</b></td><td><b>' + stock + '</b> units</td><td>' + sent.length + ' transfers — ' + sentQty + ' units bheje gaye</td></tr>';
    }).join('');
    bCard.appendChild(el('<div class="table-wrap"><table id="dashboard-branch-table"><thead><tr><th>Branch</th><th>Current Stock</th><th>Sent So Far</th></tr></thead><tbody>' + bRows + '</tbody></table></div>'));
    wrap.appendChild(bCard);

    const prods = (st.productions || []).slice(0, 5);
    const prCard = el('<div class="card"><h2>Production Report — Aakhri Productions</h2></div>');
    if (prods.length === 0) prCard.appendChild(el('<p class="muted">Abhi tak koi production nahi hui.</p>'));
    else {
      const rows = prods.map((pr) => '<tr><td><b>' + esc(pr.billNo || '') + '</b></td><td>' + esc(pr.finishName || '') + ' <b>' + pr.finishQty + ' ' + esc(pr.finishUnit || '') + '</b></td><td><b>' + money(pr.totalCost) + '</b></td><td class="muted">' + esc(String(pr.date || '').slice(0, 10)) + '</td></tr>').join('');
      prCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Finish</th><th>Total Cost</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    wrap.appendChild(prCard);
  }

  // Kam Stock alerts list (Dashboard only).
  if (lowCount > 0) {
    const card = el('<div class="card"><h2>Kam Stock Alerts</h2></div>');
    const rows = lowItems.map((p) => {
      const lim = window.App.lowLimitFor(p);
      const qty = window.App.totalStock(p);
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.unit || '') + '</td><td><b>' + qty + '</b></td><td>Limit: ' + (lim == null ? '—' : lim) + '</td></tr>';
    }).join('');
    card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Unit</th><th>Stock</th><th>Limit</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    wrap.appendChild(card);
  }

  // Aaj ki movements (latest first, max 10).
  const todayMoves = movements.filter((m) => String(m.date || '').slice(0, 10) === today).slice(0, 10);
  const movesCard = el('<div class="card"><h2>Aaj Ki Stock Movement</h2></div>');
  if (todayMoves.length === 0) {
    movesCard.appendChild(el('<p class="muted">Aaj abhi tak koi stock in/out nahi hua.</p>'));
  } else {
    const rows = todayMoves.map((m) => {
      const q = Number(m.qty) || 0;
      return '<tr><td>' + esc(m.productName || '') + '</td><td>' + (q > 0 ? 'Aaya' : 'Gaya') + '</td><td><b>' + Math.abs(q) + '</b></td><td>' + esc(m.reason || '') + '</td><td class="muted">' + esc(String(m.date || '').slice(11, 16)) + '</td></tr>';
    }).join('');
    movesCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Type</th><th>Miqdaar</th><th>Wajah</th><th>Waqt</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(movesCard);

  container.appendChild(wrap);
}

window.Screens.dashboard = renderDashboard;
})();
