/* Sahara Bakers — Items (v2.0.0).
 * Two professional categories: "Raw Materials" (28) / "Finished Goods"
 * (16). Search bar placeholder "Search Item". The WHOLE product card
 * is clickable — it opens that item's Stock In sheet (see stock.js).
 * Exactly ONE English button per card: "Edit Item" (for logins that
 * cannot edit, the one button is "History"). Wrapped in an IIFE.
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
// v2.1.0 — cost gating helper (Owner hamesha; Manager kabhi nahi —
// is screen par cost dikhayi hi nahi jati, sirf form gating ke
// liye).
function isOwner() { return !!(window.App.user && window.App.user.role === 'Owner'); }

let currentType = 'raw';
let currentQuery = '';

function typeLabel(t) { return t === 'raw' ? 'Raw Materials' : 'Finished Goods'; }

function productImg(p) {
  if (p.image) return '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><div class="product-ph" style="display:none">' + esc(p.name) + '</div>';
  return '<div class="product-ph">' + esc(p.name) + '</div>';
}

function renderItems(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const canEdit = window.App.canEditItems();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Items</h1><button type="button" class="btn btn-primary" id="add-item-btn">+ Item Add Karein</button></div>'));

  // Search bar
  const searchRow = el('<div class="pos-search-row"><input id="items-search" class="input" type="text" placeholder="Search Item" value="' + esc(currentQuery) + '"></div>');
  wrap.appendChild(searchRow);

  // Category tabs (2 only)
  const tabs = el('<div class="btn-row" style="margin-bottom:14px">' +
    '<button type="button" class="btn' + (currentType === 'raw' ? ' btn-primary' : '') + '" id="tab-raw">Raw Materials</button>' +
    '<button type="button" class="btn' + (currentType === 'finished' ? ' btn-primary' : '') + '" id="tab-finished">Finished Goods</button>' +
    '</div>');
  wrap.appendChild(tabs);

  const gridWrap = el('<div id="items-grid-wrap"></div>');
  wrap.appendChild(gridWrap);

  function drawGrid() {
    gridWrap.innerHTML = '';
    const q = currentQuery.trim().toLowerCase();
    const list = products.filter((p) => p.type === currentType && (!q || String(p.name || '').toLowerCase().indexOf(q) !== -1 || String(p.category || '').toLowerCase().indexOf(q) !== -1));
    const head = el('<p class="muted">' + esc(typeLabel(currentType)) + ' — ' + list.length + ' items</p>');
    gridWrap.appendChild(head);
    if (list.length === 0) {
      gridWrap.appendChild(el('<div class="card"><p class="muted">Koi item nahi mila.</p></div>'));
      return;
    }
    const grid = el('<div class="product-grid"></div>');
    list.forEach((p) => {
      const stock = window.App.totalStock(p);
      const low = window.App.isLowStock(p);
      const card = el('<div class="product-card' + (low ? ' low-stock' : '') + '" tabindex="0" role="button">' +
        productImg(p) +
        '<div class="p-name">' + esc(p.name) + '</div>' +
        '<div class="p-price">' + esc(window.App.moneyOrDash(p.price)) + '</div>' +
        '<div class="p-stock">Stock: <b>' + stock + '</b> ' + esc(p.unit || '') + (low ? ' · <span class="low-tag">Kam Stock</span>' : '') + '</div>' +
        '<div style="margin-top:8px"><button type="button" class="btn btn-sm item-one-btn">' + (canEdit ? 'Edit Item' : 'History') + '</button></div>' +
        '</div>');
      // Whole card clickable → opens the Stock In sheet for this item.
      const openStockIn = () => { if (window.App.openStockInSheet) window.App.openStockInSheet(p.id); else window.App.go('stockio'); };
      card.addEventListener('click', (e) => {
        // The single button is the only exception: it does its own job.
        if (e.target.closest('.item-one-btn')) return;
        openStockIn();
      });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStockIn(); } });
      card.querySelector('.item-one-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (canEdit) openEditForm(p);
        else openHistory(p);
      });
      grid.appendChild(card);
    });
    gridWrap.appendChild(grid);
  }

  function openEditForm(p) {
    const isNew = !p;
    const prod = p || { type: currentType };
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = isNew ? 'Naya Item Add Karein' : 'Edit Item — ' + (prod.name || '');
    bodyEl.innerHTML = '';
    const form = el('<form></form>');
    const nameIn = el('<input class="input" type="text" required value="' + esc(prod.name || '') + '" placeholder="Item ka naam">');
    const typeSel = el('<select class="input"><option value="raw"' + (prod.type === 'raw' ? ' selected' : '') + '>Raw Materials</option><option value="finished"' + (prod.type === 'finished' ? ' selected' : '') + '>Finished Goods</option></select>');
    const catIn = el('<input class="input" type="text" value="' + esc(prod.category || '') + '" placeholder="Category (jaise Flour, Mithai)">');
    const unitSel = el('<select class="input">' + ['Kg', 'Liter', 'Pieces'].map((u) => '<option value="' + u + '"' + (prod.unit === u ? ' selected' : '') + '>' + u + '</option>').join('') + '</select>');
    const priceIn = el('<input class="input" type="number" min="0" step="0.01" value="' + (prod.price != null ? esc(prod.price) : '') + '" placeholder="Sale price (blank chhod sakte hain)">');
    // v2.1.0 — Purchase Price field sirf Owner ko dikhe. Non-Owner
    // ko form mein cost field milta hi nahi.
    const purchIn = isOwner() ? el('<input class="input" type="number" min="0" step="0.01" value="' + (prod.purchasePrice != null ? esc(prod.purchasePrice) : '') + '" placeholder="Purchase price (blank chhod sakte hain)">') : null;
    const lowIn = el('<input class="input" type="number" min="0" step="1" value="' + (prod.lowThreshold != null ? esc(prod.lowThreshold) : '') + '" placeholder="Low stock limit (blank = default)">');
    const skuIn = el('<input class="input" type="text" value="' + esc(prod.sku || '') + '" placeholder="SKU (optional)">');
    const barcodeIn = el('<input class="input" type="text" value="' + esc(prod.barcode || '') + '" placeholder="Barcode (optional)">');
    form.appendChild(el('<label>Naam</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Type</label>')); form.appendChild(typeSel);
    form.appendChild(el('<label>Category</label>')); form.appendChild(catIn);
    form.appendChild(el('<label>Unit</label>')); form.appendChild(unitSel);
    form.appendChild(el('<label>Sale Price (Rs)</label>')); form.appendChild(priceIn);
    if (isOwner()) { form.appendChild(el('<label>Purchase Price (Rs)</label>')); form.appendChild(purchIn); }
    form.appendChild(el('<label>Low Stock Limit</label>')); form.appendChild(lowIn);
    form.appendChild(el('<label>SKU</label>')); form.appendChild(skuIn);
    form.appendChild(el('<label>Barcode</label>')); form.appendChild(barcodeIn);
    // v2.1.0 — Owner ke liye maujooda item edit karte waqt Cost
    // Price ke ilawa SAB fields read-only/disabled hain.
    if (isOwner() && !isNew) {
      [nameIn, typeSel, catIn, unitSel, priceIn, lowIn, skuIn, barcodeIn].forEach((inp) => { inp.disabled = true; });
    }
    const row = el('<div class="form-actions"></div>');
    const saveBtn = el('<button type="submit" class="btn btn-primary">Save Karein</button>');
    const delBtn = !isNew ? el('<button type="button" class="btn btn-danger">Delete Karein</button>') : null;
    const cancelBtn = el('<button type="button" class="btn">Cancel</button>');
    row.appendChild(saveBtn);
    if (delBtn) row.appendChild(delBtn);
    row.appendChild(cancelBtn);
    form.appendChild(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { notify('Issue — Item ka naam zaroori hai', 'error'); return; }
      // v2.1.0 — cost gating: purchasePrice kabhi is form ke rec
      // mein nahi jata. Owner ki cost sirf DB.setItemCostPrice se
      // badalti hai; Manager ki edit central DB.updateItem se save
      // hoti hai (jo purchasePrice/costPrice patch se khud drop
      // karta hai).
      const rec = {
        name, type: typeSel.value, category: catIn.value.trim(),
        unit: unitSel.value,
        price: priceIn.value === '' ? null : Number(priceIn.value),
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
        notify('Ho Gaya ✓ — Item add ho gaya: ' + name, 'success');
        renderItems(container);
      } else if (isOwner()) {
        // Owner edit: sirf Cost Price editable hai — baqi fields
        // disabled hain, is liye yahan sirf cost save hoti hai.
        const cRes = DB.setItemCostPrice ? DB.setItemCostPrice(prod.id, purchIn.value === '' ? null : Number(purchIn.value), window.App.user) : { ok: false, message: 'Cost price set nahi ho saki' };
        if (!cRes.ok) { notify('Issue — ' + (cRes.message || 'Cost price set nahi ho saki'), 'error'); return; }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Cost price update ho gaya: ' + (prod.name || ''), 'success');
        renderItems(container);
      } else {
        const patch = { name, type: typeSel.value, category: catIn.value.trim(), unit: unitSel.value, price: rec.price, lowThreshold: rec.lowThreshold, sku: rec.sku, barcode: rec.barcode };
        const res = DB.updateItem ? DB.updateItem(prod.id, patch, window.App.user) : { ok: true };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Item update nahi ho saka'), 'error'); return; }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Item update ho gaya: ' + name, 'success');
        renderItems(container);
      }
    });
    if (delBtn) delBtn.addEventListener('click', async () => {
      const ok = await window.App.confirmDialog('Item Delete Karein?', '"' + (prod.name || '') + '" delete kar diya jayega. Ye wapas nahi aayega.');
      if (!ok) return;
      const idx = S().products.findIndex((x) => String(x.id) === String(prod.id));
      if (idx !== -1) S().products.splice(idx, 1);
      window.App.save();
      closeForm();
      notify('Ho Gaya ✓ — Item delete ho gaya: ' + (prod.name || ''), 'success');
      renderItems(container);
    });
    cancelBtn.addEventListener('click', closeForm);
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
    if (moves.length === 0) bodyEl.appendChild(el('<p class="muted">Is item ki koi movement abhi tak nahi hai.</p>'));
    else {
      const rows = moves.map((m) => {
        const q = Number(m.qty) || 0;
        return '<tr><td>' + (q > 0 ? 'Aaya' : 'Gaya') + '</td><td><b>' + Math.abs(q) + '</b></td><td>' + esc(window.App.branchName(m.branchId)) + '</td><td>' + esc(m.reason || '') + '</td><td class="muted">' + esc(String(m.date || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
      }).join('');
      bodyEl.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Type</th><th>Miqdaar</th><th>Branch</th><th>Wajah</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    const closeBtn = el('<div class="form-actions"><button type="button" class="btn btn-primary">Band Karein</button></div>');
    closeBtn.querySelector('button').addEventListener('click', closeForm);
    bodyEl.appendChild(closeBtn);
    overlay.hidden = false;
    overlay.style.display = 'flex';
  }

  const searchInput = searchRow.querySelector('#items-search');
  let deb = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { currentQuery = searchInput.value; drawGrid(); }, 150);
  });
  tabs.querySelector('#tab-raw').addEventListener('click', () => { currentType = 'raw'; renderItems(container); });
  tabs.querySelector('#tab-finished').addEventListener('click', () => { currentType = 'finished'; renderItems(container); });
  wrap.querySelector('#add-item-btn').addEventListener('click', () => {
    if (!window.App.canEditItems()) { notify('Issue — Item add karne ki permission nahi hai', 'error'); return; }
    openEditForm(null);
  });
  const closeBtn = document.getElementById('item-form-x');
  if (closeBtn) closeBtn.onclick = closeForm;

  drawGrid();
  container.appendChild(wrap);
}

window.Screens.items = renderItems;
})();
