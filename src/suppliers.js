/* Sahara Bakers — Suppliers (v2.1.0).
 * Suppliers list + supplier-wise purchases view, via the frozen
 * DB.addSupplier / DB.supplierPurchases. Supplier payments are
 * DEFERRED (phase 2) — not built here. Wrapped in an IIFE.
 * Route: 'suppliers' (window.Screens.suppliers).
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

let selectedSupplierId = null;

function renderSuppliers(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const suppliers = (st.suppliers || []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Suppliers</h1></div>'));
  wrap.appendChild(el('<p class="screen-sub">Suppliers ki list aur har supplier se purchases — supplier payments phase 2 mein hain.</p>'));

  // ---- Add supplier form ----
  const fCard = el('<div class="card"><h2>Naya Supplier</h2></div>');
  const form = el('<form></form>');
  const nameIn = el('<input class="input" type="text" placeholder="Supplier ka naam (zaroori)">');
  const phoneIn = el('<input class="input" type="text" placeholder="Phone (optional)">');
  const addrIn = el('<input class="input" type="text" placeholder="Address (optional)">');
  form.appendChild(el('<label>Naam</label>')); form.appendChild(nameIn);
  form.appendChild(el('<label>Phone</label>')); form.appendChild(phoneIn);
  form.appendChild(el('<label>Address</label>')); form.appendChild(addrIn);
  form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save Supplier</button></div>'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const res = DB.addSupplier ? DB.addSupplier({
      name: nameIn.value.trim(), phone: phoneIn.value.trim(), address: addrIn.value.trim(),
    }) : { ok: false, message: 'Supplier add available nahi hai' };
    if (!res.ok) { notify('Issue — ' + (res.message || 'Supplier add nahi ho saka'), 'error'); return; }
    window.App.save();
    selectedSupplierId = res.supplier.id;
    notify('Ho Gaya ✓ — Supplier "' + res.supplier.name + '" add ho gaya', 'success');
    renderSuppliers(container);
  });
  fCard.appendChild(form);
  wrap.appendChild(fCard);

  // ---- Suppliers list ----
  const lCard = el('<div class="card"><h2>Suppliers List</h2></div>');
  if (suppliers.length === 0) lCard.appendChild(el('<p class="muted">Abhi tak koi supplier nahi hai — purchase par supplier ka naam likhne se bhi supplier ban jata hai.</p>'));
  else {
    const rows = suppliers.map((s) => {
      const purs = DB.supplierPurchases ? DB.supplierPurchases(s.id) : (st.purchases || []).filter((p) => String(p.supplierId) === String(s.id));
      const total = purs.reduce((a, p) => a + (Number(p.total) || 0), 0);
      return '<tr><td><b>' + esc(s.name || '') + '</b><br><span class="muted">' + esc(s.phone || '') + (s.address ? ' · ' + esc(s.address) : '') + '</span></td>' +
        '<td>' + purs.length + ' purchases</td><td><b>' + money(total) + '</b></td>' +
        '<td><button type="button" class="btn btn-sm" data-sup="' + esc(s.id) + '">' + (String(selectedSupplierId) === String(s.id) ? 'Selected ✓' : 'Purchases Dekhein') + '</button></td></tr>';
    }).join('');
    lCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Purchases</th><th>Kul Amount</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    lCard.querySelectorAll('button[data-sup]').forEach((b) => b.addEventListener('click', () => {
      selectedSupplierId = b.getAttribute('data-sup');
      renderSuppliers(container);
    }));
  }
  wrap.appendChild(lCard);

  // ---- Supplier-wise purchases ----
  if (selectedSupplierId != null) {
    const sup = suppliers.find((s) => String(s.id) === String(selectedSupplierId));
    const purs = (DB.supplierPurchases ? DB.supplierPurchases(selectedSupplierId) : []).slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const pCard = el('<div class="card"><h2>' + esc(sup ? sup.name : 'Supplier') + ' — Purchases</h2></div>');
    if (purs.length === 0) pCard.appendChild(el('<p class="muted">Is supplier se abhi tak koi purchase nahi hai.</p>'));
    else {
      const rows = purs.map((pu) => {
        const ls = (st.purchaseLines || []).filter((l) => String(l.purchaseId) === String(pu.id));
        const items = ls.map((l) => {
          const p = products.find((x) => String(x.id) === String(l.productId));
          return esc(p ? p.name : ('Item ' + l.productId)) + ' × ' + l.qty;
        }).join(', ');
        return '<tr><td><b>' + esc(pu.invoiceNo || '') + '</b></td><td>' + items + '</td><td><b>' + money(pu.total) + '</b></td><td>' + money(pu.paid) + '</td><td>' + money(pu.remaining) + '</td><td class="muted">' + esc(String(pu.date || '').slice(0, 10)) + '</td></tr>';
      }).join('');
      pCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Items</th><th>Total</th><th>Paid</th><th>Baaki</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    wrap.appendChild(pCard);
  }

  container.appendChild(wrap);
}

window.Screens.suppliers = renderSuppliers;
window.Screens.Suppliers = renderSuppliers;
})();
