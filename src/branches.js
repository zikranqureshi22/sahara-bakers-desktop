/* Sahara Bakers — Branches (v2.0.0).
 * Branches Branch 1, Branch 2, Branch 3: list + rename/edit (name,
 * address, contact, manager), per-branch stock & history — sent so
 * far, dates, products, quantities, current stock, sold. (No
 * separate "Remaining" stat: Current Stock already is the
 * remaining stock.)
 * (The transfer FORM lives on its own Stock Transfer screen now;
 * Transfer History lives there and on Billing.) Wrapped in an IIFE.
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
  const transfers = (st.transfers || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Branches</h1><button type="button" class="btn btn-primary" id="branches-transfer-btn">Transfer Stock</button></div>'));

  // ---- Branch list + edit ----
  const bCard = el('<div class="card"><h2>Branch List</h2></div>');
  const rows = branches.map((b) => {
    return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + esc(b.address || '—') + '</td><td>' + esc(b.contact || '—') + '</td><td>' + esc(b.manager || '—') + '</td><td><button type="button" class="btn btn-sm" data-edit="' + esc(b.id) + '">Edit Karein</button></td></tr>';
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
    form.appendChild(el('<label>Branch Name</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Address</label>')); form.appendChild(addrIn);
    form.appendChild(el('<label>Contact</label>')); form.appendChild(contactIn);
    form.appendChild(el('<label>Manager</label>')); form.appendChild(mgrIn);
    const row = el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn" id="branch-edit-cancel">Cancel</button></div>');
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

  // ---- Per-branch stock & history ----
  // Sent so far (transfers in), current stock, sold (explicit Stock
  // Out movements only — see DB.soldQtyForBranch / isSaleMovement:
  // production raw consumption and transfer legs are NOT sales, so
  // a production run never inflates a branch's "Sold". Production
  // movements are recorded at the Warehouse — a separate location,
  // not a branch — so they never enter any branch's Sold at all.) The
  // app has no sales screen, so branch counter sales are recorded
  // as Stock Out. There is NO separate "Remaining" stat: Current
  // Stock already IS the remaining stock, so showing it twice under
  // two labels was a duplicate — it is dropped, with a note below
  // the stats saying so.
  branches.forEach((b) => {
    const sent = transfers.filter((t) => String(t.toBranchId) === String(b.id));
    const sentQty = sent.reduce((a, t) => a + (t.items || []).reduce((x, it) => x + (Number(it.qty) || 0), 0), 0);
    const curStock = products.reduce((a, p) => a + (window.App.stockOf(p, b.id) || 0), 0);
    const soldQty = DB.soldQtyForBranch(b.id);
    const card = el('<div class="card" id="branch-summary-' + esc(b.id) + '"><h2>' + esc(b.name) + ' — Stock &amp; History</h2></div>');
    const stats = el('<div class="stat-grid"></div>');
    const stat = (label, value, sub) => el('<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<div class="muted">' + esc(sub) + '</div>' : '') + '</div>');
    stats.appendChild(stat('Sent So Far', String(sentQty), sent.length + ' transfers aaye'));
    stats.appendChild(stat('Current Stock', String(curStock), 'units maujooda'));
    stats.appendChild(stat('Sold', String(soldQty), 'Stock Out (sales ka koi alag screen nahi — Stock Out yahan sold mein count hota hai; Production aur Transfer count nahi hote)'));
    card.appendChild(stats);
    card.appendChild(el('<p class="muted">Current Stock hi remaining stock hai — is liye alag "Remaining" stat nahi dikhaya jata.</p>'));
    if (sent.length === 0) card.appendChild(el('<p class="muted">Is branch ko abhi tak koi transfer nahi aaya.</p>'));
    else {
      const rowsHtml = sent.map((t) => {
        const items = (t.items || []).map((it) => {
          const p = products.find((x) => String(x.id) === String(it.productId));
          return esc(p ? p.name : ('Item ' + it.productId)) + ' × ' + it.qty;
        }).join(', ');
        return '<tr><td><b>' + esc(window.App.transferBillNo(t)) + '</b></td><td>' + esc(String(t.date || '').slice(0, 16).replace('T', ' ')) + '</td><td>' + items + '</td><td>' + esc(window.App.branchName(t.fromBranchId)) + '</td><td><button type="button" class="btn btn-sm" data-bill="' + esc(t.id) + '">Bill</button></td></tr>';
      }).join('');
      card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Date</th><th>Products &amp; Quantities</th><th>From</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
      card.querySelectorAll('button[data-bill]').forEach((btn) => btn.addEventListener('click', () => {
        const t = transfers.find((x) => String(x.id) === String(btn.getAttribute('data-bill')));
        if (t && window.App.showTransferBill) window.App.showTransferBill(t);
      }));
    }
    wrap.appendChild(card);
  });

  wrap.querySelector('#branches-transfer-btn').addEventListener('click', () => window.App.go('transfer'));
  container.appendChild(wrap);
}

window.Screens.branches = renderBranches;
})();
