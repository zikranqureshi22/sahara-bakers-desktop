// Sahara Bakers — database layer (v1.0.0).
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
//   DB.transferBillValues(transfer, products)  per-item price values
//                        for the thermal transfer bill
//
// State shape:
//   products, branches, stockMovements, transfers, purchases,
//   purchaseLines, suppliers, appUsers, loginSecurity, settings
// Product: {id, name, price, purchasePrice, category, type ('raw' |
// 'finished'), unit, sku, barcode, lowThreshold, status, image,
// stock, branchStocks:[{branchId, qty}]}. Prices are null until the
// user enters them in-app — never invented.
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
    ['transfers', 'purchases', 'purchaseLines'].forEach((coll) => {
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

  addMovement(movement) {
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
      reference: movement.reference || ''
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
