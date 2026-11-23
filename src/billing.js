/* Sahara Bakers — Billing (v2.0.0).
 * All bills in one place: Production Bills (PB-...) and Transfer
 * Bills (SB-...), each re-printable (80mm thermal) and PDF-saveable
 * from the preview modal. Wrapped in an IIFE.
 */
(function () {
'use strict';
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;
if (window.App) window.App.state = DB.state;

function S() { return (window.App && window.App.state) || state; }
function money(n) { return window.App.money(n); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }

function renderBilling(container) {
  container.innerHTML = '';
  const st = S();
  const prods = (st.productions || []).slice();
  const transfers = (st.transfers || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const products = st.products || [];

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Billing</h1></div>'));
  wrap.appendChild(el('<p class="muted">Production bills (PB-…), transfer bills (SB-…) aur sale bills (SL-…) — kisi bhi bill par click kar ke dobara print ya PDF save karein.</p>'));

  const pCard = el('<div class="card"><h2>Production Bills</h2></div>');
  if (prods.length === 0) pCard.appendChild(el('<p class="muted">Abhi tak koi production bill nahi hai.</p>'));
  else {
    const rows = prods.map((pr) => {
      const used = (pr.lines || []).map((l) => esc(l.name) + ' ' + l.qty + ' ' + esc(l.unit || '')).join(', ');
      return '<tr><td><b>' + esc(pr.billNo || '') + '</b></td><td>' + esc(pr.finishName || '') + ' <b>' + pr.finishQty + ' ' + esc(pr.finishUnit || '') + '</b></td><td>' + used + '</td><td><b>' + (pr.costKnown ? money(pr.totalCost) : money(pr.totalCost) + ' *') + '</b></td><td class="muted">' + esc(String(pr.date || '').slice(0, 16).replace('T', ' ')) + '</td><td><button type="button" class="btn btn-sm" data-pbill="' + esc(pr.id) + '">Bill</button></td></tr>';
    }).join('');
    pCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Finish</th><th>Raw Used</th><th>Total Cost</th><th>Date</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    pCard.querySelectorAll('button[data-pbill]').forEach((btn) => btn.addEventListener('click', () => {
      const pr = prods.find((x) => String(x.id) === String(btn.getAttribute('data-pbill')));
      if (pr && window.App.showProductionBill) window.App.showProductionBill(pr);
    }));
  }
  wrap.appendChild(pCard);

  const tCard = el('<div class="card"><h2>Transfer Bills</h2></div>');
  if (transfers.length === 0) tCard.appendChild(el('<p class="muted">Abhi tak koi transfer bill nahi hai.</p>'));
  else {
    const rows = transfers.map((t) => {
      const items = (t.items || []).map((it) => {
        const p = products.find((x) => String(x.id) === String(it.productId));
        return esc(p ? p.name : ('Item ' + it.productId)) + ' × ' + it.qty;
      }).join(', ');
      return '<tr><td><b>' + esc(window.App.transferBillNo(t)) + '</b></td><td>' + esc(window.App.branchName(t.fromBranchId)) + ' → ' + esc(window.App.branchName(t.toBranchId)) + '</td><td>' + items + '</td><td class="muted">' + esc(String(t.date || '').slice(0, 16).replace('T', ' ')) + '</td><td><button type="button" class="btn btn-sm" data-bill="' + esc(t.id) + '">Bill</button></td></tr>';
    }).join('');
    tCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>From → To</th><th>Items</th><th>Date</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    tCard.querySelectorAll('button[data-bill]').forEach((btn) => btn.addEventListener('click', () => {
      const t = transfers.find((x) => String(x.id) === String(btn.getAttribute('data-bill')));
      if (t && window.App.showTransferBill) window.App.showTransferBill(t);
    }));
  }
  wrap.appendChild(tCard);

  // ---- v2.1.0: Sale Bills (SL-...) alongside PB/SB ----
  const sales = (st.sales || []).slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
  const sCard = el('<div class="card"><h2>Sale Bills</h2></div>');
  if (sales.length === 0) sCard.appendChild(el('<p class="muted">Abhi tak koi sale bill nahi hai — Counter Sale se sale karein.</p>'));
  else {
    const rows = sales.map((s) => {
      const typeLabel = (s.note && String(s.note).indexOf('Road Side') !== -1) ? 'Road Side'
        : s.orderType === 'dine_in' ? 'Dine-in' + (s.tableNo != null ? ' — Table ' + s.tableNo : '')
        : s.orderType === 'delivery' ? 'Online Delivery' : 'Take Away';
      return '<tr><td><b>' + esc(window.App.saleBillNo ? window.App.saleBillNo(s) : ('SL-' + String(s.saleNo).padStart(4, '0'))) + '</b>' + (s.voidedAt ? ' <span class="void-stamp">VOID</span>' : '') + '</td><td>' + esc(typeLabel) + '</td><td>' + esc(s.cashierName || '') + '</td><td>' + esc(s.paymentMethod || '') + '</td><td><b>' + money(s.total) + '</b></td><td class="muted">' + esc(String(s.occurredAt || '').slice(0, 16).replace('T', ' ')) + '</td><td><button type="button" class="btn btn-sm" data-sbill="' + esc(s.id) + '">Bill</button></td></tr>';
    }).join('');
    sCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill No</th><th>Type</th><th>Cashier</th><th>Payment</th><th>Total</th><th>Date</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    sCard.querySelectorAll('button[data-sbill]').forEach((btn) => btn.addEventListener('click', () => {
      const s = sales.find((x) => String(x.id) === String(btn.getAttribute('data-sbill')));
      if (s && window.App.showSaleBill) window.App.showSaleBill(s);
    }));
  }
  wrap.appendChild(sCard);

  container.appendChild(wrap);
}

window.Screens.billing = renderBilling;
})();
