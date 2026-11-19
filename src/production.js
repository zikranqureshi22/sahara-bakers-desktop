/* Sahara Bakers — Production (v2.0.0).
 * Raw -> Finish flow with a CART beside the Raw Material list: pick
 * multiple raw items, custom qty each; the cart shows total used
 * material + costing. "Complete" validates the whole cart first
 * (over-stock = rejected, NOTHING moves), then deducts raw at the
 * Warehouse and adds the finish — and generates Production Bill
 * PB-0001... (invoice no, date/time, raw details, used qty, total
 * cost, finish name, produced qty, remaining raw stock, final finish
 * stock) with the same 80mm thermal preview/print as transfers.
 * Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
let RECEIPT_LOGO = '';
try { RECEIPT_LOGO = require('./receipt-logo.js'); } catch (e1) { try { RECEIPT_LOGO = require('./src/receipt-logo.js'); } catch (e2) { RECEIPT_LOGO = ''; } }
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function money(n) { return window.App.money(n); }
function notify(m, t) { window.App.notify(m, t); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}
function productionBillNo(p) { return 'PB-' + String(p.id == null ? '' : p.id).padStart(4, '0'); }

function productionBillHtml(production) {
  const st = S();
  const logoHtml = RECEIPT_LOGO
    ? '<div class="r-center"><img class="r-logo" src="' + RECEIPT_LOGO + '" alt="Sahara Bakers"></div>'
    : '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>';
  const rows = (production.lines || []).map((l) =>
    '<tr><td>' + esc(l.name) + '<br><small>Used ' + l.qty + ' ' + esc(l.unit || '') + (l.purchasePrice != null ? ' · ' + money(l.purchasePrice) + ' / ' + esc(l.unit || '') : ' · cost blank') + '</small></td>' +
    '<td class="r-right">' + (l.lineCost != null ? money(l.lineCost) : '—') + '</td></tr>'
  ).join('');
  const remaining = (production.remainingRaw || []).map((r) =>
    '<div>' + esc(r.name) + ': ' + r.remaining + ' ' + esc(r.unit || '') + ' bacha</div>'
  ).join('');
  return '' +
    logoHtml +
    '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center r-bold">Production Bill</div>' +
    '<div>Bill No: <b>' + esc(production.billNo || productionBillNo(production)) + '</b></div>' +
    '<div>Date: ' + esc(fmtDate(production.date)) + '</div>' +
    (production.createdBy ? '<div>Banane Wala: ' + esc(production.createdBy) + '</div>' : '') +
    '<div class="r-line"></div>' +
    '<div class="r-bold">Raw Material Used:</div>' +
    '<table><thead><tr><th>Item</th><th class="r-right">Cost</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="r-line"></div>' +
    '<table>' +
    '<tr><td class="r-bold">TOTAL COST</td><td class="r-right r-bold">' + (production.costKnown ? money(production.totalCost) : money(production.totalCost) + ' *') + '</td></tr>' +
    '<tr><td>Finish: ' + esc(production.finishName || '') + '</td><td class="r-right"><b>' + production.finishQty + ' ' + esc(production.finishUnit || '') + '</b></td></tr>' +
    (production.costPerUnit != null ? '<tr><td>Cost per ' + esc(production.finishUnit || 'unit') + '</td><td class="r-right">' + money(production.costPerUnit) + '</td></tr>' : '') +
    '</table>' +
    (production.costKnown ? '' : '<div class="r-line"></div><div>Note: kuch raw items ki purchase price blank hai — Raw Material mein price set karein, warna total cost poori nahi dikhegi. (* = kuch lines ki cost blank hai)</div>') +
    '<div class="r-line"></div>' +
    '<div class="r-bold">Remaining Raw Stock (Godown):</div>' + remaining +
    '<div>Final Finish Stock: <b>' + production.finalFinishStock + ' ' + esc(production.finishUnit || '') + '</b> (' + esc(production.finishName || '') + ')</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center">Sahara Bakers — Godown Stock</div>';
}

function showProductionBill(production) {
  if (!production) return false;
  if (window.App.showBillPreviewHtml) {
    return window.App.showBillPreviewHtml(productionBillHtml(production), function () { return printProductionBill(production); });
  }
  return false;
}
async function printProductionBill(production) {
  if (!production) return false;
  if (window.App.printReceiptHtml) return window.App.printReceiptHtml(productionBillHtml(production));
  return false;
}

function renderProduction(container) {
  container.innerHTML = '';
  const st = S();
  const raws = (st.products || []).filter((p) => p.type === 'raw');
  const finishes = (st.products || []).filter((p) => p.type === 'finished');
  const warehouseId = window.App.warehouseBranchId();
  const cart = []; // [{productId, qty}]

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Production</h1></div>'));
  wrap.appendChild(el('<p class="muted">Raw Material se Finish Goods banayein — raw items chunein, cart mein miqdaar likhein, phir Complete karein. Raw godown se kat jayega aur finish godown mein add ho jayega.</p>'));

  const layout = el('<div class="prod-layout"></div>');
  const left = el('<div class="card"><h2>Raw Material — Add to Cart</h2></div>');
  const searchRow = el('<div class="pos-search-row"><input id="prod-search" class="input" type="text" placeholder="Search Raw Item"></div>');
  left.appendChild(searchRow);
  const rawList = el('<div id="prod-raw-list"></div>');
  left.appendChild(rawList);
  layout.appendChild(left);

  const cartCard = el('<div class="card prod-cart"><h2>Production Cart</h2></div>');
  const cartBody = el('<div id="prod-cart-body"></div>');
  cartCard.appendChild(cartBody);
  const finishRow = el('<div class="form-row"></div>');
  const finishSel = el('<select id="prod-finish-sel" class="input">' + finishes.map((p) =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
  ).join('') + '</select>');
  const finishQty = el('<input id="prod-finish-qty" class="input" type="number" min="0" step="any" placeholder="Bani hui miqdaar (jaise 80)">');
  finishRow.appendChild(finishSel); finishRow.appendChild(finishQty);
  cartCard.appendChild(el('<label>Finish Item</label>')); cartCard.appendChild(finishRow);
  const completeBtn = el('<button type="button" class="btn btn-primary btn-block" id="prod-complete-btn">Complete Production &amp; View Bill</button>');
  cartCard.appendChild(completeBtn);
  layout.appendChild(cartCard);
  wrap.appendChild(layout);

  function drawRawList(q) {
    rawList.innerHTML = '';
    const query = (q || '').trim().toLowerCase();
    const list = raws.filter((p) => !query || String(p.name || '').toLowerCase().indexOf(query) !== -1);
    if (list.length === 0) { rawList.appendChild(el('<p class="muted">Koi raw item nahi mila.</p>')); return; }
    const rows = list.map((p) => {
      const avail = window.App.stockOf(p, warehouseId);
      const inCart = cart.find((c) => String(c.productId) === String(p.id));
      return '<tr data-id="' + esc(p.id) + '"><td><b>' + esc(p.name) + '</b><br><span class="muted">' + esc(p.unit || '') + ' · ' + (p.purchasePrice != null ? 'Cost ' + esc(window.App.money(p.purchasePrice)) : 'Cost blank') + '</span></td>' +
        '<td>Available: <b>' + avail + '</b></td>' +
        '<td><input class="input prod-cart-qty" data-id="' + esc(p.id) + '" type="number" min="0" step="any" placeholder="Qty" value="' + (inCart ? inCart.qty : '') + '" style="max-width:110px"></td>' +
        '<td><button type="button" class="btn btn-sm prod-add-cart" data-id="' + esc(p.id) + '">' + (inCart ? 'Update' : '+ Cart') + '</button></td></tr>';
    }).join('');
    rawList.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Raw Item</th><th>Godown Stock</th><th>Qty</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    rawList.querySelectorAll('.prod-add-cart').forEach((b) => b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      const input = rawList.querySelector('.prod-cart-qty[data-id="' + id + '"]');
      const qty = input ? Number(input.value) : 0;
      const p = raws.find((x) => String(x.id) === String(id));
      if (!p) return;
      if (!qty || qty <= 0) { notify('Issue — Miqdaar durust likhein', 'error'); return; }
      const existing = cart.find((c) => String(c.productId) === String(id));
      if (existing) existing.qty = qty;
      else cart.push({ productId: p.id, qty });
      drawCart();
      drawRawList(searchRow.querySelector('#prod-search').value);
      notify('Ho Gaya ✓ — ' + p.name + ' ' + qty + ' ' + (p.unit || '') + ' cart mein add ho gaya', 'success');
    }));
  }

  function drawCart() {
    cartBody.innerHTML = '';
    if (cart.length === 0) {
      cartBody.appendChild(el('<p class="muted">Cart khaali hai — left se raw items add karein.</p>'));
      return;
    }
    let totalCost = 0, costKnown = true, totalUsed = 0;
    const rows = cart.map((c, i) => {
      const p = raws.find((x) => String(x.id) === String(c.productId));
      const pp = p && p.purchasePrice != null ? Number(p.purchasePrice) : null;
      const lineCost = pp == null ? null : c.qty * pp;
      if (lineCost == null) costKnown = false; else totalCost += lineCost;
      totalUsed += c.qty;
      return '<tr><td>' + esc(p ? p.name : '') + '</td><td><b>' + c.qty + '</b> ' + esc(p ? (p.unit || '') : '') + '</td><td>' + (lineCost != null ? money(lineCost) : 'cost blank') + '</td><td><button type="button" class="btn btn-sm" data-i="' + i + '">Hataein</button></td></tr>';
    }).join('');
    cartBody.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Raw Item</th><th>Used Qty</th><th>Cost</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    cartBody.appendChild(el('<p id="prod-cart-total-cost"><b>Total Used Material:</b> ' + cart.length + ' items, kul ' + totalUsed + ' units<br><b>Total Cost:</b> ' + (costKnown ? money(totalCost) : money(totalCost) + ' * (kuch items ki purchase price blank hai)') + '</p>'));
    cartBody.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
      cart.splice(Number(b.getAttribute('data-i')), 1);
      drawCart();
      drawRawList(searchRow.querySelector('#prod-search').value);
    }));
  }

  completeBtn.addEventListener('click', () => {
    const finishId = finishSel.value;
    const fQty = Number(finishQty.value);
    if (cart.length === 0) { notify('Issue — Pehle cart mein kam az kam aik raw item add karein', 'error'); return; }
    if (!fQty || fQty <= 0) { notify('Issue — Bani hui miqdaar durust likhein', 'error'); return; }
    const finish = finishes.find((x) => String(x.id) === String(finishId));
    if (!finish) { notify('Issue — Pehle finish item chunein', 'error'); return; }
    const clientRef = 'prod-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const res = DB.completeProduction ? DB.completeProduction({
      finishProductId: finish.id, finishQty: fQty,
      lines: cart.map((c) => ({ productId: c.productId, qty: c.qty })),
      createdBy: window.App.user ? window.App.user.name : '',
      clientRef, warehouseBranchId: warehouseId,
    }) : { ok: false, message: 'Production available nahi hai' };
    if (!res.ok) {
      notify('Issue — ' + (res.message || 'Production nahi ho saki'), 'error');
      return;
    }
    window.App.save();
    cart.length = 0;
    finishQty.value = '';
    drawCart();
    drawRawList('');
    notify('Ho Gaya ✓ — Production ' + (res.production.billNo || '') + ' complete — ' + (finish.name || '') + ' ' + fQty + ' ' + (finish.unit || '') + ' tayyar', 'success');
    renderHistory();
    if (window.App.showProductionBill) window.App.showProductionBill(res.production);
  });

  // ---- Production history ----
  const histCard = el('<div class="card" id="prod-history-card"><h2>Production History</h2></div>');
  const histWrap = el('<div id="prod-history"></div>');
  histCard.appendChild(histWrap);
  wrap.appendChild(histCard);
  function renderHistory() {
    const prods = (S().productions || []).slice();
    histWrap.innerHTML = '';
    if (prods.length === 0) { histWrap.appendChild(el('<p class="muted">Abhi tak koi production nahi hui.</p>')); return; }
    const rows = prods.map((pr) => {
      const used = (pr.lines || []).map((l) => esc(l.name) + ' ' + l.qty + ' ' + esc(l.unit || '')).join(', ');
      return '<tr><td><b>' + esc(pr.billNo || productionBillNo(pr)) + '</b></td><td>' + esc(pr.finishName || '') + ' <b>' + pr.finishQty + ' ' + esc(pr.finishUnit || '') + '</b></td><td>' + used + '</td><td><b>' + (pr.costKnown ? money(pr.totalCost) : money(pr.totalCost) + ' *') + '</b></td><td>' + esc(pr.createdBy || '') + '</td><td class="muted">' + esc(String(pr.date || '').slice(0, 16).replace('T', ' ')) + '</td><td><button type="button" class="btn btn-sm" data-pbill="' + esc(pr.id) + '">Bill</button></td></tr>';
    }).join('');
    histWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Finish</th><th>Raw Used</th><th>Total Cost</th><th>Banane Wala</th><th>Date</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    histWrap.querySelectorAll('button[data-pbill]').forEach((btn) => btn.addEventListener('click', () => {
      const pr = prods.find((x) => String(x.id) === String(btn.getAttribute('data-pbill')));
      if (pr) showProductionBill(pr);
    }));
  }

  searchRow.querySelector('#prod-search').addEventListener('input', (e) => drawRawList(e.target.value));
  drawRawList('');
  drawCart();
  renderHistory();
  container.appendChild(wrap);
}

window.Screens.production = renderProduction;
window.App.showProductionBill = showProductionBill;
window.App.printProductionBill = printProductionBill;
window.App.productionBillHtml = productionBillHtml;
window.App.productionBillNo = productionBillNo;
})();
