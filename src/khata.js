/* Sahara Bakers — Khata (v2.1.0).
 * Credit customers (udhar khata): customer list + add customer, one
 * customer's ledger (Khata sales with totals, payments recorded,
 * running balance = sales − payments), and record payment.
 * All balances are DERIVED from the frozen DB functions
 * (DB.khataBalance / DB.khataLedger / DB.recordKhataPayment /
 * DB.addKhataCustomer) — nothing is stored on the screen, and no
 * cost or profit ever appears here. Voided sales leave the ledger
 * (the DB excludes them). Wrapped in an IIFE.
 *
 * Picker for the POS (Worker B's pos.js): Screens.Khata.pickCustomer
 * opens the customer picker in the shared item-form overlay and calls
 * callback(customer) with the chosen (or just-created) customer, or
 * callback(null) when the picker is closed without a choice.
 * Screens.Khata.listCustomers() returns [{id, name, phone, balance}]
 * for callers that want the plain list instead.
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
function money(n) { return window.App.money(n); }
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}

let selectedId = null; // customer whose ledger is open (null = list only)

/* Plain customer list with derived balances, name-sorted. */
function listCustomers() {
  const customers = (S().khataCustomers || []).slice().sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || '')));
  return customers.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone || '',
    balance: DB.khataBalance ? DB.khataBalance(c.id) : 0
  }));
}

/* ---- POS picker: choose (or quickly add) a Khata customer ---- */
function pickCustomer(callback) {
  const overlay = document.getElementById('item-form-overlay');
  const bodyEl = document.getElementById('item-form-body');
  const titleEl = document.getElementById('item-form-title');
  if (!overlay || !bodyEl) {
    notify('Issue — Customer picker khol nahi saka', 'error');
    if (typeof callback === 'function') callback(null);
    return;
  }
  const done = (customer) => {
    overlay.hidden = true;
    overlay.style.display = 'none';
    if (typeof callback === 'function') callback(customer || null);
  };
  titleEl.textContent = 'Khata Customer Chunein';
  bodyEl.innerHTML = '';
  bodyEl.appendChild(el('<p class="muted">Khata sale ke liye customer chunein — ya neeche se naya customer banayein. Naam zaroori hai, phone optional hai.</p>'));
  const searchIn = el('<input class="input" type="text" placeholder="Search — naam ya phone likhein">');
  bodyEl.appendChild(searchIn);
  const listWrap = el('<div style="margin-top:12px"></div>');
  bodyEl.appendChild(listWrap);
  function drawPickerList() {
    const q = searchIn.value.trim().toLowerCase();
    const rows = listCustomers().filter((c) =>
      !q || String(c.name || '').toLowerCase().indexOf(q) !== -1 ||
      String(c.phone || '').toLowerCase().indexOf(q) !== -1);
    listWrap.innerHTML = '';
    if (rows.length === 0) {
      listWrap.appendChild(el('<p class="muted">Koi customer nahi mila.</p>'));
      return;
    }
    const html = rows.map((c) =>
      '<tr><td><b>' + esc(c.name) + '</b>' + (c.phone ? '<br><span class="muted">' + esc(c.phone) + '</span>' : '') +
      '</td><td class="r-right"><b>' + esc(money(c.balance)) + '</b><br><span class="muted">Baqi khata</span></td>' +
      '<td><button type="button" class="btn btn-sm btn-primary" data-pick="' + esc(c.id) + '">Chunein</button></td></tr>'
    ).join('');
    listWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Customer</th><th class="r-right">Baqi Khata</th><th></th></tr></thead><tbody>' + html + '</tbody></table></div>'));
    listWrap.querySelectorAll('button[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const c = (S().khataCustomers || []).find((x) => String(x.id) === String(b.getAttribute('data-pick')));
      if (!c) { notify('Issue — Customer nahi mila', 'error'); return; }
      done({ id: c.id, name: c.name, phone: c.phone || '', balance: DB.khataBalance ? DB.khataBalance(c.id) : 0 });
    }));
  }
  searchIn.addEventListener('input', drawPickerList);
  drawPickerList();
  // Quick add inside the picker (same rule as the Khata screen: name required).
  const addForm = el('<form style="margin-top:16px"></form>');
  const nameIn = el('<input class="input" type="text" placeholder="Naya customer — naam (zaroori)">');
  const phoneIn = el('<input class="input" type="text" placeholder="Phone (optional)">');
  addForm.appendChild(el('<label>Naya Customer</label>'));
  addForm.appendChild(nameIn);
  addForm.appendChild(phoneIn);
  addForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Add aur Chunein</button></div>'));
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const res = DB.addKhataCustomer ? DB.addKhataCustomer({ name: nameIn.value, phone: phoneIn.value }) : { ok: false, message: 'Khata available nahi hai' };
    if (!res.ok) { notify('Issue — ' + (res.message || 'Customer nahi ban saka'), 'error'); return; }
    window.App.save();
    notify('Ho Gaya ✓ — Khata customer ban gaya: ' + res.customer.name, 'success');
    done({ id: res.customer.id, name: res.customer.name, phone: res.customer.phone || '', balance: 0 });
  });
  bodyEl.appendChild(addForm);
  const closeBtn = el('<button type="button" class="btn" style="margin-top:12px">Close</button>');
  closeBtn.addEventListener('click', () => done(null));
  bodyEl.appendChild(closeBtn);
  overlay.hidden = false;
  overlay.style.display = 'flex';
  try { searchIn.focus(); } catch (e) { /* ignore */ }
}

/* ---- Khata screen ---- */
function renderKhata(container) {
  container.innerHTML = '';
  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Khata</h1></div>'));
  wrap.appendChild(el('<p class="muted">Udhar khata — customers, unki sales, adaigi aur baqi balance. Cost ya profit yahan kabhi nahi dikhta.</p>'));

  // ---- Add customer ----
  const aCard = el('<div class="card"><h2>Add Customer — Naya khata customer</h2></div>');
  const aForm = el('<form></form>');
  const nameIn = el('<input class="input" type="text" placeholder="Customer ka naam (zaroori)">');
  const phoneIn = el('<input class="input" type="text" placeholder="Phone (optional)">');
  aForm.appendChild(el('<label>Naam</label>')); aForm.appendChild(nameIn);
  aForm.appendChild(el('<label>Phone</label>')); aForm.appendChild(phoneIn);
  aForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Add Customer</button></div>'));
  aForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const res = DB.addKhataCustomer ? DB.addKhataCustomer({ name: nameIn.value, phone: phoneIn.value }) : { ok: false, message: 'Khata available nahi hai' };
    if (!res.ok) { notify('Issue — ' + (res.message || 'Customer nahi ban saka'), 'error'); return; }
    window.App.save();
    notify('Ho Gaya ✓ — Khata customer ban gaya: ' + res.customer.name, 'success');
    renderKhata(container);
  });
  aCard.appendChild(aForm);
  wrap.appendChild(aCard);

  // ---- Customer list (searchable) ----
  const lCard = el('<div class="card"><h2>Customers — Khata list</h2></div>');
  const searchIn = el('<input class="input" type="text" placeholder="Search — naam ya phone likhein">');
  lCard.appendChild(searchIn);
  const listWrap = el('<div style="margin-top:12px"></div>');
  lCard.appendChild(listWrap);
  function drawList() {
    const q = searchIn.value.trim().toLowerCase();
    const rows = listCustomers().filter((c) =>
      !q || String(c.name || '').toLowerCase().indexOf(q) !== -1 ||
      String(c.phone || '').toLowerCase().indexOf(q) !== -1);
    listWrap.innerHTML = '';
    if (rows.length === 0) {
      listWrap.appendChild(el('<p class="muted">Koi khata customer abhi tak nahi hai — upar se naya customer banayein.</p>'));
      return;
    }
    const totalDue = rows.reduce((a, c) => a + (Number(c.balance) || 0), 0);
    const html = rows.map((c) =>
      '<tr><td><b>' + esc(c.name) + '</b>' + (c.phone ? '<br><span class="muted">' + esc(c.phone) + '</span>' : '') +
      '</td><td class="r-right"><b>' + esc(money(c.balance)) + '</b></td>' +
      '<td><button type="button" class="btn btn-sm' + (String(selectedId) === String(c.id) ? ' btn-primary' : '') + '" data-ledger="' + esc(c.id) + '">Ledger</button></td></tr>'
    ).join('');
    listWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Customer</th><th class="r-right">Baqi Khata</th><th></th></tr></thead><tbody>' + html +
      '<tr><td><b>Kul Baqi (sab customers)</b></td><td class="r-right"><b>' + esc(money(totalDue)) + '</b></td><td></td></tr>' +
      '</tbody></table></div>'));
    listWrap.querySelectorAll('button[data-ledger]').forEach((b) => b.addEventListener('click', () => {
      selectedId = Number(b.getAttribute('data-ledger'));
      renderKhata(container);
    }));
  }
  searchIn.addEventListener('input', drawList);
  drawList();
  wrap.appendChild(lCard);

  // ---- Customer detail: ledger + record payment ----
  if (selectedId != null) {
    const led = DB.khataLedger ? DB.khataLedger(selectedId) : { ok: false, message: 'Khata available nahi hai' };
    if (!led.ok) {
      selectedId = null;
      notify('Issue — ' + (led.message || 'Customer nahi mila'), 'error');
    } else {
      const c = led.customer;
      const dCard = el('<div class="card"><h2>Ledger — ' + esc(c.name) + '</h2></div>');
      dCard.appendChild(el('<p class="muted">' + (c.phone ? 'Phone: ' + esc(c.phone) + ' · ' : '') + 'Sales − adaigi = baqi khata. Void sale ledger mein nahi aati.</p>'));
      dCard.appendChild(el('<div class="khata-balance-box"><div class="muted">Baqi Khata — Baqi balance</div><div class="khata-balance-big">' + esc(money(led.balance)) + '</div></div>'));
      // Ledger entries, oldest first (DB order), with running balance.
      let running = 0;
      const rowsHtml = (led.entries || []).map((en) => {
        let desc = '';
        let plus = null;
        let minus = null;
        if (en.type === 'sale') {
          desc = esc(en.billNo || '') + ' — Khata Sale' + (Number(en.paid) > 0 ? ' (sale par adaigi ' + esc(money(en.paid)) + ')' : '');
          plus = Number(en.total) || 0;
          minus = Number(en.paid) || 0;
          running += plus - minus;
        } else {
          desc = 'Adaigi' + (en.note ? ' — ' + esc(en.note) : '');
          minus = Number(en.amount) || 0;
          running -= minus;
        }
        return '<tr><td>' + esc(fmtDate(en.date)) + '</td><td>' + desc + '</td>' +
          '<td class="r-right">' + (plus != null ? esc(money(plus)) : '—') + '</td>' +
          '<td class="r-right">' + (minus ? esc(money(minus)) : '—') + '</td>' +
          '<td class="r-right"><b>' + esc(money(running)) + '</b></td></tr>';
      }).join('');
      if ((led.entries || []).length === 0) {
        dCard.appendChild(el('<p class="muted">Is customer ki abhi tak koi khata sale ya adaigi nahi hai.</p>'));
      } else {
        dCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Date</th><th>Detail</th><th class="r-right">Udhar (+)</th><th class="r-right">Adaigi (−)</th><th class="r-right">Baqi</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'));
      }
      // Record payment (web parity: payment baqi khata se zyada nahi ho sakti).
      const pForm = el('<form style="margin-top:16px"></form>');
      const amtIn = el('<input class="input" type="number" min="0" step="any" placeholder="Adaigi ki raqam (Rs)">');
      const noteIn = el('<input class="input" type="text" placeholder="Note (optional) — kis cheez ki adaigi hai">');
      pForm.appendChild(el('<label>Record Payment — Adaigi darj karein</label>'));
      pForm.appendChild(amtIn);
      pForm.appendChild(noteIn);
      pForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Payment Save Karein</button></div>'));
      pForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const amount = Number(amtIn.value);
        if (!amount || amount <= 0) { notify('Issue — Payment ki raqam durust likhein (0 se zyada)', 'error'); return; }
        const bal = DB.khataBalance ? DB.khataBalance(c.id) : 0;
        if (bal <= 0) { notify('Issue — Is customer ka koi khata baqi nahi hai', 'error'); return; }
        if (amount > bal) { notify('Issue — Adaigi baqi khata (' + money(bal) + ') se zyada nahi ho sakti', 'error'); return; }
        const res = DB.recordKhataPayment ? DB.recordKhataPayment({
          customerId: c.id,
          amount,
          note: noteIn.value.trim(),
          recordedBy: window.App.user ? window.App.user.name : '',
          occurredAt: new Date().toISOString()
        }) : { ok: false, message: 'Khata available nahi hai' };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Payment save nahi ho saki'), 'error'); return; }
        window.App.save();
        notify('Ho Gaya ✓ — Payment save ho gayi — baqi khata ' + money(res.balance), 'success');
        renderKhata(container);
      });
      dCard.appendChild(pForm);
      const backBtn = el('<button type="button" class="btn" style="margin-top:12px">← Customers List</button>');
      backBtn.addEventListener('click', () => { selectedId = null; renderKhata(container); });
      dCard.appendChild(backBtn);
      wrap.appendChild(dCard);
    }
  }

  container.appendChild(wrap);
}

window.Screens.khata = renderKhata;
window.Screens.Khata = {
  render: renderKhata,
  pickCustomer: pickCustomer,
  listCustomers: listCustomers
};
})();
