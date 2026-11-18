/* Sahara Bakers — Dashboard (v1.0.0).
 * The summary panel lives ONLY here (Kul Items, Stock Value, Aaj Aaya,
 * Aaj Gaya, low-stock count, Kam Stock alerts). Other screens never
 * show this summary. Wrapped in an IIFE so top-level consts don't
 * collide with the other classic <script> files.
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
  const today = todayISO();

  const kulItems = products.length;
  const kulStock = products.reduce((a, p) => a + (window.App.totalStock(p) || 0), 0);
  // Stock value only counts items whose price is known; prices are
  // never invented — a missing price simply does not add value.
  let stockValue = 0;
  let pricedCount = 0;
  products.forEach((p) => {
    if (p.price != null && !isNaN(Number(p.price))) {
      stockValue += (Number(p.price) || 0) * (window.App.totalStock(p) || 0);
      pricedCount += 1;
    }
  });
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
    '<div class="screen-head"><h1>Dashboard</h1>' +
    '<span class="muted">' + esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + '</span></div>'
  ));

  // Low-stock banner (RARA-style, top of Dashboard): item names with
  // "Stock Dekhein" / "Band Karein". Only when notifications are ON.
  if (lowCount > 0) {
    const banner = el(
      '<div class="warning-banner" id="low-stock-banner">' +
      '<b>Kam Stock:</b> ' + esc(lowItems.slice(0, 8).map((p) => p.name).join(', ')) +
      (lowCount > 8 ? ' aur ' + (lowCount - 8) + ' items' : '') +
      ' <span class="btn-row" style="margin-top:8px">' +
      '<button type="button" class="btn btn-sm btn-primary" id="low-stock-go">Stock Dekhein</button>' +
      '<button type="button" class="btn btn-sm" id="low-stock-close">Band Karein</button>' +
      '</span></div>'
    );
    banner.querySelector('#low-stock-go').addEventListener('click', () => window.App.go('stock'));
    banner.querySelector('#low-stock-close').addEventListener('click', () => banner.remove());
    wrap.appendChild(banner);
  }

  const stats = el('<div class="stat-grid"></div>');
  const stat = (label, value, sub) => el(
    '<div class="stat"><div class="stat-label">' + esc(label) + '</div>' +
    '<div class="stat-value">' + esc(value) + '</div>' +
    (sub ? '<div class="muted">' + esc(sub) + '</div>' : '') + '</div>'
  );
  stats.appendChild(stat('Kul Items', String(kulItems), kulStock + ' units kul stock'));
  stats.appendChild(stat('Stock Value', money(stockValue), pricedCount < kulItems ? (kulItems - pricedCount) + ' items ki price abhi blank hai' : 'Sab items ki price lagi hui hai'));
  stats.appendChild(stat('Aaj Aaya', String(aajAaya), 'units aaj godown mein aaye'));
  stats.appendChild(stat('Aaj Gaya', String(aajGaya), 'units aaj gaye (transfer / stock out)'));
  stats.appendChild(stat('Kam Stock', String(lowCount), lowCount > 0 ? 'items limit se neeche hain' : 'Koi item limit se neeche nahi'));
  wrap.appendChild(stats);

  // Quick actions — the main work in 1–2 taps.
  const actions = el('<div class="card"><h2>Jaldi Kaam</h2><div class="btn-row">' +
    '<button type="button" class="btn btn-primary" id="qa-stockio">Stock In / Out</button>' +
    '<button type="button" class="btn" id="qa-items">Items Dekhein</button>' +
    '<button type="button" class="btn" id="qa-branches">Branch Transfer</button>' +
    '<button type="button" class="btn" id="qa-purchases">Purchase Add Karein</button>' +
    '</div></div>');
  actions.querySelector('#qa-stockio').addEventListener('click', () => window.App.go('stockio'));
  actions.querySelector('#qa-items').addEventListener('click', () => window.App.go('items'));
  actions.querySelector('#qa-branches').addEventListener('click', () => window.App.go('branches'));
  actions.querySelector('#qa-purchases').addEventListener('click', () => window.App.go('purchases'));
  wrap.appendChild(actions);

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
