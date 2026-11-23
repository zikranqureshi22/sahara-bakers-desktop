/* Sahara Bakers — Expiry Batches + Wastage (v2.1.0).
 * Expiry: per-product batch list (qty, expiry date, purchase ref);
 * expired batches are highlighted and blocked from dispatch — the
 * block itself lives in the DB (DB.fefoPick never picks an expired
 * batch); this screen only SHOWS the DB's rule and its message,
 * it never invents its own. Batches are created by Purchases for
 * expiry-tracked items (see purchases.js).
 * Wastage: record wastage (product, qty, reason) via the frozen
 * DB.recordWastage — stock deducts and a movement with reason
 * 'Wastage …' is recorded (isSaleMovement counts it as NOT a sale).
 * Wrapped in an IIFE. Route: 'expiry' (window.Screens.expiry).
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
function todayLocal() {
  if (DB._todayLocal) return DB._todayLocal();
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderExpiry(container) {
  container.innerHTML = '';
  const st = S();
  const products = st.products || [];
  const branches = st.branches || [];
  const batches = (st.batches || []).slice();
  const today = todayLocal();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Expiry &amp; Wastage</h1></div>'));
  wrap.appendChild(el('<p class="screen-sub">Expiry batches (FEFO) aur wastage — expired batch se dispatch nahi ho sakta.</p>'));

  // ---- Expiry batches (FEFO order: earliest expiry first) ----
  const tracked = products.filter((p) => p.expiryTracked);
  const bCard = el('<div class="card"><h2>Expiry Batches</h2><p class="muted">Batches pehle expire hone wali pehle use hoti hain (FEFO — First Expired, First Out). Expired batch kabhi dispatch nahi hoti.</p></div>');
  if (tracked.length === 0) {
    bCard.appendChild(el('<p class="muted">Koi item expiry-tracked nahi hai — item edit se "Expiry Tracked" on karein, phir purchase par batch banega.</p>'));
  } else {
    const rows = tracked.map((p) => {
      const pb = batches.filter((b) => String(b.productId) === String(p.id))
        .sort((a, b) => String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31')));
      const fresh = pb.filter((b) => !b.expiryDate || String(b.expiryDate) >= today)
        .reduce((a, b) => a + (Number(b.qty) || 0), 0);
      const expired = pb.filter((b) => b.expiryDate && String(b.expiryDate) < today)
        .reduce((a, b) => a + (Number(b.qty) || 0), 0);
      const detail = pb.length === 0
        ? '<span class="muted">Koi batch nahi hai — abhi tak is item ki expiry wali purchase nahi hui.</span>'
        : pb.map((b) => {
          const isExp = b.expiryDate && String(b.expiryDate) < today;
          const pur = (st.purchases || []).find((x) => String(x.id) === String(b.purchaseId));
          const purRef = pur ? (pur.invoiceNo || ('#' + pur.id)) : ('#' + (b.purchaseId == null ? '—' : b.purchaseId));
          return '<div class="batch-row' + (isExp ? ' batch-expired' : '') + '">' +
            '<span><b>' + (Number(b.qty) || 0) + ' ' + esc(p.unit || '') + '</b> — Expiry: <b>' + esc(b.expiryDate || '—') + '</b></span>' +
            '<span class="muted">Purchase ' + esc(purRef) + ' · ' + esc(window.App.branchName(b.branchId)) + '</span>' +
            (isExp ? '<span class="badge-expired">EXPIRED — dispatch blocked</span>' : '') +
            '</div>';
        }).join('');
      return '<tr><td><b>' + esc(p.name) + '</b><br><span class="muted">Fresh: <b>' + fresh + '</b> ' + esc(p.unit || '') + (expired > 0 ? ' · Expired: <b>' + expired + '</b> ' + esc(p.unit || '') : '') + '</span></td><td>' + detail + '</td></tr>';
    }).join('');
    bCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Batches (FEFO order — pehle expire wali pehle)</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(bCard);

  // ---- Wastage form ----
  const wCard = el('<div class="card"><h2>Wastage Record Karein</h2></div>');
  const wForm = el('<form></form>');
  const wItemSel = el('<select class="input">' + products.map((p) =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
  ).join('') + '</select>');
  const wQtyIn = el('<input class="input" type="number" min="0" step="any" placeholder="Miqdaar (qty)">');
  const wReasonIn = el('<input class="input" type="text" placeholder="Wajah — jaise Expired, Damaged, Broken">');
  const wBranchSel = el('<select class="input"><option value="warehouse" selected>Warehouse (Godown)</option>' + branches.map((b) =>
    '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  wForm.appendChild(el('<label>Item</label>')); wForm.appendChild(wItemSel);
  wForm.appendChild(el('<label>Miqdaar</label>')); wForm.appendChild(wQtyIn);
  wForm.appendChild(el('<label>Wajah (Reason)</label>')); wForm.appendChild(wReasonIn);
  wForm.appendChild(el('<label>Kahan se kata</label>')); wForm.appendChild(wBranchSel);
  wForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save Wastage</button></div>'));
  wForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = products.find((x) => String(x.id) === String(wItemSel.value));
    const qty = Number(wQtyIn.value);
    const reason = wReasonIn.value.trim();
    if (!p) { notify('Issue — Pehle item chunein', 'error'); return; }
    if (!qty || qty <= 0) { notify('Issue — Miqdaar durust likhein', 'error'); return; }
    if (!reason) { notify('Issue — Wastage ki wajah likhein', 'error'); return; }
    const res = DB.recordWastage ? DB.recordWastage({
      productId: p.id, qty, reason,
      branchId: window.App.normBranchId(wBranchSel.value),
      recordedBy: window.App.user ? window.App.user.name : '',
    }) : { ok: false, message: 'Wastage available nahi hai' };
    if (!res.ok) { notify('Issue — ' + (res.message || 'Wastage record nahi ho saka'), 'error'); return; }
    window.App.save();
    notify('Ho Gaya ✓ — Wastage record ho gaya — ' + p.name + ' ' + qty + ' ' + (p.unit || '') + ' kata', 'success');
    renderExpiry(container);
  });
  wCard.appendChild(wForm);
  wrap.appendChild(wCard);

  // ---- Wastage list ----
  const wastage = (st.wastage || []).slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
  const lCard = el('<div class="card"><h2>Wastage List</h2></div>');
  if (wastage.length === 0) lCard.appendChild(el('<p class="muted">Abhi tak koi wastage record nahi hai.</p>'));
  else {
    const rows = wastage.map((w) => {
      const p = products.find((x) => String(x.id) === String(w.productId));
      return '<tr><td><b>' + esc(p ? p.name : ('Item ' + w.productId)) + '</b></td><td><b>' + w.qty + '</b> ' + esc(p ? (p.unit || '') : '') + '</td><td>' + esc(w.reason || '') + '</td><td>' + esc(window.App.branchName(w.branchId)) + '</td><td>' + esc(w.recordedBy || '') + '</td><td class="muted">' + esc(String(w.occurredAt || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
    }).join('');
    lCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Wajah</th><th>Branch</th><th>Recorded By</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(lCard);

  container.appendChild(wrap);
}

window.Screens.expiry = renderExpiry;
window.Screens.Expiry = renderExpiry;
})();
