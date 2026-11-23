/* Sahara Bakers — renderer core (v2.0.0).
 * Contract: window.App exposes {state, user, theme, go, notify, money,
 * branchName, stockOf, can, currentBranchId, save}.
 * window.Screens = {} registry; each screen module registers
 * Screens.<name> = function render(containerEl) {...}.
 *
 * State shape (src/db.js / src/seed.json):
 *   state.settings   { businessName, address, phone, currency,
 *                      defaultBranchId, allowNegativeStock,
 *                      sessionTimeoutMinutes, printerName,
 *                      lowStockNotifications, defaultLowStockLimit }
 *   state.branches   [{ id, name, address, contact, manager }]
 *                      — exactly 3 real branches (Branch 1/2/3).
 *                      The Warehouse/Godown is NOT a branch: it is
 *                      the separate location DB.WAREHOUSE_ID
 *                      ('warehouse') — see warehouseBranchId().
 *   state.products   [{ id, name, price (null until entered), purchasePrice,
 *                       category, type ('raw'|'finished'), unit, sku,
 *                       barcode, lowThreshold, status, image,
 *                       stock (total), branchStocks: [{branchId, qty}] }]
 *   state.appUsers   [{ id, name, username, pinHash (sha256 via DB.hashPin),
 *                       role, branchId (null for Owner), branchName, isActive }]
 *   state.stockMovements [{ id, productId, productName, branchId, qty,
 *                       date, reason, user, reference }]
 *   state.transfers  [{ id, billNo, date, fromBranchId, toBranchId,
 *                       items: [{productId, qty}], status, createdBy }]
 *   state.purchases  [{ id, invoiceNo, date, supplierId, supplierName,
 *                       total, paid, remaining, createdBy }]
 *   state.purchaseLines [{ id, purchaseId, productId, qty, unitPrice, lineTotal }]
 *   state.suppliers  [{ id, name, phone, address }]
 * Stock reads/writes go through DB.stockOf / DB.setStock / DB.addMovement
 * (branchStocks array; branch ids are numbers — option values from
 * <select> are strings, so App normalises them with normBranchId()).
 */
/* NOTE on the contract snippet `require('./db.js')`: in the Electron
 * renderer, a relative require inside a classic <script> resolves against
 * the HTML document (project root), not the JS file — so './db.js' throws
 * MODULE_NOT_FOUND when the page is index.html and db.js lives in src/.
 * The fallback below keeps the contract form first and resolves via
 * src/ when needed. */
const DB = (function () { try { return require('./db.js'); } catch (e) { return require('./src/db.js'); } })();
DB.load();
const state = DB.state;

window.Screens = window.Screens || {};

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function ensureState() {
  const s = DB.state || state;
  if (!s.settings) s.settings = {};
  if (!s.settings.businessName) s.settings.businessName = 'Sahara Bakers';
  if (!s.settings.currency) s.settings.currency = 'PKR';
  if (typeof s.settings.allowNegativeStock !== 'boolean') s.settings.allowNegativeStock = false;
  if (typeof s.settings.lowStockNotifications !== 'boolean') s.settings.lowStockNotifications = true;
  if (!Array.isArray(s.branches)) s.branches = [];
  if (s.branches.length === 0) {
    // No branches at all (seed file missing): the v2 seed shape —
    // exactly 3 real branches. The Warehouse is NOT a branch and is
    // never created here; it is the separate location
    // DB.WAREHOUSE_ID ('warehouse').
    s.branches.push(
      { id: 1, name: 'Branch 1', address: '' },
      { id: 2, name: 'Branch 2', address: '' },
      { id: 3, name: 'Branch 3', address: '' }
    );
  }
  if (s.settings.defaultBranchId === undefined || s.settings.defaultBranchId === null) s.settings.defaultBranchId = s.branches[0].id;
  if (!Array.isArray(s.products)) s.products = [];
  if (!Array.isArray(s.appUsers)) s.appUsers = [];
  if (!Array.isArray(s.stockMovements)) s.stockMovements = [];
  if (!Array.isArray(s.transfers)) s.transfers = [];
  if (!Array.isArray(s.purchases)) s.purchases = [];
  if (!Array.isArray(s.purchaseLines)) s.purchaseLines = [];
  if (!Array.isArray(s.suppliers)) s.suppliers = [];
  return s;
}
function dbSave() {
  try { App.state = DB.state; DB.save(); }
  catch (e) {
    // A failed save must never crash the UI or lose the in-memory state.
    try { App.handleError(e, 'save'); } catch (err) { /* never throw from error handling */ }
  }
}

/* Central error handler: every user action fails gracefully.
 * No stack traces, no blank screens, no sensitive data (PINs, hashes)
 * in the message — only a short Roman Urdu notice on top. */
function sanitiseErrorMessage(e) {
  let msg = (e && e.message) ? String(e.message) : 'Kuch ghalat ho gaya';
  msg = msg.replace(/\b[0-9a-f]{32,}\b/gi, '[hidden]');
  if (msg.length > 160) msg = msg.slice(0, 160) + '…';
  return msg;
}

/* ---------- Role / permission model ---------- */
// Roles: Owner (Rahmanullah, PIN 1234), Manager (PIN 123),
// Warehouse Staff, Branch.
// Owner can do everything. Manager: daily ops only — Reports,
// Logins and Settings are Owner-only and hidden from Manager.
// Warehouse Staff: dashboard, products/raw/production/finish,
// warehouse, transfer, branches, stock in/out, stock.
// Branch: own branch stock + items view only.
const OWNER_ONLY = ['reports', 'logins', 'settings'];
// v2.1.0 — POS routes (Counter Manager only) + godown Owner screens.
// Route ids match window.Screens registrations: 'sale' (pos.js),
// 'sales-history', 'shifts', 'sales-summary', 'pos-dashboard',
// 'pos-settings', 'staff', 'recipes', 'owner-dashboard', 'expiry',
// 'suppliers', 'expenses'. kot.js / sale-bill.js have NO screen
// (helpers only) and items.js is already reachable — no nav for them.
const POS_ROUTES = ['sale', 'sales-history', 'shifts', 'sales-summary', 'pos-dashboard', 'khata', 'pos-settings', 'staff'];
const NAV = [
  { id: 'owner-dashboard', label: 'Owner Dashboard', sub: 'Sales aur dispatch', action: 'owner-dashboard', section: 'main' },
  { id: 'dashboard', label: 'Dashboard', sub: 'Aaj ka hisaab', action: 'dashboard', section: 'main' },
  { id: 'products', label: 'Products', sub: 'Sab items', action: 'products', section: 'main' },
  { id: 'raw', label: 'Raw Material', sub: 'Kacha maal', action: 'raw', section: 'main' },
  { id: 'production', label: 'Production', sub: 'Tayyar karna', action: 'production', section: 'main' },
  { id: 'recipes', label: 'Recipes', sub: 'Production recipes', action: 'recipes', section: 'main' },
  { id: 'finished', label: 'Finish Goods', sub: 'Tayyar cheezein', action: 'finished', section: 'main' },
  { id: 'warehouse', label: 'Warehouse', sub: 'Godown', action: 'warehouse', section: 'main' },
  { id: 'transfer', label: 'Stock Transfer', sub: 'Branch ko bhejo', action: 'transfer', section: 'main' },
  { id: 'branches', label: 'Branches', sub: 'Teeno branches', action: 'branches', section: 'main' },
  { id: 'billing', label: 'Billing', sub: 'Bill aur invoices', action: 'billing', section: 'main' },
  { id: 'stockio', label: 'Stock In/Out', sub: 'Maal aaya / gaya', action: 'stockio', section: 'main' },
  { id: 'stock', label: 'Stock', sub: 'Stock dekho', action: 'stock', section: 'main' },
  { id: 'expiry', label: 'Expiry & Wastage', sub: 'Batches aur wastage', action: 'expiry', section: 'main' },
  { id: 'suppliers', label: 'Suppliers', sub: 'Supplier aur kharidari', action: 'suppliers', section: 'main' },
  { id: 'expenses', label: 'Expenses', sub: 'Godown kharcha', action: 'expenses', section: 'main' },
  { id: 'sale', label: 'Counter Sale', sub: 'Sale counter', action: 'sale', section: 'pos' },
  { id: 'sales-history', label: 'Sale History', sub: 'SL bills', action: 'sales-history', section: 'pos' },
  { id: 'shifts', label: 'Shifts', sub: 'Shift aur drawer', action: 'shifts', section: 'pos' },
  { id: 'sales-summary', label: 'Sales Summary', sub: 'Summary aur breakdown', action: 'sales-summary', section: 'pos' },
  { id: 'pos-dashboard', label: 'POS Dashboard', sub: 'Din ki sales', action: 'pos-dashboard', section: 'pos' },
  { id: 'khata', label: 'Khata', sub: 'Udhaar khata', action: 'khata', section: 'pos' },
  { id: 'staff', label: 'Staff', sub: 'Cashier aur staff', action: 'staff', section: 'pos' },
  { id: 'pos-settings', label: 'POS Settings', sub: 'POS aur KOT settings', action: 'pos-settings', section: 'pos' },
  { id: 'reports', label: 'Reports', sub: 'Hisaab report', action: 'reports', section: 'other' },
  { id: 'purchases', label: 'Purchases', sub: 'Kharidari', action: 'purchases', section: 'other' },
  { id: 'logins', label: 'Logins', sub: 'Login details', action: 'logins', section: 'other' },
  { id: 'settings', label: 'Settings', sub: 'Settings', action: 'settings', section: 'other' },
  { id: 'theme', label: 'Dark Theme', action: 'theme', section: 'other' },
];
// Roman Urdu supporting line under the breadcrumb on each screen.
const SCREEN_SUBS = {
  'owner-dashboard': 'Counter sales aur warehouse dispatch — alag-alag hisaab',
  dashboard: 'Aaj ka hisaab — kul stock, production aur transfers',
  products: 'Sab items aik hi screen par — kisi item par click karein to uski details khulengi',
  raw: 'Kacha maal — godown stock aur kharid price',
  production: 'Raw material se finish goods tayyar karein',
  recipes: 'Production recipes — raw material ka hisaab',
  finished: 'Tayyar cheezein — stock, cost aur history',
  warehouse: 'Godown — finish goods ka kul stock',
  transfer: 'Warehouse se kisi bhi branch ko maal bhejein',
  branches: 'Teeno branches ka stock aur transfer history',
  billing: 'Production aur transfer ke bill',
  stockio: 'Maal aaya ya gaya — stock in aur out',
  stock: 'Godown aur har branch ka stock',
  expiry: 'Expiry batches (FEFO) aur wastage',
  suppliers: 'Suppliers — supplier-wise kharidari',
  expenses: 'Godown kharch — head aur raqam',
  sale: 'Counter sale — item chunein, cart banayein, payment lein',
  'sales-history': 'Counter sales (SL-…) — bill, void aur delete',
  shifts: 'Shift start / band karein — drawer aur closing report',
  'sales-summary': 'Sales summary — payment, order type aur void hisaab',
  'pos-dashboard': 'Aaj ki counter sales — bills aur totals',
  khata: 'Udhaar khata — customers, ledger aur adaigi',
  staff: 'Staff — cashier, rider aur haazri',
  'pos-settings': 'POS aur KOT settings',
  reports: 'Mahina aur kul hisaab — report',
  purchases: 'Kharidari — invoice aur stock in',
  logins: 'Login details aur PIN badlein',
  settings: 'Backup, printer aur theme settings',
};

const App = {
  state: DB.state,
  user: null,
  theme: 'light',
  currentScreen: null,
  _branchId: null,      // Owner's selected branch (header selector)
  _selectedLoginUser: null,
  _lockedUser: null,    // user who was locked out by the session timeout
  _idleTimer: null,
  _idleWarnTimer: null,
  _idleWarned: false,
  perf: { lastSwitchMs: 0, switches: [] },

  /* ----- central error handling ----- */
  handleError(err, context) {
    let msg = sanitiseErrorMessage(err);
    this.notify('Issue — ' + msg, 'error');
    try {
      if (typeof console !== 'undefined' && console.error) console.error('[Sahara Bakers]', context || 'error', msg);
    } catch (e) { /* ignore */ }
  },

  /* ----- automatic session timeout ----- */
  // Locks the app after N minutes of no input (default 15, from Settings).
  // The loaded data stays in memory; only the PIN screen comes back.
  // A warning appears 1 minute before locking.
  sessionTimeoutMs() {
    const mins = Number(this.state && this.state.settings && this.state.settings.sessionTimeoutMinutes);
    if (!mins || mins <= 0) return 15 * 60 * 1000;
    return Math.max(1, mins) * 60 * 1000;
  },
  startIdleTimer() {
    this.stopIdleTimer();
    if (!this.user) return;
    const total = this.sessionTimeoutMs();
    const warnAt = Math.max(0, total - 60 * 1000);
    this._idleWarned = false;
    this._idleWarnTimer = setTimeout(() => {
      this._idleWarned = true;
      this.notify('1 minute mein lock ho jayega — kaam jari rakhne ke liye kahin bhi click karein', 'warning');
    }, warnAt);
    this._idleTimer = setTimeout(() => this.lock(), total);
  },
  resetIdleTimer() {
    if (!this.user) return;
    if (this._idleWarned) this._idleWarned = false;
    this.startIdleTimer();
  },
  stopIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this._idleWarnTimer) { clearTimeout(this._idleWarnTimer); this._idleWarnTimer = null; }
  },
  lock() {
    if (!this.user) return;
    this._lockedUser = this.user;
    this.stopIdleTimer();
    this.user = null;
    this.currentScreen = null;
    try { document.body.classList.remove('pos-only'); } catch (e) { /* ignore */ }
    const container = document.getElementById('screen');
    if (container) container.innerHTML = '';
    this.notify('Session lock ho gaya — PIN dobara dalein', 'warning');
    this.renderLogin();
  },

  /* ----- lifecycle ----- */
  init() {
    ensureState();
    this.state = DB.state;
    const savedTheme = (() => { try { return localStorage.getItem('sahara-theme'); } catch (e) { return null; } })();
    this.theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'light';
    this.applyTheme();
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.addEventListener('click', () => this.toggleTheme());
    // Login-screen ⋮ menu: theme toggle + one-click restore from
    // backup, available BEFORE any login (the data-loss case has no
    // logins at all).
    const loginMenuBtn = document.getElementById('login-menu-btn');
    const loginMenu = document.getElementById('login-menu');
    if (loginMenuBtn && loginMenu) {
      loginMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); loginMenu.hidden = !loginMenu.hidden; });
      document.addEventListener('click', (e) => {
        if (!loginMenu.hidden && !loginMenu.contains(e.target) && e.target !== loginMenuBtn) loginMenu.hidden = true;
      });
    }
    const loginThemeBtn = document.getElementById('login-theme-toggle');
    if (loginThemeBtn) loginThemeBtn.addEventListener('click', () => { if (loginMenu) loginMenu.hidden = true; this.toggleTheme(); });
    const loginRestoreBtn = document.getElementById('login-restore-btn');
    if (loginRestoreBtn) loginRestoreBtn.addEventListener('click', () => { if (loginMenu) loginMenu.hidden = true; this.restoreFromLogin(); });
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout());
    const branchSel = document.getElementById('branch-select');
    if (branchSel) branchSel.addEventListener('change', (e) => {
      this._branchId = this.normBranchId(e.target.value || null);
      this.save();
      this.go(this.currentScreen || 'dashboard');
    });
    this.updateNetBadge();
    window.addEventListener('online', () => this.updateNetBadge());
    window.addEventListener('offline', () => this.updateNetBadge());
    // Global error handling: no blank screens, no raw stack traces —
    // everything goes through the top notice.
    window.addEventListener('error', (ev) => {
      try { this.handleError(ev.error || ev.message, 'window'); } catch (e) { /* ignore */ }
    });
    window.addEventListener('unhandledrejection', (ev) => {
      try { this.handleError(ev.reason, 'promise'); } catch (e) { /* ignore */ }
    });
    // Session-timeout activity tracking: any input resets the countdown.
    ['pointerdown', 'keydown', 'wheel', 'input', 'touchstart'].forEach((evt) => {
      window.addEventListener(evt, () => this.resetIdleTimer(), { passive: true });
    });
    // Tell the user if the data file was recovered from a backup.
    if (DB.loadError) {
      setTimeout(() => this.notify(DB.recoveredFromBackup ? (DB.loadError || 'Data backup se wapas laya gaya hai — sab kuch mehfooz hai') : 'Issue — ' + DB.loadError, DB.recoveredFromBackup ? 'warning' : 'error'), 400);
    }
    // Splash: Sahara logo animation (~1.1s, click to skip), then the
    // login-selection screen. The splash never blocks login for long.
    this.showSplash();
  },

  showSplash() {
    const splash = document.getElementById('splash-screen');
    const login = document.getElementById('login-screen');
    if (!splash) { this.renderLogin(); return; }
    splash.hidden = false;
    splash.style.display = 'flex';
    if (login) login.style.display = 'none';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      splash.hidden = true;
      splash.style.display = 'none';
      this.renderLogin();
    };
    splash.addEventListener('click', finish, { once: true });
    setTimeout(finish, 1100);
  },

  save() { dbSave(); },

  /* ----- theme (black & white; dark mode = inverted) ----- */
  applyTheme() {
    document.body.setAttribute('data-theme', this.theme);
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.textContent = this.theme === 'dark' ? 'Light Theme' : 'Dark Theme';
    const loginToggle = document.getElementById('login-theme-toggle');
    if (loginToggle) loginToggle.textContent = this.theme === 'dark' ? 'Light Theme' : 'Dark Theme';
    const logoImg = document.getElementById('login-logo-img');
    if (logoImg) { logoImg.style.display = ''; }
    const headerImg = document.getElementById('header-logo-img');
    if (headerImg) { headerImg.style.display = ''; }
    this.renderSidebar();
  },
  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('sahara-theme', this.theme); } catch (e) { /* private mode */ }
    this.applyTheme();
    this.notify(this.theme === 'dark' ? 'Ho Gaya ✓ — Dark theme lag gaya' : 'Ho Gaya ✓ — Light theme lag gaya', 'success');
  },

  updateNetBadge() {
    const badge = document.getElementById('net-badge');
    if (!badge) return;
    const online = typeof navigator !== 'undefined' ? navigator.onLine : false;
    if (online) {
      badge.textContent = 'Online';
      badge.className = 'badge badge-online';
    } else {
      badge.textContent = 'Offline — Local';
      badge.className = 'badge badge-offline';
    }
  },

  /* ----- money / branches / stock ----- */
  money(n) {
    const v = Number(n) || 0;
    const formatted = Number.isInteger(v)
      ? v.toLocaleString('en-US')
      : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return 'Rs ' + formatted;
  },
  // A price that has not been entered yet prints as "—", never as 0
  // and never as an invented amount.
  moneyOrDash(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return this.money(n);
  },
  branchName(id) {
    // The Warehouse is a real location separate from the 3 branches:
    // its name is always "Warehouse", never a branch name.
    if (String(id) === 'warehouse') return 'Warehouse';
    const b = (this.state.branches || []).find((x) => String(x.id) === String(id));
    return b ? b.name : (id === null || id === undefined || id === '' ? '—' : String(id));
  },
  // Branch ids are numbers in DB; <select> values are strings. Normalise to
  // the branch's real id type so DB.stockOf's strict === lookup works.
  normBranchId(id) {
    if (id === null || id === undefined || id === '') return id;
    const b = (this.state.branches || []).find((x) => String(x.id) === String(id));
    return b ? b.id : id;
  },
  // The Warehouse/Godown is a REAL location, separate from the 3
  // branches (Branch 1, Branch 2, Branch 3) — DB.WAREHOUSE_ID
  // ('warehouse'). It is never a branch record, so it never appears
  // in the branch list or the header branch selector. Every screen
  // that needs godown stock calls this; nothing hard-codes a branch
  // id for the warehouse any more (v1.0.0/v2.0.0 used Branch 1 by
  // convention — that is gone; see the v201 migration in db.js).
  warehouseBranchId() {
    return (typeof DB !== 'undefined' && DB.WAREHOUSE_ID) ? DB.WAREHOUSE_ID : 'warehouse';
  },
  stockOf(product, branchId) {
    if (!product) return 0;
    try {
      if (DB.stockOf) return Number(DB.stockOf(product, branchId === undefined ? undefined : this.normBranchId(branchId))) || 0;
    } catch (e) { /* fall through to manual read */ }
    if (branchId === undefined || branchId === null) return Number(product.stock) || 0;
    const row = (product.branchStocks || []).find((b) => String(b.branchId) === String(branchId));
    return row ? Number(row.qty) || 0 : 0;
  },
  totalStock(product) {
    if (!product) return 0;
    try { if (DB.stockOf) return Number(DB.stockOf(product)) || 0; } catch (e) { /* fall through */ }
    return Number(product.stock) || 0;
  },
  setStock(product, branchId, qty) {
    const bid = this.normBranchId(branchId);
    try {
      if (DB.setStock) { DB.setStock(product, bid, qty); return; }
    } catch (e) { /* fall through */ }
    product.branchStocks = product.branchStocks || [];
    const row = product.branchStocks.find((b) => String(b.branchId) === String(bid));
    if (row) row.qty = Math.max(0, Number(qty) || 0);
    else product.branchStocks.push({ branchId: bid, qty: Math.max(0, Number(qty) || 0) });
    product.stock = product.branchStocks.reduce((a, b) => a + (Number(b.qty) || 0), 0);
  },
  adjustStock(product, branchId, delta, reason, ref, clientRef) {
    // v2.1.0 — Owner gate (Worker E §F): Owner stock change nahi kar
    // sakta — stock entry Warehouse ka kaam hai. Stock In/Out form
    // Owner ko dikhti hi nahi (stock.js), is liye ye check belt-and-
    // braces hai. EXCEPTION: 'Purchase — …' reason wali auto stock-in
    // — purchase khud Owner ka jaiz kaam hai (purchases.js:139) aur
    // usay rokne se purchase record ban jata magar stock nahi aata.
    // Transfer legs Manager karta hai (Owner ko form nahi milta).
    if (this.user && this.user.role === 'Owner' && String(reason || '').indexOf('Purchase —') !== 0) {
      this.notify('Issue — Owner stock change nahi kar sakta — stock entry Warehouse ka kaam hai', 'error');
      return this.stockOf(product, branchId);
    }
    const bid = this.normBranchId(branchId);
    const next = this.stockOf(product, bid) + Number(delta);
    this.setStock(product, bid, next);
    const movement = {
      productId: product.id, productName: product.name || '',
      branchId: bid, qty: Number(delta), reason: reason || 'Adjustment',
      user: this.user ? this.user.name : '', reference: ref || '',
      clientRef: clientRef || null,
    };
    try {
      if (DB.addMovement) DB.addMovement(movement);
      else throw new Error('no DB.addMovement');
    } catch (e) {
      (this.state.stockMovements = this.state.stockMovements || []).unshift(Object.assign(
        { id: Date.now(), date: new Date().toISOString() }, movement));
    }
    return next;
  },
  lowLimitFor(product) {
    try { if (DB.lowLimitFor) return DB.lowLimitFor(product); } catch (e) { /* fall through */ }
    if (!product) return null;
    if (product.lowThreshold != null && product.lowThreshold !== '') return Number(product.lowThreshold);
    const s = this.state.settings || {};
    if (s.defaultLowStockLimit != null && s.defaultLowStockLimit !== '') return Number(s.defaultLowStockLimit);
    return null;
  },
  isLowStock(product, branchId) {
    const lim = this.lowLimitFor(product);
    if (lim == null || isNaN(lim)) return false;
    return this.stockOf(product, branchId) <= lim;
  },
  lowStockProducts(branchId) {
    if (!this.state.settings || !this.state.settings.lowStockNotifications) return [];
    return (this.state.products || []).filter((p) => this.isLowStock(p, branchId));
  },

  /* ----- roles (v2.1.0) ----- */
  // Owner: sab kuch SIWA un screens ke jo us ke kaam ki nahi —
  // dashboard (Manager view), production, sale (Counter), recipes,
  // staff, sales-history, shifts, sales-summary, pos-dashboard,
  // khata, pos-settings. Owner ka ghar 'owner-dashboard' hai.
  // Counter Manager: sirf POS screens. Manager: godown daily ops +
  // recipes/expiry/suppliers/expenses; Reports/Logins/Settings
  // Owner-only; koi POS screen nahi, koi owner-dashboard nahi.
  isPosOnlyUser() {
    return !!(this.user && this.user.isPosOnly);
  },
  homeRoute() {
    if (!this.user) return 'dashboard';
    if (this.user.role === 'Owner') return 'owner-dashboard';
    if (this.isPosOnlyUser() || this.user.role === 'Counter Manager') return 'sale';
    return 'dashboard';
  },
  can(action) {
    if (!this.user) return false;
    const role = this.user.role;
    if (role === 'Owner') {
      return ['dashboard', 'production', 'sale', 'recipes', 'staff', 'sales-history', 'shifts', 'sales-summary', 'pos-dashboard', 'khata', 'pos-settings'].indexOf(action) === -1;
    }
    if (OWNER_ONLY.indexOf(action) !== -1) return false;
    if (action === 'theme') return true;
    if (role === 'Counter Manager' || this.user.isPosOnly) {
      return ['sale', 'sales-history', 'shifts', 'sales-summary', 'pos-dashboard', 'khata', 'pos-settings', 'staff'].indexOf(action) !== -1;
    }
    if (role === 'Manager') {
      return ['dashboard', 'products', 'raw', 'production', 'finished', 'warehouse', 'transfer', 'branches', 'billing', 'stockio', 'stock', 'purchases', 'recipes', 'expiry', 'suppliers', 'expenses'].indexOf(action) !== -1;
    }
    if (role === 'Warehouse Staff') {
      return ['dashboard', 'products', 'raw', 'production', 'finished', 'warehouse', 'transfer', 'branches', 'stockio', 'stock'].indexOf(action) !== -1;
    }
    if (role === 'Branch') {
      return ['dashboard', 'products', 'finished', 'stock'].indexOf(action) !== -1;
    }
    return false;
  },
  // Only the Owner (and Manager) can edit items; everyone else gets the
  // single "History" button on item cards instead of "Edit Item".
  canEditItems() {
    if (!this.user) return false;
    return this.user.role === 'Owner' || this.user.role === 'Manager';
  },
  currentBranchId() {
    const fallback = (this.state.settings && this.state.settings.defaultBranchId !== undefined && this.state.settings.defaultBranchId !== null)
      ? this.state.settings.defaultBranchId
      : (this.state.branches[0] && this.state.branches[0].id);
    if (!this.user) return this.normBranchId(fallback);
    if (this.user.role === 'Owner') {
      return this.normBranchId(this._branchId !== null && this._branchId !== undefined ? this._branchId : fallback);
    }
    return this.normBranchId(this.user.branchId !== null && this.user.branchId !== undefined ? this.user.branchId : fallback);
  },
  setBranch(id) { this._branchId = this.normBranchId(id); this.save(); this.renderHeader(); },

  /* ----- navigation ----- */
  go(screenName) {
    if (!this.user) { this.renderLogin(); return; }
    // v2.1.0 — POS-only shell: Counter Manager godown route khole to
    // sale par redirect (isPosOnly flag se, sirf role string se nahi).
    if (this.isPosOnlyUser() && POS_ROUTES.indexOf(screenName) === -1 && screenName !== 'theme') {
      if (screenName !== 'sale') this.notify('Issue — Counter par sirf Sale screen khulti hai', 'error');
      screenName = 'sale';
    }
    const nav = NAV.find((n) => n.id === screenName);
    if (nav && nav.action === 'theme') { this.toggleTheme(); return; }
    if (nav && !this.can(nav.action)) {
      this.notify('Issue — Is screen ki permission nahi hai', 'error');
      return;
    }
    this.currentScreen = screenName;
    this.renderSidebar();
    const container = document.getElementById('screen');
    if (!container) return;
    container.innerHTML = '';
    // SmartPOS breadcrumb: back to Dashboard + current screen name.
    const crumb = el('<div class="crumb"><button type="button" class="crumb-home" id="crumb-home">← Sahara Bakers</button><span class="crumb-sep">›</span><span class="crumb-here">' + esc(nav ? nav.label : screenName) + '</span></div>');
    container.appendChild(crumb);
    if (SCREEN_SUBS[screenName]) container.appendChild(el('<div class="screen-sub">' + esc(SCREEN_SUBS[screenName]) + '</div>'));
    crumb.querySelector('#crumb-home').addEventListener('click', () => this.go(this.homeRoute()));
    const content = el('<div class="screen-content"></div>');
    container.appendChild(content);
    const fn = window.Screens[screenName];
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (typeof fn === 'function') {
      try { fn(content); }
      catch (e) {
        content.innerHTML = '';
        this.handleError(e, 'screen:' + screenName);
        content.appendChild(el('<div class="card"><h2>Masla</h2><p>Screen load nahi ho saki — dobara koshish karein ya app band kar ke kholein.</p></div>'));
      }
    } else {
      content.appendChild(el(
        '<div class="card"><h2>' + esc(nav ? nav.label : screenName) + '</h2>' +
        '<p class="muted">Ye screen abhi tayyar ho raha hai. Baraye meharbani thodi der baad dobara koshish karein.</p></div>'
      ));
    }
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.perf.lastSwitchMs = Math.round((t1 - t0) * 10) / 10;
    this.perf.switches.push({ screen: screenName, ms: this.perf.lastSwitchMs });
    if (this.perf.switches.length > 50) this.perf.switches.shift();
    window.scrollTo(0, 0);
    const sc = document.getElementById('screen');
    if (sc) sc.scrollTop = 0;
  },

  /* ----- product detail / manage screen ----- */
  // The product's OWN detail screen (opened by clicking a card/row on
  // a listing). Edit, Delete and stock correction live HERE — never on
  // the main listing screens. Non-editors see details + history only.
  showProductDetail(product, opts) {
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl || !product) return;
    opts = opts || {};
    const canEdit = this.canEditItems();
    const warehouseId = this.warehouseBranchId();
    titleEl.textContent = 'Product Details — ' + (product.name || '');
    bodyEl.innerHTML = '';
    const photo = product.image
      ? '<img class="detail-photo" src="' + esc(product.image) + '" alt="' + esc(product.name) + '" onerror="this.style.display=\'none\'">'
      : '<div class="detail-photo detail-photo-ph">' + esc(String(product.name || '').slice(0, 12)) + '</div>';
    bodyEl.appendChild(el('<div>' + photo + '</div>'));
    bodyEl.appendChild(el('<h2 style="margin-top:12px">' + esc(product.name || '') + '</h2>'));
    bodyEl.appendChild(el('<p class="muted">' + esc(product.category || '') + ' · ' + (product.type === 'raw' ? 'Raw Material' : 'Finish Goods') + ' · ' + esc(product.unit || '') + '</p>'));
    const infoRows = [
      ['Sale Price', this.moneyOrDash(product.price)],
    ];
    // v2.1.0 — Cost row gating (Worker E §E): Purchase Price / Cost
    // sirf tab dikhe jab DB.canSeeCost(user) true ho (Owner hamesha;
    // Manager sirf jab settings.managerCanSeeCost ON ho). Fallback:
    // DB.canSeeCost na ho to sirf Owner ko dikhe.
    const canSeeCost = (typeof DB !== 'undefined' && DB.canSeeCost) ? DB.canSeeCost(this.user) : !!(this.user && this.user.role === 'Owner');
    if (canSeeCost) infoRows.push(['Purchase Price / Cost', this.moneyOrDash(product.purchasePrice)]);
    infoRows.push(
      ['Details', product.details || '—'],
      ['Low Stock Limit', product.lowThreshold == null ? '—' : String(product.lowThreshold)],
      ['SKU', product.sku || '—'],
      ['Barcode', product.barcode || '—'],
    );
    const infoRowsHtml = infoRows.map((kv) => '<tr><td><b>' + esc(kv[0]) + '</b></td><td>' + esc(kv[1]) + '</td></tr>').join('');
    bodyEl.appendChild(el('<div class="table-wrap"><table><tbody>' + infoRowsHtml + '</tbody></table></div>'));
    // Stock per location.
    const locs = [{ id: warehouseId, name: 'Warehouse (Godown)' }].concat((this.state.branches || []).map((b) => ({ id: b.id, name: b.name })));
    const stockRows = locs.map((loc) => {
      const qty = this.stockOf(product, loc.id);
      const low = this.isLowStock(product, loc.id);
      return '<tr><td>' + esc(loc.name) + '</td><td><b>' + qty + '</b> ' + esc(product.unit || '') + (low ? ' <span class="low-tag">Kam Stock</span>' : '') + '</td></tr>';
    }).join('');
    bodyEl.appendChild(el('<h3 style="margin-top:14px">Stock — Godown aur Branches</h3>'));
    bodyEl.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Jagah</th><th>Stock</th></tr></thead><tbody>' + stockRows + '<tr><td><b>Total Stock</b></td><td><b>' + this.totalStock(product) + '</b> ' + esc(product.unit || '') + '</td></tr></tbody></table></div>'));
    // Production history (finish items only).
    if (product.type === 'finished') {
      const prods = (this.state.productions || []).filter((pr) => String(pr.finishProductId) === String(product.id)).slice(0, 5);
      if (prods.length > 0) {
        // Production History ki Total Cost bhi cost hai — canSeeCost
        // false ho to '—' dikhe (Purchase Price row wali hi gating).
        const rows = prods.map((pr) => '<tr><td><b>' + esc(pr.billNo || '') + '</b></td><td><b>' + pr.finishQty + ' ' + esc(pr.finishUnit || '') + '</b></td><td>' + esc(canSeeCost ? this.money(pr.totalCost) : '—') + '</td><td class="muted">' + esc(String(pr.date || '').slice(0, 16).replace('T', ' ')) + '</td></tr>').join('');
        bodyEl.appendChild(el('<h3 style="margin-top:14px">Production History</h3>'));
        bodyEl.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Bill</th><th>Produced</th><th>Total Cost</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
      }
    }
    // Stock history (latest 8).
    const moves = (this.state.stockMovements || []).filter((m) => String(m.productId) === String(product.id)).slice(0, 8);
    bodyEl.appendChild(el('<h3 style="margin-top:14px">Stock History</h3>'));
    if (moves.length === 0) bodyEl.appendChild(el('<p class="muted">Is item ki koi stock movement abhi tak nahi hai.</p>'));
    else {
      const rows = moves.map((m) => {
        const q = Number(m.qty) || 0;
        return '<tr><td>' + (q > 0 ? 'Aaya' : 'Gaya') + '</td><td><b>' + Math.abs(q) + '</b></td><td>' + esc(this.branchName(m.branchId)) + '</td><td>' + esc(m.reason || '') + '</td><td class="muted">' + esc(String(m.date || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
      }).join('');
      bodyEl.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Type</th><th>Miqdaar</th><th>Branch</th><th>Wajah</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
    // Actions: Edit / Delete live here (editors only); Close for everyone.
    const actions = el('<div class="form-actions"></div>');
    if (canEdit && typeof opts.onEdit === 'function') {
      const editBtn = el('<button type="button" class="btn btn-primary" id="detail-edit-btn">Edit</button>');
      editBtn.addEventListener('click', () => { try { opts.onEdit(product); } catch (e) { this.handleError(e, 'detail-edit'); } });
      actions.appendChild(editBtn);
      const delBtn = el('<button type="button" class="btn btn-danger" id="detail-delete-btn">Delete</button>');
      delBtn.addEventListener('click', async () => {
        const ok = await this.confirmDialog('Product Delete Karein?', '"' + (product.name || '') + '" delete kar diya jayega. Ye wapas nahi aayega.');
        if (!ok) return;
        const idx = (this.state.products || []).findIndex((x) => String(x.id) === String(product.id));
        if (idx !== -1) this.state.products.splice(idx, 1);
        this.save();
        this.notify('Ho Gaya ✓ — Product delete ho gaya: ' + (product.name || ''), 'success');
        const ov = document.getElementById('item-form-overlay');
        if (ov) { ov.hidden = true; ov.style.display = 'none'; }
        this.go(this.currentScreen || 'products');
      });
      actions.appendChild(delBtn);
    }
    const closeBtn = el('<button type="button" class="btn" id="detail-close-btn">Close</button>');
    closeBtn.addEventListener('click', () => { const ov = document.getElementById('item-form-overlay'); if (ov) { ov.hidden = true; ov.style.display = 'none'; } });
    actions.appendChild(closeBtn);
    bodyEl.appendChild(actions);
    overlay.hidden = false;
    overlay.style.display = 'flex';
  },

  renderHeader() {
    const sel = document.getElementById('branch-select');
    if (sel) {
      const cur = this.currentBranchId();
      // Non-Owners are locked to their own branch — and the dropdown
      // only ever lists that one branch, so other branches are not
      // even visible as options.
      const visibleBranches = (this.user && this.user.role === 'Owner')
        ? (this.state.branches || [])
        : (this.state.branches || []).filter((b) => String(b.id) === String(cur));
      sel.innerHTML = visibleBranches.map((b) =>
        '<option value="' + esc(b.id) + '"' + (String(b.id) === String(cur) ? ' selected' : '') + '>' + esc(b.name) + '</option>'
      ).join('');
      sel.disabled = !(this.user && this.user.role === 'Owner');
    }
    const chip = document.getElementById('user-chip');
    if (chip && this.user) chip.textContent = this.user.name + ' (' + this.user.role + ')';
  },

  renderSidebar() {
    const nav = document.getElementById('sidebar');
    if (!nav) return;
    nav.innerHTML = '';
    // v2.1.0 — POS-only shell: the sidebar renders for the Counter
    // Manager too, but App.can() filters it to ONLY the POS screens
    // (sale, sales-history, shifts, sales-summary, pos-dashboard,
    // khata, staff, pos-settings) — no godown item ever renders.
    // The sidebar is NOT removed outright: no POS screen links to
    // Khata / Sale History / Summary / POS Dashboard / Staff, so
    // hiding the whole sidebar would make 6 of the 8 POS screens
    // unreachable. The header is reduced to name + logout by CSS.
    // Brand at the top of the sidebar (SmartPOS layout).
    nav.appendChild(el('<div class="sidebar-brand"><img src="assets/sahara-logo.png" alt="Sahara Bakers logo" onerror="this.style.display=\'none\'"><div><div class="sidebar-brand-name">SAHARA BAKERS</div><div class="sidebar-brand-sub">Godown Stock</div></div></div>'));
    let currentSection = null;
    const addSectionLabel = (label) => {
      nav.appendChild(el('<div class="sidebar-section-label">' + esc(label) + '</div>'));
    };
    // v2.1.0 — 'pos' section ka label 'POS' hai (pehle har
    // non-'other' section 'Main' likha jata tha).
    const sectionLabel = (section) => (section === 'other' ? 'Other' : (section === 'pos' ? 'POS' : 'Main'));
    NAV.forEach((item) => {
      // The theme toggle is a sidebar action, not a screen — it shows
      // for every logged-in user.
      if (item.action === 'theme') {
        if (currentSection !== 'other') { addSectionLabel('Other'); currentSection = 'other'; }
        const label = this.theme === 'dark' ? 'Light Theme' : 'Dark Theme';
        const btn = el('<button type="button" class="nav-item"><span class="nav-label">' + esc(label) + '</span></button>');
        btn.addEventListener('click', () => this.toggleTheme());
        nav.appendChild(btn);
        return;
      }
      if (!this.user) return;
      if (!this.can(item.action)) return; // hide nav items the role cannot use
      const section = item.section || 'main';
      if (section !== currentSection) { addSectionLabel(sectionLabel(section)); currentSection = section; }
      const btn = el('<button type="button" class="nav-item' + (this.currentScreen === item.id ? ' active' : '') + '"><span class="nav-label">' + esc(item.label) + '</span>' + (item.sub ? '<span class="nav-sub">' + esc(item.sub) + '</span>' : '') + '</button>');
      btn.addEventListener('click', () => this.go(item.id));
      nav.appendChild(btn);
    });
    // User block at the bottom of the sidebar (SmartPOS layout).
    if (this.user) {
      const initials = String(this.user.name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      nav.appendChild(el('<div class="sidebar-user"><div class="sidebar-user-avatar">' + esc(initials) + '</div><div><div class="sidebar-user-name">' + esc(this.user.name) + '</div><div class="sidebar-user-role">' + esc(this.user.role) + '</div></div></div>'));
    }
  },

  showShell(show) {
    const shell = document.getElementById('app-shell');
    const login = document.getElementById('login-screen');
    if (shell) shell.hidden = !show;
    if (login) login.style.display = show ? 'none' : 'flex';
  },

  /* ----- login / owner setup / logout ----- */
  // v2.0.0 login: splash, then login-selection cards — Owner Rahmanullah
  // (PIN 1234, seeded hashed) and Manager (PIN 123). Each card opens
  // its own PIN page. 5 wrong PINs = 15-minute lockout, persisted per
  // user, with a clear notice stating the lockout.
  renderLogin() {
    this.showShell(false);
    const body = document.getElementById('login-body');
    if (!body) return;
    body.innerHTML = '';
    const loginCard = document.querySelector('.login-card');
    const allUsers = (this.state.appUsers || []).filter((u) => u.isActive !== false && u.active !== false);
    if (allUsers.length === 0) {
      // No logins at all: the Owner Setup form (logo + ⋮ menu visible).
      if (loginCard) loginCard.classList.remove('select-mode');
      body.appendChild(this.ownerSetupForm());
      return;
    }
    // ---- Step 1: login-selection screen — ONLY two buttons ----
    // Owner (PIN 1234) and Manager (PIN 123), in beautiful elegant
    // fonts. Nothing else on this screen: no logo, no heading, no
    // extra text, no menu (the logo already showed in the splash
    // animation; the ⋮ menu with theme + restore lives on the PIN
    // page instead). Each button opens its own PIN page; the correct
    // PIN opens that role's dashboard. 5 wrong PINs = 15-minute
    // lockout, persisted per user, exactly as before.
    if (loginCard) loginCard.classList.add('select-mode');
    const cards = el('<div class="login-cards" id="login-cards"></div>');
    allUsers.forEach((u) => {
      // v2.1.0 — card par display name (user.name) bara aur role
      // chhota: Owner "Rahmanullah", Manager "Warehouse", Counter
      // Manager "Counter Manager". Username data-attribute mein rehta
      // hai (lockout username-keyed hai — username kabhi mat badlo).
      const card = el('<button type="button" class="btn login-role-card" data-username="' + esc(u.username || '') + '">' +
        '<span class="login-role-name">' + esc(u.name || u.role) + '</span>' +
        '<span class="login-role-sub">' + esc(u.role) + '</span></button>');
      card.addEventListener('click', () => this.renderPinPage(u));
      cards.appendChild(card);
    });
    body.appendChild(cards);
    // After a session lock, the same user's PIN page opens straight
    // away, so the PIN is all they need to get back to work.
    if (this._lockedUser) {
      const lu = allUsers.find((u) => String(u.id) === String(this._lockedUser.id));
      if (lu) { this.renderPinPage(lu); return; }
    }
    if (this._selectedLoginUser) {
      const su = allUsers.find((u) => String(u.id) === String(this._selectedLoginUser.id));
      if (su) { this.renderPinPage(su); return; }
    }
  },

  // ---- Step 2: PIN page for ONE selected user ----
  renderPinPage(u) {
    this.showShell(false);
    // The PIN page is not the selection screen: logo + ⋮ menu (theme
    // toggle + one-click restore) are visible again here.
    const loginCard = document.querySelector('.login-card');
    if (loginCard) loginCard.classList.remove('select-mode');
    const body = document.getElementById('login-body');
    if (!body) return;
    this._selectedLoginUser = u;
    body.innerHTML = '';
    const wrap = el('<div></div>');
    wrap.appendChild(el('<button type="button" class="btn btn-ghost btn-sm" id="login-back-btn">← Back</button>'));
    wrap.appendChild(el('<h3 style="text-align:left">Enter PIN</h3>'));
    wrap.appendChild(el('<p class="muted" style="text-align:left"><b>' + esc(u.name) + '</b> (' + esc(u.role) + ') — apna PIN dalein.</p>'));
    const lockMsg = el('<p class="muted" style="text-align:left" id="login-lock-msg"></p>');
    const showLockMsg = () => {
      if (!DB.isLoginLocked) { lockMsg.textContent = ''; return; }
      try {
        const lock = DB.isLoginLocked(u.username);
        lockMsg.textContent = lock.locked
          ? ('Ye login lock hai — ' + lock.remainingMinutes + ' minute baad dobara koshish karein.')
          : '';
      } catch (e) { lockMsg.textContent = ''; }
    };
    const form = el('<form></form>');
    const pinInput = el('<input class="input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="PIN" required>');
    form.appendChild(el('<label>PIN</label>'));
    form.appendChild(pinInput);
    form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Login</button></div>'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pin = pinInput.value.trim();
      if (pin.length < 3) { this.notify('Issue — PIN kam az kam 3 digit ka hona chahiye', 'error'); return; }
      // PIN brute-force protection: 5 ghalat PIN ke baad ye login 15
      // minute ke liye lock ho jata hai. Lock data file me save hota
      // hai, is liye app band kar ke kholne se reset nahi hota — sirf
      // waqt guzarne se khulta hai.
      if (DB.isLoginLocked) {
        let lock = null;
        try { lock = DB.isLoginLocked(u.username); } catch (e) { lock = null; }
        if (lock && lock.locked) {
          this.notify('Issue — Ye login lock hai — ' + lock.remainingMinutes + ' minute baad dobara koshish karein', 'error');
          pinInput.value = '';
          showLockMsg();
          return;
        }
      }
      // PINs are stored hashed only (DB.hashPin / DB.checkPin).
      let ok = false;
      try { ok = DB.checkPin ? DB.checkPin(u, pin) : false; } catch (e) { ok = false; }
      if (ok) {
        if (DB.recordSuccessfulLogin) { try { DB.recordSuccessfulLogin(u.username); } catch (e) {} }
        this.login(u);
      } else {
        let lockedNow = false;
        if (DB.recordFailedLogin) { try { const r = DB.recordFailedLogin(u.username); lockedNow = !!(r && r.locked); } catch (e) {} }
        if (lockedNow) this.notify('Issue — 5 ghalat PIN — ye login 15 minute ke liye lock ho gaya hai', 'error');
        else this.notify('Issue — PIN ghalat hai', 'error');
        pinInput.value = '';
        pinInput.focus();
        showLockMsg();
      }
    });
    wrap.appendChild(form);
    wrap.appendChild(lockMsg);
    body.appendChild(wrap);
    wrap.querySelector('#login-back-btn').addEventListener('click', () => {
      this._selectedLoginUser = null;
      this.renderLogin();
    });
    showLockMsg();
    try { pinInput.focus(); } catch (e) { /* ignore */ }
  },

  // One-click restore from the login screen — no login needed, for the
  // case where the data is gone and there are no logins at all.
  // Restores the newest GOOD backup (never the newest empty one) and
  // re-renders the login screen so the logins come back.
  restoreFromLogin() {
    let res = { ok: false, message: 'Restore available nahi hai' };
    try { res = DB.restoreLatestBackup ? DB.restoreLatestBackup() : res; } catch (e) { res = { ok: false, message: e && e.message ? e.message : 'Restore nahi ho saka' }; }
    if (res.ok) {
      this.state = DB.state;
      this._selectedLoginUser = null;
      this._lockedUser = null;
      this.notify('Ho Gaya ✓ — Backup se data wapas aa gaya — Items ' + res.products + ', Logins ' + res.logins, 'success');
      this.renderLogin();
    } else {
      this.notify('Issue — ' + (res.message || 'Restore nahi ho saka'), 'error');
    }
  },

  ownerSetupForm() {
    const wrap = el('<div></div>');
    wrap.appendChild(el('<h3 style="text-align:left">Owner Setup</h3>'));
    wrap.appendChild(el('<p class="muted" style="text-align:left">Pehli dafa setup: Owner ka naam, username aur 3–8 digit ka PIN banayein. Koi default PIN nahi hai.</p>'));
    const form = el('<form></form>');
    const nameIn = el('<input class="input" type="text" required placeholder="Owner ka naam">');
    const userIn = el('<input class="input" type="text" required placeholder="Username">');
    const pinIn = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="PIN (3–8 digits)">');
    const pin2In = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="PIN dobara likhein">');
    form.appendChild(el('<label>Name</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Username</label>')); form.appendChild(userIn);
    form.appendChild(el('<label>PIN (3–8 digits)</label>')); form.appendChild(pinIn);
    form.appendChild(el('<label>Confirm PIN</label>')); form.appendChild(pin2In);
    form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Create Owner Account</button></div>'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      const username = userIn.value.trim();
      const pin = pinIn.value.trim();
      const pin2 = pin2In.value.trim();
      if (!name || !username) { this.notify('Issue — Naam aur username zaroori hain', 'error'); return; }
      if (!/^\d{3,8}$/.test(pin)) { this.notify('Issue — PIN sirf 3–8 digit ka hona chahiye', 'error'); return; }
      if (pin !== pin2) { this.notify('Issue — Dono PIN match nahi karte', 'error'); return; }
      if (DB.checkUniqueness) {
        const chk = DB.checkUniqueness('appUsers', { username }, null);
        if (!chk.ok) { this.notify('Issue — ' + chk.message, 'error'); return; }
      } else if ((this.state.appUsers || []).some((u) => String(u.username).toLowerCase() === username.toLowerCase())) {
        this.notify('Issue — Ye username pehle se mojood hai', 'error'); return;
      }
      const owner = {
        id: (DB.nextId ? DB.nextId('appUsers') : ((this.state.appUsers || []).length + 1)),
        name, username,
        pinHash: (DB.hashPin ? DB.hashPin(pin) : pin),
        role: 'Owner', branchId: null, branchName: null, isActive: true,
      };
      this.state.appUsers.push(owner);
      dbSave();
      this.notify('Ho Gaya ✓ — Owner account ban gaya', 'success');
      this.login(owner);
    });
    wrap.appendChild(form);
    return wrap;
  },

  login(user) {
    this.user = user;
    this._lockedUser = null;
    this._branchId = user.role === 'Owner' ? (this.state.settings.defaultBranchId || null) : (user.branchId || null);
    this._selectedLoginUser = null;
    // v2.1.0 — POS-only shell: Counter Manager ke liye body par
    // 'pos-only' class — CSS header controls chhupata hai (sirf naam
    // + logout wali top bar rehti hai); sidebar mein sirf POS
    // screens aate hain (renderSidebar + can() filter).
    try { document.body.classList.toggle('pos-only', this.isPosOnlyUser()); } catch (e) { /* ignore */ }
    this.showShell(true);
    this.renderHeader();
    this.renderSidebar();
    this.notify('Ho Gaya ✓ — Welcome, ' + user.name, 'success');
    this.startIdleTimer();
    // Reliable backup: once a day, right after login, take a verified
    // auto-backup. Failures are reported, never silent.
    try {
      if (DB.backupInfo) {
        const info = DB.backupInfo();
        const today = new Date().toISOString().slice(0, 10);
        if (!info.lastBackup || String(info.lastBackup).slice(0, 10) !== today) {
          const res = DB.backup ? DB.backup() : { ok: false };
          if (!res.ok) this.notify('Issue — Aaj ka auto-backup nahi ban saka — Settings > Backup se dobara koshish karein', 'error');
        }
      }
    } catch (e) { /* backup failure must never block login */ }
    // v2.1.0 — Login redirect: Owner → owner-dashboard, Counter
    // Manager / POS-only → seedha dark Sale screen, baqi → dashboard.
    this.go(this.homeRoute());
  },

  logout() {
    this.stopIdleTimer();
    this._lockedUser = null;
    this.user = null;
    this.currentScreen = null;
    try { document.body.classList.remove('pos-only'); } catch (e) { /* ignore */ }
    const container = document.getElementById('screen');
    if (container) container.innerHTML = '';
    this.renderLogin();
  },

  /* ----- notices: 5s auto-dismiss with countdown line + X ----- */
  // Success = black "Ho Gaya ✓" notice; issue = white notice with a
  // thick black border starting "Issue — …". EVERY notice carries a
  // 5-second countdown line at its bottom that drains over 5s and then
  // the notice auto-dismisses; × closes it early.
  notify(msg, type, action) {
    const t = type || 'info';
    const stack = document.getElementById('notice-stack');
    if (!stack) return;
    const n = el('<div class="notice notice-' + esc(t) + '">' + esc(msg) +
      '<button type="button" class="notice-x" aria-label="Close">×</button>' +
      '<span class="notice-bar"></span></div>');
    const dismiss = () => { if (n.parentNode) n.parentNode.removeChild(n); };
    n.querySelector('.notice-x').addEventListener('click', dismiss);
    if (action && action.label && typeof action.onClick === 'function') {
      const b = el('<button type="button" class="btn btn-primary" style="margin-left:8px;padding:4px 10px">' + esc(action.label) + '</button>');
      b.addEventListener('click', () => { dismiss(); try { action.onClick(); } catch (e) { /* ignore */ } });
      n.insertBefore(b, n.querySelector('.notice-x'));
    }
    stack.appendChild(n);
    setTimeout(dismiss, 5000);
  },

  /* ----- bill preview / measured-height thermal print (80mm) ----- */
  // The bill is shown first in a modal rendering the SAME html that
  // printing uses, so preview and printed bill always match.
  showBillPreviewHtml(html, printFn) {
    const overlay = document.getElementById('bill-preview-overlay');
    const bodyEl = document.getElementById('bill-preview-body');
    const printBtn = document.getElementById('bill-preview-print');
    const pdfBtn = document.getElementById('bill-preview-pdf');
    const closeBtn = document.getElementById('bill-preview-close');
    const xBtn = document.getElementById('bill-preview-x');
    if (!overlay || !bodyEl) return false;
    bodyEl.innerHTML = html;
    overlay.hidden = false;
    overlay.style.display = 'flex';
    const close = () => { overlay.hidden = true; overlay.style.display = 'none'; };
    if (xBtn) xBtn.onclick = close;
    if (closeBtn) closeBtn.onclick = close;
    if (pdfBtn) {
      pdfBtn.onclick = () => {
        // PDF save: the browser print dialog lets the user choose
        // "Save as PDF" — the 80mm @page rule prints only the bill.
        const area = document.getElementById('receipt-print');
        if (area) area.innerHTML = html;
        try { window.print(); } catch (e) { /* ignore */ }
        this.notify('Print dialog khul gaya — PDF save karne ke liye "Save as PDF" chunein', 'info');
      };
    }
    if (printBtn) {
      printBtn.onclick = async () => {
        let ok = false;
        try { ok = await printFn(); } catch (e) { ok = false; }
        if (ok) { close(); this.notify('Ho Gaya ✓ — Bill print ho gaya', 'success'); }
        else this.notify('Issue — Print nahi ho saka — printer check karein ya dialog se print karein', 'error');
      };
    }
    return true;
  },
  // Measure the rendered bill height, then print silently at exactly
  // that height (80mm wide). Falls back to the print dialog when no
  // printer is set, no IPC is available, or the silent print fails —
  // except a 12-second timeout, where the silent job may still come
  // out, so the dialog is deliberately NOT opened (the bill would
  // print twice).
  measureReceiptHeightPx(html) {
    const area = document.getElementById('receipt-print');
    if (!area) return 0;
    area.innerHTML = html;
    area.style.display = 'block';
    area.style.visibility = 'hidden';
    area.style.position = 'absolute';
    area.style.left = '-9999px';
    area.style.width = '80mm';
    const h = area.getBoundingClientRect().height;
    area.style.display = 'none';
    area.style.visibility = '';
    area.style.position = '';
    area.style.left = '';
    area.innerHTML = '';
    return h;
  },
  async printReceiptHtml(html) {
    const heightPx = this.measureReceiptHeightPx(html);
    if (!heightPx || heightPx <= 0) return false;
    // px → microns, +6mm trailing feed for the cutter.
    const heightMicrons = Math.round((heightPx * 25.4 / 96 + 6) * 1000);
    let ipc = null;
    try { ipc = require('electron').ipcRenderer; } catch (e) { ipc = null; }
    if (ipc) {
      const t0 = Date.now();
      try {
        const printerName = (this.state.settings && this.state.settings.printerName) || '';
        const res = await Promise.race([
          ipc.invoke('print-receipt', { heightMicrons, deviceName: printerName }),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 12000))
        ]);
        if (res && res.ok) return true;
        if (res && res.error === 'timeout') return false; // may still print — do not re-print
        if (res && res.error === 'no-printer') {
          // No printer chosen — fall through to the dialog below.
        } else {
          return false;
        }
      } catch (e) {
        // IPC failed — fall through to the dialog.
        if (Date.now() - t0 >= 12000) return false;
      }
    }
    // Fallback: browser print dialog (80mm @page in styles.css).
    const area = document.getElementById('receipt-print');
    if (area) area.innerHTML = html;
    try { window.print(); } catch (e) { return false; }
    return true;
  },
  async printerList() {
    try {
      const ipc = require('electron').ipcRenderer;
      const list = await ipc.invoke('printer-list');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  },

  /* ----- in-app confirm dialog (replaces window.confirm) ----- */
  confirmDialog(title, text) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('confirm-overlay');
      const tEl = document.getElementById('confirm-title');
      const xEl = document.getElementById('confirm-text');
      const yesBtn = document.getElementById('confirm-yes');
      const noBtn = document.getElementById('confirm-no');
      if (!overlay) { resolve(window.confirm(text || title)); return; }
      tEl.textContent = title || 'Confirm';
      xEl.textContent = text || '';
      overlay.hidden = false;
      overlay.style.display = 'flex';
      const done = (v) => {
        overlay.hidden = true;
        overlay.style.display = 'none';
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
        resolve(v);
      };
      const onYes = () => done(true);
      const onNo = () => done(false);
      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
    });
  },
};

window.App = App;
window.esc = esc;
window.el = el;
