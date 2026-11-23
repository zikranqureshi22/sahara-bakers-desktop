/* Sahara Bakers — Stock In/Out + Stock levels (v2.0.0).
 * Stock In/Out: a simple form — Item + Miqdaar + Save only. Extra
 * details sit behind "Aur Details (optional)". Before saving, a
 * preview shows "Abhi godown mein: X — save ke baad kul Y". After
 * saving, a clear confirmation (item name, kitna aaya/gaya, ab kul
 * stock kitna hai) plus a low-stock inline note when the item falls
 * below its limit.
 * Stock: a clean stock-levels page (warehouse + each branch). Low-stock
 * rows get a bold border + "Kam Stock" tag + the line "Kam Stock
 * Notice — Warehouse mein sirf X bacha hai (limit: Y)".
 * Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function notify(m, t) { window.App.notify(m, t); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }

// Called from the Items screen: a whole-card click opens the Stock In
// sheet for that item. The stockio screen picks the pending product up.
window.App.openStockInSheet = function (productId) {
  window.App._pendingStockInProduct = productId;
  window.App.go('stockio');
};

function productOptions(selectedId) {
  return (S().products || []).map((p) =>
    '<option value="' + esc(p.id) + '"' + (String(p.id) === String(selectedId) ? ' selected' : '') + '>' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
  ).join('');
}

function renderStockIO(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const branches = st.branches || [];
  const pendingId = window.App._pendingStockInProduct;
  window.App._pendingStockInProduct = null;

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Stock In / Out</h1></div>'));

  // v2.1.0 — Owner gate: Owner Stock In/Out + Adjustment nahi kar
  // sakta (App.adjustStock mein Owner-check hai — DB layer mein koi
  // role check nahi, gate UI-level hai) — form chhupa di jati hai; neeche Recent Stock Movement
  // history read-only rehti hai. Stock screen (levels) alag se
  // readable rehti hai.
  const isOwner = !!(window.App.user && window.App.user.role === 'Owner');
  let formCtl = null;
  if (isOwner) {
    wrap.appendChild(el('<div class="card"><h2>Stock In / Out — Read-Only</h2><p class="muted">Owner stock in/out nahi kar sakta — stock entry Warehouse ka kaam hai. Aap neeche recent stock movements dekh sakte hain.</p></div>'));
  } else {
    const card = el('<div class="card"><h2>Stock Entry</h2></div>');
    formCtl = renderStockIOForm(card, pendingId, products, branches);
    wrap.appendChild(card);
  }

  // Recent movements (latest first, max 15).
  const moves = (S().stockMovements || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 15);
  const hist = el('<div class="card"><h2>Recent Stock Movement</h2></div>');
  if (moves.length === 0) hist.appendChild(el('<p class="muted">Abhi tak koi stock movement nahi hai.</p>'));
  else {
    const rows = moves.map((m) => {
      const q = Number(m.qty) || 0;
      return '<tr><td>' + esc(m.productName || '') + '</td><td>' + (q > 0 ? 'Aaya' : 'Gaya') + '</td><td><b>' + Math.abs(q) + '</b></td><td>' + esc(window.App.branchName(m.branchId)) + '</td><td>' + esc(m.reason || '') + '</td><td class="muted">' + esc(String(m.date || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
    }).join('');
    hist.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Type</th><th>Miqdaar</th><th>Branch</th><th>Wajah</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(hist);

  container.appendChild(wrap);
  if (formCtl) {
    formCtl.updatePreview();
    if (pendingId) { try { formCtl.qtyIn.focus(); } catch (e) { /* ignore */ } }
  }
}
// v2.1.0 — Stock Entry form, renderStockIO se alag kiya gaya taake
// Owner gate par form chhupaya ja sake aur history read-only rahe.
// (Pehle ye code renderStockIO ke andar inline tha; behaviour waisa
// hi hai — sirf updatePreview/qtyIn wapas diye jate hain.)
function renderStockIOForm(card, pendingId, products, branches) {
  const form = el('<form></form>');
  const itemSel = el('<select class="input" id="sio-item">' + productOptions(pendingId || (products[0] && products[0].id)) + '</select>');
  const qtyIn = el('<input class="input" type="number" min="0" step="any" required placeholder="Quantity (jaise 5)">');
  const dirSel = el('<select class="input"><option value="in">Stock In — Godown mein aaya</option><option value="out">Stock Out — Godown se gaya</option></select>');
  // Warehouse is a real location, not a branch: it is the FIRST
  // option (and the default), then the 3 branches.
  const branchSel = el('<select class="input"><option value="warehouse" selected>Warehouse (Godown)</option>' + branches.map((b) =>
    '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  // Extra details — hidden behind one toggle, never in the way.
  const detailsToggle = el('<button type="button" class="btn btn-ghost btn-sm" id="sio-details-toggle">More Details (optional) +</button>');
  const details = el('<div id="sio-details" hidden></div>');
  const reasonIn = el('<input class="input" type="text" placeholder="Wajah / Note (optional)">');
  const refIn = el('<input class="input" type="text" placeholder="Reference — bill / invoice no (optional)">');
  details.appendChild(el('<label>Reason / Note</label>')); details.appendChild(reasonIn);
  details.appendChild(el('<label>Reference</label>')); details.appendChild(refIn);
  const preview = el('<p class="muted" id="sio-preview"></p>');
  const confirmBox = el('<div id="sio-confirm" class="confirm-box-inline" hidden></div>');

  form.appendChild(el('<label>Item</label>')); form.appendChild(itemSel);
  form.appendChild(el('<label>Quantity</label>')); form.appendChild(qtyIn);
  form.appendChild(el('<label>Type</label>')); form.appendChild(dirSel);
  form.appendChild(el('<label>Branch / Godown</label>')); form.appendChild(branchSel);
  form.appendChild(detailsToggle);
  form.appendChild(details);
  form.appendChild(preview);
  form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Save</button></div>'));
  form.appendChild(confirmBox);
  card.appendChild(form);

  function updatePreview() {
    const p = (S().products || []).find((x) => String(x.id) === String(itemSel.value));
    const qty = Number(qtyIn.value) || 0;
    const dir = dirSel.value;
    if (!p || qty <= 0) { preview.textContent = ''; return; }
    const nowQty = window.App.stockOf(p, branchSel.value);
    const after = dir === 'in' ? nowQty + qty : Math.max(0, nowQty - qty);
    preview.textContent = 'Abhi godown mein: ' + nowQty + ' ' + (p.unit || '') + ' — save ke baad kul ' + after + ' ' + (p.unit || '');
  }
  [itemSel, qtyIn, dirSel, branchSel].forEach((inp) => inp.addEventListener('input', updatePreview));
  [itemSel, dirSel, branchSel].forEach((inp) => inp.addEventListener('change', updatePreview));
  detailsToggle.addEventListener('click', () => {
    const hidden = details.hidden;
    details.hidden = !hidden;
    detailsToggle.textContent = hidden ? 'More Details (optional) −' : 'More Details (optional) +';
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = (S().products || []).find((x) => String(x.id) === String(itemSel.value));
    const qty = Number(qtyIn.value);
    if (!p) { notify('Issue — Pehle item chunein', 'error'); return; }
    if (!qty || qty <= 0) { notify('Issue — Miqdaar durust likhein', 'error'); return; }
    const dir = dirSel.value;
    const branchId = window.App.normBranchId(branchSel.value);
    const delta = dir === 'in' ? qty : -qty;
    const before = window.App.stockOf(p, branchId);
    if (dir === 'out' && qty > before && !S().settings.allowNegativeStock) {
      notify('Issue — Itna stock nahi hai — godown mein sirf ' + before + ' ' + (p.unit || '') + ' hai', 'error');
      return;
    }
    const after = window.App.adjustStock(p, branchId, delta, reasonIn.value.trim() || (dir === 'in' ? 'Stock In' : 'Stock Out'), refIn.value.trim());
    window.App.save();
    const dirWord = dir === 'in' ? 'aaya' : 'gaya';
    confirmBox.hidden = false;
    const lowNow = window.App.isLowStock(p, branchId);
    const lim = window.App.lowLimitFor(p);
    confirmBox.innerHTML = '<b>' + esc(p.name) + '</b> — ' + qty + ' ' + esc(p.unit || '') + ' ' + dirWord +
      '. Ab kul stock: <b>' + after + ' ' + esc(p.unit || '') + '</b> (' + esc(window.App.branchName(branchId)) + ').' +
      (lowNow ? '<br><span class="low-tag">Kam Stock Notice — ' + esc(window.App.branchName(branchId)) + ' mein sirf ' + after + ' bacha hai (limit: ' + (lim == null ? '—' : lim) + ')</span>' : '');
    notify('Ho Gaya ✓ — ' + p.name + ': ' + qty + ' ' + (p.unit || '') + ' ' + dirWord + ' — ab kul ' + after, 'success');
    qtyIn.value = '';
    reasonIn.value = '';
    refIn.value = '';
    updatePreview();
  });

  return { updatePreview, qtyIn };
}

function renderStock(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const branches = st.branches || [];
  const warehouseId = window.App.warehouseBranchId();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Stock</h1></div>'));

  // Warehouse first — a real location, separate from the 3 branches.
  const whCard = el('<div class="card"><h2>Warehouse (Godown)</h2></div>');
  const whRows = products.map((p) => {
    const qty = window.App.stockOf(p, warehouseId);
    const low = window.App.isLowStock(p, warehouseId);
    const lim = window.App.lowLimitFor(p);
    return '<tr class="' + (low ? 'low-row' : '') + '"><td>' + esc(p.name) + '</td><td>' + esc(p.unit || '') + '</td><td><b>' + qty + '</b>' + (low ? ' <span class="low-tag">Kam Stock</span>' : '') + '</td><td>' + esc(window.App.moneyOrDash(p.price)) + '</td></tr>' +
      (low ? '<tr class="low-note-row"><td colspan="4">Kam Stock Notice — Warehouse mein sirf ' + qty + ' bacha hai (limit: ' + (lim == null ? '—' : lim) + ')</td></tr>' : '');
  }).join('');
  whCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Unit</th><th>Stock</th><th>Price</th></tr></thead><tbody>' + whRows + '</tbody></table></div>'));
  wrap.appendChild(whCard);

  branches.forEach((b) => {
    const card = el('<div class="card"><h2>' + esc(b.name) + '</h2></div>');
    const rows = products.map((p) => {
      const qty = window.App.stockOf(p, b.id);
      const low = window.App.isLowStock(p, b.id);
      const lim = window.App.lowLimitFor(p);
      return '<tr class="' + (low ? 'low-row' : '') + '"><td>' + esc(p.name) + '</td><td>' + esc(p.unit || '') + '</td><td><b>' + qty + '</b>' + (low ? ' <span class="low-tag">Kam Stock</span>' : '') + '</td><td>' + esc(window.App.moneyOrDash(p.price)) + '</td></tr>' +
        (low ? '<tr class="low-note-row"><td colspan="4">Kam Stock Notice — ' + esc(b.name) + ' mein sirf ' + qty + ' bacha hai (limit: ' + (lim == null ? '—' : lim) + ')</td></tr>' : '');
    }).join('');
    card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Unit</th><th>Stock</th><th>Price</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    wrap.appendChild(card);
  });

  container.appendChild(wrap);
}

window.Screens.stockio = renderStockIO;
window.Screens.stock = renderStock;
})();
