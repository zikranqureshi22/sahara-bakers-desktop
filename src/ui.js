/* Sahara Bakers — renderer core (v1.0.0).
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
 *                      branch 1 = the central godown (Warehouse)
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
  if (s.branches.length === 0) s.branches.push({ id: 1, name: 'Warehouse (Godown)', address: '' });
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
// Roles: Owner (Rahmanullah), Manager, Warehouse Staff, Branch.
// Owner can do everything. Manager: everything except logins/settings.
// Warehouse Staff: dashboard, items, stock in/out, stock, branches
// (transfers). Branch: own branch stock + items view only.
const OWNER_ONLY = ['logins', 'settings'];
const NAV = [
  { id: 'dashboard', label: 'Dashboard', action: 'dashboard' },
  { id: 'items', label: 'Items', action: 'items' },
  { id: 'theme', label: 'Dark Theme', action: 'theme' },
  { id: 'logins', label: 'Logins', action: 'logins' },
  { id: 'settings', label: 'Settings', action: 'settings' },
  { id: 'branches', label: 'Branches', action: 'branches' },
  { id: 'stockio', label: 'Stock In/Out', action: 'stockio' },
  { id: 'stock', label: 'Stock', action: 'stock' },
  { id: 'purchases', label: 'Purchases', action: 'purchases' },
];

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
    this.renderLogin();
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
  // Branch 1 is the central godown (Warehouse). Transfers always start
  // here unless the Owner picks another source branch.
  warehouseBranchId() {
    const bs = this.state.branches || [];
    const b1 = bs.find((b) => String(b.id) === '1');
    return b1 ? b1.id : (bs[0] && bs[0].id);
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
  adjustStock(product, branchId, delta, reason, ref) {
    const bid = this.normBranchId(branchId);
    const next = this.stockOf(product, bid) + Number(delta);
    this.setStock(product, bid, next);
    const movement = {
      productId: product.id, productName: product.name || '',
      branchId: bid, qty: Number(delta), reason: reason || 'Adjustment',
      user: this.user ? this.user.name : '', reference: ref || '',
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

  /* ----- roles ----- */
  can(action) {
    if (!this.user) return false;
    const role = this.user.role;
    if (role === 'Owner') return true;
    if (OWNER_ONLY.indexOf(action) !== -1) return false;
    if (action === 'theme') return true;
    if (role === 'Manager') {
      return ['dashboard', 'items', 'branches', 'stockio', 'stock', 'purchases'].indexOf(action) !== -1;
    }
    if (role === 'Warehouse Staff') {
      return ['dashboard', 'items', 'branches', 'stockio', 'stock'].indexOf(action) !== -1;
    }
    if (role === 'Branch') {
      return ['dashboard', 'items', 'stock'].indexOf(action) !== -1;
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
    const fn = window.Screens[screenName];
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (typeof fn === 'function') {
      try { fn(container); }
      catch (e) {
        container.innerHTML = '';
        this.handleError(e, 'screen:' + screenName);
        container.appendChild(el('<div class="card"><h2>Masla</h2><p>Screen load nahi ho saki — dobara koshish karein ya app band kar ke kholein.</p></div>'));
      }
    } else {
      container.appendChild(el(
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
    NAV.forEach((item) => {
      // The theme toggle is a sidebar action, not a screen — it shows
      // for every logged-in user.
      if (item.action === 'theme') {
        const label = this.theme === 'dark' ? 'Light Theme' : 'Dark Theme';
        const btn = el('<button type="button" class="nav-item">' + esc(label) + '</button>');
        btn.addEventListener('click', () => this.toggleTheme());
        nav.appendChild(btn);
        return;
      }
      if (!this.user) return;
      if (!this.can(item.action)) return; // hide nav items the role cannot use
      const btn = el('<button type="button" class="nav-item' + (this.currentScreen === item.id ? ' active' : '') + '">' + esc(item.label) + '</button>');
      btn.addEventListener('click', () => this.go(item.id));
      nav.appendChild(btn);
    });
  },

  showShell(show) {
    const shell = document.getElementById('app-shell');
    const login = document.getElementById('login-screen');
    if (shell) shell.hidden = !show;
    if (login) login.style.display = show ? 'none' : 'flex';
  },

  /* ----- login / owner setup / logout ----- */
  // PIN login: the app opens to this screen. Owner Rahmanullah's entry
  // PIN is 3333 (seeded hashed). 5 wrong PINs = 15-minute lockout,
  // persisted per user, with a clear notice stating the lockout.
  renderLogin() {
    this.showShell(false);
    const body = document.getElementById('login-body');
    if (!body) return;
    body.innerHTML = '';
    const allUsers = (this.state.appUsers || []).filter((u) => u.isActive !== false && u.active !== false);
    if (allUsers.length === 0) {
      body.appendChild(this.ownerSetupForm());
      return;
    }
    const wrap = el('<div></div>');
    wrap.appendChild(el('<h3 style="text-align:left">Login Karein</h3>'));
    wrap.appendChild(el('<p class="muted" style="text-align:left">Apna naam chunein aur PIN dalein.</p>'));
    const lockMsg = el('<p class="muted" style="text-align:left"></p>');
    const showLockMsg = () => {
      const u = this._selectedLoginUser;
      if (!u || !DB.isLoginLocked) { lockMsg.textContent = ''; return; }
      try {
        const lock = DB.isLoginLocked(u.username);
        lockMsg.textContent = lock.locked
          ? ('Ye login lock hai — ' + lock.remainingMinutes + ' minute baad dobara koshish karein.')
          : '';
      } catch (e) { lockMsg.textContent = ''; }
    };
    const list = el('<div class="login-user-list"></div>');
    allUsers.forEach((u) => {
      const b = el('<button type="button" class="btn login-user-btn">' + esc(u.name) + ' <span class="muted">(' + esc(u.role) + ')</span></button>');
      b.addEventListener('click', () => {
        this._selectedLoginUser = u;
        list.querySelectorAll('.login-user-btn').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        showLockMsg();
        pinInput.focus();
      });
      list.appendChild(b);
      // After a session lock, the same user is pre-selected so the PIN
      // is all they need to get back to work.
      if (this._lockedUser && String(this._lockedUser.id) === String(u.id)) {
        this._selectedLoginUser = u;
        b.classList.add('selected');
      }
    });
    wrap.appendChild(list);
    const form = el('<form></form>');
    const pinInput = el('<input class="input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="PIN" required>');
    const pinLabel = el('<label>PIN (4–8 digit)</label>');
    form.appendChild(pinLabel);
    form.appendChild(pinInput);
    form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Login Karein</button></div>'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pin = pinInput.value.trim();
      const u = this._selectedLoginUser;
      if (!u) { this.notify('Issue — Pehle apna naam chunein', 'error'); return; }
      if (pin.length < 4) { this.notify('Issue — PIN kam az kam 4 digit ka hona chahiye', 'error'); return; }
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
    showLockMsg();
    // After a session lock, the PIN field is focused straight away.
    if (this._selectedLoginUser) { try { pinInput.focus(); } catch (e) { /* ignore */ } }
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
    wrap.appendChild(el('<p class="muted" style="text-align:left">Pehli dafa setup: Owner ka naam, username aur 4–8 digit ka PIN banayein. Koi default PIN nahi hai.</p>'));
    const form = el('<form></form>');
    const nameIn = el('<input class="input" type="text" required placeholder="Owner ka naam">');
    const userIn = el('<input class="input" type="text" required placeholder="Username">');
    const pinIn = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="PIN (4–8 digit)">');
    const pin2In = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="PIN dobara likhein">');
    form.appendChild(el('<label>Naam</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Username</label>')); form.appendChild(userIn);
    form.appendChild(el('<label>PIN (4–8 digit)</label>')); form.appendChild(pinIn);
    form.appendChild(el('<label>PIN Confirm Karein</label>')); form.appendChild(pin2In);
    form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Owner Account Banayein</button></div>'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      const username = userIn.value.trim();
      const pin = pinIn.value.trim();
      const pin2 = pin2In.value.trim();
      if (!name || !username) { this.notify('Issue — Naam aur username zaroori hain', 'error'); return; }
      if (!/^\d{4,8}$/.test(pin)) { this.notify('Issue — PIN sirf 4–8 digit ka hona chahiye', 'error'); return; }
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
    this.go('dashboard');
  },

  logout() {
    this.stopIdleTimer();
    this._lockedUser = null;
    this.user = null;
    this.currentScreen = null;
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
    const closeBtn = document.getElementById('bill-preview-close');
    const xBtn = document.getElementById('bill-preview-x');
    if (!overlay || !bodyEl) return false;
    bodyEl.innerHTML = html;
    overlay.hidden = false;
    overlay.style.display = 'flex';
    const close = () => { overlay.hidden = true; overlay.style.display = 'none'; };
    if (xBtn) xBtn.onclick = close;
    if (closeBtn) closeBtn.onclick = close;
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
      tEl.textContent = title || 'Confirm Karein';
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
