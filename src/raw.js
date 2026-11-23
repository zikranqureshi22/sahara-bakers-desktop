/* Sahara Bakers — Raw Material (v2.0.0).
 * Raw section only: add raw item (Name, Qty/Stock, custom unit picker
 * KG/Gram/Liter/ML/Pieces + free-typed custom unit, purchase price),
 * total stock rollup, available stock visible per item, search/filter.
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
// v2.1.0 — cost gating: cost sirf tab dikhe jab
// DB.canSeeCost(currentUser) true ho (Owner hamesha; Manager sirf
// jab Owner ne settings.managerCanSeeCost ON kiya ho).
function canSeeCost() {
  if (DB.canSeeCost) return DB.canSeeCost(window.App.user);
  return !!(window.App.user && window.App.user.role === 'Owner');
}
function isOwner() { return !!(window.App.user && window.App.user.role === 'Owner'); }

let currentQuery = '';

function thumb(p) {
  if (p.image) return '<img class="thumb" src="' + esc(p.image) + '" alt="' + esc(p.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'inline-flex\'"><span class="thumb-ph" style="display:none">' + esc(String(p.name || '').slice(0, 12)) + '</span>';
  return '<span class="thumb-ph">' + esc(String(p.name || '').slice(0, 12)) + '</span>';
}

function unitOptions(selected) {
  const units = ['Kg', 'Gram', 'Liter', 'ML', 'Pieces'];
  let html = units.map((u) => '<option value="' + u + '"' + (selected === u ? ' selected' : '') + '>' + u + '</option>').join('');
  if (selected && units.indexOf(selected) === -1) html += '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (custom)</option>';
  html += '<option value="__custom">Custom unit likhein…</option>';
  return html;
}

function renderRaw(container) {
  container.innerHTML = '';
  const st = S();
  const raws = (st.products || []).filter((p) => p.type === 'raw');
  const canEdit = window.App.canEditItems();
  const warehouseId = window.App.warehouseBranchId();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Raw Material</h1>' + (canEdit ? '<button type="button" class="btn btn-primary" id="add-raw-btn">+ New Raw Item</button>' : '') + '</div>'));

  const totalQty = raws.reduce((a, p) => a + (window.App.totalStock(p) || 0), 0);
  const stats = el('<div class="stat-grid"></div>');
  stats.appendChild(el('<div class="stat"><div class="stat-label">Raw Items</div><div class="stat-value">' + raws.length + '</div><div class="muted">kul raw items</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Total Raw Stock</div><div class="stat-value">' + totalQty + '</div><div class="muted">sab raw items ka kul stock (sab branches)</div></div>'));
  stats.appendChild(el('<div class="stat"><div class="stat-label">Godown Raw Stock</div><div class="stat-value">' + raws.reduce((a, p) => a + (window.App.stockOf(p, warehouseId) || 0), 0) + '</div><div class="muted">Warehouse mein raw stock</div></div>'));
  wrap.appendChild(stats);

  const searchRow = el('<div class="pos-search-row"><input id="raw-search" class="input" type="text" placeholder="Search Raw Item — naam ya category" value="' + esc(currentQuery) + '"></div>');
  wrap.appendChild(searchRow);
  const tableWrap = el('<div id="raw-table-wrap"></div>');
  wrap.appendChild(tableWrap);

  function drawTable() {
    tableWrap.innerHTML = '';
    const q = currentQuery.trim().toLowerCase();
    const list = raws.filter((p) => !q || String(p.name || '').toLowerCase().indexOf(q) !== -1 || String(p.category || '').toLowerCase().indexOf(q) !== -1);
    tableWrap.appendChild(el('<p class="muted" id="raw-count">' + list.length + ' raw items</p>'));
    if (list.length === 0) {
      tableWrap.appendChild(el('<div class="card"><p class="muted">Koi raw item nahi mila.</p></div>'));
      return;
    }
    const rows = list.map((p) => {
      const qty = window.App.totalStock(p);
      const avail = window.App.stockOf(p, warehouseId);
      const low = window.App.isLowStock(p);
      return '<tr data-id="' + esc(p.id) + '" class="' + (low ? 'low-row' : '') + '">' +
        '<td>' + thumb(p) + '</td>' +
        '<td><b>' + esc(p.name) + '</b><br><span class="muted">' + esc(p.category || '') + '</span></td>' +
        '<td>' + esc(p.unit || '') + '</td>' +
        '<td><b>' + qty + '</b>' + (low ? ' <span class="low-tag">Kam Stock</span>' : '') + '</td>' +
        '<td><b>' + avail + '</b> ' + esc(p.unit || '') + ' <span class="muted">(godown)</span></td>' +
        // v2.1.0 — Purchase Price sirf canSeeCost() walon ko dikhe,
        // warna "—" (blank cost bhi "—").
        '<td>' + (canSeeCost() ? esc(window.App.moneyOrDash(p.purchasePrice)) : '—') + '</td>' +
        '<td>' + esc(window.App.moneyOrDash(p.price)) + '</td>' +
        '<td>' + '<button type="button" class="btn btn-sm raw-details" data-id="' + esc(p.id) + '">Details</button></td></tr>';
    }).join('');
    tableWrap.appendChild(el('<div class="table-wrap"><table id="raw-table"><thead><tr><th>Photo</th><th>Name</th><th>Unit</th><th>Total Stock</th><th>Available (Godown)</th><th>Purchase Price</th><th>Sale Price</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    // No Edit button on the main listing: Details opens the product's
    // own detail/manage screen, where Edit, Delete and stock correction live.
    tableWrap.querySelectorAll('.raw-details').forEach((b) => b.addEventListener('click', () => {
      const p = raws.find((x) => String(x.id) === String(b.getAttribute('data-id')));
      if (p) window.App.showProductDetail(p, { onEdit: (prod) => openRawForm(prod) });
    }));
  }

  function openRawHistory(p) {
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
    const closeBtn = el('<div class="form-actions"><button type="button" class="btn btn-primary">Close</button></div>');
    closeBtn.querySelector('button').addEventListener('click', closeForm);
    bodyEl.appendChild(closeBtn);
    overlay.hidden = false;
    overlay.style.display = 'flex';
  }

  function openRawForm(p) {
    const isNew = !p;
    const prod = p || { type: 'raw' };
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = isNew ? 'New Raw Item' : 'Edit Raw Item — ' + (prod.name || '');
    bodyEl.innerHTML = '';
    const form = el('<form></form>');
    const nameIn = el('<input id="rf-name" class="input" type="text" required value="' + esc(prod.name || '') + '" placeholder="Raw item ka naam">');
    const catIn = el('<input id="rf-category" class="input" type="text" value="' + esc(prod.category || 'Bakery Raw Materials') + '" placeholder="Category">');
    const unitSel = el('<select id="rf-unit-sel" class="input">' + unitOptions(prod.unit || 'Kg') + '</select>');
    const unitCustom = el('<input id="rf-unit-custom" class="input" type="text" placeholder="Custom unit likhein (jaise Pack, Dozen)" style="display:none">');
    const qtyIn = el('<input id="rf-qty" class="input" type="number" min="0" step="any" value="' + (isNew ? '' : window.App.stockOf(prod, warehouseId)) + '" placeholder="Godown mein miqdaar (optional)">');
    // v2.1.0 — Purchase Price field sirf Owner ko dikhe. Non-Owner
    // ko form mein cost field milta hi nahi.
    const purchIn = isOwner() ? el('<input id="rf-purchase" class="input" type="number" min="0" step="0.01" value="' + (prod.purchasePrice != null ? esc(prod.purchasePrice) : '') + '" placeholder="Purchase price (Rs) — blank chhod sakte hain">') : null;
    const priceIn = el('<input id="rf-price" class="input" type="number" min="0" step="0.01" value="' + (prod.price != null ? esc(prod.price) : '') + '" placeholder="Sale price (Rs) — blank chhod sakte hain">');
    const detailsIn = el('<textarea id="rf-details" class="input" rows="2" placeholder="Details (optional)">' + esc(prod.details || '') + '</textarea>');
    form.appendChild(el('<label>Name</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Category</label>')); form.appendChild(catIn);
    form.appendChild(el('<label>Unit</label>')); form.appendChild(unitSel); form.appendChild(unitCustom);
    form.appendChild(el('<label>Godown Stock (Quantity)</label>')); form.appendChild(qtyIn);
    if (isOwner()) { form.appendChild(el('<label>Purchase Price (Rs)</label>')); form.appendChild(purchIn); }
    form.appendChild(el('<label>Sale Price (Rs)</label>')); form.appendChild(priceIn);
    form.appendChild(el('<label>Details</label>')); form.appendChild(detailsIn);
    // v2.1.0 — Owner ke liye maujooda item edit karte waqt Cost
    // Price ke ilawa SAB fields read-only/disabled hain.
    if (isOwner() && !isNew) {
      [nameIn, catIn, unitSel, qtyIn, priceIn, detailsIn].forEach((inp) => { inp.disabled = true; });
    }
    const row = el('<div class="form-actions"></div>');
    row.appendChild(el('<button type="submit" class="btn btn-primary">Save</button>'));
    row.appendChild(el('<button type="button" class="btn" id="rf-cancel">Cancel</button>'));
    form.appendChild(row);
    unitSel.addEventListener('change', () => {
      const custom = unitSel.value === '__custom';
      unitCustom.style.display = custom ? '' : 'none';
      if (custom) unitCustom.focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { notify('Issue — Naam zaroori hai', 'error'); return; }
      let unit = unitSel.value;
      if (unit === '__custom') {
        unit = unitCustom.value.trim();
        if (!unit) { notify('Issue — Custom unit likhein', 'error'); return; }
      }
      // v2.1.0 — cost gating: purchasePrice kabhi is form ke rec
      // mein nahi jata. Owner ki cost sirf DB.setItemCostPrice se
      // badalti hai; Manager ki edit central DB.updateItem se save
      // hoti hai (jo purchasePrice/costPrice patch se khud drop
      // karta hai). Godown stock set karna Owner ke liye disabled
      // hai (qty field read-only), is liye wahan koi movement nahi
      // banti.
      const rec = {
        name, type: 'raw', category: catIn.value.trim(), unit,
        price: priceIn.value === '' ? null : Number(priceIn.value),
        details: detailsIn.value.trim() || null,
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
        const q0 = Number(qtyIn.value);
        if (q0 > 0) {
          window.App.setStock(np, warehouseId, q0);
          DB.addMovement({ productId: np.id, productName: np.name, branchId: warehouseId, qty: q0, reason: 'Raw Item Add — opening stock', user: window.App.user ? window.App.user.name : '', reference: 'Add Item' });
        }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Raw item add ho gaya: ' + name, 'success');
        renderRaw(container);
      } else if (isOwner()) {
        // Owner edit: sirf Cost Price editable hai — baqi fields
        // disabled hain, is liye yahan sirf cost save hoti hai.
        const cRes = DB.setItemCostPrice ? DB.setItemCostPrice(prod.id, purchIn.value === '' ? null : Number(purchIn.value), window.App.user) : { ok: false, message: 'Cost price set nahi ho saki' };
        if (!cRes.ok) { notify('Issue — ' + (cRes.message || 'Cost price set nahi ho saki'), 'error'); return; }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Cost price update ho gaya: ' + (prod.name || ''), 'success');
        renderRaw(container);
      } else {
        const patch = { name, type: 'raw', category: catIn.value.trim(), unit, price: rec.price };
        const res = DB.updateItem ? DB.updateItem(prod.id, patch, window.App.user) : { ok: true };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Raw item update nahi ho saka'), 'error'); return; }
        prod.details = rec.details;
        const q1 = qtyIn.value === '' ? null : Number(qtyIn.value);
        if (q1 != null && q1 >= 0) {
          const before = window.App.stockOf(prod, warehouseId);
          if (q1 !== before) {
            window.App.setStock(prod, warehouseId, q1);
            DB.addMovement({ productId: prod.id, productName: prod.name, branchId: warehouseId, qty: q1 - before, reason: 'Raw Item Edit — stock set', user: window.App.user ? window.App.user.name : '', reference: 'Edit Item' });
          }
        }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Raw item update ho gaya: ' + name, 'success');
        renderRaw(container);
      }
    });
    row.querySelector('#rf-cancel').addEventListener('click', closeForm);
    bodyEl.appendChild(form);
    overlay.hidden = false;
    overlay.style.display = 'flex';
    nameIn.focus();
  }
  function closeForm() {
    const overlay = document.getElementById('item-form-overlay');
    if (overlay) { overlay.hidden = true; overlay.style.display = 'none'; }
  }

  const searchInput = searchRow.querySelector('#raw-search');
  let deb = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { currentQuery = searchInput.value; drawTable(); }, 150);
  });
  const addBtn = wrap.querySelector('#add-raw-btn');
  if (addBtn) addBtn.addEventListener('click', () => openRawForm(null));
  const closeBtn = document.getElementById('item-form-x');
  if (closeBtn) closeBtn.onclick = closeForm;

  drawTable();
  container.appendChild(wrap);
}

window.Screens.raw = renderRaw;
})();
