// Sahara Bakers — database layer (v2.0.0).
//
// Single local JSON store, copied from the RARA POS v1.1.9 hardening
// (the 2026-11-15 data-loss lesson). In Electron the data file lives in
// the app's userData folder (<userData>/sahara-bakers-data.json). When
// required outside Electron (plain node, e.g. tests) it falls back to a
// ./data folder next to this file.
//
//   DB.load()            load from disk, or seed from ./seed.json on first run
//   DB.save()            persist state to disk (atomic: temp file + rename)
//   DB.state             the in-memory state object
//   DB.nextId(collection)  max id in state[collection] + 1 (cached, O(1))
//   DB.hashPin(pin)      sha256(pin + ':sahara-bakers-salt') hex
//   DB.checkPin(user, pin)  compare a user's stored pinHash with a PIN
//   DB.stockOf(product, branchId)
//   DB.setStock(product, branchId, qty)
//   DB.addMovement({productId, productName, branchId, qty, reason, user, reference})
//   DB.recalcProductStock(product)
//   DB.backup()          verified timestamped backup, keeps last 7
//   DB.backupInfo()      { lastBackup, count, files[] }
//   DB.newestGoodBackup()  newest backup that actually holds data
//                        (products, else logins) — never the newest
//                        empty one
//   DB.restoreLatestBackup()  restores the newest GOOD backup, with
//                        { ok, at, name, products, logins }
//   DB.completeProduction({finishProductId, finishQty, lines, createdBy, clientRef})
//                        validate-then-apply raw->finish conversion:
//                        rejects over-stock with NO stock moved; on
//                        success deducts raw at the Warehouse, adds the
//                        finish, records the production (bill PB-XXXX)
//                        and one movement per leg (clientRef deduped)
//   DB.productionBillNo(production)  'PB-0001' ...
//   DB.WAREHOUSE_ID    'warehouse' — the Warehouse/Godown location.
//                        It is a REAL location, separate from the 3
//                        branches: stock lives in branchStocks rows
//                        with branchId 'warehouse', exactly like a
//                        branch id, but it is NOT a branch record —
//                        it never appears in the branch list, the
//                        header branch selector, or a transfer To
//                        dropdown. Transfers always start HERE.
//
// State shape:
//   products, branches, stockMovements, transfers, productions,
//   purchases, purchaseLines, suppliers, appUsers, loginSecurity, settings
// Product: {id, name, price, purchasePrice, category, type ('raw' |
// 'finished'), unit, sku, barcode, lowThreshold, status, image,
// stock, branchStocks:[{branchId, qty}]}. A branchStocks row whose
// branchId is DB.WAREHOUSE_ID ('warehouse') is warehouse stock;
// rows with a numeric branchId are that branch's stock. Prices are
// null until the user enters them in-app — never invented.
// Indexes are in-memory only and are never written to the JSON file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolve the data directory. Inside Electron use app.getPath('userData');
// outside Electron (plain node) fall back to ./data next to this file.
// main.js sets SAHARA_DATA_DIR in the environment before the window is
// created and the renderer inherits it. That is the first choice; the
// direct app.getPath() call below only works if db.js is ever required
// from the main process, and ./data is only for plain-node tests.
let dataDir;
if (process.env.SAHARA_DATA_DIR) {
  dataDir = process.env.SAHARA_DATA_DIR;
} else {
  try {
    const electron = require('electron');
    const app = electron.app || (electron.remote && electron.remote.app);
    if (app && typeof app.getPath === 'function') {
      dataDir = app.getPath('userData');
    }
  } catch (e) {
    // Not running under Electron (or electron not installed) — fall through.
  }
}
if (!dataDir) {
  dataDir = path.join(__dirname, 'data');
}

const DATA_FILE = path.join(dataDir, 'sahara-bakers-data.json');
const BAK_FILE = DATA_FILE + '.bak';
const BACKUP_DIR = path.join(dataDir, 'backups');
const SEED_FILE = path.join(__dirname, 'seed.json');
const MAX_BACKUPS = 7;

function emptyState() {
  return {
    products: [],
    branches: [],
    stockMovements: [],
    transfers: [],
    productions: [],
    purchases: [],
    purchaseLines: [],
    suppliers: [],
    appUsers: [],
    // PIN brute-force protection: per-username
    // { attempts, lockedUntil } — persisted here so restarting the app
    // does NOT reset the counter or the lock.
    loginSecurity: {},
    settings: {
      businessName: 'Sahara Bakers',
      phone: '',
      address: '',
      currency: 'PKR',
      defaultBranchId: 1,
      allowNegativeStock: false,
      sessionTimeoutMinutes: 15,
      printerName: '',
      lowStockNotifications: true,
      defaultLowStockLimit: null
    }
  };
}

const DB = {
  state: emptyState(),
  dataFile: DATA_FILE,
  backupDir: BACKUP_DIR,
  // The Warehouse/Godown is a REAL location, separate from the 3
  // branches (Branch 1, Branch 2, Branch 3). Its id is the string
  // 'warehouse' — stored in branchStocks rows, movements, transfers
  // and purchases exactly like a branch id, but it is NOT a branch
  // record (see the header comment). Never hard-code the string
  // elsewhere; always use DB.WAREHOUSE_ID.
  WAREHOUSE_ID: 'warehouse',
  WAREHOUSE_NAME: 'Warehouse',
  // Set by load(): true when the data was recovered from a backup/seed.
  recoveredFromBackup: false,
  loadError: null,
  // In-memory indexes (never serialised). Rebuilt by buildIndexes().
  indexes: null,

  /* ---------- indexes ---------- */
  buildIndexes() {
    const st = this.state;
    const idx = {
      productById: new Map(),
      productBySku: new Map(),
      productByBarcode: new Map(),
      branchById: new Map(),
      supplierById: new Map(),
      supplierByName: new Map(),
      userByUsername: new Map(),
      maxId: {},
      movementsByBranch: new Map()
    };
    const trackMax = (coll, id) => {
      if (typeof id === 'number' && (!idx.maxId[coll] || id > idx.maxId[coll])) idx.maxId[coll] = id;
    };
    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
    (st.products || []).forEach((p) => {
      idx.productById.set(String(p.id), p);
      if (p.sku && String(p.sku).trim()) idx.productBySku.set(norm(p.sku), p);
      if (p.barcode && String(p.barcode).trim()) idx.productByBarcode.set(String(p.barcode).trim(), p);
      trackMax('products', p.id);
    });
    (st.branches || []).forEach((b) => { idx.branchById.set(String(b.id), b); trackMax('branches', b.id); });
    (st.suppliers || []).forEach((s) => {
      idx.supplierById.set(String(s.id), s);
      if (s.name && String(s.name).trim()) idx.supplierByName.set(norm(s.name), s);
      trackMax('suppliers', s.id);
    });
    (st.stockMovements || []).forEach((m) => {
      trackMax('stockMovements', m.id);
      const key = m.branchId == null ? 'all' : String(m.branchId);
      if (!idx.movementsByBranch.has(key)) idx.movementsByBranch.set(key, []);
      idx.movementsByBranch.get(key).push(m);
      if (key !== 'all') {
        if (!idx.movementsByBranch.has('all')) idx.movementsByBranch.set('all', []);
        idx.movementsByBranch.get('all').push(m);
      }
    });
    idx.movementsByBranch.forEach((arr) => arr.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))));
    (st.appUsers || []).forEach((u) => {
      if (u.username) idx.userByUsername.set(norm(u.username), u);
      trackMax('appUsers', u.id);
    });
    ['transfers', 'productions', 'purchases', 'purchaseLines'].forEach((coll) => {
      (st[coll] || []).forEach((r) => trackMax(coll, r.id));
    });
    this.indexes = idx;
    return idx;
  },

  _idx() {
    return this.indexes || this.buildIndexes();
  },

  /* O(1) lookups — fall back to a scan only if indexes are unavailable. */
  productById(id) {
    if (id == null) return undefined;
    const hit = this._idx().productById.get(String(id));
    if (hit) return hit;
    return (this.state.products || []).find((p) => String(p.id) === String(id));
  },
  productBySku(sku) {
    if (!sku || !String(sku).trim()) return undefined;
    const hit = this._idx().productBySku.get(String(sku).trim().toLowerCase());
    if (hit) return hit;
    return (this.state.products || []).find((p) => p.sku && String(p.sku).trim().toLowerCase() === String(sku).trim().toLowerCase());
  },
  productByBarcode(code) {
    if (!code || !String(code).trim()) return undefined;
    const hit = this._idx().productByBarcode.get(String(code).trim());
    if (hit) return hit;
    return (this.state.products || []).find((p) => p.barcode && String(p.barcode).trim() === String(code).trim());
  },
  branchById(id) {
    if (id == null) return undefined;
    return this._idx().branchById.get(String(id)) ||
      (this.state.branches || []).find((b) => String(b.id) === String(id));
  },
  supplierById(id) {
    if (id == null) return undefined;
    return this._idx().supplierById.get(String(id)) ||
      (this.state.suppliers || []).find((s) => String(s.id) === String(id));
  },
  userByUsername(username) {
    if (!username || !String(username).trim()) return undefined;
    return this._idx().userByUsername.get(String(username).trim().toLowerCase());
  },

  /* ---------- load / save (atomic + .bak recovery) ---------- */
  load() {
    // The recovery flags are STICKY on purpose — load() runs once per
    // renderer module at startup on the same DB object, so a later
    // clean re-read of the just-recovered file must NOT wipe the first
    // load's recovery report before App.init() shows it. A load that
    // recovers or fails overwrites the flags with its own report; a
    // clean load leaves them exactly as they were.
    const readState = (file) => {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign(emptyState(), parsed);
    };
    // The newest backup can itself be the empty state, so a recovery
    // never trusts it blindly — it takes the newest backup that
    // actually has products (or, failing that, logins).
    const recoverFromGoodBackup = (why) => {
      const good = this.newestGoodBackup();
      if (!good.ok) return false;
      this.state = good.state;
      this.recoveredFromBackup = true;
      this.loadError = why + ' — backup "' + good.name + '" se data wapas laya gaya hai.';
      try { this._saveRecovered(); } catch (saveErr) { /* keep running on the recovered state */ }
      return true;
    };
    // The .bak copy is the last good file before the most recent save.
    // It is consulted not only when the file is corrupt but also when
    // the file parses yet is EMPTY: a good .bak (products, else logins)
    // recovers the data before the timestamped backups are tried.
    // A missing, corrupt or empty .bak simply returns false and the
    // caller falls through to the next recovery step unchanged.
    const recoverFromBak = () => {
      try {
        if (!fs.existsSync(BAK_FILE)) return false;
        const bakState = readState(BAK_FILE);
        const products = (bakState.products || []).length;
        const logins = (bakState.appUsers || []).length;
        if (products === 0 && logins === 0) return false;
        this.state = bakState;
        this.recoveredFromBackup = true;
        this.loadError = 'Khaali data mila — pichli achi copy (.bak) se data wapas laya gaya hai.';
        try { this._saveRecovered(); } catch (saveErr) { /* keep running on the recovered state */ }
        return true;
      } catch (e) {
        return false;
      }
    };
    // One-time fresh-seed migration: first launch on a lost or empty
    // state loads the seed (44 items, 3 branches, logins) instead of
    // starting empty. Flag-guarded (settings.v100FreshSeedApplied) —
    // once applied, later losses auto-recover from a good backup
    // instead of re-seeding. The write uses _saveRecovered() (atomic,
    // no .bak touch): the file on disk is empty/corrupt and must never
    // become the last-good .bak copy.
    const applyFreshSeed = () => {
      try {
        if (!fs.existsSync(SEED_FILE)) return false;
        const raw = fs.readFileSync(SEED_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        delete parsed._note;
        // Existing users WIN over seed users: they go first, a seed
        // user is skipped when its username already exists, and the
        // seed Owner is skipped when an existing user already has the
        // Owner role (his PIN wins, so there is never a second Owner).
        const existingUsers = (this.state.appUsers || []).slice();
        const oldSettings = Object.assign({}, this.state.settings || {});
        this.state = Object.assign(emptyState(), parsed);
        const seedUsers = this.state.appUsers || [];
        const merged = existingUsers.slice();
        for (const s of seedUsers) {
          const nameTaken = merged.some((m) => String(m.username || '').toLowerCase() === String(s.username || '').toLowerCase());
          if (nameTaken) continue;
          if (s.role === 'Owner' && merged.some((m) => m.role === 'Owner')) continue;
          merged.push(s);
        }
        this.state.appUsers = merged;
        this.state.settings = Object.assign({}, parsed.settings || {}, oldSettings, { v100FreshSeedApplied: true });
        this.recoveredFromBackup = true;
        this.loadError = 'Naya data load ho gaya hai — 44 items aur logins tayyar hain.';
        try { this._saveRecovered(); } catch (saveErr) { /* keep running on the seeded state */ }
        return true;
      } catch (e) {
        return false;
      }
    };
    if (fs.existsSync(DATA_FILE)) {
      try {
        this.state = readState(DATA_FILE);
        // The file parses but holds no products — the empty-state
        // start. Fresh seed FIRST (the fresh start for v1.0.0): first
        // launch with no products becomes the new seed. Only if the
        // seed cannot be applied (already applied, or no seed file)
        // fall back to auto-recovery: the .bak copy first, then a good
        // timestamped backup. NOTE: the trigger is products == 0
        // alone, not products == 0 AND users == 0 — the user may
        // already have an Owner login, and applyFreshSeed merges
        // existing users so his Owner survives.
        if ((this.state.products || []).length === 0) {
          const seeded = !((this.state.settings || {}).v100FreshSeedApplied) && applyFreshSeed();
          if (!seeded && !recoverFromBak() && !recoverFromGoodBackup('Khaali data mila')) {
            this.recoveredFromBackup = false;
            this.loadError = 'Khaali data mila aur koi acha backup nahi mila — Backup se restore karein ya naya item add karein.';
          }
        }
      } catch (e) {
        // Main file is corrupt — try the last-good backup copy.
        try {
          this.state = readState(BAK_FILE);
          this.recoveredFromBackup = true;
          this.loadError = 'Main data file kharab thi — pichli achi copy (.bak) se data wapas laya gaya hai.';
          try { this.save(); } catch (saveErr) { /* keep running on the recovered state */ }
        } catch (bakErr) {
          // .bak also failed — try the newest GOOD backup before
          // giving up and starting empty.
          if (!recoverFromGoodBackup('Data file kharab thi')) {
            const seeded = !((this.state.settings || {}).v100FreshSeedApplied) && applyFreshSeed();
            if (!seeded) {
              this.state = emptyState();
              this.recoveredFromBackup = false;
              this.loadError = 'Data file kharab thi aur backup bhi nahi mila — khaali data se shuru kiya gaya hai. Backup se restore karein.';
            }
          }
        }
      }
    } else if (fs.existsSync(SEED_FILE)) {
      const raw = fs.readFileSync(SEED_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      delete parsed._note;
      this.state = Object.assign(emptyState(), parsed);
      if (!this.state.settings) this.state.settings = {};
      // A seed load counts as the fresh seed being applied, so a later
      // data-loss empty state auto-recovers from a good backup instead
      // of re-seeding.
      this.state.settings.v100FreshSeedApplied = true;
      this.save();
    } else {
      this.state = emptyState();
      this.save();
    }
    // v2.0.0 one-time migration (flag-guarded by
    // settings.v200SeedMigrated, so it runs exactly once on a v1.0.0
    // data file and never again). Fresh v2.0.0 seeds already carry the
    // flag as true, so this is a no-op for them.
    //  - Auth: the single v1 PIN 3333 Owner becomes PIN 1234, and a
    //    Manager login (username 'manager', PIN 123) is added. The
    //    hash scheme is unchanged: sha256(pin + ':sahara-bakers-salt').
    //    Any other existing PIN (e.g. a user-changed Owner PIN) is
    //    left untouched — only the exact 3333 hash is replaced.
    //  - Branches: the old v1 names become Branch 1 / Branch 2 /
    //    Branch 3 (only the exact old names are renamed; a name the
    //    user chose himself is kept).
    //  - Live prices: Cheese (id 18) price 8000 / purchasePrice 5000
    //    with unit '1 Kg', Bakery Cake (id 55) price 9000 /
    //    purchasePrice 7000 with unit '10 Pieces' — but ONLY when the
    //    item still has no prices at all, so a price the user entered
    //    in-app is never overwritten.
    if (!this.state.settings || !this.state.settings.v200SeedMigrated) {
      try {
        let changed = false;
        const users = this.state.appUsers || [];
        const owner3333 = users.find((u) => u.pinHash === this.hashPin('3333'));
        if (owner3333) { owner3333.pinHash = this.hashPin('1234'); changed = true; }
        const hasManager = users.some((u) => String(u.username || '').toLowerCase() === 'manager' || u.role === 'Manager');
        if (!hasManager && users.length > 0) {
          users.push({ id: this.nextId('appUsers'), name: 'Manager', username: 'manager',
            pinHash: this.hashPin('123'), role: 'Manager', branchId: null, branchName: null, isActive: true });
          changed = true;
        }
        const renameBranch = (id, oldName, newName) => {
          const b = (this.state.branches || []).find((x) => String(x.id) === String(id));
          if (b && String(b.name || '').trim().toLowerCase() === oldName) { b.name = newName; changed = true; }
        };
        renameBranch(1, 'sahara backers railway road', 'Branch 1');
        renameBranch(2, 'tehzeeb cafe', 'Branch 2');
        const priceIfBlank = (id, price, purchasePrice, unit) => {
          const p = (this.state.products || []).find((x) => String(x.id) === String(id));
          if (p && p.price == null && p.purchasePrice == null) {
            p.price = price; p.purchasePrice = purchasePrice; changed = true;
            if (unit && p.unit !== unit) { p.unit = unit; }
          }
        };
        priceIfBlank(18, 8000, 5000, '1 Kg');
        priceIfBlank(55, 9000, 7000, '10 Pieces');
        if (!this.state.settings) this.state.settings = {};
        this.state.settings.v200SeedMigrated = true;
        if (changed) { try { this.save(); } catch (e) { /* migration lives in memory until the next save */ } }
      } catch (e) { /* a failed migration must never block loading */ }
    }
    // v2.0.0 -> v2.0.1 Warehouse migration (flag-guarded by
    // settings.v201WarehouseMigrated, so it runs exactly once and
    // never again). In v1.0.0 and v2.0.0 Branch 1 WAS the warehouse
    // by convention: stock lived in branchStocks rows with
    // branchId 1, and movements/transfers/purchases pointed at
    // branch 1. The warehouse is now a REAL separate location
    // (DB.WAREHOUSE_ID, 'warehouse'), so branch-1 stock becomes
    // warehouse stock:
    //  - per product, the branch-1 qty moves into the warehouse row
    //    (added to any warehouse qty already there — never
    //    duplicated, never lost) and the branch-1 row is removed;
    //  - stock movements, transfers (from AND to) and purchases at
    //    branch 1 are re-pointed to 'warehouse'.
    // Branch 1 itself stays a normal branch — after the migration
    // its stock is 0 until a transfer sends stock to it. Totals
    // never change: the move is a re-label, not a copy. User
    // branchIds (Branch-role logins) are NOT touched — a login
    // tied to Branch 1 is a real branch login, not the warehouse.
    // Fresh seeds already carry the flag as true, so this is a
    // no-op for them.
    if (!this.state.settings || !this.state.settings.v201WarehouseMigrated) {
      try {
        let changed = false;
        const W = this.WAREHOUSE_ID;
        const isB1 = (v) => String(v) === '1';
        (this.state.products || []).forEach((p) => {
          const rows = p.branchStocks || [];
          const b1 = rows.find((r) => isB1(r.branchId));
          if (!b1) return;
          const qty = Number(b1.qty) || 0;
          const wh = rows.find((r) => String(r.branchId) === W);
          if (wh) wh.qty = (Number(wh.qty) || 0) + qty;
          else rows.push({ branchId: W, qty });
          rows.splice(rows.indexOf(b1), 1);
          this.recalcProductStock(p);
          changed = true;
        });
        (this.state.stockMovements || []).forEach((m) => { if (isB1(m.branchId)) { m.branchId = W; changed = true; } });
        (this.state.transfers || []).forEach((t) => {
          if (isB1(t.fromBranchId)) { t.fromBranchId = W; changed = true; }
          if (isB1(t.toBranchId)) { t.toBranchId = W; changed = true; }
        });
        (this.state.purchases || []).forEach((pu) => { if (isB1(pu.branchId)) { pu.branchId = W; changed = true; } });
        if (!this.state.settings) this.state.settings = {};
        this.state.settings.v201WarehouseMigrated = true;
        if (changed) { try { this.save(); } catch (e) { /* migration lives in memory until the next save */ } }
      } catch (e) { /* a failed migration must never block loading */ }
    }
    // Settings defaults for older data files.
    if (!this.state.settings) this.state.settings = {};
    if (this.state.settings.sessionTimeoutMinutes == null) this.state.settings.sessionTimeoutMinutes = 15;
    if (this.state.settings.lowStockNotifications == null) this.state.settings.lowStockNotifications = true;
    if (this.state.settings.defaultLowStockLimit == null) this.state.settings.defaultLowStockLimit = null;
    if (!this.state.settings.currency) this.state.settings.currency = 'PKR';
    this.buildIndexes();
    return this.state;
  },

  // Atomic save: keep a .bak copy of the last good file, write to a temp
  // file in the same folder, then rename over the real file, so a crash
  // mid-write never leaves a half file. Indexes are rebuilt first so
  // they always match the state that was just saved.
  save() {
    fs.mkdirSync(dataDir, { recursive: true });
    this.buildIndexes();
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf8');
    // Preserve the previous good file as .bak before replacing it.
    try {
      if (fs.existsSync(DATA_FILE)) {
        const prev = fs.readFileSync(DATA_FILE, 'utf8');
        JSON.parse(prev); // only back up a file that parses
        fs.writeFileSync(BAK_FILE, prev, 'utf8');
      }
    } catch (e) { /* a corrupt previous file is not worth backing up */ }
    fs.renameSync(tmpFile, DATA_FILE);
  },

  // Atomic write of the current state WITHOUT touching the .bak copy.
  // Used after a recovery: the file on disk is corrupt or empty, and it
  // must never become the "last good" .bak copy.
  _saveRecovered() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
  },

  nextId(collection) {
    const idx = this._idx();
    if (typeof idx.maxId[collection] === 'number') return idx.maxId[collection] + 1;
    const rows = this.state[collection] || [];
    let max = 0;
    for (const row of rows) {
      if (typeof row.id === 'number' && row.id > max) max = row.id;
    }
    return max + 1;
  },

  hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin) + ':sahara-bakers-salt').digest('hex');
  },

  checkPin(user, pin) {
    if (!user || !user.pinHash) return false;
    return user.pinHash === this.hashPin(pin);
  },

  /* ---------- PIN brute-force protection ---------- */
  // After LOCKOUT_AFTER consecutive wrong PINs for one username, that
  // login is locked for LOCKOUT_MINUTES minutes. The counter and the
  // lock live in state.loginSecurity (the local data file), so restarting
  // the app does NOT reset them. A successful login clears the counter.
  LOCKOUT_AFTER: 5,
  LOCKOUT_MINUTES: 15,
  _loginSecurity() {
    if (!this.state.loginSecurity || typeof this.state.loginSecurity !== 'object') this.state.loginSecurity = {};
    return this.state.loginSecurity;
  },
  _loginSecKey(username) { return String(username == null ? '' : username).trim().toLowerCase(); },
  // { locked: bool, attempts: n, remainingMs, remainingMinutes }
  isLoginLocked(username) {
    const sec = this._loginSecurity();
    const rec = sec[this._loginSecKey(username)];
    if (!rec) return { locked: false, attempts: 0, remainingMs: 0, remainingMinutes: 0 };
    if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
      delete sec[this._loginSecKey(username)];
      try { this.save(); } catch (e) { /* lock clears on next load */ }
      return { locked: false, attempts: 0, remainingMs: 0, remainingMinutes: 0 };
    }
    if (rec.lockedUntil) {
      const remainingMs = rec.lockedUntil - Date.now();
      return { locked: true, attempts: rec.attempts || 0, remainingMs: remainingMs, remainingMinutes: Math.max(1, Math.ceil(remainingMs / 60000)) };
    }
    return { locked: false, attempts: rec.attempts || 0, remainingMs: 0, remainingMinutes: 0 };
  },
  // Call after a wrong PIN. Returns { locked: bool, attempts: n }.
  recordFailedLogin(username) {
    const sec = this._loginSecurity();
    const key = this._loginSecKey(username);
    const rec = sec[key] || { attempts: 0, lockedUntil: null };
    rec.attempts = (rec.attempts || 0) + 1;
    let locked = false;
    if (rec.attempts >= this.LOCKOUT_AFTER) {
      rec.lockedUntil = Date.now() + this.LOCKOUT_MINUTES * 60 * 1000;
      locked = true;
    }
    sec[key] = rec;
    try { this.save(); } catch (e) { /* counter lives in memory until the next save */ }
    return { locked: locked, attempts: rec.attempts };
  },
  // Call after a successful login — resets the counter to zero.
  recordSuccessfulLogin(username) {
    const sec = this._loginSecurity();
    const key = this._loginSecKey(username);
    if (sec[key]) {
      delete sec[key];
      try { this.save(); } catch (e) { /* cleared on next load */ }
    }
  },

  /* ---------- uniqueness (data layer — never UI-only) ---------- */
  // Returns { ok: true } or { ok: false, message } (Roman Urdu).
  // Empty values are ignored. excludeId skips the record being edited.
  checkUniqueness(collection, record, excludeId) {
    const same = (a, b) => String(a) === String(b);
    if (collection === 'products') {
      if (record.sku && String(record.sku).trim()) {
        const hit = this.productBySku(record.sku);
        if (hit && !same(hit.id, excludeId)) return { ok: false, message: 'Ye SKU pehle se mojood hai (' + (hit.name || '') + ') — duplicate SKU allow nahi hai.' };
      }
      if (record.barcode && String(record.barcode).trim()) {
        const hit = this.productByBarcode(record.barcode);
        if (hit && !same(hit.id, excludeId)) return { ok: false, message: 'Ye Barcode pehle se mojood hai (' + (hit.name || '') + ') — duplicate barcode allow nahi hai.' };
      }
    }
    if (collection === 'suppliers') {
      if (record.name && String(record.name).trim()) {
        const hit = this._idx().supplierByName.get(String(record.name).trim().toLowerCase());
        if (hit && !same(hit.id, excludeId)) return { ok: false, message: 'Is naam ka supplier pehle se mojood hai.' };
      }
    }
    if (collection === 'appUsers') {
      if (record.username && String(record.username).trim()) {
        const hit = this.userByUsername(record.username);
        if (hit && !same(hit.id, excludeId)) return { ok: false, message: 'Ye username pehle se mojood hai — koi aur username chunein.' };
      }
    }
    if (collection === 'branches') {
      if (record.name && String(record.name).trim()) {
        const hit = (this.state.branches || []).find((b) => String(b.name).trim().toLowerCase() === String(record.name).trim().toLowerCase());
        if (hit && !same(hit.id, excludeId)) return { ok: false, message: 'Is naam ki branch pehle se mojood hai.' };
      }
    }
    if (collection === 'purchases') {
      if (record.invoiceNo && String(record.invoiceNo).trim()) {
        const hit = (this.state.purchases || []).find((p) => String(p.invoiceNo || '').trim().toLowerCase() === String(record.invoiceNo).trim().toLowerCase());
        if (hit && !same(hit.id, excludeId)) return { ok: false, message: 'Ye invoice number pehle se mojood hai — duplicate invoice number allow nahi hai.' };
      }
    }
    return { ok: true };
  },

  /* ---------- backup (verified, keeps last 7) ---------- */
  backup() {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const now = new Date();
      const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') +
        '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0') +
        '-' + String(now.getMilliseconds()).padStart(3, '0');
      const file = path.join(BACKUP_DIR, 'sahara-bakers-backup-' + stamp + '.json');
      // Two backups in the same millisecond must never overwrite each
      // other — suffix until the name is free.
      let dest = file, n = 0;
      while (fs.existsSync(dest)) { n += 1; dest = path.join(BACKUP_DIR, 'sahara-bakers-backup-' + stamp + '-' + n + '.json'); }
      const payload = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(dest, payload, 'utf8');
      // Verify: read it back and parse it. A backup that cannot be read
      // back is not a backup.
      const check = JSON.parse(fs.readFileSync(dest, 'utf8'));
      if (!check || !Array.isArray(check.products)) throw new Error('Backup verify nahi hua');
      // Prune to the newest MAX_BACKUPS files.
      const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('sahara-bakers-backup-') && f.endsWith('.json'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      files.slice(MAX_BACKUPS).forEach((f) => { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) { /* ignore */ } });
      return { ok: true, path: dest, name: path.basename(dest), at: now.toISOString() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  },

  backupInfo() {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return { lastBackup: null, count: 0, files: [] };
      const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('sahara-bakers-backup-') && f.endsWith('.json'))
        .map((f) => {
          const st = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, path: path.join(BACKUP_DIR, f), at: st.mtime.toISOString(), size: st.size };
        })
        .sort((a, b) => (b.at < a.at ? -1 : 1));
      return { lastBackup: files.length ? files[0].at : null, count: files.length, files };
    } catch (e) {
      return { lastBackup: null, count: 0, files: [], error: e && e.message ? e.message : String(e) };
    }
  },

  // The NEWEST backup is not trusted blindly — after a data loss it can
  // itself be the empty state. Scan backups newest-first and take the
  // first one that actually holds data: products present (a real backup
  // always has products and branches). If no backup has products, fall
  // back to the newest backup that at least has logins.
  // Returns { ok, name, at, state, products, logins } or { ok: false }.
  newestGoodBackup() {
    const info = this.backupInfo();
    let loginFallback = null;
    for (const f of info.files) {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(f.path, 'utf8')); } catch (e) { continue; }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.products) || !Array.isArray(parsed.branches)) continue;
      const logins = Array.isArray(parsed.appUsers) ? parsed.appUsers.length : 0;
      if (parsed.products.length > 0) {
        return { ok: true, name: f.name, at: f.at, state: Object.assign(emptyState(), parsed),
          products: parsed.products.length, logins };
      }
      if (!loginFallback && logins > 0) {
        loginFallback = { ok: true, name: f.name, at: f.at, state: Object.assign(emptyState(), parsed),
          products: 0, logins };
      }
    }
    return loginFallback || { ok: false };
  },

  // Replace current data with the newest GOOD backup (the newest backup
  // can itself be the empty state — it is skipped, never restored).
  // Returns { ok, at, name, products, logins } or { ok: false, message }.
  restoreLatestBackup() {
    const info = this.backupInfo();
    if (!info.files.length) return { ok: false, message: 'Koi backup nahi mila — pehle backup banayein.' };
    // Read the good backup into memory FIRST: the safety backup below
    // writes a new file and prunes to the last 7, which must never be
    // able to push the good backup out before it is read.
    const good = this.newestGoodBackup();
    if (!good.ok) return { ok: false, message: 'Koi acha backup nahi mila — tamam backups khaali hain ya kharab hain.' };
    try {
      // Keep a safety copy of the current (possibly broken) state first.
      try { this.backup(); } catch (e) { /* ignore */ }
      this.state = good.state;
      if (this.state.settings.sessionTimeoutMinutes == null) this.state.settings.sessionTimeoutMinutes = 15;
      this.save();
      return { ok: true, at: good.at, name: good.name, products: good.products, logins: good.logins };
    } catch (e) {
      return { ok: false, message: 'Backup restore nahi ho saka: ' + (e && e.message ? e.message : 'unknown error') };
    }
  },

  /* ---------- roles ---------- */
  requireRole(user, roles, action) {
    const role = user && user.role;
    if (!user || roles.indexOf(role) === -1) {
      throw new Error('Is kaam ki permission nahi hai' + (action ? ' — ' + action : ''));
    }
    return true;
  },

  /* ---------- Stock Transfer Bill values ---------- */
  // Per-item values for a transfer, from the product's CURRENT price.
  // No price is ever invented: a product with price null contributes
  // value null and sets the priceMissing flag so the UI can say so
  // plainly. The bill is about stock GIVEN, so quantities are the
  // dispatched qty. Read-only — no transfer record is ever changed.
  // Returns { rows: [{productId, name, qty, unit, price, lineValue,
  // priceMissing}], totals: {qty, value, valueKnown}, priceMissing }.
  transferBillValues(transfer, products) {
    var byId = {};
    (products || []).forEach(function (p) { byId[String(p.id)] = p; });
    var rows = [];
    var totals = { qty: 0, value: 0, valueKnown: true };
    var priceMissing = false;
    (transfer && Array.isArray(transfer.items) ? transfer.items : []).forEach(function (it) {
      var prod = it.productId != null ? byId[String(it.productId)] : null;
      var qty = Number(it.qty) || 0;
      var price = prod && prod.price != null ? Number(prod.price) : null;
      if (qty > 0 && (price == null || isNaN(price))) priceMissing = true;
      var row = {
        productId: it.productId != null ? String(it.productId) : null,
        name: (prod && prod.name) || it.name || it.productName || 'Item',
        unit: (prod && prod.unit) || it.unit || '',
        qty: qty, price: price,
        lineValue: price == null ? null : qty * price,
        priceMissing: price == null
      };
      rows.push(row);
      totals.qty += qty;
      if (row.lineValue != null) totals.value += row.lineValue;
      else totals.valueKnown = false;
    });
    return { rows: rows, totals: totals, priceMissing: priceMissing };
  },

  // Bill number for a production: PB-0001, PB-0002, ... (id-based,
  // same pattern as the transfer bill SB-XXXX).
  productionBillNo(production) {
    return 'PB-' + String(production.id == null ? '' : production.id).padStart(4, '0');
  },

  // Raw -> Finish production, as ONE validated transaction.
  //   completeProduction({ finishProductId, finishQty, lines, createdBy, clientRef, warehouseBranchId })
  //   lines: [{ productId, qty }] — raw items and the quantity of
  //   each used. warehouseBranchId defaults to DB.WAREHOUSE_ID
  //   (the real Warehouse location, separate from the 3 branches).
  // Validation runs FIRST and rejects the whole cart when ANY line
  // is short — over-stock is rejected with NO stock moved at all.
  // On success: raw is deducted at the Warehouse, the finish is
  // added at the Warehouse, one stockMovement per leg is recorded
  // (clientRef deduped, so a double submit cannot double-count),
  // and a production record is stored with the bill number.
  // Costing uses each raw item's purchasePrice; a line whose
  // purchasePrice is null contributes no cost and makes costKnown
  // false — no cost is ever invented. costPerUnit = totalCost /
  // finishQty when the full cost is known, else null.
  // Returns { ok: true, production } or { ok: false, message }.
  completeProduction(opts) {
    const finishQty = Number(opts && opts.finishQty) || 0;
    const lines = (opts && Array.isArray(opts.lines)) ? opts.lines : [];
    const warehouseId = (opts && opts.warehouseBranchId != null) ? opts.warehouseBranchId : this.WAREHOUSE_ID;
    const finish = this.productById(opts && opts.finishProductId);
    if (!finish) return { ok: false, message: 'Finish item nahi mila — pehle finish item chunein.' };
    if (finish.type !== 'finished') return { ok: false, message: '"' + (finish.name || '') + '" finish item nahi hai — Production sirf Finish Goods ke liye hai.' };
    if (!finishQty || finishQty <= 0) return { ok: false, message: 'Bani hui miqdaar durust likhein (0 se zyada).' };
    if (lines.length === 0) return { ok: false, message: 'Pehle cart mein kam az kam aik raw item add karein.' };
    // Idempotency FIRST (before the stock check): the same clientRef
    // completed before returns the original production instead of
    // producing twice. A retry after success would otherwise fail
    // the stock check, because the raw is already deducted.
    const clientRef = (opts && opts.clientRef) || null;
    if (clientRef) {
      const prev = (this.state.productions || []).find((p) => p.clientRef === clientRef);
      if (prev) return { ok: true, production: prev, duplicate: true };
    }
    // ---- validate every line BEFORE moving anything ----
    const checked = [];
    for (const ln of lines) {
      const qty = Number(ln.qty) || 0;
      const raw = this.productById(ln.productId);
      if (!raw) return { ok: false, message: 'Raw item nahi mila (id ' + ln.productId + ').' };
      if (raw.type !== 'raw') return { ok: false, message: '"' + (raw.name || '') + '" raw item nahi hai.' };
      if (!qty || qty <= 0) return { ok: false, message: '"' + (raw.name || '') + '" ki miqdaar durust likhein.' };
      const avail = this.stockOf(raw, warehouseId);
      if (qty > avail && !(this.state.settings && this.state.settings.allowNegativeStock)) {
        return { ok: false, message: '"' + (raw.name || '') + '" ka itna stock nahi hai — godown mein sirf ' + avail + ' ' + (raw.unit || '') + ' hai, aap ne ' + qty + ' manga hai. Kuch bhi move nahi hua.' };
      }
      const pp = (raw.purchasePrice != null && !isNaN(Number(raw.purchasePrice))) ? Number(raw.purchasePrice) : null;
      checked.push({ productId: raw.id, name: raw.name, qty, unit: raw.unit || '', purchasePrice: pp, lineCost: pp == null ? null : qty * pp, availableBefore: avail });
    }
    const totalCost = checked.reduce((a, l) => a + (l.lineCost == null ? 0 : l.lineCost), 0);
    const costKnown = checked.every((l) => l.lineCost != null);
    const id = this.nextId('productions');
    const billNo = 'PB-' + String(id).padStart(4, '0');
    const now = new Date().toISOString();
    const createdBy = (opts && opts.createdBy) || '';
    const remainingRaw = checked.map((l) => {
      const raw = this.productById(l.productId);
      return { productId: l.productId, name: l.name, unit: l.unit, usedQty: l.qty, remaining: this.stockOf(raw, warehouseId) - l.qty };
    });
    // ---- apply: deduct raw, add finish, record movements ----
    checked.forEach((l) => {
      const raw = this.productById(l.productId);
      this.setStock(raw, warehouseId, this.stockOf(raw, warehouseId) - l.qty);
      this.addMovement({ productId: raw.id, productName: raw.name, branchId: warehouseId, qty: -l.qty,
        reason: 'Production ' + billNo + ' — ' + finish.name + ' banane mein use hua', user: createdBy,
        reference: billNo, clientRef: clientRef ? clientRef + ':raw:' + raw.id : null });
    });
    this.setStock(finish, warehouseId, this.stockOf(finish, warehouseId) + finishQty);
    this.addMovement({ productId: finish.id, productName: finish.name, branchId: warehouseId, qty: finishQty,
      reason: 'Production ' + billNo + ' — tayyar hua', user: createdBy,
      reference: billNo, clientRef: clientRef ? clientRef + ':finish:' + finish.id : null });
    const finalFinishStock = this.stockOf(finish, warehouseId);
    const production = {
      id, billNo, date: now, finishProductId: finish.id, finishName: finish.name,
      finishQty, finishUnit: finish.unit || '',
      lines: checked, totalCost, costKnown,
      costPerUnit: costKnown && finishQty > 0 ? totalCost / finishQty : null,
      remainingRaw, finalFinishStock, warehouseBranchId: warehouseId,
      createdBy, clientRef
    };
    if (!Array.isArray(this.state.productions)) this.state.productions = [];
    this.state.productions.unshift(production);
    return { ok: true, production };
  },

  /* ---------- stock ---------- */
  // Total stock of a product across branches when branchId is omitted;
  // the stock held at one branch when it is given.
  stockOf(product, branchId) {
    if (!product) return 0;
    if (branchId === undefined || branchId === null) {
      if (typeof product.stock === 'number') return product.stock;
      return (product.branchStocks || []).reduce((sum, b) => sum + (b.qty || 0), 0);
    }
    const row = (product.branchStocks || []).find(b => b.branchId === branchId);
    return row ? row.qty : 0;
  },

  setStock(product, branchId, qty) {
    if (!product) return;
    qty = Math.max(0, Number(qty) || 0);
    product.branchStocks = product.branchStocks || [];
    const row = product.branchStocks.find(b => b.branchId === branchId);
    if (row) {
      row.qty = qty;
    } else {
      product.branchStocks.push({ branchId, qty });
    }
    this.recalcProductStock(product);
  },

  // Duplicate-stock-entry protection: a movement that carries a
  // clientRef (one stable id per transaction leg, e.g. a production
  // or transfer leg) is recorded at most ONCE — a second add with
  // the same clientRef returns the existing record and moves no
  // stock. Movements without a clientRef behave exactly as before.
  addMovement(movement) {
    if (movement && movement.clientRef) {
      const dup = (this.state.stockMovements || []).find((m) => m.clientRef === movement.clientRef);
      if (dup) return dup;
    }
    const now = new Date().toISOString();
    const record = {
      id: this.nextId('stockMovements'),
      productId: movement.productId,
      productName: movement.productName || '',
      branchId: movement.branchId !== undefined ? movement.branchId : null,
      qty: movement.qty,
      date: movement.date || now,
      reason: movement.reason || '',
      user: movement.user || '',
      reference: movement.reference || '',
      clientRef: movement.clientRef || null
    };
    this.state.stockMovements.push(record);
    // Keep the movement index in step without a full rebuild.
    const idx = this.indexes;
    if (idx) {
      const key = record.branchId == null ? 'all' : String(record.branchId);
      const keys = key === 'all' ? ['all'] : [key, 'all'];
      keys.forEach((k) => {
        if (!idx.movementsByBranch.has(k)) idx.movementsByBranch.set(k, []);
        idx.movementsByBranch.get(k).push(record);
      });
      if (typeof idx.maxId.stockMovements !== 'number' || record.id > idx.maxId.stockMovements) idx.maxId.stockMovements = record.id;
    }
    return record;
  },

  // ---- "Sold" per branch (Branches screen) ----
  // A stock movement counts as a SALE only when it is an explicit
  // Stock Out: a negative movement that is NOT a transfer leg and
  // NOT a production leg. Stock movements carry no `kind` field, so
  // the rule is decided by the movement's reason prefix — the only
  // marker each writer sets (see completeProduction and
  // transfer.js). In particular, production raw consumption
  // (reason 'Production PB-0001 — ...', recorded at the Warehouse)
  // is NOT a sale: the raw was consumed to make a finish
  // item, not sold. Counting it as sold inflated the "Sold"
  // figure for the location holding the raw stock. The same
  // applies to stock corrections from item edits (reasons
  // 'Raw Item Edit — stock set' / 'Finish Item Edit — stock
  // set', written by raw.js and finished.js when an edit changes
  // a quantity): a correction is not a sale either. Positive
  // movements (stock in, finish produced) never count as sold.
  isSaleMovement(m) {
    if (!m || Number(m.qty) >= 0) return false;
    const reason = String(m.reason || '');
    if (reason.indexOf('Transfer') === 0) return false; // transfer leg, not a sale
    if (reason.indexOf('Production') === 0) return false; // production consumption, not a sale
    if (reason.indexOf('Raw Item Edit') === 0) return false; // stock correction, not a sale
    if (reason.indexOf('Finish Item Edit') === 0) return false; // stock correction, not a sale
    return true;
  },

  // Total units sold at one branch: |qty| of that branch's sale
  // movements only (see isSaleMovement). Used by the Branches
  // screen; kept here (not in branches.js) so the rule is defined
  // once and unit-testable from the Node DB suite.
  soldQtyForBranch(branchId) {
    return (this.state.stockMovements || [])
      .filter((m) => String(m.branchId) === String(branchId) && this.isSaleMovement(m))
      .reduce((a, m) => a + Math.abs(Number(m.qty) || 0), 0);
  },

  movementsInRange(fromISO, toISO, branchId) {
    const idx = this._idx();
    const key = branchId == null || branchId === 'all' ? 'all' : String(branchId);
    let arr = idx.movementsByBranch.get(key) || [];
    if (key !== 'all') {
      const extra = (idx.movementsByBranch.get('all') || []).filter((m) => m.branchId == null);
      arr = arr.concat(extra);
    }
    const from = fromISO ? String(fromISO).slice(0, 10) : null;
    const to = toISO ? String(toISO).slice(0, 10) : null;
    if (!from && !to) return arr.slice();
    return arr.filter((m) => {
      const d = String(m.date || '').slice(0, 10);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  },

  // Recompute a product's total stock from its per-branch stocks.
  recalcProductStock(product) {
    if (!product) return 0;
    product.stock = (product.branchStocks || []).reduce((sum, b) => sum + (b.qty || 0), 0);
    return product.stock;
  },

  // Low-stock limit for one item: the item's own limit wins; otherwise
  // the Settings default; null means no limit set.
  lowLimitFor(product) {
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
  }
};

module.exports = DB;
