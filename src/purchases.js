/* Sahara Bakers — Purchases (v2.0.0).
 * Unique invoice number (duplicates rejected with a notice), supplier,
 * lines, auto stock-in on save. The purchase lands in the Warehouse
 * unless another branch is picked. Wrapped in an IIFE.
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

function renderPurchases(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const branches = st.branches || [];

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Purchases</h1></div>'));

  // ---- New purchase form ----
  const pCard = el('<div class="card"><h2>Nayi Purchase</h2></div>');
  const form = el('<form></form>');
  const invIn = el('<input class="input" type="text" required placeholder="Invoice number (unique — jaise INV-001)">');
  const supplierIn = el('<input class="input" type="text" placeholder="Supplier ka naam (optional)">');
  const branchSel = el('<select class="input"><option value="warehouse" selected>Warehouse (Godown)</option>' + branches.map((b) =>
    '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  const paidIn = el('<input class="input" type="number" min="0" step="0.01" placeholder="Paid amount (optional)">');
  const linesWrap = el('<div id="purchase-lines" style="margin-top:12px"></div>');
  const lines = []; // [{productId, qty, unitPrice, expiryDate}] — expiryDate sirf expiry-tracked items par hoti hai
  const addRow = el('<div class="form-row"></div>');
  const addItemSel = el('<select class="input">' + products.map((p) =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
  ).join('') + '</select>');
  const addQtyIn = el('<input class="input" type="number" min="0" step="any" placeholder="Miqdaar">');
  const addPriceIn = el('<input class="input" type="number" min="0" step="0.01" placeholder="Unit price (Rs)">');
  // v2.1.0 — Expiry: expiry-date input sirf expiry-tracked items par dikhta hai.
  const addExpiryIn = el('<input class="input" id="purchase-expiry" type="date" title="Expiry date" style="display:none">');
  const addBtn = el('<button type="button" class="btn">+ Add Purchase</button>');
  addRow.appendChild(addItemSel); addRow.appendChild(addQtyIn); addRow.appendChild(addPriceIn); addRow.appendChild(addExpiryIn); addRow.appendChild(addBtn);
  // Tracked item chunte hi expiry input dikhao, warna chhupao.
  function syncExpiryInput() {
    const p = products.find((x) => String(x.id) === String(addItemSel.value));
    if (p && p.expiryTracked) { addExpiryIn.style.display = ''; }
    else { addExpiryIn.style.display = 'none'; addExpiryIn.value = ''; }
  }
  addItemSel.addEventListener('change', syncExpiryInput);
  const totalEl = el('<p class="muted" id="purchase-total"></p>');

  function drawLines() {
    linesWrap.innerHTML = '';
    if (lines.length === 0) {
      linesWrap.appendChild(el('<p class="muted">Abhi koi line add nahi hui — upar se item, miqdaar aur unit price likhein, phir "+ Add Purchase".</p>'));
    } else {
      const rows = lines.map((ln, i) => {
        const p = products.find((x) => String(x.id) === String(ln.productId));
        return '<tr><td>' + esc(p ? p.name : '') + (ln.expiryDate ? '<br><span class="muted">Expiry: ' + esc(ln.expiryDate) + '</span>' : '') + '</td><td><b>' + ln.qty + '</b></td><td>' + money(ln.unitPrice) + '</td><td><b>' + money(ln.qty * ln.unitPrice) + '</b></td><td><button type="button" class="btn btn-sm" data-i="' + i + '">Hataein</button></td></tr>';
      }).join('');
      linesWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Line Total</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
      linesWrap.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
        lines.splice(Number(b.getAttribute('data-i')), 1);
        drawLines();
      }));
    }
    const total = lines.reduce((a, ln) => a + (ln.qty * ln.unitPrice), 0);
    totalEl.textContent = 'Kul Total: ' + money(total);
  }
  addBtn.addEventListener('click', () => {
    const p = products.find((x) => String(x.id) === String(addItemSel.value));
    const qty = Number(addQtyIn.value);
    const price = Number(addPriceIn.value);
    if (!p) { notify('Issue — Pehle item chunein', 'error'); return; }
    if (!qty || qty <= 0) { notify('Issue — Miqdaar durust likhein', 'error'); return; }
    if (addPriceIn.value === '' || isNaN(price) || price < 0) { notify('Issue — Unit price durust likhein', 'error'); return; }
    // v2.1.0 — Expiry: tracked item par expiry date zaroori hai (DB.addBatch bhi yehi mangta hai).
    const expiryDate = addExpiryIn.value ? addExpiryIn.value.slice(0, 10) : '';
    if (p.expiryTracked && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) { notify('Issue — "' + p.name + '" expiry-tracked hai — expiry date zaroori hai', 'error'); return; }
    const existing = lines.find((ln) => String(ln.productId) === String(p.id) && ln.unitPrice === price && String(ln.expiryDate || '') === expiryDate);
    if (existing) existing.qty += qty;
    else lines.push({ productId: p.id, qty, unitPrice: price, expiryDate: expiryDate || null });
    addQtyIn.value = '';
    addPriceIn.value = '';
    addExpiryIn.value = '';
    drawLines();
  });

  form.appendChild(el('<label>Invoice Number</label>')); form.appendChild(invIn);
  form.appendChild(el('<label>Supplier</label>')); form.appendChild(supplierIn);
  form.appendChild(el('<label>Stock kahan aayega</label>')); form.appendChild(branchSel);
  form.appendChild(el('<label>Lines</label>')); form.appendChild(addRow);
  form.appendChild(linesWrap);
  form.appendChild(totalEl);
  form.appendChild(el('<label>Paid Amount (Rs)</label>')); form.appendChild(paidIn);
  form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Save Purchase (Auto Stock-In)</button></div>'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const invoiceNo = invIn.value.trim();
    if (!invoiceNo) { notify('Issue — Invoice number zaroori hai', 'error'); return; }
    if (lines.length === 0) { notify('Issue — Pehle kam az kam aik line add karein', 'error'); return; }
    // Duplicate invoice numbers are rejected (data layer + here).
    if (DB.checkUniqueness) {
      const chk = DB.checkUniqueness('purchases', { invoiceNo }, null);
      if (!chk.ok) { notify('Issue — ' + chk.message, 'error'); return; }
    }
    const total = lines.reduce((a, ln) => a + (ln.qty * ln.unitPrice), 0);
    const paid = paidIn.value === '' ? total : Number(paidIn.value);
    const branchId = window.App.normBranchId(branchSel.value);
    const supplierName = supplierIn.value.trim();
    let supplierId = null;
    if (supplierName) {
      const existing = (S().suppliers || []).find((s) => String(s.name || '').trim().toLowerCase() === supplierName.toLowerCase());
      if (existing) supplierId = existing.id;
      else {
        supplierId = DB.nextId('suppliers');
        S().suppliers.push({ id: supplierId, name: supplierName, phone: '', address: '' });
      }
    }
    const purchase = {
      id: DB.nextId('purchases'),
      invoiceNo, date: new Date().toISOString(),
      supplierId, supplierName,
      total, paid, remaining: Math.max(0, total - paid),
      branchId, createdBy: window.App.user ? window.App.user.name : '',
    };
    S().purchases.unshift(purchase);
    let batchError = null;
    lines.forEach((ln) => {
      const p = products.find((x) => String(x.id) === String(ln.productId));
      S().purchaseLines.push({ id: DB.nextId('purchaseLines'), purchaseId: purchase.id, productId: ln.productId, qty: ln.qty, unitPrice: ln.unitPrice, lineTotal: ln.qty * ln.unitPrice });
      // Auto stock-in: the purchased quantity lands in the branch stock.
      if (p) window.App.adjustStock(p, branchId, ln.qty, 'Purchase — ' + invoiceNo, invoiceNo);
      // v2.1.0 — Expiry: tracked item ki purchase par batch banao (FEFO ke liye).
      // Master purchasePrice kabhi overwrite nahi hota — ye behaviour waisa hi hai.
      if (p && p.expiryTracked && ln.expiryDate && DB.addBatch) {
        const br = DB.addBatch({ productId: p.id, qty: ln.qty, expiryDate: ln.expiryDate, purchaseId: purchase.id, branchId });
        if (!br.ok && !batchError) batchError = br.message;
      }
    });
    window.App.save();
    lines.length = 0;
    drawLines();
    invIn.value = ''; supplierIn.value = ''; paidIn.value = '';
    notify('Ho Gaya ✓ — Purchase ' + invoiceNo + ' save ho gayi — kul ' + money(total) + ', stock auto add ho gaya', 'success');
    if (batchError) notify('Issue — Batch nahi ban saka: ' + batchError, 'error');
    renderPurchases(container);
  });
  pCard.appendChild(form);
  wrap.appendChild(pCard);

  // ---- Purchase history ----
  const purchases = (st.purchases || []).slice();
  const hCard = el('<div class="card"><h2>Purchase History</h2></div>');
  if (purchases.length === 0) hCard.appendChild(el('<p class="muted">Abhi tak koi purchase nahi hai.</p>'));
  else {
    const rows = purchases.map((pu) => {
      const ls = (st.purchaseLines || []).filter((l) => String(l.purchaseId) === String(pu.id));
      const items = ls.map((l) => {
        const p = products.find((x) => String(x.id) === String(l.productId));
        return esc(p ? p.name : ('Item ' + l.productId)) + ' × ' + l.qty;
      }).join(', ');
      return '<tr><td><b>' + esc(pu.invoiceNo || '') + '</b></td><td>' + esc(pu.supplierName || '—') + '</td><td>' + items + '</td><td><b>' + money(pu.total) + '</b></td><td>' + money(pu.paid) + '</td><td>' + money(pu.remaining) + '</td><td class="muted">' + esc(String(pu.date || '').slice(0, 10)) + '</td></tr>';
    }).join('');
    hCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Supplier</th><th>Items</th><th>Total</th><th>Paid</th><th>Baaki</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(hCard);

  container.appendChild(wrap);
  drawLines();
  syncExpiryInput();
}

window.Screens.purchases = renderPurchases;
})();
