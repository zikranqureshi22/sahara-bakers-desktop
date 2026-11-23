/* Sahara Bakers — Products (v2.0.0).
 * ALL items on ONE full screen: a single table with photo, Name,
 * Price, Quantity (total stock) and Details — no Raw/Finished tabs
 * here (those live on their own screens). Search + type filter,
 * add/edit/delete (Owner/Manager). Wrapped in an IIFE.
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
// v2.1.0 — cost gating: cost sirf tab dikhe jab
// DB.canSeeCost(currentUser) true ho (Owner hamesha; Manager sirf
// jab Owner ne settings.managerCanSeeCost ON kiya ho).
function canSeeCost() {
  if (DB.canSeeCost) return DB.canSeeCost(window.App.user);
  return !!(window.App.user && window.App.user.role === 'Owner');
}
function isOwner() { return !!(window.App.user && window.App.user.role === 'Owner'); }

let currentQuery = '';
let currentFilter = 'all';

function thumb(p) {
  if (p.image) return '<img class="thumb" src="' + esc(p.image) + '" alt="' + esc(p.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'inline-flex\'"><span class="thumb-ph" style="display:none">' + esc(String(p.name || '').slice(0, 12)) + '</span>';
  return '<span class="thumb-ph">' + esc(String(p.name || '').slice(0, 12)) + '</span>';
}

function renderProducts(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const canEdit = window.App.canEditItems();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Products</h1>' + (canEdit ? '<button type="button" class="btn btn-primary" id="add-product-btn">+ New Product</button>' : '') + '</div>'));
  wrap.appendChild(el('<p class="muted">Sab items aik hi screen par — Raw Material aur Finish Goods, kul ' + products.length + ' items.</p>'));

  const searchRow = el('<div class="pos-search-row">' +
    '<input id="products-search" class="input" type="text" placeholder="Search Product — naam ya category" value="' + esc(currentQuery) + '">' +
    '<select id="products-filter" class="input" style="max-width:220px">' +
    '<option value="all"' + (currentFilter === 'all' ? ' selected' : '') + '>Sab Items</option>' +
    '<option value="raw"' + (currentFilter === 'raw' ? ' selected' : '') + '>Raw Material</option>' +
    '<option value="finished"' + (currentFilter === 'finished' ? ' selected' : '') + '>Finish Goods</option>' +
    '</select></div>');
  wrap.appendChild(searchRow);
  const tableWrap = el('<div id="products-table-wrap"></div>');
  wrap.appendChild(tableWrap);

  // SmartPOS card grid: photo, bold name, gray line, price in bold
  // yellow. No price entered yet -> the stock line is the value line
  // (a price is never invented). Edit/Delete (or History) on each card.
  function drawCards() {
    tableWrap.innerHTML = '';
    const q = currentQuery.trim().toLowerCase();
    const list = products.filter((p) =>
      (currentFilter === 'all' || p.type === currentFilter) &&
      (!q || String(p.name || '').toLowerCase().indexOf(q) !== -1 || String(p.category || '').toLowerCase().indexOf(q) !== -1));
    tableWrap.appendChild(el('<p class="muted" id="products-count">' + list.length + ' items dikhaye ja rahe hain (kul ' + products.length + ')</p>'));
    if (list.length === 0) {
      tableWrap.appendChild(el('<div class="card"><p class="muted">Koi product nahi mila.</p></div>'));
      return;
    }
    const cards = list.map((p) => {
      const qty = window.App.totalStock(p);
      const low = window.App.isLowStock(p);
      const hasPrice = p.price != null && p.price !== '';
      const imgHtml = p.image
        ? '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><span class="product-ph" style="display:none">' + esc(String(p.name || '').slice(0, 12)) + '</span>'
        : '<span class="product-ph">' + esc(String(p.name || '').slice(0, 12)) + '</span>';
      return '<div class="product-card' + (low ? ' low-stock' : '') + '" data-id="' + esc(p.id) + '" tabindex="0" role="button">' +
        imgHtml +
        '<div class="p-name">' + esc(p.name) + '</div>' +
        '<div class="p-meta">' + esc(p.category || '') + ' · ' + (p.type === 'raw' ? 'Raw Material' : 'Finish Goods') + ' · ' + esc(p.unit || '') + '</div>' +
        (hasPrice ? '<div class="p-price">' + esc(window.App.money(p.price)) + '</div>' : '') +
        // v2.1.0 — Cost line sirf canSeeCost() walon ko dikhe, warna
        // kuch nahi; blank cost "—" dikhaye, 0 ya andaza nahi.
        (canSeeCost() ? '<div class="p-meta">Cost: ' + esc(window.App.moneyOrDash(p.purchasePrice)) + '</div>' : '') +
        '<div class="' + (hasPrice ? 'p-stock' : 'p-stock p-stock-strong') + '">Stock: <b>' + qty + '</b> ' + esc(p.unit || '') + (low ? ' · <span class="low-tag">Kam Stock</span>' : '') + '</div></div>';
    }).join('');
    tableWrap.appendChild(el('<div class="product-grid" id="products-grid">' + cards + '</div>'));
    // No Edit/Delete buttons on the main listing: clicking a card opens
    // that product's own detail/manage screen, where Edit, Delete and
    // stock correction live.
    tableWrap.querySelectorAll('.product-card').forEach((cardEl) => {
      const p = products.find((x) => String(x.id) === String(cardEl.getAttribute('data-id')));
      if (!p) return;
      const open = () => window.App.showProductDetail(p, { onEdit: (prod) => openProductForm(prod) });
      cardEl.addEventListener('click', open);
      cardEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  function unitOptions(selected) {
    const units = ['Kg', 'Gram', 'Liter', 'ML', 'Pieces'];
    let html = units.map((u) => '<option value="' + u + '"' + (selected === u ? ' selected' : '') + '>' + u + '</option>').join('');
    if (selected && units.indexOf(selected) === -1) html += '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (custom)</option>';
    html += '<option value="__custom">Custom unit likhein…</option>';
    return html;
  }

  function openProductForm(p) {
    const isNew = !p;
    const prod = p || { type: 'raw' };
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = isNew ? 'New Product' : 'Edit Product — ' + (prod.name || '');
    bodyEl.innerHTML = '';
    const form = el('<form></form>');
    const nameIn = el('<input id="pf-name" class="input" type="text" required value="' + esc(prod.name || '') + '" placeholder="Product ka naam">');
    const typeSel = el('<select id="pf-type" class="input"><option value="raw"' + (prod.type === 'raw' ? ' selected' : '') + '>Raw Material</option><option value="finished"' + (prod.type === 'finished' ? ' selected' : '') + '>Finish Goods</option></select>');
    const catIn = el('<input id="pf-category" class="input" type="text" value="' + esc(prod.category || '') + '" placeholder="Category (jaise Flour, Mithai)">');
    const unitSel = el('<select id="pf-unit-sel" class="input">' + unitOptions(prod.unit || 'Kg') + '</select>');
    const unitCustom = el('<input id="pf-unit-custom" class="input" type="text" placeholder="Custom unit likhein (jaise Pack, Dozen)" style="display:none">');
    const priceIn = el('<input id="pf-price" class="input" type="number" min="0" step="0.01" value="' + (prod.price != null ? esc(prod.price) : '') + '" placeholder="Sale price (blank chhod sakte hain)">');
    // v2.1.0 — Cost Price field sirf Owner ko dikhe. Non-Owner ko
    // form mein cost field milta hi nahi (DB.updateItem patch se
    // purchasePrice waise bhi drop karta hai).
    const purchIn = isOwner() ? el('<input id="pf-purchase" class="input" type="number" min="0" step="0.01" value="' + (prod.purchasePrice != null ? esc(prod.purchasePrice) : '') + '" placeholder="Purchase price / cost (blank chhod sakte hain)">') : null;
    const detailsIn = el('<textarea id="pf-details" class="input" rows="2" placeholder="Details (jaise 50 Kg bag, fresh, waghera)">' + esc(prod.details || '') + '</textarea>');
    const lowIn = el('<input id="pf-low" class="input" type="number" min="0" step="1" value="' + (prod.lowThreshold != null ? esc(prod.lowThreshold) : '') + '" placeholder="Low stock limit (blank = default)">');
    const skuIn = el('<input id="pf-sku" class="input" type="text" value="' + esc(prod.sku || '') + '" placeholder="SKU (optional)">');
    const barcodeIn = el('<input id="pf-barcode" class="input" type="text" value="' + esc(prod.barcode || '') + '" placeholder="Barcode (optional)">');
    form.appendChild(el('<label>Name</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Type</label>')); form.appendChild(typeSel);
    form.appendChild(el('<label>Category</label>')); form.appendChild(catIn);
    form.appendChild(el('<label>Unit</label>')); form.appendChild(unitSel); form.appendChild(unitCustom);
    form.appendChild(el('<label>Sale Price (Rs)</label>')); form.appendChild(priceIn);
    if (isOwner()) { form.appendChild(el('<label>Purchase Price / Cost (Rs)</label>')); form.appendChild(purchIn); }
    form.appendChild(el('<label>Details</label>')); form.appendChild(detailsIn);
    form.appendChild(el('<label>Low Stock Limit</label>')); form.appendChild(lowIn);
    form.appendChild(el('<label>SKU</label>')); form.appendChild(skuIn);
    form.appendChild(el('<label>Barcode</label>')); form.appendChild(barcodeIn);
    // v2.1.0 — Owner ke liye maujooda item edit karte waqt Cost
    // Price ke ilawa SAB fields read-only/disabled hain.
    if (isOwner() && !isNew) {
      [nameIn, typeSel, catIn, unitSel, priceIn, detailsIn, lowIn, skuIn, barcodeIn].forEach((inp) => { inp.disabled = true; });
    }
    const row = el('<div class="form-actions"></div>');
    row.appendChild(el('<button type="submit" class="btn btn-primary">Save</button>'));
    row.appendChild(el('<button type="button" class="btn" id="pf-cancel">Cancel</button>'));
    form.appendChild(row);
    unitSel.addEventListener('change', () => {
      const custom = unitSel.value === '__custom';
      unitCustom.style.display = custom ? '' : 'none';
      if (custom) unitCustom.focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { notify('Issue — Product ka naam zaroori hai', 'error'); return; }
      let unit = unitSel.value;
      if (unit === '__custom') {
        unit = unitCustom.value.trim();
        if (!unit) { notify('Issue — Custom unit likhein', 'error'); return; }
      }
      // v2.1.0 — cost gating: purchasePrice kabhi is form ke rec
      // mein nahi jata. Owner ki cost sirf DB.setItemCostPrice se
      // badalti hai; Manager ki edit central DB.updateItem se save
      // hoti hai (jo purchasePrice/costPrice patch se khud drop
      // karta hai).
      const rec = {
        name, type: typeSel.value, category: catIn.value.trim(), unit,
        price: priceIn.value === '' ? null : Number(priceIn.value),
        details: detailsIn.value.trim() || null,
        lowThreshold: lowIn.value === '' ? null : Number(lowIn.value),
        sku: skuIn.value.trim() || null,
        barcode: barcodeIn.value.trim() || null,
      };
      if (isNew) {
        if (DB.checkUniqueness) {
          const chk = DB.checkUniqueness('products', rec, null);
          if (!chk.ok) { notify('Issue — ' + chk.message, 'error'); return; }
        }
        const np = Object.assign({ id: DB.nextId('products'), status: 'active', image: '', purchasePrice: null, stock: 0, branchStocks: (S().branches || []).map((b) => ({ branchId: b.id, qty: 0 })) }, rec);
        S().products.push(np);
        if (isOwner() && purchIn && purchIn.value !== '') {
          const cRes = DB.setItemCostPrice ? DB.setItemCostPrice(np.id, Number(purchIn.value), window.App.user) : { ok: false, message: 'Cost price set nahi ho saki' };
          if (!cRes.ok) notify('Issue — ' + (cRes.message || 'Cost price set nahi ho saki'), 'error');
        }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Product add ho gaya: ' + name, 'success');
        renderProducts(container);
      } else if (isOwner()) {
        // Owner edit: sirf Cost Price editable hai — baqi fields
        // disabled hain, is liye yahan sirf cost save hoti hai.
        const cRes = DB.setItemCostPrice ? DB.setItemCostPrice(prod.id, purchIn.value === '' ? null : Number(purchIn.value), window.App.user) : { ok: false, message: 'Cost price set nahi ho saki' };
        if (!cRes.ok) { notify('Issue — ' + (cRes.message || 'Cost price set nahi ho saki'), 'error'); return; }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Cost price update ho gaya: ' + (prod.name || ''), 'success');
        renderProducts(container);
      } else {
        const patch = { name, type: typeSel.value, category: catIn.value.trim(), unit, price: rec.price, lowThreshold: rec.lowThreshold, sku: rec.sku, barcode: rec.barcode };
        const res = DB.updateItem ? DB.updateItem(prod.id, patch, window.App.user) : { ok: true };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Product update nahi ho saka'), 'error'); return; }
        prod.details = rec.details;
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Product update ho gaya: ' + name, 'success');
        renderProducts(container);
      }
    });
    row.querySelector('#pf-cancel').addEventListener('click', closeForm);
    bodyEl.appendChild(form);
    overlay.hidden = false;
    overlay.style.display = 'flex';
    nameIn.focus();
  }
  function closeForm() {
    const overlay = document.getElementById('item-form-overlay');
    if (overlay) { overlay.hidden = true; overlay.style.display = 'none'; }
  }
  function openHistory(p) {
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = 'History — ' + (p.name || '');
    bodyEl.innerHTML = '';
    const moves = (S().stockMovements || []).filter((m) => String(m.productId) === String(p.id)).slice(0, 30);
    if (moves.length === 0) bodyEl.appendChild(el('<p class="muted">Is product ki koi movement abhi tak nahi hai.</p>'));
    else {
      const rows = moves.map((m) => {
        const q = Number(m.qty) || 0;
        return '<tr><td>' + (q > 0 ? 'Aaya' : 'Gaya') + '</td><td><b>' + Math.abs(q) + '</b></td><td>' + esc(window.App.branchName(m.branchId)) + '</td><td>' + esc(m.reason || '') + '</td><td class="muted">' + esc(String(m.date || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
      }).join('');
      bodyEl.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Type</th><th>Miqdaar</th><th>Branch</th><th>Wajah</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    const closeBtn = el('<div class="form-actions"><button type="button" class="btn btn-primary">Close</button></div>');
    closeBtn.querySelector('button').addEventListener('click', closeForm);
    bodyEl.appendChild(closeBtn);
    overlay.hidden = false;
    overlay.style.display = 'flex';
  }

  const searchInput = searchRow.querySelector('#products-search');
  let deb = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { currentQuery = searchInput.value; drawCards(); }, 150);
  });
  searchRow.querySelector('#products-filter').addEventListener('change', (e) => { currentFilter = e.target.value; drawCards(); });
  const addBtn = wrap.querySelector('#add-product-btn');
  if (addBtn) addBtn.addEventListener('click', () => openProductForm(null));
  const closeBtn = document.getElementById('item-form-x');
  if (closeBtn) closeBtn.onclick = closeForm;

  drawCards();
  container.appendChild(wrap);
}

window.Screens.products = renderProducts;
})();
