/* Sahara Bakers — Branches + Branch Transfer (v1.0.0).
 * Branches: list + rename/edit (name, address, contact, manager),
 * Transfer History per branch. Branch Transfer form (warehouse →
 * one branch, multi-item staging) sits at the top of this screen:
 * on submit the stock moves, the movement is recorded, and the 80mm
 * thermal bill preview opens automatically. Re-print from Transfer
 * History rows. Wrapped in an IIFE.
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

function renderBranches(container) {
  container.innerHTML = '';
  const st = S();
  const branches = st.branches || [];
  const products = st.products || [];
  const warehouseId = window.App.warehouseBranchId();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Branches</h1></div>'));

  // ---- Branch Transfer form (multi-item staging) ----
  const tCard = el('<div class="card"><h2>Branch Transfer — Warehouse se Branch</h2></div>');
  const tForm = el('<form></form>');
  const fromSel = el('<select class="input">' + branches.map((b) =>
    '<option value="' + esc(b.id) + '"' + (String(b.id) === String(warehouseId) ? ' selected' : '') + '>' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  const toSel = el('<select class="input">' + branches.filter((b) => String(b.id) !== String(warehouseId)).map((b) =>
    '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  const stageList = el('<div id="transfer-stage" style="margin-top:12px"></div>');
  const stage = []; // [{productId, qty}]
  const addRow = el('<div class="form-row"></div>');
  const addItemSel = el('<select class="input">' + products.map((p) =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
  ).join('') + '</select>');
  const addQtyIn = el('<input class="input" type="number" min="0" step="any" placeholder="Miqdaar">');
  const addBtn = el('<button type="button" class="btn">+ Add Karein</button>');
  addRow.appendChild(addItemSel); addRow.appendChild(addQtyIn); addRow.appendChild(addBtn);

  function drawStage() {
    stageList.innerHTML = '';
    if (stage.length === 0) {
      stageList.appendChild(el('<p class="muted">Abhi koi item add nahi hua — upar se item aur miqdaar chunein, phir "+ Add Karein".</p>'));
      return;
    }
    const rows = stage.map((it, i) => {
      const p = products.find((x) => String(x.id) === String(it.productId));
      const avail = p ? window.App.stockOf(p, fromSel.value) : 0;
      return '<tr><td>' + esc(p ? p.name : '') + '</td><td><b>' + it.qty + '</b> ' + esc(p ? (p.unit || '') : '') + '</td><td class="muted">Available: ' + avail + '</td><td><button type="button" class="btn btn-sm" data-i="' + i + '">Hataein</button></td></tr>';
    }).join('');
    stageList.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Miqdaar</th><th>Warehouse Stock</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    stageList.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
      stage.splice(Number(b.getAttribute('data-i')), 1);
      drawStage();
    }));
  }
  addBtn.addEventListener('click', () => {
    const p = products.find((x) => String(x.id) === String(addItemSel.value));
    const qty = Number(addQtyIn.value);
    if (!p) { notify('Issue — Pehle item chunein', 'error'); return; }
    if (!qty || qty <= 0) { notify('Issue — Miqdaar durust likhein', 'error'); return; }
    const existing = stage.find((it) => String(it.productId) === String(p.id));
    if (existing) existing.qty += qty;
    else stage.push({ productId: p.id, qty });
    addQtyIn.value = '';
    drawStage();
  });
  tForm.appendChild(el('<label>From (Warehouse / Godown)</label>')); tForm.appendChild(fromSel);
  tForm.appendChild(el('<label>To (Branch)</label>')); tForm.appendChild(toSel);
  tForm.appendChild(el('<label>Item Add Karein</label>')); tForm.appendChild(addRow);
  tForm.appendChild(stageList);
  tForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Transfer Karein aur Bill Dekhein</button></div>'));
  tForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fromId = window.App.normBranchId(fromSel.value);
    const toId = window.App.normBranchId(toSel.value);
    if (String(fromId) === String(toId)) { notify('Issue — From aur To branch aik hi nahi ho sakte', 'error'); return; }
    if (stage.length === 0) { notify('Issue — Pehle kam az kam aik item add karein', 'error'); return; }
    // Stock check first — nothing moves until every line is available.
    for (const it of stage) {
      const p = products.find((x) => String(x.id) === String(it.productId));
      if (!p) continue;
      if (window.App.stockOf(p, fromId) < it.qty && !S().settings.allowNegativeStock) {
        notify('Issue — ' + p.name + ' ka itna stock nahi hai — ' + esc(window.App.branchName(fromId)) + ' mein sirf ' + window.App.stockOf(p, fromId) + ' hai', 'error');
        return;
      }
    }
    const transfer = {
      id: DB.nextId('transfers'),
      date: new Date().toISOString(),
      fromBranchId: fromId,
      toBranchId: toId,
      items: stage.map((it) => ({ productId: it.productId, qty: it.qty })),
      status: 'sent',
      createdBy: window.App.user ? window.App.user.name : '',
    };
    stage.forEach((it) => {
      const p = products.find((x) => String(x.id) === String(it.productId));
      if (!p) return;
      window.App.adjustStock(p, fromId, -it.qty, 'Transfer — ' + window.App.branchName(toId), window.App.transferBillNo(transfer));
      window.App.adjustStock(p, toId, it.qty, 'Transfer — ' + window.App.branchName(fromId) + ' se aaya', window.App.transferBillNo(transfer));
    });
    S().transfers.unshift(transfer);
    window.App.save();
    stage.length = 0;
    drawStage();
    notify('Ho Gaya ✓ — Transfer ' + window.App.transferBillNo(transfer) + ' ho gaya — ' + window.App.branchName(toId) + ' ko stock bhej diya', 'success');
    renderBranches(container);
    if (window.App.showTransferBill) window.App.showTransferBill(transfer);
  });
  tCard.appendChild(tForm);
  wrap.appendChild(tCard);

  // ---- Branch list + edit ----
  const bCard = el('<div class="card"><h2>Branch List</h2></div>');
  const rows = branches.map((b) => {
    const isWarehouse = String(b.id) === String(warehouseId);
    return '<tr><td><b>' + esc(b.name) + '</b>' + (isWarehouse ? ' <span class="muted">(Warehouse / Godown)</span>' : '') + '</td><td>' + esc(b.address || '—') + '</td><td>' + esc(b.contact || '—') + '</td><td>' + esc(b.manager || '—') + '</td><td><button type="button" class="btn btn-sm" data-edit="' + esc(b.id) + '">Edit Karein</button></td></tr>';
  }).join('');
  bCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Branch</th><th>Address</th><th>Contact</th><th>Manager</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  bCard.querySelectorAll('button[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const b = branches.find((x) => String(x.id) === String(btn.getAttribute('data-edit')));
    if (!b) return;
    openBranchEdit(b);
  }));
  wrap.appendChild(bCard);

  function openBranchEdit(b) {
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = 'Edit Branch — ' + (b.name || '');
    bodyEl.innerHTML = '';
    const form = el('<form></form>');
    const nameIn = el('<input class="input" type="text" required value="' + esc(b.name || '') + '">');
    const addrIn = el('<input class="input" type="text" value="' + esc(b.address || '') + '" placeholder="Address">');
    const contactIn = el('<input class="input" type="text" value="' + esc(b.contact || '') + '" placeholder="Contact / phone">');
    const mgrIn = el('<input class="input" type="text" value="' + esc(b.manager || '') + '" placeholder="Manager ka naam">');
    form.appendChild(el('<label>Branch Ka Naam</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Address</label>')); form.appendChild(addrIn);
    form.appendChild(el('<label>Contact</label>')); form.appendChild(contactIn);
    form.appendChild(el('<label>Manager</label>')); form.appendChild(mgrIn);
    const row = el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save Karein</button><button type="button" class="btn" id="branch-edit-cancel">Cancel</button></div>');
    form.appendChild(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { notify('Issue — Branch ka naam zaroori hai', 'error'); return; }
      if (DB.checkUniqueness) {
        const chk = DB.checkUniqueness('branches', { name }, b.id);
        if (!chk.ok) { notify('Issue — ' + chk.message, 'error'); return; }
      }
      b.name = name;
      b.address = addrIn.value.trim();
      b.contact = contactIn.value.trim();
      b.manager = mgrIn.value.trim();
      window.App.save();
      overlay.hidden = true; overlay.style.display = 'none';
      notify('Ho Gaya ✓ — Branch update ho gayi: ' + name, 'success');
      renderBranches(container);
    });
    row.querySelector('#branch-edit-cancel').addEventListener('click', () => { overlay.hidden = true; overlay.style.display = 'none'; });
    bodyEl.appendChild(form);
    overlay.hidden = false;
    overlay.style.display = 'flex';
    nameIn.focus();
  }

  // ---- Transfer History (per branch filter + re-print) ----
  const transfers = (st.transfers || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const hCard = el('<div class="card"><h2>Transfer History</h2></div>');
  const filterRow = el('<div class="toolbar"><div class="field"><label>Branch</label><select class="input" id="th-filter"><option value="all">Sab Branches</option>' +
    branches.map((b) => '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>').join('') + '</select></div></div>');
  hCard.appendChild(filterRow);
  const histWrap = el('<div id="th-list"></div>');
  hCard.appendChild(histWrap);
  function drawHistory() {
    const f = filterRow.querySelector('#th-filter').value;
    const list = transfers.filter((t) => f === 'all' || String(t.fromBranchId) === String(f) || String(t.toBranchId) === String(f));
    histWrap.innerHTML = '';
    if (list.length === 0) { histWrap.appendChild(el('<p class="muted">Koi transfer abhi tak nahi hua.</p>')); return; }
    const rowsHtml = list.map((t) => {
      const items = (t.items || []).map((it) => {
        const p = products.find((x) => String(x.id) === String(it.productId));
        return esc(p ? p.name : ('Item ' + it.productId)) + ' × ' + it.qty;
      }).join(', ');
      return '<tr><td><b>' + esc(window.App.transferBillNo(t)) + '</b></td><td>' + esc(window.App.branchName(t.fromBranchId)) + ' → ' + esc(window.App.branchName(t.toBranchId)) + '</td><td>' + items + '</td><td>' + esc(t.createdBy || '') + '</td><td class="muted">' + esc(String(t.date || '').slice(0, 16).replace('T', ' ')) + '</td><td><button type="button" class="btn btn-sm" data-bill="' + esc(t.id) + '">Bill</button></td></tr>';
    }).join('');
    histWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>From → To</th><th>Items</th><th>Sent By</th><th>Date</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
    histWrap.querySelectorAll('button[data-bill]').forEach((btn) => btn.addEventListener('click', () => {
      const t = transfers.find((x) => String(x.id) === String(btn.getAttribute('data-bill')));
      if (t && window.App.showTransferBill) window.App.showTransferBill(t);
    }));
  }
  filterRow.querySelector('#th-filter').addEventListener('change', drawHistory);
  drawHistory();
  wrap.appendChild(hCard);

  container.appendChild(wrap);
  drawStage();
}

window.Screens.branches = renderBranches;
})();
