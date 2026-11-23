/* Sahara Bakers — Stock Transfer (v2.0.0).
 * Warehouse (godown) -> branch transfer with multi-item staging.
 * On submit the stock moves (both legs), the transfer is recorded,
 * and the invoice SB-0001... opens automatically: logo, warehouse,
 * branch, invoice no, date/time, product, qty sent, total items,
 * grand total / stock value, Received By, Issued By. 80mm thermal
 * print (measured-height) + PDF save via the bill preview modal.
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

function renderTransfer(container) {
  container.innerHTML = '';
  const st = S();
  const branches = st.branches || [];
  const products = st.products || [];
  const warehouseId = window.App.warehouseBranchId();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Stock Transfer</h1></div>'));

  // v2.1.0 — Owner read-only gate: Owner transfer create nahi kar
  // sakta (frozen DB bhi reject karta hai) — create form chhupa di
  // jati hai; list + bill detail neeche read-only rehte hain.
  const isOwner = !!(window.App.user && window.App.user.role === 'Owner');
  if (isOwner) {
    wrap.appendChild(el('<div class="card"><h2>Stock Transfer — Read-Only</h2><p class="muted">Transfer sirf Warehouse Manager karta hai — aap sirf dekh sakte hain. Neeche transfer history aur bills dekh sakte hain.</p></div>'));
  }

  const tCard = el('<div class="card"><h2>Branch Transfer — Warehouse se Branch</h2></div>');
  const tForm = el('<form></form>');
  // The source is LOCKED to the Warehouse (DB.WAREHOUSE_ID): there is
  // no From selector at all, so no branch can ever be picked as the
  // source and a branch-to-branch transfer is impossible in the UI.
  // The To dropdown lists ALL THREE branches — Branch 1 included.
  const fromId = warehouseId;
  const fromLine = el('<div class="input" id="tr-from-static" style="background:var(--panel2)"><b>Warehouse (Godown)</b></div>');
  const toSel = el('<select class="input" id="tr-to">' + branches.map((b) =>
    '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  const stageList = el('<div id="transfer-stage" style="margin-top:12px"></div>');
  const stage = []; // [{productId, qty}]
  const addRow = el('<div class="form-row"></div>');
  const addItemSel = el('<select class="input" id="tr-item">' + products.map((p) =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
  ).join('') + '</select>');
  const addQtyIn = el('<input class="input" id="tr-qty" type="number" min="0" step="any" placeholder="Miqdaar">');
  const addBtn = el('<button type="button" class="btn" id="tr-add-btn">+ Add Item</button>');
  addRow.appendChild(addItemSel); addRow.appendChild(addQtyIn); addRow.appendChild(addBtn);
  const receivedIn = el('<input class="input" id="tr-received-by" type="text" placeholder="Received By — jis ne stock liya (optional)">');
  const issuedIn = el('<input class="input" id="tr-issued-by" type="text" value="' + esc(window.App.user ? window.App.user.name : '') + '" placeholder="Issued By — jis ne stock bheja">');

  function drawStage() {
    stageList.innerHTML = '';
    if (stage.length === 0) {
      stageList.appendChild(el('<p class="muted">Abhi koi item add nahi hua — upar se item aur miqdaar chunein, phir "+ Add Item".</p>'));
      return;
    }
    const rows = stage.map((it, i) => {
      const p = products.find((x) => String(x.id) === String(it.productId));
      const avail = p ? window.App.stockOf(p, warehouseId) : 0;
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
  tForm.appendChild(el('<label>From (Warehouse / Godown)</label>')); tForm.appendChild(fromLine);
  tForm.appendChild(el('<label>To (Branch)</label>')); tForm.appendChild(toSel);
  tForm.appendChild(el('<label>Add Item</label>')); tForm.appendChild(addRow);
  tForm.appendChild(stageList);
  tForm.appendChild(el('<label>Received By</label>')); tForm.appendChild(receivedIn);
  tForm.appendChild(el('<label>Issued By</label>')); tForm.appendChild(issuedIn);
  tForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Transfer &amp; View Bill</button></div>'));
  tForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // Source is always the Warehouse — locked above, never read from
    // the form, so a branch can never become the source.
    const toId = window.App.normBranchId(toSel.value);
    if (String(fromId) === String(toId)) { notify('Issue — From aur To branch aik hi nahi ho sakte', 'error'); return; }
    if (stage.length === 0) { notify('Issue — Pehle kam az kam aik item add karein', 'error'); return; }
    // Stock check first — nothing moves until every line is available.
    // v2.1.0 — FEFO: expiry-tracked lines pick earliest-expiry first;
    // expired batches are never used. DB.fefoPick rejects (nothing
    // moves) when fresh stock is short — show its message as-is.
    const fefoPicks = [];
    for (const it of stage) {
      const p = products.find((x) => String(x.id) === String(it.productId));
      if (!p || !p.expiryTracked) continue;
      const fefo = DB.fefoPick(p.id, fromId, it.qty);
      if (!fefo.ok) { notify('Issue — ' + fefo.message, 'error'); return; }
      fefoPicks.push(...fefo.picks);
    }
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
      // v2.1.0 — line unitPrice stamp: har line ki supply value
      // transfer waqt ki CURRENT price se stamp hoti hai (price
      // blank ho to null) — dispatch cost/margin isi se banta hai.
      items: stage.map((it) => {
        const p = products.find((x) => String(x.id) === String(it.productId));
        return { productId: it.productId, qty: it.qty, unitPrice: (p && p.price != null) ? Number(p.price) : null };
      }),
      status: 'sent',
      createdBy: window.App.user ? window.App.user.name : '',
      receivedBy: receivedIn.value.trim(),
      issuedBy: issuedIn.value.trim() || (window.App.user ? window.App.user.name : ''),
    };
    const billNo = window.App.transferBillNo(transfer);
    stage.forEach((it) => {
      const p = products.find((x) => String(x.id) === String(it.productId));
      if (!p) return;
      const legRef = 'tr-' + transfer.id + '-' + p.id;
      window.App.adjustStock(p, fromId, -it.qty, 'Transfer — ' + window.App.branchName(toId), billNo, legRef + ':out');
      window.App.adjustStock(p, toId, it.qty, 'Transfer — ' + window.App.branchName(fromId) + ' se aaya', billNo, legRef + ':in');
    });
    // v2.1.0 — FEFO consume: decrement the picked batches now that the
    // stock has moved. (Coordinator-blessed: DB._consumeBatches.)
    if (DB._consumeBatches) DB._consumeBatches(fefoPicks);
    S().transfers.unshift(transfer);
    window.App.save();
    stage.length = 0;
    drawStage();
    notify('Ho Gaya ✓ — Transfer ' + billNo + ' ho gaya — ' + window.App.branchName(toId) + ' ko stock bhej diya', 'success');
    renderTransfer(container);
    if (window.App.showTransferBill) window.App.showTransferBill(transfer);
  });
  tCard.appendChild(tForm);
  // v2.1.0 — Owner read-only: create form sirf non-Owner ko dikhe.
  if (!isOwner) wrap.appendChild(tCard);

  // ---- Transfer History (re-print from here too) ----
  const transfers = (st.transfers || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const hCard = el('<div class="card"><h2>Transfer History</h2></div>');
  if (transfers.length === 0) hCard.appendChild(el('<p class="muted">Koi transfer abhi tak nahi hua.</p>'));
  else {
    const rowsHtml = transfers.map((t) => {
      const items = (t.items || []).map((it) => {
        const p = products.find((x) => String(x.id) === String(it.productId));
        return esc(p ? p.name : ('Item ' + it.productId)) + ' × ' + it.qty;
      }).join(', ');
      return '<tr><td><b>' + esc(window.App.transferBillNo(t)) + '</b></td><td>' + esc(window.App.branchName(t.fromBranchId)) + ' → ' + esc(window.App.branchName(t.toBranchId)) + '</td><td>' + items + '</td><td>' + esc(t.createdBy || '') + '</td><td class="muted">' + esc(String(t.date || '').slice(0, 16).replace('T', ' ')) + '</td><td><button type="button" class="btn btn-sm" data-bill="' + esc(t.id) + '">Bill</button></td></tr>';
    }).join('');
    hCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>From → To</th><th>Items</th><th>Sent By</th><th>Date</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
    hCard.querySelectorAll('button[data-bill]').forEach((btn) => btn.addEventListener('click', () => {
      const t = transfers.find((x) => String(x.id) === String(btn.getAttribute('data-bill')));
      if (t && window.App.showTransferBill) window.App.showTransferBill(t);
    }));
  }
  wrap.appendChild(hCard);

  container.appendChild(wrap);
  drawStage();
}

window.Screens.transfer = renderTransfer;
})();
