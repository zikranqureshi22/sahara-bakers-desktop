// Sahara Bakers — database layer (v2.1.0).
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
//   + v2.1.0: sales, saleLines, heldOrders, khataCustomers, khataPayments,
//   shifts, staff, staffAttendance, shiftExpenses, deletedSales, batches,
//   wastage, expenses, recipes
// Product: {id, name, price, purchasePrice, costPrice (production-only,
// null until a production sets it), category, type ('raw' |
// 'finished'), unit, sku, barcode, lowThreshold, status, image,
// expiryTracked (default false), stock, branchStocks:[{branchId, qty}]}. A branchStocks row whose
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
    // v2.1.0 — Counter POS tables (web v53 schema, local JSON port).
    // Live web transactions are NEVER seeded: fresh installs start
    // with all of these empty, and the v210 migration never touches
    // existing rows in them.
    sales: [],
    saleLines: [],
    heldOrders: [],
    khataCustomers: [],
    khataPayments: [],
    shifts: [],
    staff: [],
    staffAttendance: [],
    shiftExpenses: [],
    deletedSales: [],
    batches: [],
    wastage: [],
    expenses: [],
    recipes: [],
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
      defaultLowStockLimit: null,
      // v2.1.0 settings (defaults; see DB.canSeeCost / POS settings).
      managerCanSeeCost: false,
      posServiceCharge: { type: 'flat', value: 0 },
      posBillCopies: 1,
      kotEnabled: true,
      kotRemarks: true,
      backupFormatVersion: 2,
      v210Migrated: false
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
    ['transfers', 'productions', 'purchases', 'purchaseLines',
      'sales', 'saleLines', 'heldOrders', 'khataCustomers', 'khataPayments',
      'shifts', 'staff', 'staffAttendance', 'shiftExpenses', 'deletedSales',
      'batches', 'wastage', 'expenses', 'recipes'].forEach((coll) => {
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
    // v2.1.0 migration (flag-guarded by settings.v210Migrated, runs
    // exactly once on a v2.0.0 data file, never again). Fresh v2.1.0
    // seeds already carry the flag as true, so this is a no-op there.
    // A SAFETY BACKUP is taken FIRST (v200/v201 did not do this).
    //   (a) Counter Manager login add (username 'counter', PIN 1234,
    //       role 'Counter Manager', isPosOnly true) — only when no
    //       user with username 'counter' AND no Counter Manager exists.
    //       Existing PINs are NEVER changed.
    //   (b) Manager display rename: exact name 'Manager' ->
    //       'Warehouse'. Username 'manager' and PIN stay unchanged.
    //       A name the user renamed himself is left alone.
    //   (c) Seed merge of the 96 video-menu products (ids 63-158)
    //       from seed.json: an id that already exists is SKIPPED —
    //       existing rows (name/price/stock/photo/PIN) are NEVER
    //       overwritten. New rows come in with stock 0 and a
    //       warehouse branchStocks row. The merge only runs when the
    //       file already holds products (a real v2.0.0 install): a
    //       login-only recovery (0 products) stays empty — the
    //       fresh-seed path owns the empty case.
    //   (d) Any missing v2.1.0 table is created as an empty array.
    //   (e) Missing settings keys are filled with defaults; existing
    //       settings are never changed.
    if (!this.state.settings || !this.state.settings.v210Migrated) {
      try {
        // Safety backup FIRST — but only when there is product data
        // to protect. An empty (or login-only) state has nothing to
        // lose, and writing a backup of it would pollute backups/
        // with an empty file (it also broke the Electron L3b check,
        // which asserts a fresh empty-state app writes NO backup).
        if ((this.state.products || []).length > 0) {
          try { this.backup(); } catch (e) { /* safety backup is best-effort */ }
        }
        let changed = false;
        const users = this.state.appUsers || [];
        const hasCounter = users.some((u) => String(u.username || '').toLowerCase() === 'counter' || u.role === 'Counter Manager');
        if (!hasCounter && users.length > 0) {
          users.push({ id: this.nextId('appUsers'), name: 'Counter Manager', username: 'counter',
            pinHash: this.hashPin('1234'), role: 'Counter Manager', branchId: null, branchName: null,
            isPosOnly: true, isActive: true });
          changed = true;
        }
        const mgrUser = users.find((u) => u.name === 'Manager');
        if (mgrUser) { mgrUser.name = 'Warehouse'; changed = true; }
        const NEW_TABLES = ['sales', 'saleLines', 'heldOrders', 'khataCustomers', 'khataPayments',
          'shifts', 'staff', 'staffAttendance', 'shiftExpenses', 'deletedSales',
          'batches', 'wastage', 'expenses', 'recipes'];
        NEW_TABLES.forEach((t) => {
          if (!Array.isArray(this.state[t])) { this.state[t] = []; changed = true; }
        });
        if ((this.state.products || []).length > 0) {
          try {
            const seedRaw = fs.readFileSync(SEED_FILE, 'utf8');
            const seedParsed = JSON.parse(seedRaw);
            const have = new Set((this.state.products || []).map((p) => String(p.id)));
            (seedParsed.products || []).forEach((sp) => {
              if (Number(sp.id) < 63) return; // only the video-menu rows merge; base 44 are never touched
              if (have.has(String(sp.id))) return;
              this.state.products.push(JSON.parse(JSON.stringify(sp)));
              have.add(String(sp.id));
              changed = true;
            });
          } catch (e) { /* a missing/unreadable seed must never block the migration */ }
        }
        if (!this.state.settings) this.state.settings = {};
        const s = this.state.settings;
        const fill = (k, v) => { if (s[k] == null) { s[k] = v; changed = true; } };
        fill('managerCanSeeCost', false);
        fill('posServiceCharge', { type: 'flat', value: 0 });
        fill('posBillCopies', 1);
        fill('kotEnabled', true);
        fill('kotRemarks', true);
        fill('backupFormatVersion', 2);
        s.v210Migrated = true;
        if (changed) { this.buildIndexes(); try { this.save(); } catch (e) { /* migration lives in memory until the next save */ } }
      } catch (e) { /* a failed migration must never block loading */ }
    }
    // Field defaults for older rows (idempotent, runs every load):
    // products without expiryTracked behave as not tracked, and
    // without costPrice as "no production cost yet". No row is ever
    // overwritten — only a missing field is filled.
    (this.state.products || []).forEach((p) => {
      if (p.expiryTracked == null) p.expiryTracked = false;
      if (p.costPrice === undefined) p.costPrice = null;
    });
    // Settings defaults for older data files.
    if (!this.state.settings) this.state.settings = {};
    if (this.state.settings.sessionTimeoutMinutes == null) this.state.settings.sessionTimeoutMinutes = 15;
    if (this.state.settings.lowStockNotifications == null) this.state.settings.lowStockNotifications = true;
    if (this.state.settings.defaultLowStockLimit == null) this.state.settings.defaultLowStockLimit = null;
    if (!this.state.settings.currency) this.state.settings.currency = 'PKR';
    if (this.state.settings.managerCanSeeCost == null) this.state.settings.managerCanSeeCost = false;
    if (this.state.settings.posServiceCharge == null) this.state.settings.posServiceCharge = { type: 'flat', value: 0 };
    if (this.state.settings.posBillCopies == null) this.state.settings.posBillCopies = 1;
    if (this.state.settings.kotEnabled == null) this.state.settings.kotEnabled = true;
    if (this.state.settings.kotRemarks == null) this.state.settings.kotRemarks = true;
    if (this.state.settings.backupFormatVersion == null) this.state.settings.backupFormatVersion = 2;
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
  // Per-item values for a transfer, from the line's stamped unitPrice
  // when present, else the product's CURRENT price (old transfers
  // carry no stamp, so the current price is the fallback — a line
  // whose stamp is null AND whose current price is null contributes
  // value null). No price is ever invented: a product with price null
  // contributes value null and sets the priceMissing flag so the UI
  // can say so plainly. The bill is about stock GIVEN, so quantities
  // are the dispatched qty. Cost = qty x purchasePrice (null when the
  // item has no purchase price); margin = value - cost when both are
  // known, else null. Read-only — no transfer record is ever changed.
  // Returns { rows: [{productId, name, qty, unit, price, lineValue,
  // priceMissing, costPrice, lineCost, lineMargin, marginKnown}],
  // totals: {qty, value, valueKnown, cost, costKnown, margin,
  // marginKnown}, priceMissing }.
  transferBillValues(transfer, products) {
    var byId = {};
    (products || []).forEach(function (p) { byId[String(p.id)] = p; });
    var rows = [];
    var totals = { qty: 0, value: 0, valueKnown: true, cost: 0, costKnown: true, margin: 0, marginKnown: true };
    var priceMissing = false;
    (transfer && Array.isArray(transfer.items) ? transfer.items : []).forEach(function (it) {
      var prod = it.productId != null ? byId[String(it.productId)] : null;
      var qty = Number(it.qty) || 0;
      // Stamped supply value wins; current price is the fallback for
      // pre-v2.1.0 transfers whose lines carry no stamp.
      var price = (it.unitPrice != null && !isNaN(Number(it.unitPrice))) ? Number(it.unitPrice)
        : (prod && prod.price != null ? Number(prod.price) : null);
      if (qty > 0 && (price == null || isNaN(price))) priceMissing = true;
      var costPrice = (prod && prod.purchasePrice != null && !isNaN(Number(prod.purchasePrice))) ? Number(prod.purchasePrice) : null;
      if (qty > 0 && costPrice == null) totals.costKnown = false;
      var row = {
        productId: it.productId != null ? String(it.productId) : null,
        name: (prod && prod.name) || it.name || it.productName || 'Item',
        unit: (prod && prod.unit) || it.unit || '',
        qty: qty, price: price,
        lineValue: price == null ? null : qty * price,
        priceMissing: price == null,
        costPrice: costPrice,
        lineCost: costPrice == null ? null : qty * costPrice,
        lineMargin: (price == null || costPrice == null) ? null : (qty * price - qty * costPrice),
        marginKnown: price != null && costPrice != null
      };
      rows.push(row);
      totals.qty += qty;
      if (row.lineValue != null) totals.value += row.lineValue;
      else totals.valueKnown = false;
      if (row.lineCost != null) totals.cost += row.lineCost;
      else totals.marginKnown = false;
      if (row.lineMargin != null) totals.margin += row.lineMargin;
      else totals.marginKnown = false;
    });
    if (!totals.costKnown) totals.cost = null;
    if (!totals.marginKnown) totals.margin = null;
    // When a value is unknown the partial sum stays, but
    // valueKnown=false says plainly that it is incomplete.
    return { rows: rows, totals: totals, priceMissing: priceMissing };
  },

  // Bill number for a production: PB-0001, PB-0002, ... (id-based,
  // same pattern as the transfer bill SB-XXXX).
  productionBillNo(production) {
    return 'PB-' + String(production.id == null ? '' : production.id).padStart(4, '0');
  },

  // Raw -> Finish production, as ONE validated transaction.
  //   completeProduction({ finishProductId, finishQty, lines, createdBy, clientRef, warehouseBranchId, user, recipeId })
  //   lines: [{ productId, qty }] — raw items and the quantity of
  //   each used. warehouseBranchId defaults to DB.WAREHOUSE_ID
  //   (the real Warehouse location, separate from the 3 branches).
  //   user: the login doing the production (role 'Owner' is REJECTED
  //   — the Owner never produces; Warehouse does). When no user is
  //   passed (tests / legacy callers) the role check is skipped.
  //   recipeId: when lines are omitted, the saved recipe's lines
  //   are used instead.
  // Validation runs FIRST and rejects the whole cart when ANY line
  // is short — over-stock is rejected with NO stock moved at all.
  // On success: raw is deducted at the Warehouse, the finish is
  // added at the Warehouse, one stockMovement per leg is recorded
  // (clientRef deduped, so a double submit cannot double-count),
  // and a production record is stored with the bill number.
  // Costing uses each raw item's purchasePrice; a line whose
  // purchasePrice is null contributes no cost and makes costKnown
  // false — no cost is ever invented. costPerUnit = totalCost /
  // finishQty when the full cost is known, else null. When costKnown,
  // the finish item's costPrice is set to costPerUnit — production
  // is the ONLY writer of costPrice (no UI edit ever touches it).
  // Returns { ok: true, production } or { ok: false, message }.
  completeProduction(opts) {
    const finishQty = Number(opts && opts.finishQty) || 0;
    let lines = (opts && Array.isArray(opts.lines)) ? opts.lines : [];
    const warehouseId = (opts && opts.warehouseBranchId != null) ? opts.warehouseBranchId : this.WAREHOUSE_ID;
    // Owner gate: the Owner never runs production (web v53 rule).
    const callerRole = (opts && opts.user && opts.user.role) || (opts && opts.callerRole) || null;
    if (callerRole === 'Owner') return { ok: false, message: 'Owner production nahi kar sakta — production Warehouse ka kaam hai.' };
    // Recipe lines: when no ad-hoc lines are given, a saved recipe
    // supplies them (quantities are per-batch as stored on the recipe).
    if (lines.length === 0 && opts && opts.recipeId != null) {
      const recipe = (this.state.recipes || []).find((r) => String(r.id) === String(opts.recipeId));
      if (!recipe) return { ok: false, message: 'Recipe nahi mili.' };
      lines = (recipe.lines || []).map((l) => ({ productId: l.productId, qty: l.qty }));
    }
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
      createdBy, clientRef, recipeId: (opts && opts.recipeId) || null
    };
    if (!Array.isArray(this.state.productions)) this.state.productions = [];
    this.state.productions.unshift(production);
    // Production is the ONLY writer of products.costPrice: when the
    // full cost is known, the finish item's cost becomes the
    // per-unit production cost. When cost is unknown, the old
    // costPrice (if any) is left exactly as it was.
    if (production.costKnown && production.costPerUnit != null) {
      finish.costPrice = production.costPerUnit;
    }
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
    if (reason.indexOf('Wastage') === 0) return false; // wastage, not a sale
    if (reason.indexOf('Sale') === 0) return true; // counter sale (Sale SL-0001 — ...)
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
  },

  /* ================= v2.1.0 — helpers ================= */
  _ensureColl(name) {
    if (!Array.isArray(this.state[name])) this.state[name] = [];
    return this.state[name];
  },
  // Keep the cached max-id index in step after an insert, so a
  // second nextId() in the same call (e.g. several sale lines in
  // one sale) never hands out the same id twice.
  _noteId(coll, id) {
    const idx = this.indexes;
    if (idx && typeof id === 'number' && (typeof idx.maxId[coll] !== 'number' || id > idx.maxId[coll])) idx.maxId[coll] = id;
  },
  // Local YYYY-MM-DD (the app works in the shop's local day).
  _todayLocal(d) {
    const dt = d instanceof Date ? d : new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  },
  _dayOf(iso) { return String(iso || '').slice(0, 10); },
  _addDays(dayStr, n) {
    const d = new Date(dayStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return this._todayLocal(d);
  },
  // Date range for a chip: 'today' | 'yesterday' | 'thisWeek' |
  // 'thisMonth'. Returns { from, to } as local YYYY-MM-DD.
  dateRangeFor(chip) {
    const today = this._todayLocal();
    if (chip === 'yesterday') { const y = this._addDays(today, -1); return { from: y, to: y }; }
    if (chip === 'thisWeek') {
      const d = new Date(today + 'T12:00:00');
      const dow = (d.getDay() + 6) % 7; // Monday = 0
      return { from: this._addDays(today, -dow), to: today };
    }
    if (chip === 'thisMonth') return { from: today.slice(0, 8) + '01', to: today };
    return { from: today, to: today };
  },

  /* ================= v2.1.0 — items & cost gating ================= */
  // CENTRAL item patcher — every item edit in the app must go through
  // this. purchasePrice AND costPrice are ALWAYS dropped from the
  // patch, for Owner and non-Owner alike: purchasePrice changes only
  // via DB.setItemCostPrice (Owner-only), costPrice only via
  // production (DB.completeProduction). Returns { ok, product } or
  // { ok: false, message }.
  updateItem(productId, patch, user) {
    const product = this.productById(productId);
    if (!product) return { ok: false, message: 'Item nahi mila.' };
    const clean = Object.assign({}, patch || {});
    delete clean.purchasePrice;
    delete clean.costPrice;
    delete clean.id;
    delete clean.stock;
    delete clean.branchStocks;
    const allowed = ['name', 'price', 'category', 'type', 'unit', 'sku', 'barcode', 'lowThreshold', 'status', 'image', 'expiryTracked'];
    const next = {};
    allowed.forEach((k) => { if (clean[k] !== undefined) next[k] = clean[k]; });
    if (next.name != null && String(next.name).trim() === '') return { ok: false, message: 'Item ka naam khaali nahi ho sakta.' };
    if (next.price != null && (isNaN(Number(next.price)) || Number(next.price) < 0)) return { ok: false, message: 'Price durust likhein (0 ya zyada).' };
    const uniq = this.checkUniqueness('products', Object.assign({}, product, next), product.id);
    if (!uniq.ok) return uniq;
    Object.assign(product, next);
    this.buildIndexes();
    return { ok: true, product };
  },

  // Who may SEE a cost (purchasePrice / costPrice)? Owner: always.
  // Manager (Warehouse): only when the Owner switched
  // settings.managerCanSeeCost ON. Counter Manager and everyone
  // else: never.
  canSeeCost(user) {
    if (!user) return false;
    if (user.role === 'Owner') return true;
    if (user.role === 'Manager') return (this.state.settings || {}).managerCanSeeCost === true;
    return false;
  },

  // Owner-only cost setter: the ONLY way to change an item's
  // purchasePrice (the master cost). A purchase never changes it,
  // and updateItem never changes it. Returns { ok, product } or
  // { ok: false, message }.
  setItemCostPrice(itemId, purchasePrice, user) {
    if (!user || user.role !== 'Owner') return { ok: false, message: 'Sirf Owner cost price set kar sakta hai.' };
    const product = this.productById(itemId);
    if (!product) return { ok: false, message: 'Item nahi mila.' };
    if (purchasePrice != null && (isNaN(Number(purchasePrice)) || Number(purchasePrice) < 0)) {
      return { ok: false, message: 'Cost price durust likhein (0 ya zyada, ya khaali).' };
    }
    product.purchasePrice = purchasePrice == null ? null : Number(purchasePrice);
    return { ok: true, product };
  },

  // Bill number for a sale: SL-0001, SL-0002, ... (saleNo-based,
  // same pad-4 pattern as SB-XXXX / PB-XXXX).
  saleBillNo(sale) {
    return 'SL-' + String(sale.saleNo == null ? '' : sale.saleNo).padStart(4, '0');
  },

  /* ================= v2.1.0 — shifts ================= */
  // The one open shift, or null. At most one shift is open at a time.
  getOpenShift() {
    return (this.state.shifts || []).find((s) => s.status === 'open') || null;
  },
  getShiftState() {
    const open = this.getOpenShift();
    const closed = (this.state.shifts || []).filter((s) => s.status === 'closed')
      .slice().sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
    return { openShift: open || null, history: closed };
  },
  // Start a shift. Rejects when another shift is already open.
  // clientRef dedupe: the same clientRef returns the original shift.
  // Returns { ok, shift } or { ok: false, message }.
  startShift(opts) {
    const open = this.getOpenShift();
    if (open) return { ok: false, message: 'Aik shift pehle se khuli hui hai (' + (open.cashierName || 'Cashier') + ') — pehle usay band karein.' };
    const clientRef = (opts && opts.clientRef) || null;
    if (clientRef) {
      const prev = (this.state.shifts || []).find((s) => s.clientRef === clientRef);
      if (prev) return { ok: true, shift: prev, duplicate: true };
    }
    const opening = Number((opts && opts.openingBalance) || 0);
    if (isNaN(opening) || opening < 0) return { ok: false, message: 'Opening balance durust likhein (0 ya zyada).' };
    const shift = {
      id: this.nextId('shifts'),
      cashierId: (opts && opts.cashierId) || null,
      cashierName: (opts && opts.cashierName) || '',
      openingBalance: opening,
      deposit: 0, withdrawal: 0, notes: '',
      status: 'open',
      startedAt: new Date().toISOString(),
      endedAt: null,
      clientRef: clientRef,
      closeClientRef: null,
      // Closing snapshot (stamped by closeShift, null while open).
      totalSales: null, billCount: null, cashBills: null, khataPaid: null,
      stillKhata: null, cardOther: null, cashInDrawer: null, nextOpening: null,
      closing: null
    };
    this._ensureColl('shifts').push(shift);
    this._noteId('shifts', shift.id);
    return { ok: true, shift };
  },
  // Close a shift and stamp the closing snapshot. countedDrawer is
  // the cash actually counted in the drawer; ownerDeposit /
  // ownerWithdrawal are entered on the Close screen.
  // expectedDrawer = opening + cashSales - expenses + deposit -
  // withdrawal; difference = counted - expected. nextOpening =
  // countedDrawer (the next shift opens with what was counted).
  // Returns { ok, shift } or { ok: false, message }.
  closeShift(opts) {
    const shift = (this.state.shifts || []).find((s) => String(s.id) === String(opts && opts.shiftId));
    if (!shift) return { ok: false, message: 'Shift nahi mili.' };
    if (shift.status !== 'open') return { ok: false, message: 'Ye shift pehle se band hai.' };
    const closeClientRef = (opts && opts.closeClientRef) || null;
    if (closeClientRef && shift.closeClientRef === closeClientRef) return { ok: true, shift, duplicate: true };
    const counted = Number((opts && opts.countedDrawer) || 0);
    if (isNaN(counted) || counted < 0) return { ok: false, message: 'Counted cash durust likhein (0 ya zyada).' };
    const deposit = Number((opts && opts.ownerDeposit) || 0);
    const withdrawal = Number((opts && opts.ownerWithdrawal) || 0);
    if (isNaN(deposit) || deposit < 0 || isNaN(withdrawal) || withdrawal < 0) {
      return { ok: false, message: 'Deposit/withdrawal durust likhein (0 ya zyada).' };
    }
    const sales = (this.state.sales || []).filter((s) => String(s.shiftId) === String(shift.id) && !s.voidedAt);
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
    const expensesTotal = (this.state.shiftExpenses || [])
      .filter((e) => String(e.shiftId) === String(shift.id))
      .reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const expectedDrawer = (Number(shift.openingBalance) || 0) + cashSales - expensesTotal + deposit - withdrawal;
    const closing = {
      openingBalance: Number(shift.openingBalance) || 0,
      totalSales, billCount: sales.length, cashSales,
      byPayment, khataPaid, stillKhata, cardOther,
      expensesTotal, ownerDeposit: deposit, ownerWithdrawal: withdrawal,
      expectedDrawer, countedDrawer: counted,
      difference: counted - expectedDrawer,
      nextOpening: counted,
      closedBy: (opts && opts.recordedBy) || ''
    };
    shift.status = 'closed';
    shift.endedAt = new Date().toISOString();
    shift.deposit = deposit;
    shift.withdrawal = withdrawal;
    shift.notes = (opts && opts.notes) || '';
    shift.closeClientRef = closeClientRef;
    shift.totalSales = totalSales;
    shift.billCount = sales.length;
    shift.cashBills = cashSales;
    shift.khataPaid = khataPaid;
    shift.stillKhata = stillKhata;
    shift.cardOther = cardOther;
    shift.cashInDrawer = expectedDrawer;
    shift.nextOpening = counted;
    shift.closing = closing;
    return { ok: true, shift };
  },
  // Shift expense (the Close Shift "Expenses" line). The shift must
  // exist; amount must be > 0.
  addShiftExpense(opts) {
    const shift = (this.state.shifts || []).find((s) => String(s.id) === String(opts && opts.shiftId));
    if (!shift) return { ok: false, message: 'Shift nahi mili — pehle shift start karein.' };
    const amount = Number(opts && opts.amount) || 0;
    if (!amount || amount <= 0) return { ok: false, message: 'Kharch ki raqam durust likhein (0 se zyada).' };
    const expense = {
      id: this.nextId('shiftExpenses'),
      shiftId: shift.id,
      amount,
      note: (opts && opts.note) || '',
      recordedBy: (opts && opts.recordedBy) || '',
      occurredAt: (opts && opts.occurredAt) || new Date().toISOString()
    };
    this._ensureColl('shiftExpenses').push(expense);
    this._noteId('shiftExpenses', expense.id);
    return { ok: true, expense };
  },
  listShiftExpenses(shiftId) {
    return (this.state.shiftExpenses || []).filter((e) => String(e.shiftId) === String(shiftId));
  },

  /* ================= v2.1.0 — counter sales ================= */
  // Counter sale, as ONE validated transaction.
  //   createSale({ lines: [{productId, qty}], orderType, tableNo,
  //     branchId (null = warehouse counter), paymentMethod, customerId,
  //     discount, deliveryCharges, serviceCharge, amountPaid, clientRef,
  //     shiftId, cashierId, cashierName, note, recordedBy, occurredAt })
  // Rules (web v53): an OPEN SHIFT is required — a sale with no open
  // shift is rejected; every line must have a sale price (an unpriced
  // item rejects the whole sale, nothing is cut); stock is deducted
  // at the sale location (branchId, or the Warehouse when null) and
  // one movement per line is recorded with reason 'Sale SL-…'
  // (negative qty, so isSaleMovement counts it); clientRef dedupe —
  // a second call with the same clientRef returns { duplicate: true }
  // with the original sale and cuts no stock again. Prices are
  // stamped from items.price at sale time. Khata sales need an
  // existing khata customer; their unpaid rest is the balance due.
  // total = subtotal - discount + deliveryCharges + serviceCharge.
  // serviceCharge: when not passed, it is computed from
  // settings.posServiceCharge (flat Rs, or % of subtotal).
  // Returns { ok: true, sale, billNo } or { ok: false, message }.
  createSale(opts) {
    const lines = (opts && Array.isArray(opts.lines)) ? opts.lines : [];
    const branchId = (opts && opts.branchId != null) ? opts.branchId : null;
    const locId = branchId == null ? this.WAREHOUSE_ID : branchId;
    const paymentMethods = ['Cash', 'JazzCash', 'Easypaisa', 'Card', 'Bank', 'Khata'];
    const paymentMethod = (opts && opts.paymentMethod) || 'Cash';
    if (paymentMethods.indexOf(paymentMethod) === -1) return { ok: false, message: 'Payment method durust chunein.' };
    if (lines.length === 0) return { ok: false, message: 'Pehle cart mein kam az kam aik item add karein.' };
    // Shift gate: an explicit shiftId wins, else the open shift.
    let shift = null;
    if (opts && opts.shiftId != null) {
      shift = (this.state.shifts || []).find((s) => String(s.id) === String(opts.shiftId));
    }
    if (!shift) shift = this.getOpenShift();
    if (!shift || shift.status !== 'open') {
      return { ok: false, message: 'Pehle shift start karein — bina shift ke sale nahi ho sakti.' };
    }
    // Idempotency FIRST: the same clientRef returns the original sale.
    const clientRef = (opts && opts.clientRef) || null;
    if (clientRef) {
      const prev = (this.state.sales || []).find((s) => s.clientRef === clientRef);
      if (prev) return { ok: true, sale: prev, billNo: this.saleBillNo(prev), duplicate: true };
    }
    // Khata needs a real customer.
    let customer = null;
    if (paymentMethod === 'Khata') {
      customer = (this.state.khataCustomers || []).find((c) => String(c.id) === String(opts && opts.customerId));
      if (!customer) return { ok: false, message: 'Khata sale ke liye pehle customer chunein.' };
    }
    // ---- validate every line BEFORE moving anything ----
    const checked = [];
    for (const ln of lines) {
      const qty = Number(ln.qty) || 0;
      const product = this.productById(ln.productId);
      if (!product) return { ok: false, message: 'Item nahi mila (id ' + ln.productId + ').' };
      if (product.type !== 'finished') return { ok: false, message: '"' + (product.name || '') + '" counter par sale nahi ho sakta — sirf tayyar (finished) items bikte hain.' };
      if (!qty || qty <= 0) return { ok: false, message: '"' + (product.name || '') + '" ki miqdaar durust likhein.' };
      if (product.price == null || isNaN(Number(product.price))) {
        return { ok: false, message: '"' + (product.name || '') + '" ka rate nahi hai — pehle is ki price set karein. Sale nahi hui, kuch bhi kata nahi.' };
      }
      const avail = this.stockOf(product, locId);
      if (qty > avail && !(this.state.settings && this.state.settings.allowNegativeStock)) {
        return { ok: false, message: '"' + (product.name || '') + '" ka itna stock nahi hai — yahan sirf ' + avail + ' ' + (product.unit || '') + ' hai, aap ne ' + qty + ' manga hai. Kuch bhi kata nahi.' };
      }
      // FEFO: an expiry-tracked item is picked from its batches,
      // earliest expiry first; expired batches are never used.
      let picks = null;
      if (product.expiryTracked) {
        const fefo = this.fefoPick(product.id, locId, qty);
        if (!fefo.ok) return { ok: false, message: fefo.message };
        picks = fefo.picks;
      }
      checked.push({ productId: product.id, name: product.name, unit: product.unit || '',
        qty, unitPrice: Number(product.price), lineTotal: qty * Number(product.price),
        availableBefore: avail, picks });
    }
    const subtotal = checked.reduce((a, l) => a + l.lineTotal, 0);
    const discount = Math.max(0, Number((opts && opts.discount) || 0));
    const deliveryCharges = Math.max(0, Number((opts && opts.deliveryCharges) || 0));
    let serviceCharge;
    if (opts && opts.serviceCharge != null) serviceCharge = Math.max(0, Number(opts.serviceCharge) || 0);
    else {
      const sc = (this.state.settings || {}).posServiceCharge || { type: 'flat', value: 0 };
      serviceCharge = sc.type === 'percent' ? subtotal * (Number(sc.value) || 0) / 100 : (Number(sc.value) || 0);
    }
    const total = Math.max(0, subtotal - discount + deliveryCharges + serviceCharge);
    const amountPaid = (opts && opts.amountPaid != null) ? Math.max(0, Number(opts.amountPaid) || 0)
      : (paymentMethod === 'Khata' ? 0 : total);
    const orderType = (opts && opts.orderType) || 'takeaway';
    const tableNo = orderType === 'dine_in' && opts && opts.tableNo != null ? Number(opts.tableNo) : null;
    const saleNo = ((this.state.sales || []).reduce((m, s) => Math.max(m, Number(s.saleNo) || 0), 0)) + 1;
    const orderNo = ((this.state.sales || []).filter((s) => String(s.shiftId) === String(shift.id))
      .reduce((m, s) => Math.max(m, Number(s.orderNo) || 0), 0)) + 1;
    const id = this.nextId('sales');
    const billNo = 'SL-' + String(saleNo).padStart(4, '0');
    const now = (opts && opts.occurredAt) || new Date().toISOString();
    const recordedBy = (opts && opts.recordedBy) || '';
    const sale = {
      id, saleNo, orderType, tableNo, branchId,
      paymentMethod, customerId: customer ? customer.id : null,
      subtotal, discount, deliveryCharges, serviceCharge, total, amountPaid,
      clientRef, shiftId: shift.id, orderNo,
      cashierId: (opts && opts.cashierId) || null,
      cashierName: (opts && opts.cashierName) || '',
      voidedAt: null, voidedBy: null,
      note: (opts && opts.note) || '', recordedBy, occurredAt: now
    };
    this._ensureColl('sales').push(sale);
    this._noteId('sales', sale.id);
    checked.forEach((l) => {
      const lineId = this.nextId('saleLines');
      this._ensureColl('saleLines').push({
        id: lineId,
        saleId: sale.id, itemId: l.productId, quantity: l.qty, unitPrice: l.unitPrice
      });
      this._noteId('saleLines', lineId);
      const product = this.productById(l.productId);
      this.setStock(product, locId, this.stockOf(product, locId) - l.qty);
      this.addMovement({ productId: l.productId, productName: l.name, branchId: locId, qty: -l.qty,
        reason: 'Sale ' + billNo + ' — ' + l.name, user: recordedBy,
        reference: billNo, clientRef: clientRef ? clientRef + ':line:' + l.productId : null });
      if (l.picks) this._consumeBatches(l.picks);
    });
    return { ok: true, sale, billNo };
  },

  // One sale with its lines (for the bill / history screens).
  // Returns { sale, lines: [{...line, name, unit}] } or null.
  getSaleBill(saleId) {
    const sale = (this.state.sales || []).find((s) => String(s.id) === String(saleId));
    if (!sale) return null;
    const lines = (this.state.saleLines || []).filter((l) => String(l.saleId) === String(sale.id))
      .map((l) => {
        const p = this.productById(l.itemId);
        return Object.assign({}, l, { name: (p && p.name) || 'Item', unit: (p && p.unit) || '' });
      });
    return { sale, lines };
  },

  // Void a sale: the row STAYS (voidedAt/voidedBy stamp), its stock
  // movements are REMOVED so the stock comes back, and the sale
  // leaves every total (Summary, Dashboard, Close Shift) and the
  // khata balance (khata is derived from non-voided sales). A
  // voided sale cannot be voided twice.
  // Returns { ok, sale } or { ok: false, message }.
  voidSale(saleId, user) {
    const sale = (this.state.sales || []).find((s) => String(s.id) === String(saleId));
    if (!sale) return { ok: false, message: 'Sale nahi mili.' };
    if (sale.voidedAt) return { ok: false, message: 'Ye sale pehle se void hai — dobara void nahi ho sakti.' };
    const billNo = this.saleBillNo(sale);
    const locId = sale.branchId == null ? this.WAREHOUSE_ID : sale.branchId;
    const lines = (this.state.saleLines || []).filter((l) => String(l.saleId) === String(sale.id));
    lines.forEach((l) => {
      const product = this.productById(l.itemId);
      if (product) this.setStock(product, locId, this.stockOf(product, locId) + (Number(l.quantity) || 0));
    });
    this.state.stockMovements = (this.state.stockMovements || []).filter((m) =>
      !(m.reference === billNo && String(m.reason || '').indexOf('Sale') === 0));
    sale.voidedAt = new Date().toISOString();
    sale.voidedBy = (user && (user.name || user.username)) || '';
    this.buildIndexes();
    return { ok: true, sale };
  },

  // Delete a sale — OWNER ONLY. The row is removed (its lines too),
  // the stock comes back exactly like a void, and a snapshot lands
  // in deletedSales so the Summary can still show a true Deleted
  // count. Returns { ok, deleted: { saleNo, total } } or
  // { ok: false, message }.
  deleteSale(saleId, user) {
    if (!user || user.role !== 'Owner') return { ok: false, message: 'Sirf Owner sale delete kar sakta hai.' };
    const sale = (this.state.sales || []).find((s) => String(s.id) === String(saleId));
    if (!sale) return { ok: false, message: 'Sale nahi mili.' };
    const lines = (this.state.saleLines || []).filter((l) => String(l.saleId) === String(sale.id));
    if (!sale.voidedAt) {
      // Stock returns (same as a void); a voided sale's stock is
      // already back, so this runs only for live sales.
      const billNo = this.saleBillNo(sale);
      const locId = sale.branchId == null ? this.WAREHOUSE_ID : sale.branchId;
      lines.forEach((l) => {
        const product = this.productById(l.itemId);
        if (product) this.setStock(product, locId, this.stockOf(product, locId) + (Number(l.quantity) || 0));
      });
      this.state.stockMovements = (this.state.stockMovements || []).filter((m) =>
        !(m.reference === billNo && String(m.reason || '').indexOf('Sale') === 0));
    }
    const snapshot = JSON.parse(JSON.stringify({ sale, lines }));
    const delId = this.nextId('deletedSales');
    this._ensureColl('deletedSales').push({
      id: delId,
      saleNo: sale.saleNo,
      orderType: sale.orderType,
      paymentMethod: sale.paymentMethod,
      total: sale.total,
      deletedBy: user.name || user.username || '',
      occurredAt: sale.occurredAt,
      deletedAt: new Date().toISOString(),
      snapshotJson: JSON.stringify(snapshot)
    });
    this._noteId('deletedSales', delId);
    this.state.sales = (this.state.sales || []).filter((s) => String(s.id) !== String(sale.id));
    this.state.saleLines = (this.state.saleLines || []).filter((l) => String(l.saleId) !== String(sale.id));
    this.buildIndexes();
    return { ok: true, deleted: { saleNo: sale.saleNo, total: sale.total } };
  },

  /* ================= v2.1.0 — hold orders & tables ================= */
  // Park a cart: lines are stored as JSON [{itemId, quantity}] with
  // NO prices — on resume the cart uses each item's CURRENT price.
  // Returns { ok, heldOrder } or { ok: false, message }.
  holdOrder(opts) {
    const lines = (opts && Array.isArray(opts.lines)) ? opts.lines : [];
    if (lines.length === 0) return { ok: false, message: 'Pehle cart mein kam az kam aik item add karein.' };
    for (const ln of lines) {
      const qty = Number(ln.qty) || 0;
      if (!this.productById(ln.itemId)) return { ok: false, message: 'Item nahi mila (id ' + ln.itemId + ').' };
      if (!qty || qty <= 0) return { ok: false, message: 'Miqdaar durust likhein.' };
    }
    const held = {
      id: this.nextId('heldOrders'),
      orderType: (opts && opts.orderType) || 'takeaway',
      tableNo: (opts && opts.tableNo) != null ? Number(opts.tableNo) : null,
      branchId: (opts && opts.branchId != null) ? opts.branchId : null,
      linesJson: JSON.stringify(lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.qty) || 0 }))),
      note: (opts && opts.note) || '',
      recordedBy: (opts && opts.recordedBy) || '',
      createdAt: new Date().toISOString()
    };
    this._ensureColl('heldOrders').push(held);
    this._noteId('heldOrders', held.id);
    return { ok: true, heldOrder: held };
  },
  // Resume a held order: the cart is rebuilt from CURRENT prices.
  // Returns { ok, cart } or { ok: false, message }.
  resumeHoldOrder(heldId) {
    const held = (this.state.heldOrders || []).find((h) => String(h.id) === String(heldId));
    if (!held) return { ok: false, message: 'Hold order nahi mila.' };
    let raw = [];
    try { raw = JSON.parse(held.linesJson || '[]'); } catch (e) { raw = []; }
    const lines = raw.map((l) => {
      const p = this.productById(l.itemId);
      return { itemId: l.itemId, quantity: l.quantity, name: (p && p.name) || 'Item',
        unit: (p && p.unit) || '', unitPrice: p ? p.price : null };
    });
    return { ok: true, cart: { orderType: held.orderType, tableNo: held.tableNo,
      branchId: held.branchId, note: held.note, lines } };
  },
  deleteHoldOrder(heldId) {
    const before = (this.state.heldOrders || []).length;
    this.state.heldOrders = (this.state.heldOrders || []).filter((h) => String(h.id) !== String(heldId));
    if (this.state.heldOrders.length === before) return { ok: false, message: 'Hold order nahi mila.' };
    return { ok: true };
  },
  // Table state (dine-in tables 1-9): busy when an active held
  // dine-in order sits on it. Returns { tableNo, busy, since, heldOrderId }.
  tableStatus(tableNo) {
    const held = (this.state.heldOrders || []).find((h) =>
      h.orderType === 'dine_in' && Number(h.tableNo) === Number(tableNo));
    if (!held) return { tableNo: Number(tableNo), busy: false, since: null, heldOrderId: null };
    return { tableNo: Number(tableNo), busy: true, since: held.createdAt, heldOrderId: held.id };
  },

  /* ================= v2.1.0 — khata ================= */
  // Khata customer: the NAME is required (a customer without a name
  // is rejected). No uniqueness rule on the web side — none here.
  addKhataCustomer(opts) {
    const name = String((opts && opts.name) || '').trim();
    if (!name) return { ok: false, message: 'Khata customer ka naam zaroori hai — bina naam ke customer nahi ban sakta.' };
    const customer = {
      id: this.nextId('khataCustomers'),
      name,
      phone: String((opts && opts.phone) || '').trim(),
      createdAt: new Date().toISOString()
    };
    this._ensureColl('khataCustomers').push(customer);
    this._noteId('khataCustomers', customer.id);
    return { ok: true, customer };
  },
  // Derived balance: sum of the customer's Khata sale totals minus
  // everything paid (paid at sale time + later payments). Voided
  // sales are excluded.
  khataBalance(customerId) {
    const salesTotal = (this.state.sales || [])
      .filter((s) => s.paymentMethod === 'Khata' && String(s.customerId) === String(customerId) && !s.voidedAt)
      .reduce((a, s) => a + ((Number(s.total) || 0) - (Number(s.amountPaid) || 0)), 0);
    const paid = (this.state.khataPayments || [])
      .filter((p) => String(p.customerId) === String(customerId))
      .reduce((a, p) => a + (Number(p.amount) || 0), 0);
    return salesTotal - paid;
  },
  // Ledger: Khata sales and payments for one customer, oldest first.
  khataLedger(customerId) {
    const customer = (this.state.khataCustomers || []).find((c) => String(c.id) === String(customerId));
    if (!customer) return { ok: false, message: 'Khata customer nahi mila.' };
    const entries = [];
    (this.state.sales || [])
      .filter((s) => s.paymentMethod === 'Khata' && String(s.customerId) === String(customerId) && !s.voidedAt)
      .forEach((s) => entries.push({ type: 'sale', date: s.occurredAt, saleNo: s.saleNo,
        billNo: this.saleBillNo(s), total: s.total, paid: s.amountPaid }));
    (this.state.khataPayments || [])
      .filter((p) => String(p.customerId) === String(customerId))
      .forEach((p) => entries.push({ type: 'payment', date: p.occurredAt, amount: p.amount,
        note: p.note || '' }));
    entries.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    return { ok: true, customer, balance: this.khataBalance(customerId), entries };
  },
  recordKhataPayment(opts) {
    const customer = (this.state.khataCustomers || []).find((c) => String(c.id) === String(opts && opts.customerId));
    if (!customer) return { ok: false, message: 'Khata customer nahi mila.' };
    const amount = Number(opts && opts.amount) || 0;
    if (!amount || amount <= 0) return { ok: false, message: 'Payment ki raqam durust likhein (0 se zyada).' };
    const payment = {
      id: this.nextId('khataPayments'),
      customerId: customer.id,
      amount,
      note: (opts && opts.note) || '',
      recordedBy: (opts && opts.recordedBy) || '',
      occurredAt: (opts && opts.occurredAt) || new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    this._ensureColl('khataPayments').push(payment);
    this._noteId('khataPayments', payment.id);
    return { ok: true, payment, balance: this.khataBalance(customer.id) };
  },

  /* ================= v2.1.0 — staff ================= */
  // POS staff (NOT logins — just names for the cashier picker, bills
  // and reports). Roles: Cashier | Rider | Road Side Waiter | Waiter.
  addStaff(opts) {
    const name = String((opts && opts.name) || '').trim();
    if (!name) return { ok: false, message: 'Staff ka naam zaroori hai.' };
    const roles = ['Cashier', 'Rider', 'Road Side Waiter', 'Waiter'];
    const role = (opts && opts.role) || 'Cashier';
    if (roles.indexOf(role) === -1) return { ok: false, message: 'Staff role durust chunein (Cashier / Rider / Road Side Waiter / Waiter).' };
    const clientRef = (opts && opts.clientRef) || null;
    if (clientRef) {
      const prev = (this.state.staff || []).find((s) => s.clientRef === clientRef);
      if (prev) return { ok: true, staff: prev, duplicate: true };
    }
    const member = {
      id: this.nextId('staff'),
      name, role,
      phone: String((opts && opts.phone) || '').trim(),
      nic: (opts && opts.nic) || null,
      imageBlobKey: null,
      active: 1,
      clientRef,
      createdAt: new Date().toISOString()
    };
    this._ensureColl('staff').push(member);
    this._noteId('staff', member.id);
    return { ok: true, staff: member };
  },
  // Soft-remove: bills and closings keep the stamped cashierName, so
  // history never breaks.
  deactivateStaff(staffId) {
    const member = (this.state.staff || []).find((s) => String(s.id) === String(staffId));
    if (!member) return { ok: false, message: 'Staff nahi mila.' };
    member.active = 0;
    return { ok: true, staff: member };
  },
  // Daily attendance: one row per staff member per day — re-marking
  // the same day UPDATES the same row (never a duplicate row).
  markAttendance(opts) {
    const member = (this.state.staff || []).find((s) => String(s.id) === String(opts && opts.staffId));
    if (!member) return { ok: false, message: 'Staff nahi mila.' };
    const day = (opts && opts.day) || this._todayLocal();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, message: 'Din durust likhein (YYYY-MM-DD).' };
    const status = (opts && opts.status) || 'present';
    if (status !== 'present' && status !== 'absent') return { ok: false, message: 'Attendance present ya absent hoti hai.' };
    const rows = this._ensureColl('staffAttendance');
    const existing = rows.find((r) => String(r.staffId) === String(member.id) && r.day === day);
    if (existing) {
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
      return { ok: true, attendance: existing, updated: true };
    }
    const row = { id: this.nextId('staffAttendance'), staffId: member.id, day, status,
      recordedBy: (opts && opts.recordedBy) || '', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString() };
    rows.push(row);
    this._noteId('staffAttendance', row.id);
    return { ok: true, attendance: row };
  },

  /* ================= v2.1.0 — recipes ================= */
  // Saved production recipe: a finish item + its raw lines.
  // completeProduction can take recipeId instead of ad-hoc lines.
  saveRecipe(opts) {
    const finish = this.productById(opts && opts.finishProductId);
    if (!finish) return { ok: false, message: 'Finish item nahi mila.' };
    if (finish.type !== 'finished') return { ok: false, message: '"' + (finish.name || '') + '" finish item nahi hai — recipe sirf Finish Goods ke liye hai.' };
    const lines = (opts && Array.isArray(opts.lines)) ? opts.lines : [];
    if (lines.length === 0) return { ok: false, message: 'Recipe mein kam az kam aik raw item chahiye.' };
    for (const ln of lines) {
      const raw = this.productById(ln.productId);
      if (!raw) return { ok: false, message: 'Raw item nahi mila (id ' + ln.productId + ').' };
      if (raw.type !== 'raw') return { ok: false, message: '"' + (raw.name || '') + '" raw item nahi hai.' };
      if (!(Number(ln.qty) > 0)) return { ok: false, message: '"' + (raw.name || '') + '" ki miqdaar durust likhein.' };
    }
    const recipe = {
      id: this.nextId('recipes'),
      finishProductId: finish.id,
      name: String((opts && opts.name) || '').trim() || (finish.name + ' Recipe'),
      lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) })),
      createdBy: (opts && opts.createdBy) || '',
      createdAt: new Date().toISOString()
    };
    this._ensureColl('recipes').push(recipe);
    this._noteId('recipes', recipe.id);
    return { ok: true, recipe };
  },
  listRecipes(finishProductId) {
    const all = this.state.recipes || [];
    if (finishProductId == null) return all.slice();
    return all.filter((r) => String(r.finishProductId) === String(finishProductId));
  },
  deleteRecipe(recipeId) {
    const before = (this.state.recipes || []).length;
    this.state.recipes = (this.state.recipes || []).filter((r) => String(r.id) !== String(recipeId));
    if (this.state.recipes.length === before) return { ok: false, message: 'Recipe nahi mili.' };
    return { ok: true };
  },

  /* ================= v2.1.0 — expiry batches (FEFO) & wastage ================= */
  // A stock batch for an expiry-tracked item (created on purchase).
  // expiryDate is YYYY-MM-DD and required for tracked items.
  addBatch(opts) {
    const product = this.productById(opts && opts.productId);
    if (!product) return { ok: false, message: 'Item nahi mila.' };
    const qty = Number(opts && opts.qty) || 0;
    if (!qty || qty <= 0) return { ok: false, message: 'Batch ki miqdaar durust likhein (0 se zyada).' };
    const expiryDate = String((opts && opts.expiryDate) || '').slice(0, 10);
    if (product.expiryTracked && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      return { ok: false, message: 'Expiry-tracked item ke liye expiry date zaroori hai (YYYY-MM-DD).' };
    }
    const batch = {
      id: this.nextId('batches'),
      productId: product.id,
      qty,
      expiryDate: expiryDate || null,
      purchaseId: (opts && opts.purchaseId) || null,
      branchId: (opts && opts.branchId != null) ? opts.branchId : this.WAREHOUSE_ID,
      createdAt: new Date().toISOString()
    };
    this._ensureColl('batches').push(batch);
    this._noteId('batches', batch.id);
    return { ok: true, batch };
  },
  // FEFO pick: take `qty` from this product's batches at one
  // location, earliest expiry first. EXPIRED batches (expiryDate
  // before today) are never picked — if the non-expired stock is
  // short, the whole pick is rejected (nothing is consumed).
  // Returns { ok, picks: [{batchId, qty}], totalAvailable } or
  // { ok: false, message }.
  fefoPick(productId, branchId, qty) {
    const need = Number(qty) || 0;
    if (!need || need <= 0) return { ok: false, message: 'Miqdaar durust likhein.' };
    const today = this._todayLocal();
    const batches = (this.state.batches || [])
      .filter((b) => String(b.productId) === String(productId) &&
        String(b.branchId) === String(branchId == null ? this.WAREHOUSE_ID : branchId) &&
        (Number(b.qty) || 0) > 0)
      .sort((a, b) => String(a.expiryDate || '9999-12-31').localeCompare(String(b.expiryDate || '9999-12-31')));
    const usable = batches.filter((b) => !b.expiryDate || String(b.expiryDate) >= today);
    const available = usable.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    if (available < need) {
      const product = this.productById(productId);
      return { ok: false, message: '"' + ((product && product.name) || 'Item') + '" ki fresh (non-expired) stock sirf ' + available + ' hai, aap ne ' + need + ' manga hai — expired batch se dispatch nahi ho sakta. Kuch bhi kata nahi.' };
    }
    const picks = [];
    let left = need;
    for (const b of usable) {
      if (left <= 0) break;
      const take = Math.min(Number(b.qty) || 0, left);
      picks.push({ batchId: b.id, qty: take });
      left -= take;
    }
    return { ok: true, picks, totalAvailable: available };
  },
  // Apply FEFO picks (decrement batch quantities). Internal — called
  // by createSale after the stock move succeeds.
  _consumeBatches(picks) {
    (picks || []).forEach((p) => {
      const b = (this.state.batches || []).find((x) => String(x.id) === String(p.batchId));
      if (b) b.qty = Math.max(0, (Number(b.qty) || 0) - (Number(p.qty) || 0));
    });
  },
  // Wastage: stock goes down, a movement with reason 'Wastage …'
  // is recorded (isSaleMovement counts it as NOT a sale).
  recordWastage(opts) {
    const product = this.productById(opts && opts.productId);
    if (!product) return { ok: false, message: 'Item nahi mila.' };
    const qty = Number(opts && opts.qty) || 0;
    if (!qty || qty <= 0) return { ok: false, message: 'Wastage ki miqdaar durust likhein (0 se zyada).' };
    const branchId = (opts && opts.branchId != null) ? opts.branchId : this.WAREHOUSE_ID;
    const avail = this.stockOf(product, branchId);
    if (qty > avail && !(this.state.settings && this.state.settings.allowNegativeStock)) {
      return { ok: false, message: '"' + (product.name || '') + '" ka itna stock nahi hai — yahan sirf ' + avail + ' hai.' };
    }
    const row = {
      id: this.nextId('wastage'),
      productId: product.id,
      qty,
      reason: String((opts && opts.reason) || '').trim() || 'Wastage',
      branchId,
      recordedBy: (opts && opts.recordedBy) || '',
      occurredAt: (opts && opts.occurredAt) || new Date().toISOString()
    };
    this._ensureColl('wastage').push(row);
    this._noteId('wastage', row.id);
    this.setStock(product, branchId, this.stockOf(product, branchId) - qty);
    this.addMovement({ productId: product.id, productName: product.name, branchId,
      qty: -qty, reason: 'Wastage — ' + row.reason, user: row.recordedBy, reference: '' });
    return { ok: true, wastage: row };
  },

  /* ================= v2.1.0 — suppliers & godown expenses ================= */
  // Supplier add (duplicate NAME is rejected — the same rule the
  // purchase screen's auto-create uses).
  addSupplier(opts) {
    const name = String((opts && opts.name) || '').trim();
    if (!name) return { ok: false, message: 'Supplier ka naam zaroori hai.' };
    const uniq = this.checkUniqueness('suppliers', { name }, null);
    if (!uniq.ok) return uniq;
    const supplier = {
      id: this.nextId('suppliers'),
      name,
      phone: String((opts && opts.phone) || '').trim(),
      address: String((opts && opts.address) || '').trim(),
      createdAt: new Date().toISOString()
    };
    this._ensureColl('suppliers').push(supplier);
    this._noteId('suppliers', supplier.id);
    this.buildIndexes();
    return { ok: true, supplier };
  },
  supplierPurchases(supplierId) {
    return (this.state.purchases || []).filter((p) => String(p.supplierId) === String(supplierId));
  },
  // Godown expense (separate from shift expenses).
  addExpense(opts) {
    const head = String((opts && opts.head) || '').trim();
    if (!head) return { ok: false, message: 'Kharch ka head zaroori hai.' };
    const amount = Number(opts && opts.amount) || 0;
    if (!amount || amount <= 0) return { ok: false, message: 'Raqam durust likhein (0 se zyada).' };
    const expense = {
      id: this.nextId('expenses'),
      head, amount,
      note: String((opts && opts.note) || '').trim(),
      recordedBy: (opts && opts.recordedBy) || '',
      occurredAt: (opts && opts.occurredAt) || new Date().toISOString()
    };
    this._ensureColl('expenses').push(expense);
    this._noteId('expenses', expense.id);
    return { ok: true, expense };
  },

  /* ================= v2.1.0 — range queries, summary, dashboards ================= */
  // Non-voided sales in [from, to] (local YYYY-MM-DD, inclusive).
  // branchId: undefined = all locations; null = warehouse counter
  // only; a number = that branch only. opts.includeVoided=true
  // keeps voided sales in (default: excluded).
  salesInRange(fromISO, toISO, branchId, opts) {
    const includeVoided = !!(opts && opts.includeVoided);
    const from = fromISO ? String(fromISO).slice(0, 10) : null;
    const to = toISO ? String(toISO).slice(0, 10) : null;
    return (this.state.sales || []).filter((s) => {
      if (!includeVoided && s.voidedAt) return false;
      const d = this._dayOf(s.occurredAt);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (branchId === undefined) return true;
      if (branchId === null) return s.branchId == null;
      return String(s.branchId) === String(branchId);
    }).slice().sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));
  },
  // Transfers (dispatches) in [from, to], each with its computed
  // values (transferBillValues: stamped value, cost, margin).
  // Returns [{ transfer, values }].
  dispatchesInRange(fromISO, toISO) {
    const from = fromISO ? String(fromISO).slice(0, 10) : null;
    const to = toISO ? String(toISO).slice(0, 10) : null;
    return (this.state.transfers || []).filter((t) => {
      const d = this._dayOf(t.date);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .map((t) => ({ transfer: t, values: this.transferBillValues(t, this.state.products) }));
  },
  // Sales Summary (web getSalesSummary): totals for a date range
  // and/or one shift. byPayment / byOrderType are sums of sale
  // totals; serviceCharge is the summed service charge; tax is
  // ALWAYS 0 (there is no tax system in this app). Voided sales
  // are excluded from every total and counted separately; deleted
  // sales are counted from the deletedSales log.
  getSalesSummary(opts) {
    const from = opts && opts.from ? String(opts.from).slice(0, 10) : null;
    const to = opts && opts.to ? String(opts.to).slice(0, 10) : null;
    let sales = this.salesInRange(from, to);
    if (opts && opts.shiftId != null) sales = sales.filter((s) => String(s.shiftId) === String(opts.shiftId));
    const voided = (this.state.sales || []).filter((s) => {
      if (!s.voidedAt) return false;
      const d = this._dayOf(s.occurredAt);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (opts && opts.shiftId != null && String(s.shiftId) !== String(opts.shiftId)) return false;
      return true;
    });
    const deleted = (this.state.deletedSales || []).filter((d) => {
      const day = this._dayOf(d.deletedAt);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    const byPayment = {}, byOrderType = {};
    let totalSales = 0, serviceCharge = 0;
    sales.forEach((s) => {
      const t = Number(s.total) || 0;
      totalSales += t;
      serviceCharge += Number(s.serviceCharge) || 0;
      byPayment[s.paymentMethod] = (byPayment[s.paymentMethod] || 0) + t;
      byOrderType[s.orderType] = (byOrderType[s.orderType] || 0) + t;
    });
    return {
      from, to, shiftId: (opts && opts.shiftId) || null,
      totalSales, bills: sales.length,
      byPayment, byOrderType, serviceCharge,
      tax: 0,
      voidCount: voided.length,
      voidedTotal: voided.reduce((a, s) => a + (Number(s.total) || 0), 0),
      deletedCount: deleted.length,
      deletedTotal: deleted.reduce((a, d) => a + (Number(d.total) || 0), 0)
    };
  },
  // POS Dashboard (web getPosDashboard): one day's sales — totals
  // and the bill list. Cost/profit are deliberately NOT here (the
  // web POS dashboard does not show them either).
  getPosDashboard(opts) {
    const date = (opts && opts.date) || this._todayLocal();
    const sales = this.salesInRange(date, date);
    const byPayment = {}, byOrderType = {};
    let totalSales = 0, serviceCharge = 0;
    sales.forEach((s) => {
      const t = Number(s.total) || 0;
      totalSales += t;
      serviceCharge += Number(s.serviceCharge) || 0;
      byPayment[s.paymentMethod] = (byPayment[s.paymentMethod] || 0) + t;
      byOrderType[s.orderType] = (byOrderType[s.orderType] || 0) + t;
    });
    return {
      date, totalSales, bills: sales.length, byPayment, byOrderType, serviceCharge,
      sales: sales.map((s) => ({ id: s.id, saleNo: s.saleNo, billNo: this.saleBillNo(s),
        total: s.total, paymentMethod: s.paymentMethod, orderType: s.orderType,
        tableNo: s.tableNo, time: s.occurredAt, cashierName: s.cashierName || '' }))
    };
  },
  // Owner Dashboard (web getOwnerDashboard, local compute): counter
  // sales and warehouse dispatch are computed from their own
  // separate sources and NEVER mixed. Any cost or profit is null
  // whenever an involved item has no purchase price set — figures
  // are never estimated (a null line makes its branch total and
  // the grand total null too).
  // opts: { from, to } or { range: 'today'|'yesterday'|'thisWeek'|'thisMonth' }.
  // Returns { from, to, totals, branches, bills, dispatchTotals,
  // dispatchBranches, dispatches }.
  getOwnerDashboard(opts) {
    let from, to;
    if (opts && opts.range) { const r = this.dateRangeFor(opts.range); from = r.from; to = r.to; }
    else {
      from = opts && opts.from ? String(opts.from).slice(0, 10) : this._todayLocal();
      to = opts && opts.to ? String(opts.to).slice(0, 10) : from;
    }
    const branchNameOf = (id) => {
      if (id == null) return 'Warehouse Counter';
      const b = this.branchById(id);
      return (b && b.name) || ('Branch ' + id);
    };
    // ---- Counter sales ----
    const sales = this.salesInRange(from, to);
    const saleIds = new Set(sales.map((s) => s.id));
    const linesBySale = {};
    (this.state.saleLines || []).forEach((l) => {
      if (!saleIds.has(l.saleId)) return;
      (linesBySale[l.saleId] = linesBySale[l.saleId] || []).push(l);
    });
    const lineCost = (l) => {
      const p = this.productById(l.itemId);
      const pp = (p && p.purchasePrice != null && !isNaN(Number(p.purchasePrice))) ? Number(p.purchasePrice) : null;
      const qty = Number(l.quantity) || 0;
      const unitPrice = Number(l.unitPrice) || 0;
      return { costPrice: pp, lineCost: pp == null ? null : qty * pp,
        lineTotal: qty * unitPrice, lineProfit: pp == null ? null : (qty * unitPrice - qty * pp) };
    };
    let totalSales = 0, costSum = 0, allCostKnown = true, productsSold = 0;
    const branchAcc = {};
    const accFor = (branchId) => {
      const key = branchId == null ? 'counter' : 'b' + branchId;
      if (!branchAcc[key]) branchAcc[key] = { branchId, branchName: branchNameOf(branchId),
        bills: 0, totalSales: 0, cost: 0, costKnown: true, productsSold: 0 };
      return branchAcc[key];
    };
    const bills = sales.map((s) => {
      const acc = accFor(s.branchId);
      acc.bills += 1;
      acc.totalSales += Number(s.total) || 0;
      totalSales += Number(s.total) || 0;
      const lines = (linesBySale[s.id] || []).map((l) => {
        const p = this.productById(l.itemId);
        const c = lineCost(l);
        const qty = Number(l.quantity) || 0;
        productsSold += qty;
        acc.productsSold += qty;
        if (c.lineCost == null) { allCostKnown = false; acc.costKnown = false; }
        else { costSum += c.lineCost; acc.cost += c.lineCost; }
        return { productId: l.itemId, name: (p && p.name) || 'Item', unit: (p && p.unit) || '',
          qty, unitPrice: Number(l.unitPrice) || 0, lineTotal: c.lineTotal,
          costPrice: c.costPrice, lineCost: c.lineCost, lineProfit: c.lineProfit };
      });
      return { id: s.id, saleNo: s.saleNo, billNo: this.saleBillNo(s),
        branchId: s.branchId, branchName: branchNameOf(s.branchId),
        date: s.occurredAt, orderType: s.orderType, paymentMethod: s.paymentMethod,
        subtotal: s.subtotal, discount: s.discount, deliveryCharges: s.deliveryCharges,
        serviceCharge: s.serviceCharge, total: s.total, lines };
    });
    const branches = Object.values(branchAcc).map((a) => ({
      branchId: a.branchId, branchName: a.branchName, bills: a.bills,
      totalSales: a.totalSales, productsSold: a.productsSold,
      cost: a.costKnown ? a.cost : null,
      profit: a.costKnown ? (a.totalSales - a.cost) : null
    }));
    const cost = allCostKnown ? costSum : null;
    // ---- Warehouse dispatch (SB transfers) — separate source ----
    const dispatchesRaw = this.dispatchesInRange(from, to);
    let dispatchQty = 0, dispatchValue = 0, dispatchCost = 0, dispatchMargin = 0;
    let valueKnown = true, costKnown = true, marginKnown = true;
    const dispatchBranchAcc = {};
    const dispatches = dispatchesRaw.map(({ transfer, values }) => {
      dispatchQty += values.totals.qty;
      if (values.totals.valueKnown) dispatchValue += values.totals.value; else valueKnown = false;
      if (values.totals.costKnown) dispatchCost += values.totals.cost; else costKnown = false;
      if (values.totals.marginKnown) dispatchMargin += values.totals.margin; else marginKnown = false;
      const key = transfer.toBranchId == null ? 'counter' : 'b' + transfer.toBranchId;
      if (!dispatchBranchAcc[key]) dispatchBranchAcc[key] = { branchId: transfer.toBranchId,
        branchName: branchNameOf(transfer.toBranchId), dispatches: 0, qty: 0,
        value: 0, valueKnown: true, cost: 0, costKnown: true, margin: 0, marginKnown: true };
      const da = dispatchBranchAcc[key];
      da.dispatches += 1;
      da.qty += values.totals.qty;
      if (values.totals.valueKnown) da.value += values.totals.value; else da.valueKnown = false;
      if (values.totals.costKnown) da.cost += values.totals.cost; else da.costKnown = false;
      if (values.totals.marginKnown) da.margin += values.totals.margin; else da.marginKnown = false;
      return { id: transfer.id, billNo: transfer.billNo || ('SB-' + String(transfer.id).padStart(4, '0')),
        date: transfer.date, fromBranchId: transfer.fromBranchId, toBranchId: transfer.toBranchId,
        toBranchName: branchNameOf(transfer.toBranchId),
        items: values.rows, value: values.totals.valueKnown ? values.totals.value : null,
        cost: values.totals.costKnown ? values.totals.cost : null,
        margin: values.totals.marginKnown ? values.totals.margin : null };
    });
    const dispatchBranches = Object.values(dispatchBranchAcc).map((a) => ({
      branchId: a.branchId, branchName: a.branchName, dispatches: a.dispatches, qty: a.qty,
      value: a.valueKnown ? a.value : null,
      cost: a.costKnown ? a.cost : null,
      margin: a.marginKnown ? a.margin : null
    }));
    return {
      from, to,
      totals: { totalSales, bills: sales.length, productsSold,
        cost, profit: cost == null ? null : (totalSales - cost),
        totalStockTransferred: dispatchQty,
        totalDispatchValue: valueKnown ? dispatchValue : null,
        totalDispatchCost: costKnown ? dispatchCost : null,
        totalDispatchMargin: marginKnown ? dispatchMargin : null },
      branches, bills,
      dispatchTotals: { dispatches: dispatches.length, qty: dispatchQty,
        value: valueKnown ? dispatchValue : null,
        cost: costKnown ? dispatchCost : null,
        margin: marginKnown ? dispatchMargin : null },
      dispatchBranches, dispatches
    };
  },

  /* ================= v2.1.0 — backup export / validate / import ================= */
  // Wrapped export format (v2): { app, version, exportedAt, data }.
  // The on-disk data file and backupOnClose keep writing the raw
  // state; this wrapper is what Settings "Backup download" writes,
  // and what validateBackup/importBackup understand.
  exportBackup() {
    return {
      app: 'sahara-bakers-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      data: this.state
    };
  },
  // Validate a parsed backup BEFORE anything is replaced.
  // Accepts BOTH the new wrapper format and the legacy raw desktop
  // state (accept-with-warning). REJECTS web-format backups (their
  // schema uses items/users, not products/appUsers) with a clear
  // message. Returns { ok, warning, data, isWrapper } or
  // { ok: false, message } (Roman Urdu). Never touches state.
  validateBackup(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Backup file durust nahi hai — file khaali ya ghalat format hai. Current data waisa hi hai.' };
    }
    const isWrapper = parsed.app != null || parsed.data != null;
    let data = parsed;
    let warning = null;
    // Web-format backup: the web export puts its tables at the TOP
    // level (items/users/movements) instead of products/appUsers/
    // stockMovements, and has no `data` wrapper. Never import it
    // into the desktop store — the schema is different.
    if (Array.isArray(parsed.items) || Array.isArray(parsed.users)) {
      return { ok: false, message: 'Ye WEB app ka backup hai — desktop mein web backup restore nahi ho sakta (schema alag hai: items/users ke bajaye products/appUsers chahiye). Current data waisa hi hai.' };
    }
    if (isWrapper) {
      if (parsed.app !== 'sahara-bakers-backup') {
        return { ok: false, message: 'Ye backup Sahara Bakers ka nahi hai (app: ' + String(parsed.app || '—') + '). Restore nahi hua, current data waisa hi hai.' };
      }
      if (parsed.version != null && [1, 2].indexOf(Number(parsed.version)) === -1) {
        return { ok: false, message: 'Backup version ' + parsed.version + ' support nahi hai (sirf version 1 aur 2). Restore nahi hua, current data waisa hi hai.' };
      }
      if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
        return { ok: false, message: 'Backup file mein data nahi mila. Restore nahi hua, current data waisa hi hai.' };
      }
      data = parsed.data;
    }
    // Web-format backup nested under a wrapper: same different
    // schema (items/users/movements instead of
    // products/appUsers/stockMovements). Never import it.
    if (Array.isArray(data.items) || Array.isArray(data.users)) {
      return { ok: false, message: 'Ye WEB app ka backup hai — desktop mein web backup restore nahi ho sakta (schema alag hai: items/users ke bajaye products/appUsers chahiye). Current data waisa hi hai.' };
    }
    if (!isWrapper) {
      warning = 'Purana backup format hai (bina app/version ke) — checks pass honay par restore kiya ja raha hai.';
    }
    const required = ['products', 'branches', 'appUsers', 'stockMovements', 'transfers', 'productions', 'purchases'];
    for (const t of required) {
      if (!Array.isArray(data[t])) {
        return { ok: false, message: 'Backup mein zaroori table nahi hai: ' + t + '. Restore nahi hua, current data waisa hi hai.' };
      }
    }
    const owners = (data.appUsers || []).filter((u) => u.role === 'Owner' && u.isActive !== false);
    if (owners.length === 0) {
      return { ok: false, message: 'Backup mein koi active Owner login nahi hai — restore nahi ho sakta. Current data waisa hi hai.' };
    }
    // Empty-backup guard: a backup with no items at all must never
    // overwrite a store that has items, and a fully empty backup
    // must never overwrite a store that has any data.
    const cur = this.state;
    const curHasData = (cur.products || []).length > 0 || (cur.appUsers || []).length > 0 ||
      (cur.stockMovements || []).length > 0 || (cur.sales || []).length > 0 || (cur.branches || []).length > 0;
    const bakEmpty = (data.products || []).length === 0 && (data.appUsers || []).length === 0 &&
      (data.stockMovements || []).length === 0 && ((data.sales || []).length === 0) && (data.branches || []).length === 0;
    if (bakEmpty && curHasData) {
      return { ok: false, message: 'Backup khaali hai (koi item, login ya movement nahi) jabke current data mojood hai — khaali backup se data overwrite nahi hoga.' };
    }
    if ((data.products || []).length === 0 && (cur.products || []).length > 0) {
      return { ok: false, message: 'Backup mein koi item nahi hai jabke current data mein items hain — restore nahi ho sakta. Current data waisa hi hai.' };
    }
    return { ok: true, warning, data, isWrapper };
  },
  // Validate-then-replace import. `input` is a parsed object or a
  // JSON string. A safety backup of the CURRENT state is taken
  // before anything is replaced. On any failure the current data
  // is untouched. Returns { ok, warning, products, logins, sales,
  // transfers } or { ok: false, message }.
  importBackup(input) {
    let parsed = input;
    if (typeof input === 'string') {
      try { parsed = JSON.parse(input); }
      catch (e) {
        return { ok: false, message: 'Backup file durust nahi hai (JSON nahi). Restore nahi hua, current data waisa hi hai.' };
      }
    }
    const v = this.validateBackup(parsed);
    if (!v.ok) return v;
    try { this.backup(); } catch (e) { /* safety backup is best-effort */ }
    this.state = Object.assign(emptyState(), v.data);
    const NEW_TABLES = ['sales', 'saleLines', 'heldOrders', 'khataCustomers', 'khataPayments',
      'shifts', 'staff', 'staffAttendance', 'shiftExpenses', 'deletedSales',
      'batches', 'wastage', 'expenses', 'recipes'];
    NEW_TABLES.forEach((t) => { if (!Array.isArray(this.state[t])) this.state[t] = []; });
    if (!this.state.settings) this.state.settings = {};
    const s = this.state.settings;
    if (s.managerCanSeeCost == null) s.managerCanSeeCost = false;
    if (s.posServiceCharge == null) s.posServiceCharge = { type: 'flat', value: 0 };
    if (s.posBillCopies == null) s.posBillCopies = 1;
    if (s.kotEnabled == null) s.kotEnabled = true;
    if (s.kotRemarks == null) s.kotRemarks = true;
    if (s.backupFormatVersion == null) s.backupFormatVersion = 2;
    if (s.sessionTimeoutMinutes == null) s.sessionTimeoutMinutes = 15;
    if (s.lowStockNotifications == null) s.lowStockNotifications = true;
    if (s.defaultLowStockLimit == null) s.defaultLowStockLimit = null;
    if (!s.currency) s.currency = 'PKR';
    this.buildIndexes();
    try { this.save(); }
    catch (e) {
      return { ok: false, message: 'Restore save nahi ho saka: ' + (e && e.message ? e.message : 'unknown error') };
    }
    return { ok: true, warning: v.warning || null,
      products: (this.state.products || []).length,
      logins: (this.state.appUsers || []).length,
      sales: (this.state.sales || []).length,
      transfers: (this.state.transfers || []).length };
  }
};

module.exports = DB;
