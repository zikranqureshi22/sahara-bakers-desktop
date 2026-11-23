/* Sahara Bakers — Counter POS Sale screen (v2.1.0).
 * Dark POS screen (#171310 background, #f97316 orange accents — the
 * web AsanBilling dark theme), for the Counter Manager login.
 * Order types: Take Away, Dine-in (Table 1-9), Online Delivery,
 * Road Side, plus Hold Orders. NOTE on the freeze (API freeze §c.1):
 * the frozen orderType enum is ONLY 'takeaway' | 'dine_in' |
 * 'delivery' — Road Side is NOT a separate enum value, so a Road
 * Side order is stored as orderType 'takeaway' with a 'Road Side'
 * note marker (sale-bill.js reads the marker back for the label).
 * Khata is a PAYMENT method, not an order type (freeze §4.2).
 * Menu: all finished items with photos (assets/products/<id>-<slug>.jpg);
 * ONLY items with a price are saleable — an unpriced item shows
 * "rate nahi" and cannot be added (never price 0, never invent a
 * price). Item 96 has image null — it renders a placeholder card.
 * Cart: qty +/-, subtotal, discount (Rs), delivery charges (Rs),
 * service charge from settings.posServiceCharge (flat Rs OR % — read
 * live, never hardcoded), total = subtotal - discount + delivery +
 * service charge. Payments: Cash / JazzCash / Easypaisa / Card /
 * Bank / Khata (Khata needs a khata customer; amountPaid 0 adds the
 * rest to the customer's balance — DB derives it).
 * Hold/Resume: held orders store lines WITHOUT prices
 * (DB.holdOrder); resume uses CURRENT prices (DB.resumeHoldOrder).
 * Shift gate (web behaviour): no open shift = sale blocked, with a
 * banner + Start Shift button (App.go('shifts') — Worker I wires
 * the route). KOT buttons call window.Screens.Kot (Worker D) behind
 * typeof guards, so this screen works before kot.js loads.
 * Sale completion: DB.createSale with a FRESH clientRef per attempt
 * ('sale_' + time + random — the freeze's dedupe pattern); on
 * success the bill opens at once via Screens.SaleBill (the sale
 * object from createSale is passed — no second fetch); on DB
 * rejection the Roman Urdu error is shown as-is.
 * Wrapped in an IIFE. Module state lives in P and survives
 * re-renders (navigating away and back keeps the cart).
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
function moneyOrDash(n) { return window.App.moneyOrDash ? window.App.moneyOrDash(n) : (n == null ? '—' : money(n)); }
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '—');
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return String(iso || '—'); }
}

/* ---------- module state (survives re-render) ---------- */
var P = {
  orderType: 'takeaway',   // UI pick: takeaway | dine_in | delivery | roadside
  tableNo: null,           // 1-9 for dine_in
  cart: [],                // [{productId, qty}]
  discount: 0,
  delivery: 0,
  payment: 'Cash',         // Cash | JazzCash | Easypaisa | Card | Bank | Khata
  khataCustomerId: null,
  cashierId: null,         // staff id, or null = logged-in user
  note: '',
  search: '',
  category: 'All',
  lastSaleId: null,        // last completed sale (for Print KOT)
};
var containerEl = null;

function productById(id) {
  return (S().products || []).find((p) => String(p.id) === String(id));
}
/* Sale location: the login's branch, or null = Warehouse Counter.
 * (Counter Manager's branchId is null, so the counter sells from
 * the Warehouse; a branch login sells from its own branch.) */
function locBranchId() {
  const u = window.App.user;
  return (u && u.branchId != null) ? u.branchId : null;
}
function locId() {
  const b = locBranchId();
  return b == null ? window.App.warehouseBranchId() : b;
}
function locName() {
  const b = locBranchId();
  return b == null ? 'Warehouse Counter' : window.App.branchName(b);
}
function openShift() {
  try { return DB.getOpenShift ? DB.getOpenShift() : null; } catch (e) { return null; }
}
/* Frozen orderType for DB calls: roadside folds into 'takeaway'
 * (freeze §c.1) — the Road Side marker travels in the note. */
function dbOrderType() {
  return P.orderType === 'roadside' ? 'takeaway' : P.orderType;
}
function orderNote() {
  const base = P.orderType === 'roadside' ? 'Road Side' : '';
  const extra = String(P.note || '').trim();
  if (base && extra) return base + ' — ' + extra;
  return base || extra;
}
function isDeliveryType() { return P.orderType === 'delivery' || P.orderType === 'roadside'; }

/* Service charge from settings.posServiceCharge — flat Rs or % of
 * subtotal. Read live on every total; never hardcoded. */
function serviceChargeFor(subtotal) {
  const sc = (S().settings && S().settings.posServiceCharge) || { type: 'flat', value: 0 };
  if (sc.type === 'percent') return Math.max(0, subtotal * (Number(sc.value) || 0) / 100);
  return Math.max(0, Number(sc.value) || 0);
}
function serviceChargeLabel() {
  const sc = (S().settings && S().settings.posServiceCharge) || { type: 'flat', value: 0 };
  if (sc.type === 'percent') return 'Service Charge (' + (Number(sc.value) || 0) + '%)';
  return 'Service Charge (flat)';
}
function cartTotals() {
  let subtotal = 0;
  P.cart.forEach((ln) => {
    const p = productById(ln.productId);
    if (p && p.price != null) subtotal += (Number(p.price) || 0) * (Number(ln.qty) || 0);
  });
  const discount = Math.max(0, Number(P.discount) || 0);
  const delivery = Math.max(0, Number(P.delivery) || 0);
  const service = serviceChargeFor(subtotal);
  const total = Math.max(0, subtotal - discount + delivery + service);
  return { subtotal: subtotal, discount: discount, delivery: delivery, service: service, total: total };
}
function freshClientRef() {
  return 'sale_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- cashier picker ----------
 * CONTRACT for Worker F (staff.js): if Screens.Staff.cashierOptions()
 * exists it must return an array of {id, name} for active Cashier
 * staff; this screen uses it when present, otherwise it reads
 * DB.state.staff directly (active === 1, role 'Cashier'). Staff are
 * NOT logins — just names stamped on the bill. */
function cashierOptions() {
  try {
    if (window.Screens && window.Screens.Staff && typeof window.Screens.Staff.cashierOptions === 'function') {
      const opts = window.Screens.Staff.cashierOptions();
      if (Array.isArray(opts) && opts.every((o) => o && o.name)) return opts;
    }
  } catch (e) { /* fall through to direct read */ }
  return (S().staff || [])
    .filter((s) => s.active !== 0 && s.active !== false && s.role === 'Cashier')
    .map((s) => ({ id: s.id, name: s.name }));
}
function cashierName() {
  if (P.cashierId != null) {
    const c = cashierOptions().find((o) => String(o.id) === String(P.cashierId));
    if (c) return c.name;
  }
  return window.App.user ? window.App.user.name : '';
}

/* ---------- KOT hooks (Worker D — kot.js) ----------
 * Guarded with typeof checks: the buttons work (with a plain
 * notice) even before kot.js is loaded/wired. */
function kotAvailable() {
  return !!(window.Screens && window.Screens.Kot);
}
function printKotForSale(saleId) {
  if (!kotAvailable() || typeof window.Screens.Kot.printKot !== 'function') {
    notify('Issue — KOT abhi tayyar nahi hai — kitchen ticket baad mein aayega', 'error');
    return;
  }
  try { window.Screens.Kot.printKot(saleId); }
  catch (e) { notify('Issue — KOT print nahi ho saka', 'error'); }
}
function printLastKot() {
  if (!kotAvailable() || typeof window.Screens.Kot.printLastKot !== 'function') {
    notify('Issue — KOT abhi tayyar nahi hai — kitchen ticket baad mein aayega', 'error');
    return;
  }
  try { window.Screens.Kot.printLastKot(); }
  catch (e) { notify('Issue — KOT print nahi ho saka', 'error'); }
}

/* ---------- cart ops ---------- */
function addToCart(productId) {
  const p = productById(productId);
  if (!p) return;
  if (p.price == null) { notify('Issue — "' + p.name + '" ka rate nahi hai — pehle is ki price set karein', 'error'); return; }
  const line = P.cart.find((l) => String(l.productId) === String(productId));
  if (line) line.qty += 1;
  else P.cart.push({ productId: p.id, qty: 1 });
  drawCart();
}
function setQty(productId, qty) {
  const line = P.cart.find((l) => String(l.productId) === String(productId));
  if (!line) return;
  line.qty = Math.max(0, Number(qty) || 0);
  if (line.qty === 0) P.cart = P.cart.filter((l) => l !== line);
  drawCart();
}
function clearCart(keepType) {
  P.cart = [];
  P.discount = 0;
  P.delivery = 0;
  P.note = '';
  if (!keepType) { P.orderType = 'takeaway'; P.tableNo = null; }
  drawCart();
  drawTypes();
  drawTables();
}

/* ---------- render ---------- */
function renderPos(container) {
  containerEl = container;
  container.innerHTML = '';
  const wrap = el('<div class="pos-wrap"></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Counter Sale</h1></div>'));
  wrap.appendChild(el('<p class="pos-sub">Counter sale — item chunein, cart banayein, payment lein. Location: <b>' + esc(locName()) + '</b></p>'));
  wrap.appendChild(el('<div id="pos-shift"></div>'));
  wrap.appendChild(el('<div id="pos-types"></div>'));
  wrap.appendChild(el('<div id="pos-tables"></div>'));
  const main = el('<div class="pos-main"></div>');
  main.appendChild(el('<div id="pos-menu"></div>'));
  main.appendChild(el('<div id="pos-cart"></div>'));
  wrap.appendChild(main);
  wrap.appendChild(el('<div id="pos-held"></div>'));
  container.appendChild(wrap);
  drawShift();
  drawTypes();
  drawTables();
  drawMenu();
  drawCart();
  drawHeld();
}

/* Shift banner + gate. No open shift = banner + Start Shift button
 * (App.go('shifts') — Worker I wires the route) and the Complete
 * Sale button is blocked in completeSale() with a Roman Urdu notice. */
function drawShift() {
  const host = containerEl && containerEl.querySelector('#pos-shift');
  if (!host) return;
  host.innerHTML = '';
  const shift = openShift();
  if (shift) {
    const bar = el('<div class="pos-banner pos-banner-ok">Shift chal rahi hai — Cashier: <b>' + esc(shift.cashierName || '') + '</b> · Opening: <b>' + money(shift.openingBalance) + '</b> · Started: ' + esc(fmtTime(shift.startedAt)) + ' <button type="button" class="btn btn-sm" id="pos-shift-view">Shift Dekhein</button></div>');
    bar.querySelector('#pos-shift-view').addEventListener('click', () => window.App.go('shifts'));
    host.appendChild(bar);
  } else {
    const bar = el('<div class="pos-banner pos-banner-warn">Koi shift open nahi hai — pehle shift start karein, warna sale nahi ho sakti. <button type="button" class="btn btn-sm btn-primary" id="pos-shift-start">Start Shift</button></div>');
    bar.querySelector('#pos-shift-start').addEventListener('click', () => window.App.go('shifts'));
    host.appendChild(bar);
  }
}

var ORDER_TYPES = [
  { id: 'takeaway', label: 'Take Away', sub: 'Le jane wala' },
  { id: 'dine_in', label: 'Dine-in', sub: 'Table 1–9' },
  { id: 'delivery', label: 'Online Delivery', sub: 'Delivery' },
  { id: 'roadside', label: 'Road Side', sub: 'Road side' },
];
function drawTypes() {
  const host = containerEl && containerEl.querySelector('#pos-types');
  if (!host) return;
  host.innerHTML = '';
  const row = el('<div class="pos-type-row"></div>');
  ORDER_TYPES.forEach((t) => {
    const b = el('<button type="button" class="pos-type-btn' + (P.orderType === t.id ? ' active' : '') + '">' + esc(t.label) + '<span>' + esc(t.sub) + '</span></button>');
    b.addEventListener('click', () => {
      P.orderType = t.id;
      if (t.id !== 'dine_in') P.tableNo = null;
      drawTypes(); drawTables(); drawCart();
    });
    row.appendChild(b);
  });
  const heldBtn = el('<button type="button" class="pos-type-btn">Hold Orders<span>Ruke hue orders</span></button>');
  heldBtn.addEventListener('click', () => {
    const h = containerEl.querySelector('#pos-held');
    if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    drawHeld();
  });
  row.appendChild(heldBtn);
  host.appendChild(row);
}

/* Dine-in table picker 1-9. Busy = an active held dine-in order
 * sits on the table (DB.tableStatus) — busy table par click karne
 * se us ka held order resume hota hai. */
function drawTables() {
  const host = containerEl && containerEl.querySelector('#pos-tables');
  if (!host) return;
  host.innerHTML = '';
  if (P.orderType !== 'dine_in') return;
  const wrap = el('<div class="pos-tables"><h3>Table chunein</h3><div class="pos-table-grid"></div></div>');
  const grid = wrap.querySelector('.pos-table-grid');
  for (let t = 1; t <= 9; t++) {
    let st = { busy: false, since: null, heldOrderId: null };
    try { if (DB.tableStatus) st = DB.tableStatus(t); } catch (e) { /* table free */ }
    const b = el('<button type="button" class="pos-table-btn' + (P.tableNo === t ? ' active' : '') + (st.busy ? ' busy' : '') + '">Table ' + t + (st.busy ? '<span>Busy · ' + esc(fmtTime(st.since)) + '</span>' : '<span>Khali</span>') + '</button>');
    b.addEventListener('click', () => {
      if (st.busy && st.heldOrderId != null) { resumeHeld(st.heldOrderId); return; }
      P.tableNo = t;
      drawTables(); drawCart();
    });
    grid.appendChild(b);
  }
  host.appendChild(wrap);
}

/* Menu grid: finished items only, category chips + search.
 * Unpriced items show "rate nahi" and cannot be added. */
function menuItems() {
  const q = String(P.search || '').trim().toLowerCase();
  return (S().products || [])
    .filter((p) => p.type === 'finished' && p.status !== 'inactive')
    .filter((p) => P.category === 'All' || String(p.category || '') === P.category)
    .filter((p) => !q || String(p.name || '').toLowerCase().indexOf(q) !== -1)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}
function drawMenu() {
  const host = containerEl && containerEl.querySelector('#pos-menu');
  if (!host) return;
  host.innerHTML = '';
  const cats = ['All'];
  (S().products || []).forEach((p) => {
    if (p.type === 'finished' && p.category && cats.indexOf(p.category) === -1) cats.push(p.category);
  });
  const bar = el('<div class="pos-menu-bar"></div>');
  const searchIn = el('<input class="input pos-search" type="text" placeholder="Search Item — naam likhein" value="' + esc(P.search) + '">');
  searchIn.addEventListener('input', () => { P.search = searchIn.value; drawGrid(); });
  bar.appendChild(searchIn);
  const chips = el('<div class="pos-chips"></div>');
  cats.forEach((c) => {
    const chip = el('<button type="button" class="pos-chip' + (P.category === c ? ' active' : '') + '">' + esc(c) + '</button>');
    chip.addEventListener('click', () => { P.category = c; drawMenu(); });
    chips.appendChild(chip);
  });
  bar.appendChild(chips);
  host.appendChild(bar);
  const grid = el('<div class="pos-menu-grid" id="pos-grid"></div>');
  host.appendChild(grid);
  drawGrid();
}
function drawGrid() {
  const grid = containerEl && containerEl.querySelector('#pos-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const items = menuItems();
  if (items.length === 0) {
    grid.appendChild(el('<p class="muted">Koi item nahi mila — search ya category badlein.</p>'));
    return;
  }
  items.forEach((p) => {
    const priced = p.price != null;
    const avail = window.App.stockOf(p, locId());
    const photo = p.image
      ? '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" onerror="this.style.display=\'none\'">'
      : '<div class="pos-photo-ph">' + esc(String(p.name || '').slice(0, 12)) + '</div>';
    const card = el('<button type="button" class="pos-card' + (priced ? '' : ' unpriced') + '" ' + (priced ? '' : 'disabled') + '>' +
      photo +
      '<span class="pos-card-name">' + esc(p.name) + '</span>' +
      '<span class="pos-card-unit">' + esc(p.unit || '') + ' · Stock: ' + avail + '</span>' +
      (priced
        ? '<span class="pos-price">' + money(p.price) + '</span>'
        : '<span class="pos-noprice">rate nahi</span>') +
      '</button>');
    if (priced) card.addEventListener('click', () => addToCart(p.id));
    grid.appendChild(card);
  });
}

/* ---------- cart panel ---------- */
function drawCart() {
  const host = containerEl && containerEl.querySelector('#pos-cart');
  if (!host) return;
  host.innerHTML = '';
  const card = el('<div class="pos-cart"></div>');
  card.appendChild(el('<h2>Cart</h2>'));

  // Cashier picker (Worker F contract — see cashierOptions()).
  const cashiers = cashierOptions();
  const cashRow = el('<div class="pos-cashier"></div>');
  cashRow.appendChild(el('<label>Cashier</label>'));
  const cashSel = el('<select class="input" id="pos-cashier">' +
    '<option value="">' + esc(window.App.user ? window.App.user.name : 'Cashier') + ' (login)</option>' +
    cashiers.map((c) => '<option value="' + esc(c.id) + '"' + (String(P.cashierId) === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') +
    '</select>');
  cashSel.addEventListener('change', () => { P.cashierId = cashSel.value ? cashSel.value : null; });
  cashRow.appendChild(cashSel);
  card.appendChild(cashRow);

  // Order summary line.
  const typeLabel = P.orderType === 'dine_in' ? 'Dine-in' + (P.tableNo != null ? ' — Table ' + P.tableNo : ' — table chunein')
    : P.orderType === 'delivery' ? 'Online Delivery'
    : P.orderType === 'roadside' ? 'Road Side' : 'Take Away';
  card.appendChild(el('<p class="pos-order-line">Order: <b>' + esc(typeLabel) + '</b> · ' + esc(locName()) + '</p>'));

  // Cart lines.
  const linesHost = el('<div class="pos-lines"></div>');
  if (P.cart.length === 0) linesHost.appendChild(el('<p class="muted">Cart khali hai — menu se item chunein.</p>'));
  P.cart.forEach((ln) => {
    const p = productById(ln.productId);
    if (!p) return;
    const row = el('<div class="pos-line"></div>');
    row.appendChild(el('<span class="pos-line-name">' + esc(p.name) + '<br><small>' + money(p.price) + ' × ' + ln.qty + ' = <b>' + money((Number(p.price) || 0) * ln.qty) + '</b></small></span>'));
    const minus = el('<button type="button" class="btn btn-sm pos-qty-btn">−</button>');
    minus.addEventListener('click', () => setQty(p.id, ln.qty - 1));
    const qty = el('<span class="pos-qty">' + ln.qty + '</span>');
    const plus = el('<button type="button" class="btn btn-sm pos-qty-btn">+</button>');
    plus.addEventListener('click', () => setQty(p.id, ln.qty + 1));
    const rm = el('<button type="button" class="btn btn-sm">×</button>');
    rm.addEventListener('click', () => setQty(p.id, 0));
    row.appendChild(minus); row.appendChild(qty); row.appendChild(plus); row.appendChild(rm);
    linesHost.appendChild(row);
  });
  card.appendChild(linesHost);

  // Discount / delivery / note inputs — 'input' only updates P +
  // the totals numbers (no rebuild, so typing never loses focus).
  const discRow = el('<div class="pos-money-row"><label>Discount (Rs)</label><input class="input" id="pos-discount" type="number" min="0" step="any" value="' + (Number(P.discount) || 0) + '"></div>');
  discRow.querySelector('#pos-discount').addEventListener('input', (e) => { P.discount = Math.max(0, Number(e.target.value) || 0); updateTotals(); });
  card.appendChild(discRow);
  const delRow = el('<div class="pos-money-row"><label>Delivery Charges (Rs)</label><input class="input" id="pos-delivery" type="number" min="0" step="any" value="' + (Number(P.delivery) || 0) + '"></div>');
  delRow.querySelector('#pos-delivery').addEventListener('input', (e) => { P.delivery = Math.max(0, Number(e.target.value) || 0); updateTotals(); });
  card.appendChild(delRow);
  if (!isDeliveryType()) delRow.style.opacity = '0.55';
  const noteRow = el('<div class="pos-money-row"><label>Note (optional)</label><input class="input" id="pos-note" type="text" placeholder="Customer naam / remarks" value="' + esc(P.note) + '"></div>');
  noteRow.querySelector('#pos-note').addEventListener('input', (e) => { P.note = e.target.value; });
  card.appendChild(noteRow);

  // Totals (ids so updateTotals() can refresh numbers only).
  const totals = el('<div class="pos-totals">' +
    '<div><span>Subtotal</span><b id="pos-t-subtotal"></b></div>' +
    '<div><span>Discount</span><b id="pos-t-discount"></b></div>' +
    '<div><span>Delivery</span><b id="pos-t-delivery"></b></div>' +
    '<div><span>' + esc(serviceChargeLabel()) + '</span><b id="pos-t-service"></b></div>' +
    '<div class="pos-total"><span>TOTAL</span><b id="pos-t-total"></b></div>' +
    '</div>');
  card.appendChild(totals);

  // Payment picker.
  const payHost = el('<div class="pos-pay"></div>');
  payHost.appendChild(el('<label>Payment</label>'));
  const payRow = el('<div class="pos-pay-row"></div>');
  ['Cash', 'JazzCash', 'Easypaisa', 'Card', 'Bank', 'Khata'].forEach((m) => {
    const b = el('<button type="button" class="pos-pay-btn' + (P.payment === m ? ' active' : '') + '">' + esc(m) + '</button>');
    b.addEventListener('click', () => { P.payment = m; drawCart(); });
    payRow.appendChild(b);
  });
  payHost.appendChild(payRow);
  card.appendChild(payHost);

  // Khata customer picker (only for Khata payment).
  if (P.payment === 'Khata') card.appendChild(khataPickerEl());

  // Actions.
  const shift = openShift();
  const actions = el('<div class="pos-actions"></div>');
  const completeBtn = el('<button type="button" class="btn btn-primary btn-block" id="pos-complete">Complete Sale — ' + esc(P.payment) + '</button>');
  completeBtn.disabled = !shift || P.cart.length === 0;
  completeBtn.addEventListener('click', completeSale);
  actions.appendChild(completeBtn);
  const holdBtn = el('<button type="button" class="btn btn-block" id="pos-hold">Hold Order</button>');
  holdBtn.disabled = P.cart.length === 0;
  holdBtn.addEventListener('click', holdCurrentCart);
  actions.appendChild(holdBtn);
  const kotRow = el('<div class="pos-kot-row"></div>');
  const kotBtn = el('<button type="button" class="btn btn-sm" id="pos-kot">Print KOT</button>');
  kotBtn.addEventListener('click', () => {
    if (P.lastSaleId == null) { notify('Issue — Abhi tak koi KOT nahi bana — pehle sale complete karein', 'error'); return; }
    printKotForSale(P.lastSaleId);
  });
  const lastKotBtn = el('<button type="button" class="btn btn-sm" id="pos-kot-last">Print Last KOT</button>');
  lastKotBtn.addEventListener('click', printLastKot);
  kotRow.appendChild(kotBtn); kotRow.appendChild(lastKotBtn);
  actions.appendChild(kotRow);
  const clearBtn = el('<button type="button" class="btn btn-ghost btn-sm" id="pos-clear">Cart Clear Karein</button>');
  clearBtn.addEventListener('click', () => clearCart(true));
  actions.appendChild(clearBtn);
  card.appendChild(actions);

  host.appendChild(card);
  updateTotals();
}
function updateTotals() {
  if (!containerEl) return;
  const t = cartTotals();
  const set = (id, v) => { const n = containerEl.querySelector(id); if (n) n.textContent = v; };
  set('#pos-t-subtotal', money(t.subtotal));
  set('#pos-t-discount', '− ' + money(t.discount));
  set('#pos-t-delivery', money(t.delivery));
  set('#pos-t-service', money(t.service));
  set('#pos-t-total', money(t.total));
  const completeBtn = containerEl.querySelector('#pos-complete');
  if (completeBtn) {
    completeBtn.disabled = !openShift() || P.cart.length === 0;
    completeBtn.textContent = 'Complete Sale — ' + P.payment + ' · ' + money(t.total);
  }
  const holdBtn = containerEl.querySelector('#pos-hold');
  if (holdBtn) holdBtn.disabled = P.cart.length === 0;
}

/* Khata customer picker + inline new-customer form. Uses only the
 * frozen DB khata functions (addKhataCustomer / khataBalance).
 * Khata management itself (ledger, payments) is Worker D's khata.js. */
function khataPickerEl() {
  const host = el('<div class="pos-khata"></div>');
  const customers = S().khataCustomers || [];
  host.appendChild(el('<label>Khata Customer — chunein</label>'));
  const sel = el('<select class="input" id="pos-khata-cust">' +
    '<option value="">— Customer chunein —</option>' +
    customers.map((c) => '<option value="' + esc(c.id) + '"' + (String(P.khataCustomerId) === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + (c.phone ? ' (' + esc(c.phone) + ')' : '') + '</option>').join('') +
    '</select>');
  sel.addEventListener('change', () => { P.khataCustomerId = sel.value ? sel.value : null; drawCart(); });
  host.appendChild(sel);
  if (P.khataCustomerId != null) {
    const c = customers.find((x) => String(x.id) === String(P.khataCustomerId));
    if (c) {
      let bal = null;
      try { bal = DB.khataBalance ? DB.khataBalance(c.id) : null; } catch (e) { bal = null; }
      host.appendChild(el('<p class="pos-khata-bal">' + esc(c.name) + ' ka baqaya balance: <b>' + (bal == null ? '—' : money(bal)) + '</b> (is sale ke baad update hoga)</p>'));
    }
  }
  // Inline new customer (name required — DB rejects an empty name).
  const addRow = el('<div class="pos-khata-add"></div>');
  const nameIn = el('<input class="input" type="text" placeholder="Naya customer naam">');
  const phoneIn = el('<input class="input" type="text" placeholder="Phone (optional)">');
  const addBtn = el('<button type="button" class="btn btn-sm">+ New Customer</button>');
  addBtn.addEventListener('click', () => {
    const res = DB.addKhataCustomer ? DB.addKhataCustomer({ name: nameIn.value, phone: phoneIn.value }) : { ok: false, message: 'Khata abhi tayyar nahi hai.' };
    if (!res.ok) { notify('Issue — ' + (res.message || 'Customer nahi ban saka'), 'error'); return; }
    window.App.save();
    P.khataCustomerId = res.customer.id;
    notify('Ho Gaya ✓ — Khata customer ban gaya: ' + res.customer.name, 'success');
    drawCart();
  });
  addRow.appendChild(nameIn); addRow.appendChild(phoneIn); addRow.appendChild(addBtn);
  host.appendChild(addRow);
  host.appendChild(el('<p class="muted">Khata sale ka baqaya (total − paid) customer ke balance mein jayega — amountPaid 0 hota hai.</p>'));
  return host;
}

/* ---------- complete sale ---------- */
function completeSale() {
  const shift = openShift();
  if (!shift) { notify('Issue — Pehle shift start karein — bina shift ke sale nahi ho sakti.', 'error'); return; }
  if (P.cart.length === 0) { notify('Issue — Pehle cart mein kam az kam aik item add karein.', 'error'); return; }
  if (P.orderType === 'dine_in' && P.tableNo == null) { notify('Issue — Dine-in ke liye pehle table chunein.', 'error'); return; }
  if (P.payment === 'Khata' && P.khataCustomerId == null) { notify('Issue — Khata sale ke liye pehle customer chunein.', 'error'); return; }
  const t = cartTotals();
  // FRESH clientRef per attempt (freeze dedupe pattern) — a retry
  // after a rejection gets a new ref; a double-click with the same
  // ref returns the original sale, never a second stock cut.
  const res = DB.createSale({
    lines: P.cart.map((ln) => ({ productId: ln.productId, qty: ln.qty })),
    orderType: dbOrderType(),
    tableNo: P.orderType === 'dine_in' ? P.tableNo : null,
    branchId: locBranchId(),
    paymentMethod: P.payment,
    customerId: P.payment === 'Khata' ? P.khataCustomerId : null,
    discount: t.discount,
    deliveryCharges: t.delivery,
    serviceCharge: t.service,
    amountPaid: P.payment === 'Khata' ? 0 : t.total,
    clientRef: freshClientRef(),
    shiftId: shift.id,
    cashierId: P.cashierId,
    cashierName: cashierName(),
    note: orderNote(),
    recordedBy: window.App.user ? window.App.user.name : '',
    occurredAt: new Date().toISOString()
  });
  if (!res.ok) {
    // DB rejection — Roman Urdu error as-is; cart stays so the
    // user can fix it (e.g. stock kam hai, rate nahi hai).
    notify('Issue — ' + (res.message || 'Sale nahi ho saki'), 'error');
    return;
  }
  window.App.save();
  P.lastSaleId = res.sale.id;
  const billNo = res.billNo || (window.App.saleBillNo ? window.App.saleBillNo(res.sale) : ('SL-' + res.sale.saleNo));
  notify('Ho Gaya ✓ — Sale ' + billNo + ' ho gayi — ' + money(res.sale.total), 'success');
  // Clear the cart, keep the order type for the next customer.
  P.cart = []; P.discount = 0; P.delivery = 0; P.note = ''; P.tableNo = null;
  P.khataCustomerId = null;
  drawShift(); drawTypes(); drawTables(); drawCart(); drawHeld(); drawGrid();
  // Show the bill at once (sale object from createSale — no fetch).
  if (window.Screens && window.Screens.SaleBill && typeof window.Screens.SaleBill.showBill === 'function') {
    window.Screens.SaleBill.showBill(res.sale);
  } else if (window.App.showSaleBill) {
    window.App.showSaleBill(res.sale);
  }
}

/* ---------- hold / resume ---------- */
function holdCurrentCart() {
  if (P.cart.length === 0) { notify('Issue — Pehle cart mein kam az kam aik item add karein.', 'error'); return; }
  const res = DB.holdOrder({
    orderType: dbOrderType(),
    tableNo: P.orderType === 'dine_in' ? P.tableNo : null,
    branchId: locBranchId(),
    lines: P.cart.map((ln) => ({ itemId: ln.productId, qty: ln.qty })),
    note: orderNote(),
    recordedBy: window.App.user ? window.App.user.name : ''
  });
  if (!res.ok) { notify('Issue — ' + (res.message || 'Hold nahi ho saka'), 'error'); return; }
  window.App.save();
  notify('Ho Gaya ✓ — Order hold ho gaya — baad mein Hold Orders se wapas laein', 'success');
  clearCart(false);
  drawHeld();
}
function resumeHeld(heldId) {
  if (P.cart.length > 0) {
    // Cart already has items — resume replaces it, so confirm first.
    window.App.confirmDialog('Hold Order Resume Karein?', 'Maujooda cart hat jayega aur hold order ka cart aa jayega.').then((ok) => {
      if (ok) doResumeHeld(heldId);
    });
    return;
  }
  doResumeHeld(heldId);
}
function doResumeHeld(heldId) {
  const res = DB.resumeHoldOrder ? DB.resumeHoldOrder(heldId) : { ok: false, message: 'Hold order nahi mila.' };
  if (!res.ok) { notify('Issue — ' + (res.message || 'Hold order nahi mila'), 'error'); return; }
  const cart = res.cart;
  // Resume uses CURRENT prices — an unpriced line cannot be sold.
  const skipped = [];
  P.cart = [];
  (cart.lines || []).forEach((l) => {
    if (l.unitPrice == null) { skipped.push(l.name); return; }
    P.cart.push({ productId: l.itemId, qty: l.quantity });
  });
  P.orderType = cart.orderType === 'dine_in' ? 'dine_in' : (String(cart.note || '').indexOf('Road Side') !== -1 ? 'roadside' : (cart.orderType === 'delivery' ? 'delivery' : 'takeaway'));
  P.tableNo = cart.tableNo;
  P.note = String(cart.note || '').replace(/^Road Side( — )?/, '');
  P.discount = 0; P.delivery = 0;
  const del = DB.deleteHoldOrder ? DB.deleteHoldOrder(heldId) : { ok: true };
  if (del.ok) window.App.save();
  if (skipped.length > 0) notify('Ho Gaya ✓ — Hold order wapas aa gaya — ' + skipped.join(', ') + ' ka rate nahi hai, is liye wo line nahi aayi', 'success');
  else notify('Ho Gaya ✓ — Hold order wapas aa gaya', 'success');
  drawTypes(); drawTables(); drawCart(); drawHeld(); drawGrid();
}
function drawHeld() {
  const host = containerEl && containerEl.querySelector('#pos-held');
  if (!host) return;
  host.innerHTML = '';
  const held = (S().heldOrders || []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const card = el('<div class="card pos-held-card"><h2>Hold Orders</h2></div>');
  if (held.length === 0) {
    card.appendChild(el('<p class="muted">Koi hold order nahi hai — cart se "Hold Order" dabayein to order yahan aayega.</p>'));
  } else {
    const rows = held.map((h) => {
      let lines = [];
      try { lines = JSON.parse(h.linesJson || '[]'); } catch (e) { lines = []; }
      const items = lines.map((l) => {
        const p = productById(l.itemId);
        return esc(p ? p.name : ('Item ' + l.itemId)) + ' × ' + l.quantity;
      }).join(', ');
      const typeLabel = h.orderType === 'dine_in' ? 'Dine-in' + (h.tableNo != null ? ' — Table ' + h.tableNo : '')
        : String(h.note || '').indexOf('Road Side') !== -1 ? 'Road Side'
        : h.orderType === 'delivery' ? 'Online Delivery' : 'Take Away';
      return '<tr><td><b>' + esc(typeLabel) + '</b></td><td>' + items + '</td><td>' + esc(h.recordedBy || '') + '</td><td class="muted">' + esc(fmtTime(h.createdAt)) + '</td>' +
        '<td><button type="button" class="btn btn-sm btn-primary" data-resume="' + esc(h.id) + '">Resume</button> ' +
        '<button type="button" class="btn btn-sm" data-delheld="' + esc(h.id) + '">Hataein</button></td></tr>';
    }).join('');
    card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Type</th><th>Items</th><th>By</th><th>Time</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    card.querySelectorAll('button[data-resume]').forEach((btn) => btn.addEventListener('click', () => resumeHeld(btn.getAttribute('data-resume'))));
    card.querySelectorAll('button[data-delheld]').forEach((btn) => btn.addEventListener('click', async () => {
      const ok = await window.App.confirmDialog('Hold Order Hatayein?', 'Ye hold order delete ho jayega.');
      if (!ok) return;
      const res = DB.deleteHoldOrder ? DB.deleteHoldOrder(btn.getAttribute('data-delheld')) : { ok: false };
      if (res.ok) { window.App.save(); notify('Ho Gaya ✓ — Hold order hata diya', 'success'); drawHeld(); }
      else notify('Issue — ' + (res.message || 'Hold order nahi hata'), 'error');
    }));
  }
  host.appendChild(card);
}

window.Screens.sale = renderPos;
window.Screens.Pos = renderPos;
})();
