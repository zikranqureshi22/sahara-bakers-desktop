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
function money(n) { return window.App.money(n); }
function moneyOrDash(n) { return window.App.moneyOrDash(n); }
function notify(m, t) { window.App.notify(m, t); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }
function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}
function isOwner() { return !!(window.App.user && window.App.user.role === 'Owner'); }
// v2.1.0 — shared Owner Dashboard compute (owner-dashboard.js); the
// frozen DB function is the fallback when that screen has not loaded.
function ownerData(range) {
  const OD = window.Screens && window.Screens.OwnerDashboard;
  if (OD && typeof OD.getData === 'function') return OD.getData(range);
  if (DB.getOwnerDashboard) return DB.getOwnerDashboard(range);
  return null;
}

// v2.1.0 — Warehouse Dashboard (Owner only): dispatch totals,
// branch-wise dispatch, branch-wise stock value, dispatch list with
// date+time and SB bill detail. The Manager's stock-board view below
// is unchanged.
function renderOwnerWarehouse(wrap, container) {
  const chips = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'thisWeek', label: 'This Week' },
    { key: 'thisMonth', label: 'This Month' },
  ];
  const chipsRow = el('<div class="od-chips"></div>');
  const body = el('<div id="warehouse-dash-body"></div>');
  wrap.appendChild(el('<p class="muted">Warehouse Dashboard — godown se branches ko dispatch ka hisaab. Counter sales is mein nahi hain — woh Owner Dashboard mein hain.</p>'));
  const openBtn = el('<button type="button" class="btn" id="warehouse-open-owner-dash">Owner Dashboard kholein</button>');
  openBtn.addEventListener('click', () => window.App.go('owner-dashboard'));
  wrap.appendChild(openBtn);
  wrap.appendChild(chipsRow);
  wrap.appendChild(body);

  let activeChip = 'today';
  chips.forEach((c) => {
    const b = el('<button type="button" class="btn od-chip" data-chip="' + c.key + '">' + esc(c.label) + '</button>');
    b.addEventListener('click', () => { activeChip = c.key; markChips(); draw(); });
    chipsRow.appendChild(b);
  });
  function markChips() {
    chipsRow.querySelectorAll('.od-chip').forEach((b) => {
      if (b.getAttribute('data-chip') === activeChip) b.classList.add('active');
      else b.classList.remove('active');
    });
  }
  function draw() {
    const data = ownerData({ range: activeChip });
    body.innerHTML = '';
    if (!data) {
      body.appendChild(el('<div class="card"><p class="muted">Dashboard data available nahi hai.</p></div>'));
      return;
    }
    const st = S();
    const products = st.products || [];
    const branches = st.branches || [];
    const warehouseId = window.App.warehouseBranchId();
    const dt = data.dispatchTotals || {};
    const stats = el('<div class="stat-grid"></div>');
    const stat = (label, value, sub) => el('<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<div class="muted">' + esc(sub) + '</div>' : '') + '</div>');
    stats.appendChild(stat('Total Dispatches', String(dt.dispatches || 0), 'SB bills'));
    stats.appendChild(stat('Total Products Dispatched', String(dt.qty || 0), 'items bheje gaye'));
    stats.appendChild(stat('Total Dispatch Cost', moneyOrDash(dt.cost), 'purchase cost'));
    stats.appendChild(stat('Total Dispatch Value', moneyOrDash(dt.value), 'supply value'));
    stats.appendChild(stat('Dispatch Margin', moneyOrDash(dt.margin), 'value − cost'));
    body.appendChild(stats);

    // Branch-wise dispatch (all 3 branches, zero rows shown).
    const dById = {};
    (data.dispatchBranches || []).forEach((b) => { dById['b' + b.branchId] = b; });
    const dRows = branches.map((b) => {
      const d = dById['b' + b.id];
      return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + (d ? d.dispatches : 0) + '</td><td>' + (d ? d.qty : 0) + '</td><td>' + moneyOrDash(d ? d.value : null) + '</td><td>' + moneyOrDash(d ? d.cost : null) + '</td><td>' + moneyOrDash(d ? d.margin : null) + '</td></tr>';
    }).join('');
    const dCard = el('<div class="card"><h2>Branch-wise Dispatch</h2></div>');
    dCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Branch</th><th>Dispatches</th><th>Qty</th><th>Value</th><th>Cost</th><th>Margin</th></tr></thead><tbody>' + dRows + '</tbody></table></div>'));
    body.appendChild(dCard);

    // Branch-wise stock value: qty x current price; a stocked item
    // with a blank price makes the location value unknown ("—").
    const locs = [{ id: warehouseId, name: 'Warehouse (Godown)' }].concat(branches.map((b) => ({ id: b.id, name: b.name })));
    const vRows = locs.map((loc) => {
      let value = 0, known = true, qty = 0;
      products.forEach((p) => {
        const q = window.App.stockOf(p, loc.id) || 0;
        qty += q;
        if (q > 0) {
          if (p.price == null) known = false;
          else value += q * Number(p.price);
        }
      });
      return '<tr><td><b>' + esc(loc.name) + '</b></td><td>' + qty + '</td><td>' + (known ? money(value) : '—') + '</td></tr>';
    }).join('');
    const vCard = el('<div class="card"><h2>Branch-wise Stock Value</h2></div>');
    vCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Jagah</th><th>Stock (qty)</th><th>Stock Value</th></tr></thead><tbody>' + vRows + '</tbody></table></div>'));
    body.appendChild(vCard);

    // Individual dispatch details (SB bill opens on click).
    const dispatches = data.dispatches || [];
    const lCard = el('<div class="card"><h2>Dispatch Details</h2></div>');
    if (dispatches.length === 0) lCard.appendChild(el('<p class="muted">Is range mein koi dispatch nahi hua.</p>'));
    else {
      const rowsHtml = dispatches.map((d) => {
        const items = (d.items || []).map((r) => esc(r.name) + ' × ' + r.qty + ' ' + esc(r.unit || '')).join(', ');
        return '<tr><td><b>' + esc(d.billNo || '') + '</b></td><td class="muted">' + esc(fmtDateTime(d.date)) + '</td><td>' + esc(d.toBranchName || '') + '</td><td>' + items + '</td><td>' + moneyOrDash(d.value) + '</td><td>' + moneyOrDash(d.cost) + '</td><td>' + moneyOrDash(d.margin) + '</td><td><button type="button" class="btn btn-sm" data-dbill="' + esc(d.id) + '">Bill</button></td></tr>';
      }).join('');
      lCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Date &amp; Time</th><th>To Branch</th><th>Items</th><th>Value</th><th>Cost</th><th>Margin</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
      lCard.querySelectorAll('button[data-dbill]').forEach((btn) => btn.addEventListener('click', () => {
        const t = (S().transfers || []).find((x) => String(x.id) === String(btn.getAttribute('data-dbill')));
        if (t && window.App.showTransferBill) window.App.showTransferBill(t);
      }));
    }
    body.appendChild(lCard);
  }
  markChips();
  draw();
}

function renderWarehouse(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const warehouseId = window.App.warehouseBranchId();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Warehouse / Godown</h1><button type="button" class="btn btn-primary" id="warehouse-transfer-btn">Transfer to Branch</button></div>'));
  wrap.appendChild(el('<p class="muted">Central godown — Warehouse. Yahan ka stock branches ko bheja jata hai.</p>'));

  // v2.1.0 — Owner sees the Warehouse Dashboard view; the Manager's
  // stock-board view below is unchanged. Owner transfer create nahi
  // karta, is liye Transfer button bhi hata diya jata hai.
  if (isOwner()) {
    const tBtn = wrap.querySelector('#warehouse-transfer-btn');
    if (tBtn) tBtn.remove();
    renderOwnerWarehouse(wrap, container);
    container.appendChild(wrap);
    return;
  }

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
  // v2.1.0 — cost gating: Purchase Price sirf tab dikhe jab
  // DB.canSeeCost(currentUser) true ho, warna "—".
  const showCost = DB.canSeeCost ? DB.canSeeCost(window.App.user) : isOwner();
  const rawRows = raws.map((p) => {
    const qty = window.App.stockOf(p, warehouseId);
    return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.unit || '') + '</td><td><b>' + qty + '</b></td><td>' + (showCost ? esc(window.App.moneyOrDash(p.purchasePrice)) : '—') + '</td></tr>';
  }).join('');
  rawCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Raw Item</th><th>Unit</th><th>Godown Stock</th><th>Purchase Price</th></tr></thead><tbody>' + rawRows + '</tbody></table></div>'));
  wrap.appendChild(rawCard);

  wrap.querySelector('#warehouse-transfer-btn').addEventListener('click', () => window.App.go('transfer'));
  container.appendChild(wrap);
}

window.Screens.warehouse = renderWarehouse;
})();
