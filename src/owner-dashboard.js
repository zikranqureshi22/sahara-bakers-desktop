/* Sahara Bakers — Owner Dashboard v53 (v2.1.0).
 * Owner-only screen (route id 'owner-dashboard'). Greeting at the
 * top, date chips (Today / Yesterday / This Week / This Month /
 * Custom), cards + branch-wise counter sales with expandable per-bill
 * detail, and a SEPARATE Warehouse Dispatch section (SB bills).
 * Counter sales and warehouse dispatch are NEVER mixed into one
 * total — they come from separate sources in frozen
 * DB.getOwnerDashboard (counter sales vs dispatches). A cost or
 * profit that is unknown (purchasePrice blank) shows "—", never 0
 * and never a guess.
 * The shared compute helper Screens.OwnerDashboard.getData(range) is
 * what warehouse.js / branches.js reuse instead of duplicating the
 * logic. Wrapped in an IIFE.
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
function fmtRange(from, to) {
  if (!from) return '';
  return from === to ? from : (from + ' — ' + to);
}
function isOwner() { return !!(window.App.user && window.App.user.role === 'Owner'); }

// Shared compute for warehouse.js / branches.js: the frozen
// DB.getOwnerDashboard result for a range. range is { range:
// 'today'|'yesterday'|'thisWeek'|'thisMonth' } or { from, to }
// (YYYY-MM-DD). Returns null only if the frozen function is missing.
function getData(range) {
  if (DB.getOwnerDashboard) return DB.getOwnerDashboard(range || { range: 'today' });
  return null;
}

const CHIPS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This Week' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'custom', label: 'Custom' },
];

function renderOwnerDashboard(container) {
  container.innerHTML = '';
  const st = S();

  if (!isOwner()) {
    const wrap = el('<div></div>');
    wrap.appendChild(el('<div class="screen-head"><h1>Owner Dashboard</h1></div>'));
    wrap.appendChild(el('<div class="card"><p>Ye screen sirf Owner ke liye hai.</p></div>'));
    container.appendChild(wrap);
    return;
  }

  const ownerName = (window.App.user && window.App.user.name) || 'Owner';
  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Owner Dashboard</h1></div>'));
  wrap.appendChild(el('<p class="od-greeting">Assalamualaikum wa Rahmatullah, ' + esc(ownerName) + '</p>'));
  wrap.appendChild(el('<p class="muted">Counter sales aur warehouse dispatch alag-alag hain — in ke totals kabhi aik mein nahi milaye jate. Cost / profit jahan rate nahi hai, wahan "—" dikhega.</p>'));

  // ---- Date chips + custom range ----
  const chipsRow = el('<div class="od-chips"></div>');
  const customRow = el('<div class="od-custom" hidden></div>');
  const fromIn = el('<input class="input" type="date">');
  const toIn = el('<input class="input" type="date">');
  const customBtn = el('<button type="button" class="btn btn-primary">Dekhein</button>');
  customRow.appendChild(el('<label>From</label>')); customRow.appendChild(fromIn);
  customRow.appendChild(el('<label>To</label>')); customRow.appendChild(toIn);
  customRow.appendChild(customBtn);
  const body = el('<div id="owner-dash-body"></div>');
  wrap.appendChild(chipsRow);
  wrap.appendChild(customRow);
  wrap.appendChild(body);

  let activeChip = 'today';
  function markChips() {
    chipsRow.querySelectorAll('.od-chip').forEach((b) => {
      if (b.getAttribute('data-chip') === activeChip) b.classList.add('active');
      else b.classList.remove('active');
    });
    customRow.hidden = activeChip !== 'custom';
  }
  CHIPS.forEach((c) => {
    const b = el('<button type="button" class="btn od-chip" data-chip="' + c.key + '">' + esc(c.label) + '</button>');
    b.addEventListener('click', () => {
      activeChip = c.key;
      if (c.key === 'custom') {
        const today = DB._todayLocal ? DB._todayLocal() : new Date().toISOString().slice(0, 10);
        if (!fromIn.value) fromIn.value = today;
        if (!toIn.value) toIn.value = today;
        markChips();
        draw({ from: fromIn.value, to: toIn.value });
      } else {
        markChips();
        draw({ range: c.key });
      }
    });
    chipsRow.appendChild(b);
  });
  customBtn.addEventListener('click', () => {
    if (!fromIn.value || !toIn.value) { notify('Issue — From aur To date dono chunein', 'error'); return; }
    if (fromIn.value > toIn.value) { notify('Issue — From date, To date se baad ki nahi ho sakti', 'error'); return; }
    draw({ from: fromIn.value, to: toIn.value });
  });

  function draw(range) {
    const data = getData(range);
    body.innerHTML = '';
    if (!data) {
      body.appendChild(el('<div class="card"><p class="muted">Dashboard data available nahi hai.</p></div>'));
      return;
    }
    body.appendChild(el('<p class="muted">Range: <b>' + esc(fmtRange(data.from, data.to)) + '</b></p>'));

    // ---- Cards ----
    const t = data.totals || {};
    const stats = el('<div class="stat-grid"></div>');
    const stat = (label, value, sub) => el('<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<div class="muted">' + esc(sub) + '</div>' : '') + '</div>');
    stats.appendChild(stat('Total Sales', money(t.totalSales || 0), (t.bills || 0) + ' bills · ' + (t.productsSold || 0) + ' items beche'));
    stats.appendChild(stat('Total Bills', String(t.bills || 0), 'counter sale bills'));
    stats.appendChild(stat('Cost', moneyOrDash(t.cost), 'counter sales ki cost'));
    stats.appendChild(stat('Profit', moneyOrDash(t.profit), 'counter sales ka profit'));
    stats.appendChild(stat('Total Stock Transferred', String(t.totalStockTransferred || 0) + ' items', 'dispatch value ' + moneyOrDash(t.totalDispatchValue)));
    body.appendChild(stats);

    // ---- Branch-wise counter sales (all locations, zero rows shown) ----
    const branches = (st.branches || []).slice();
    const byId = {};
    (data.branches || []).forEach((b) => { byId[b.branchId == null ? 'counter' : 'b' + b.branchId] = b; });
    const bCard = el('<div class="card"><h2>Counter Sales — Branch-wise</h2></div>');
    const bRows = [{ branchId: null, branchName: 'Warehouse Counter' }].concat(branches.map((b) => ({ branchId: b.id, branchName: b.name }))).map((loc) => {
      const key = loc.branchId == null ? 'counter' : 'b' + loc.branchId;
      const d = byId[key];
      const bills = d ? d.bills : 0;
      const totalSales = d ? d.totalSales : 0;
      const productsSold = d ? d.productsSold : 0;
      // No bills = no cost incurred (Rs 0 is exact); bills with a
      // blank purchasePrice = unknown ("—").
      const cost = bills === 0 ? money(0) : moneyOrDash(d ? d.cost : null);
      const profit = bills === 0 ? money(0) : moneyOrDash(d ? d.profit : null);
      return '<tr><td><b>' + esc(loc.branchName) + '</b></td><td>' + bills + '</td><td><b>' + money(totalSales) + '</b></td><td>' + productsSold + '</td><td>' + esc(cost) + '</td><td>' + esc(profit) + '</td></tr>';
    }).join('');
    bCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Branch</th><th>Bills</th><th>Total Sales</th><th>Items Sold</th><th>Cost</th><th>Profit</th></tr></thead><tbody>' + bRows + '</tbody></table></div>'));
    body.appendChild(bCard);

    // ---- Per-bill detail (expandable lines) ----
    const billsCard = el('<div class="card"><h2>Counter Sale Bills — Detail</h2></div>');
    const bills = data.bills || [];
    if (bills.length === 0) billsCard.appendChild(el('<p class="muted">Is range mein koi counter sale nahi hui.</p>'));
    else {
      const rowsHtml = bills.map((s, i) => {
        const billCost = (s.lines || []).every((l) => l.lineCost != null)
          ? (s.lines || []).reduce((a, l) => a + (l.lineCost || 0), 0) : null;
        const billProfit = billCost == null ? null : ((Number(s.total) || 0) - billCost);
        const lineRows = (s.lines || []).map((l) =>
          '<tr><td>' + esc(l.name) + '</td><td>' + l.qty + ' ' + esc(l.unit || '') + '</td><td>' + money(l.unitPrice) + '</td><td>' + moneyOrDash(l.costPrice) + '</td><td>' + money(l.lineTotal) + '</td><td>' + moneyOrDash(l.lineCost) + '</td><td>' + moneyOrDash(l.lineProfit) + '</td></tr>'
        ).join('');
        return '<tr><td><b>' + esc(s.billNo || '') + '</b></td><td class="muted">' + esc(fmtDateTime(s.date)) + '</td><td>' + esc(s.branchName || '') + '</td><td>' + esc(s.orderType || '') + '</td><td>' + esc(s.paymentMethod || '') + '</td><td><b>' + money(s.total) + '</b></td><td>' + moneyOrDash(billCost) + '</td><td>' + moneyOrDash(billProfit) + '</td><td><button type="button" class="btn btn-sm" data-bill-detail="' + i + '">Detail</button></td></tr>' +
          '<tr class="od-bill-detail" data-bill-detail-row="' + i + '" hidden><td colspan="9"><div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Sale Price</th><th>Cost Price</th><th>Line Total</th><th>Line Cost</th><th>Line Profit</th></tr></thead><tbody>' + (lineRows || '<tr><td colspan="7" class="muted">Koi lines nahi.</td></tr>') + '</tbody></table></div></td></tr>';
      }).join('');
      billsCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Date</th><th>Branch</th><th>Type</th><th>Payment</th><th>Total</th><th>Cost</th><th>Profit</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
      billsCard.querySelectorAll('button[data-bill-detail]').forEach((btn) => btn.addEventListener('click', () => {
        const i = btn.getAttribute('data-bill-detail');
        const row = billsCard.querySelector('[data-bill-detail-row="' + i + '"]');
        if (row) { row.hidden = !row.hidden; btn.textContent = row.hidden ? 'Detail' : 'Band Karein'; }
      }));
    }
    body.appendChild(billsCard);

    // ---- Warehouse Dispatch (SB) — separate section, never mixed ----
    const dt = data.dispatchTotals || {};
    const dCard = el('<div class="card"><h2>Warehouse Dispatch — Godown se Branches (SB Bills)</h2></div>');
    const dStats = el('<div class="stat-grid"></div>');
    dStats.appendChild(stat('Total Dispatches', String(dt.dispatches || 0), 'SB bills'));
    dStats.appendChild(stat('Total Products Dispatched', String(dt.qty || 0), 'items bheje gaye'));
    dStats.appendChild(stat('Total Dispatch Value', moneyOrDash(dt.value), 'supply value'));
    dStats.appendChild(stat('Total Dispatch Cost', moneyOrDash(dt.cost), 'purchase cost'));
    dStats.appendChild(stat('Dispatch Margin', moneyOrDash(dt.margin), 'value − cost'));
    dCard.appendChild(dStats);
    // Branch-wise dispatch (all 3 branches, zero rows shown).
    const dById = {};
    (data.dispatchBranches || []).forEach((b) => { dById['b' + b.branchId] = b; });
    const dRows = branches.map((b) => {
      const d = dById['b' + b.id];
      return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + (d ? d.dispatches : 0) + '</td><td>' + (d ? d.qty : 0) + '</td><td>' + moneyOrDash(d ? d.value : null) + '</td><td>' + moneyOrDash(d ? d.cost : null) + '</td><td>' + moneyOrDash(d ? d.margin : null) + '</td></tr>';
    }).join('');
    dCard.appendChild(el('<h3 style="margin-top:14px">Branch-wise Dispatch</h3>'));
    dCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Branch</th><th>Dispatches</th><th>Qty</th><th>Value</th><th>Cost</th><th>Margin</th></tr></thead><tbody>' + dRows + '</tbody></table></div>'));
    // SB-wise dispatch list with bill button.
    const dispatches = data.dispatches || [];
    dCard.appendChild(el('<h3 style="margin-top:14px">Dispatch List (SB-wise)</h3>'));
    if (dispatches.length === 0) dCard.appendChild(el('<p class="muted">Is range mein koi dispatch nahi hua.</p>'));
    else {
      const rowsHtml = dispatches.map((d) => {
        const items = (d.items || []).map((r) => esc(r.name) + ' × ' + r.qty + ' ' + esc(r.unit || '')).join(', ');
        return '<tr><td><b>' + esc(d.billNo || '') + '</b></td><td class="muted">' + esc(fmtDateTime(d.date)) + '</td><td>' + esc(d.toBranchName || '') + '</td><td>' + items + '</td><td>' + moneyOrDash(d.value) + '</td><td>' + moneyOrDash(d.cost) + '</td><td>' + moneyOrDash(d.margin) + '</td><td><button type="button" class="btn btn-sm" data-dbill="' + esc(d.id) + '">Bill</button></td></tr>';
      }).join('');
      dCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Date</th><th>To Branch</th><th>Items</th><th>Value</th><th>Cost</th><th>Margin</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
      dCard.querySelectorAll('button[data-dbill]').forEach((btn) => btn.addEventListener('click', () => {
        const t = (S().transfers || []).find((x) => String(x.id) === String(btn.getAttribute('data-dbill')));
        if (t && window.App.showTransferBill) window.App.showTransferBill(t);
      }));
    }
    body.appendChild(dCard);
  }

  markChips();
  draw({ range: 'today' });
  container.appendChild(wrap);
}

renderOwnerDashboard.getData = getData;
window.Screens.OwnerDashboard = renderOwnerDashboard;
window.Screens['owner-dashboard'] = renderOwnerDashboard;
})();
