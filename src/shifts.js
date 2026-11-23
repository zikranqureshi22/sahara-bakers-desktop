/* Sahara Bakers — Shifts (v2.1.0).
 * Start / Close Shift + shift expenses + closing report + closing
 * history. Dark POS theme (#171310 / #f97316) to match the Sale
 * screen. Built ONLY against the frozen DB API (api-freeze.md §4.3):
 * DB.getOpenShift / getShiftState / startShift / closeShift /
 * addShiftExpense / listShiftExpenses. No other DB function is used.
 * Cashier picker: active staff with role 'Cashier' (DB.state.staff —
 * there is no frozen staff-list getter; staff are NOT logins). If no
 * cashier is registered yet, the name can be typed in by hand.
 * The closing snapshot comes from DB.closeShift — the screen only
 * PREVIEWS the expected drawer with the same formula before closing
 * (opening + cash sales − expenses + deposit − withdrawal).
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
function money(n) { return window.App.money(n); }
function esc(s) { return window.esc(s); }
function el(html) { return window.el(html); }
function clientRef(prefix) {
  return (prefix || 'shift') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}
function fmtDay(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (e) { return String(iso || '—').slice(0, 10); }
}

/* Live stats for one shift, computed from non-voided sales + shift
 * expenses. Same formula DB.closeShift uses, so the preview matches
 * the stamped snapshot exactly. */
function shiftStats(shiftId) {
  const st = S();
  const sales = (st.sales || []).filter((s) => String(s.shiftId) === String(shiftId) && !s.voidedAt);
  const byPayment = {};
  let totalSales = 0, cashSales = 0, khataPaid = 0, stillKhata = 0, cardOther = 0;
  sales.forEach((s) => {
    const t = Number(s.total) || 0;
    totalSales += t;
    byPayment[s.paymentMethod] = (byPayment[s.paymentMethod] || 0) + t;
    if (s.paymentMethod === 'Cash') cashSales += t;
    else if (s.paymentMethod === 'Khata') { khataPaid += Number(s.amountPaid) || 0; stillKhata += t - (Number(s.amountPaid) || 0); }
    else cardOther += t;
  });
  const expenses = DB.listShiftExpenses ? DB.listShiftExpenses(shiftId) : [];
  const expensesTotal = expenses.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  return { sales, billCount: sales.length, totalSales, cashSales, byPayment, khataPaid, stillKhata, cardOther, expenses, expensesTotal };
}
function expectedDrawer(open, stats, deposit, withdrawal) {
  return (Number(open.openingBalance) || 0) + stats.cashSales - stats.expensesTotal + (Number(deposit) || 0) - (Number(withdrawal) || 0);
}

/* 80mm closing-report receipt (same preview/print path as the
 * transfer bill: App.showBillPreviewHtml + App.printReceiptHtml). */
function closingReportHtml(shift) {
  const st = S();
  const c = shift.closing;
  if (!c) return '';
  const byPayRows = Object.keys(c.byPayment || {}).map((k) =>
    '<tr><td>' + esc(k) + '</td><td class="r-right">' + money(c.byPayment[k]) + '</td></tr>'
  ).join('');
  const diff = Number(c.difference) || 0;
  const diffLabel = diff === 0 ? 'Barabar (OK)' : (diff > 0 ? 'Zyada (extra cash)' : 'Kam (short)');
  return '' +
    '<div class="r-center r-bold">' + esc(st.settings.businessName || 'Sahara Bakers') + '</div>' +
    '<div class="r-line"></div>' +
    '<div class="r-center r-bold">Shift Closing Report</div>' +
    '<div>Cashier: <b>' + esc(shift.cashierName || '—') + '</b></div>' +
    '<div>Opened: ' + esc(fmtDateTime(shift.startedAt)) + '</div>' +
    '<div>Closed: ' + esc(fmtDateTime(shift.endedAt)) + '</div>' +
    (c.closedBy ? '<div>Closed By: ' + esc(c.closedBy) + '</div>' : '') +
    '<div class="r-line"></div>' +
    '<table>' +
    '<tr><td>Opening Balance</td><td class="r-right">' + money(c.openingBalance) + '</td></tr>' +
    '<tr><td>Cash Sales</td><td class="r-right">' + money(c.cashSales) + '</td></tr>' +
    '<tr><td>Total Sales (' + c.billCount + ' bills)</td><td class="r-right">' + money(c.totalSales) + '</td></tr>' +
    byPayRows +
    '<tr><td>Khata Paid (cash received)</td><td class="r-right">' + money(c.khataPaid) + '</td></tr>' +
    '<tr><td>Still Khata (udhaar baqi)</td><td class="r-right">' + money(c.stillKhata) + '</td></tr>' +
    '<tr><td>Card / Other</td><td class="r-right">' + money(c.cardOther) + '</td></tr>' +
    '<tr><td>Expenses (shift kharch)</td><td class="r-right">− ' + money(c.expensesTotal) + '</td></tr>' +
    '<tr><td>Owner Deposit</td><td class="r-right">+ ' + money(c.ownerDeposit) + '</td></tr>' +
    '<tr><td>Owner Withdrawal</td><td class="r-right">− ' + money(c.ownerWithdrawal) + '</td></tr>' +
    '</table>' +
    '<div class="r-line"></div>' +
    '<table>' +
    '<tr><td class="r-bold">Expected Drawer</td><td class="r-right r-bold">' + money(c.expectedDrawer) + '</td></tr>' +
    '<tr><td class="r-bold">Counted Drawer</td><td class="r-right r-bold">' + money(c.countedDrawer) + '</td></tr>' +
    '<tr><td class="r-bold">Difference (' + esc(diffLabel) + ')</td><td class="r-right r-bold">' + money(c.difference) + '</td></tr>' +
    '<tr><td>Next Opening</td><td class="r-right">' + money(c.nextOpening) + '</td></tr>' +
    '</table>' +
    (shift.notes ? '<div class="r-line"></div><div>Notes: ' + esc(shift.notes) + '</div>' : '') +
    '<div class="r-line"></div>' +
    '<div class="r-center">Sahara Bakers — Shift Report</div>';
}
function printClosingReport(shift) {
  const html = closingReportHtml(shift);
  if (!html) return false;
  if (window.App.showBillPreviewHtml) {
    return window.App.showBillPreviewHtml(html, function () { return window.App.printReceiptHtml(html); });
  }
  return false;
}

/* Last closed shift whose report is on screen (set by Close, or by
 * opening a row from Closing History). */
let reportShift = null;

function renderShifts(container) {
  container.innerHTML = '';
  const st = S();
  const shiftState = DB.getShiftState ? DB.getShiftState() : { openShift: DB.getOpenShift ? DB.getOpenShift() : null, history: [] };
  const open = shiftState.openShift || null;
  const history = shiftState.history || [];

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Shifts</h1></div>'));
  wrap.appendChild(el('<p class="muted">Shift start / band karein — har shift ka apna cash drawer aur closing report hota hai.</p>'));

  /* ---------- Closing report (after a close, or from history) ---------- */
  if (reportShift && reportShift.closing) {
    const c = reportShift.closing;
    const rCard = el('<div class="card shift-report-card"><h2>Closing Report — ' + esc(reportShift.cashierName || 'Cashier') + '</h2>' +
      '<p class="muted">' + esc(fmtDateTime(reportShift.startedAt)) + ' → ' + esc(fmtDateTime(reportShift.endedAt)) + '</p></div>');
    const rows = [
      ['Opening Balance', money(c.openingBalance)],
      ['Cash Sales', money(c.cashSales)],
      ['Total Sales (' + c.billCount + ' bills)', money(c.totalSales)],
      ['Khata Paid', money(c.khataPaid)],
      ['Still Khata (udhaar baqi)', money(c.stillKhata)],
      ['Card / Other', money(c.cardOther)],
      ['Expenses (shift kharch)', '− ' + money(c.expensesTotal)],
      ['Owner Deposit', '+ ' + money(c.ownerDeposit)],
      ['Owner Withdrawal', '− ' + money(c.ownerWithdrawal)],
      ['Expected Drawer', money(c.expectedDrawer)],
      ['Counted Drawer', money(c.countedDrawer)],
      ['Difference', money(c.difference) + (Number(c.difference) === 0 ? ' — Barabar' : (Number(c.difference) > 0 ? ' — Zyada' : ' — Kam'))],
      ['Next Opening', money(c.nextOpening)],
    ].map((kv) => '<tr><td><b>' + esc(kv[0]) + '</b></td><td class="r-right"><b>' + esc(kv[1]) + '</b></td></tr>').join('');
    let payRows = '';
    Object.keys(c.byPayment || {}).forEach((k) => {
      payRows += '<tr><td>' + esc(k) + '</td><td class="r-right">' + money(c.byPayment[k]) + '</td></tr>';
    });
    rCard.appendChild(el('<div class="table-wrap"><table><tbody>' + rows + '</tbody></table></div>'));
    if (payRows) {
      rCard.appendChild(el('<h3 style="margin-top:12px">Payment-wise</h3>'));
      rCard.appendChild(el('<div class="table-wrap"><table><tbody>' + payRows + '</tbody></table></div>'));
    }
    const rActions = el('<div class="form-actions"></div>');
    const printBtn = el('<button type="button" class="btn btn-primary">Print Report</button>');
    printBtn.addEventListener('click', () => {
      if (!printClosingReport(reportShift)) notify('Issue — Print nahi ho saka — printer check karein', 'error');
    });
    const hideBtn = el('<button type="button" class="btn">Close Report</button>');
    hideBtn.addEventListener('click', () => { reportShift = null; renderShifts(container); });
    rActions.appendChild(printBtn); rActions.appendChild(hideBtn);
    rCard.appendChild(rActions);
    rCard.appendChild(el('<p class="muted">Print dialog mein "Save as PDF" chun kar PDF bhi save kar sakte hain.</p>'));
    wrap.appendChild(rCard);
  }

  /* ---------- Open shift banner / Start Shift ---------- */
  const posCard = el('<div class="card shift-pos"></div>');
  if (open) {
    const stats = shiftStats(open.id);
    posCard.appendChild(el('<h2>Shift Khuli Hui Hai — Open Shift</h2>'));
    posCard.appendChild(el('<div class="shift-pos-grid">' +
      '<div><div class="shift-pos-label">Cashier</div><div class="shift-pos-value">' + esc(open.cashierName || '—') + '</div></div>' +
      '<div><div class="shift-pos-label">Opened At</div><div class="shift-pos-value">' + esc(fmtDateTime(open.startedAt)) + '</div></div>' +
      '<div><div class="shift-pos-label">Opening Balance</div><div class="shift-pos-value">' + money(open.openingBalance) + '</div></div>' +
      '<div><div class="shift-pos-label">Sales So Far (' + stats.billCount + ' bills)</div><div class="shift-pos-value">' + money(stats.totalSales) + '</div></div>' +
      '<div><div class="shift-pos-label">Cash Sales So Far</div><div class="shift-pos-value">' + money(stats.cashSales) + '</div></div>' +
      '<div><div class="shift-pos-label">Expenses So Far</div><div class="shift-pos-value">' + money(stats.expensesTotal) + '</div></div>' +
      '</div>'));
    posCard.appendChild(el('<p class="muted">Nayi shift tab hi start ho sakti hai jab ye shift band ho jaye.</p>'));
    const goSaleBtn = el('<button type="button" class="btn btn-primary">Sale Screen Par Jayein</button>');
    goSaleBtn.addEventListener('click', () => { if (window.App.go) window.App.go('sale'); });
    posCard.appendChild(goSaleBtn);
  } else {
    posCard.appendChild(el('<h2>Start Shift — Shift Shuru Karein</h2>'));
    posCard.appendChild(el('<p class="muted">Bina shift ke sale nahi ho sakti — pehle cashier chunein aur opening balance likhein.</p>'));
    const cashiers = (st.staff || []).filter((s) => s.active !== 0 && s.active !== false && s.role === 'Cashier');
    const form = el('<form></form>');
    const cashierSel = el('<select class="input" id="sh-cashier-sel">' +
      '<option value="">— Cashier chunein —</option>' +
      cashiers.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.phone ? ' (' + esc(c.phone) + ')' : '') + '</option>').join('') +
      '</select>');
    const cashierNameIn = el('<input class="input" id="sh-cashier-name" type="text" placeholder="Cashier naam — agar list mein na ho to yahan likhein">');
    cashierSel.addEventListener('change', () => {
      const c = cashiers.find((x) => String(x.id) === String(cashierSel.value));
      cashierNameIn.value = c ? (c.name || '') : '';
    });
    const openingIn = el('<input class="input" id="sh-opening" type="number" min="0" step="any" value="0" placeholder="Opening balance (Rs)">');
    form.appendChild(el('<label>Cashier</label>')); form.appendChild(cashierSel);
    form.appendChild(el('<label>Ya Cashier Ka Naam</label>')); form.appendChild(cashierNameIn);
    form.appendChild(el('<label>Opening Balance (Rs)</label>')); form.appendChild(openingIn);
    form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Start Shift</button></div>'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const opening = Number(openingIn.value);
      if (isNaN(opening) || opening < 0) { notify('Issue — Opening balance durust likhein (0 ya zyada)', 'error'); return; }
      const picked = cashiers.find((x) => String(x.id) === String(cashierSel.value));
      const cashierName = (picked ? picked.name : cashierNameIn.value.trim()) || '';
      if (!cashierName) { notify('Issue — Cashier chunein ya naam likhein', 'error'); return; }
      const res = DB.startShift({
        cashierId: picked ? picked.id : null,
        cashierName: cashierName,
        openingBalance: opening,
        recordedBy: window.App.user ? window.App.user.name : '',
        clientRef: clientRef('shift'),
      });
      if (!res.ok) { notify('Issue — ' + (res.message || 'Shift start nahi ho saki'), 'error'); return; }
      window.App.save();
      reportShift = null;
      notify('Ho Gaya ✓ — Shift start ho gayi (' + cashierName + ', opening ' + money(opening) + ')', 'success');
      renderShifts(container);
    });
    posCard.appendChild(form);
    if (cashiers.length === 0) {
      posCard.appendChild(el('<p class="muted">Koi cashier register nahi hai — Staff screen se cashier add karein, ya naam upar likh kar shift start karein.</p>'));
    }
  }
  wrap.appendChild(posCard);

  /* ---------- Shift expenses + Close Shift (open shift only) ---------- */
  if (open) {
    const stats = shiftStats(open.id);
    const expCard = el('<div class="card"><h2>Shift Expenses — Shift Ka Kharch</h2><p class="muted">Shift ke dauraan kharch likhein — ye Close Shift mein Expenses line mein aayega.</p></div>');
    const expForm = el('<form></form>');
    const expAmt = el('<input class="input" id="sh-exp-amt" type="number" min="0" step="any" placeholder="Amount (Rs)">');
    const expNote = el('<input class="input" id="sh-exp-note" type="text" placeholder="Note — kis cheez ka kharch (optional)">');
    expForm.appendChild(el('<label>Amount (Rs)</label>')); expForm.appendChild(expAmt);
    expForm.appendChild(el('<label>Note</label>')); expForm.appendChild(expNote);
    expForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn">Add Expense</button></div>'));
    expForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = Number(expAmt.value);
      if (!amount || amount <= 0) { notify('Issue — Kharch ki raqam durust likhein (0 se zyada)', 'error'); return; }
      const res = DB.addShiftExpense({
        shiftId: open.id,
        amount: amount,
        note: expNote.value.trim(),
        recordedBy: window.App.user ? window.App.user.name : '',
      });
      if (!res.ok) { notify('Issue — ' + (res.message || 'Expense add nahi ho saka'), 'error'); return; }
      window.App.save();
      notify('Ho Gaya ✓ — Expense add ho gaya (' + money(amount) + ')', 'success');
      renderShifts(container);
    });
    expCard.appendChild(expForm);
    if (stats.expenses.length === 0) expCard.appendChild(el('<p class="muted">Is shift mein abhi koi kharch nahi likha gaya.</p>'));
    else {
      const rows = stats.expenses.map((x) =>
        '<tr><td><b>' + money(x.amount) + '</b></td><td>' + esc(x.note || '—') + '</td><td>' + esc(x.recordedBy || '') + '</td><td class="muted">' + esc(fmtDateTime(x.occurredAt)) + '</td></tr>'
      ).join('');
      expCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Amount</th><th>Note</th><th>By</th><th>Time</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
      expCard.appendChild(el('<p><b>Total Expenses: ' + money(stats.expensesTotal) + '</b></p>'));
    }
    wrap.appendChild(expCard);

    const closeCard = el('<div class="card"><h2>Close Shift — Shift Band Karein</h2><p class="muted">Drawer mein gina hua cash likhein — expected drawer se farq (difference) report mein aayega.</p></div>');
    const closeForm = el('<form></form>');
    const countedIn = el('<input class="input" id="sh-counted" type="number" min="0" step="any" placeholder="Counted cash in drawer (Rs)">');
    const depositIn = el('<input class="input" id="sh-deposit" type="number" min="0" step="any" value="0" placeholder="Owner deposit (Rs)">');
    const withdrawIn = el('<input class="input" id="sh-withdraw" type="number" min="0" step="any" value="0" placeholder="Owner withdrawal (Rs)">');
    const notesIn = el('<input class="input" id="sh-notes" type="text" placeholder="Notes (optional)">');
    const preview = el('<p id="sh-expected-preview"><b>Expected Drawer: ' + money(expectedDrawer(open, stats, 0, 0)) + '</b> (opening ' + money(open.openingBalance) + ' + cash sales ' + money(stats.cashSales) + ' − expenses ' + money(stats.expensesTotal) + ')</p>');
    function refreshPreview() {
      const exp = expectedDrawer(open, shiftStats(open.id), Number(depositIn.value) || 0, Number(withdrawIn.value) || 0);
      const counted = Number(countedIn.value);
      let txt = '<b>Expected Drawer: ' + money(exp) + '</b> (opening ' + money(open.openingBalance) + ' + cash sales ' + money(stats.cashSales) + ' − expenses ' + money(stats.expensesTotal) + ' + deposit − withdrawal)';
      if (countedIn.value !== '' && !isNaN(counted)) {
        const diff = counted - exp;
        txt += '<br>Difference (counted − expected): <b>' + money(diff) + '</b>' + (diff === 0 ? ' — Barabar' : (diff > 0 ? ' — Zyada' : ' — Kam'));
      }
      preview.innerHTML = txt;
    }
    [countedIn, depositIn, withdrawIn].forEach((inp) => inp.addEventListener('input', refreshPreview));
    closeForm.appendChild(el('<label>Counted Drawer — gina hua cash (Rs)</label>')); closeForm.appendChild(countedIn);
    closeForm.appendChild(el('<label>Owner Deposit (Rs)</label>')); closeForm.appendChild(depositIn);
    closeForm.appendChild(el('<label>Owner Withdrawal (Rs)</label>')); closeForm.appendChild(withdrawIn);
    closeForm.appendChild(el('<label>Notes</label>')); closeForm.appendChild(notesIn);
    closeForm.appendChild(preview);
    closeForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Close Shift</button></div>'));
    closeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const counted = Number(countedIn.value);
      if (countedIn.value === '' || isNaN(counted) || counted < 0) { notify('Issue — Counted cash durust likhein (0 ya zyada)', 'error'); return; }
      const deposit = Number(depositIn.value) || 0;
      const withdrawal = Number(withdrawIn.value) || 0;
      const exp = expectedDrawer(open, shiftStats(open.id), deposit, withdrawal);
      const diff = counted - exp;
      if (diff !== 0 && window.App.confirmDialog) {
        const ok = await window.App.confirmDialog('Difference ' + money(diff) + ' hai', 'Counted drawer expected se ' + (diff > 0 ? 'zyada' : 'kam') + ' hai (' + money(diff) + '). Phir bhi shift band karein?');
        if (!ok) return;
      }
      const res = DB.closeShift({
        shiftId: open.id,
        countedDrawer: counted,
        ownerDeposit: deposit,
        ownerWithdrawal: withdrawal,
        notes: notesIn.value.trim(),
        recordedBy: window.App.user ? window.App.user.name : '',
        closeClientRef: clientRef('close'),
      });
      if (!res.ok) { notify('Issue — ' + (res.message || 'Shift band nahi ho saki'), 'error'); return; }
      window.App.save();
      reportShift = res.shift;
      notify('Ho Gaya ✓ — Shift band ho gayi — difference ' + money(res.shift.closing ? res.shift.closing.difference : diff), 'success');
      renderShifts(container);
    });
    closeCard.appendChild(closeForm);
    wrap.appendChild(closeCard);
  }

  /* ---------- Closing History ---------- */
  const hCard = el('<div class="card"><h2>Closing History — Band Shifts</h2></div>');
  if (history.length === 0) hCard.appendChild(el('<p class="muted">Abhi koi shift band nahi hui.</p>'));
  else {
    const rows = history.map((h) => {
      const c = h.closing || {};
      return '<tr><td><b>' + esc(h.cashierName || '—') + '</b></td>' +
        '<td>' + esc(fmtDay(h.startedAt)) + '<br><span class="muted">' + esc(fmtDateTime(h.startedAt)) + ' → ' + esc(fmtDateTime(h.endedAt)) + '</span></td>' +
        '<td><b>' + (c.billCount != null ? c.billCount : '—') + '</b> bills</td>' +
        '<td><b>' + money(c.totalSales) + '</b></td>' +
        '<td>' + money(c.difference) + (Number(c.difference) === 0 ? '' : (Number(c.difference) > 0 ? ' (Zyada)' : ' (Kam)')) + '</td>' +
        '<td><button type="button" class="btn btn-sm" data-shift="' + esc(h.id) + '">Report</button></td></tr>';
    }).join('');
    hCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Cashier</th><th>Shift Time</th><th>Bills</th><th>Total Sales</th><th>Difference</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    hCard.querySelectorAll('button[data-shift]').forEach((btn) => btn.addEventListener('click', () => {
      const h = history.find((x) => String(x.id) === String(btn.getAttribute('data-shift')));
      if (h) { reportShift = h; renderShifts(container); window.scrollTo(0, 0); }
    }));
  }
  wrap.appendChild(hCard);

  container.appendChild(wrap);
}

/* App.go('shifts') needs a plain render function, so the function IS
 * the screen — currentShift() rides on it for pos.js / other callers. */
renderShifts.currentShift = function () {
  try { return DB.getOpenShift ? DB.getOpenShift() : null; } catch (e) { return null; }
};
window.Screens.shifts = renderShifts;
window.Screens.Shifts = renderShifts;
})();
