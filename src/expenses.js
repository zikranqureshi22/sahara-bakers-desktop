/* Sahara Bakers — Godown Expenses (v2.1.0).
 * Godown expenses screen (head, amount, date, note; list + add),
 * via the frozen DB.addExpense. This is SEPARATE from shift
 * expenses (shifts.js, Worker C) — godown expenses never enter a
 * shift's closing totals. Web reference: actions.ts listExpenses /
 * addExpense — web fields title/category/paymentMethod map here to
 * head/note on the frozen desktop row (no paymentMethod column in
 * the frozen schema). Wrapped in an IIFE.
 * Route: 'expenses' (window.Screens.expenses).
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

function renderExpenses(container) {
  container.innerHTML = '';
  const st = S();
  const expenses = (st.expenses || []).slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
  const total = expenses.reduce((a, e) => a + (Number(e.amount) || 0), 0);

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Expenses</h1></div>'));
  wrap.appendChild(el('<p class="screen-sub">Godown kharche — shift kharche alag hain (shifts screen mein).</p>'));

  // ---- Add expense form ----
  const fCard = el('<div class="card"><h2>Naya Kharcha</h2></div>');
  const form = el('<form></form>');
  const headIn = el('<input class="input" type="text" placeholder="Kharch ka head — jaise Bijli, Kiraya, Transport">');
  const amtIn = el('<input class="input" type="number" min="0" step="0.01" placeholder="Raqam (Rs)">');
  const dateIn = el('<input class="input" type="date" value="' + esc(todayLocal()) + '">');
  const noteIn = el('<input class="input" type="text" placeholder="Note (optional)">');
  form.appendChild(el('<label>Head</label>')); form.appendChild(headIn);
  form.appendChild(el('<label>Raqam (Rs)</label>')); form.appendChild(amtIn);
  form.appendChild(el('<label>Date</label>')); form.appendChild(dateIn);
  form.appendChild(el('<label>Note</label>')); form.appendChild(noteIn);
  form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save Expense</button></div>'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const head = headIn.value.trim();
    const amount = Number(amtIn.value);
    if (!head) { notify('Issue — Kharch ka head zaroori hai', 'error'); return; }
    if (!amount || amount <= 0) { notify('Issue — Raqam durust likhein', 'error'); return; }
    const res = DB.addExpense ? DB.addExpense({
      head, amount, note: noteIn.value.trim(),
      recordedBy: window.App.user ? window.App.user.name : '',
      occurredAt: dateIn.value ? new Date(dateIn.value + 'T12:00:00').toISOString() : new Date().toISOString(),
    }) : { ok: false, message: 'Expense available nahi hai' };
    if (!res.ok) { notify('Issue — ' + (res.message || 'Expense save nahi ho saka'), 'error'); return; }
    window.App.save();
    notify('Ho Gaya ✓ — Kharcha save ho gaya — ' + head + ' ' + money(amount), 'success');
    renderExpenses(container);
  });
  fCard.appendChild(form);
  wrap.appendChild(fCard);

  // ---- Expenses list ----
  const lCard = el('<div class="card"><h2>Expenses List</h2><p class="muted">Kul kharcha: <b>' + money(total) + '</b> (' + expenses.length + ' entries)</p></div>');
  if (expenses.length === 0) lCard.appendChild(el('<p class="muted">Abhi tak koi kharcha record nahi hai.</p>'));
  else {
    const rows = expenses.map((x) => '<tr><td><b>' + esc(x.head || '') + '</b>' + (x.note ? '<br><span class="muted">' + esc(x.note) + '</span>' : '') + '</td><td><b>' + money(x.amount) + '</b></td><td class="muted">' + esc(String(x.occurredAt || '').slice(0, 10)) + '</td><td>' + esc(x.recordedBy || '') + '</td></tr>').join('');
    lCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Head</th><th>Raqam</th><th>Date</th><th>Recorded By</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(lCard);

  container.appendChild(wrap);
}

window.Screens.expenses = renderExpenses;
window.Screens.Expenses = renderExpenses;
})();
