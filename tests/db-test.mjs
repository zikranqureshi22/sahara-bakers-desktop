// Sahara Bakers Desktop v1.0.0 — Node DB tests (tester subagent).
// Plain node, no framework. Each case gets a fresh temp dir; SAHARA_DATA_DIR
// is set before (re-)requiring src/db.js (cache-busted per case).
// Run: node db-test.mjs   (from the evidence dir or anywhere)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(APP_DIR, 'src/db.js');
const SEED = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'src/seed.json'), 'utf8'));
const EXPORT = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'seed-export.json'), 'utf8'));
const LIVE = JSON.parse(fs.readFileSync(path.join(APP_DIR, '..', 'sahara-bakers-v2', 'live-backup-2026-11-19.json'), 'utf8'));
const LIVE23 = JSON.parse(fs.readFileSync(path.join(APP_DIR, '..', 'sahara-bakers-backup', 'sahara-backup-2026-11-23.json'), 'utf8'));
const PHOTOMAP = JSON.parse(fs.readFileSync(path.join(APP_DIR, '..', 'sahara-bakers-v2', 'photo-map.json'), 'utf8'));

const results = [];
function log(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sahara-db-')); }
function loadDB(dir) {
  process.env.SAHARA_DATA_DIR = dir;
  delete require.cache[DB_PATH];
  const DB = require(DB_PATH);
  DB.recoveredFromBackup = false; DB.loadError = null;
  return DB;
}
function writeState(dir, state, name = 'sahara-bakers-data.json') {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(state, null, 2), 'utf8');
}
function goodState(over = {}) {
  const s = JSON.parse(JSON.stringify(SEED)); delete s._note;
  return Object.assign(s, over);
}
function emptyStateWithFlag(flag = true) {
  return {
    products: [], branches: [], stockMovements: [], transfers: [], purchases: [],
    purchaseLines: [], suppliers: [], appUsers: [], loginSecurity: {},
    settings: { businessName: 'Sahara Bakers', currency: 'PKR', v100FreshSeedApplied: flag },
  };
}
function writeBackup(dir, state, stamp) {
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const name = 'sahara-bakers-backup-' + stamp + '.json';
  fs.writeFileSync(path.join(dir, 'backups', name), JSON.stringify(state, null, 2), 'utf8');
  return name;
}
const sleepSync = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };

try {
  // ---- 1. Fresh load seeds 140 items / 3 branches / 3 users (v2.1.0) ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const raw = DB.state.products.filter((p) => p.type === 'raw').length;
    const fin = DB.state.products.filter((p) => p.type === 'finished').length;
    const branchNames = DB.state.branches.map((b) => b.name);
    const priced = DB.state.products.filter((p) => p.price != null);
    const allZeroStock = DB.state.products.every((p) => (p.stock || 0) === 0);
    const cheese = DB.state.products.find((p) => p.id === 18);
    const cake = DB.state.products.find((p) => p.id === 55);
    const fancy = DB.state.products.find((p) => p.id === 50);
    const sada = DB.state.products.find((p) => p.id === 51);
    const roti = DB.state.products.find((p) => p.id === 52);
    log('D1 fresh load seeds 140 items (28 raw / 112 finished), branches Branch 1/2/3, Owner + Warehouse + Counter Manager, all stock 0, 98 priced items (Cheese 8000/5000, Bakery Cake 9000/7000, + 22-Nov live merges: Fancy Biscuit 1200, Sada Biscuit 1000, Double Roti 200), productions empty',
      DB.state.products.length === 140 && raw === 28 && fin === 112 &&
      JSON.stringify(branchNames) === JSON.stringify(['Branch 1', 'Branch 2', 'Branch 3']) &&
      DB.state.appUsers.length === 3 &&
      DB.state.appUsers[0].username === 'rahmanullah' && DB.state.appUsers[0].role === 'Owner' && DB.state.appUsers[0].name === 'Rahmanullah' &&
      DB.state.appUsers[1].username === 'manager' && DB.state.appUsers[1].role === 'Manager' && DB.state.appUsers[1].name === 'Warehouse' &&
      DB.state.appUsers[2].username === 'counter' && DB.state.appUsers[2].role === 'Counter Manager' && DB.state.appUsers[2].isPosOnly === true &&
      priced.length === 98 && cheese.price === 8000 && cheese.purchasePrice === 5000 && cheese.unit === '1 Kg' &&
      cake.price === 9000 && cake.purchasePrice === 7000 && cake.unit === '10 Pieces' &&
      fancy.price === 1200 && sada.price === 1000 && roti.price === 200 &&
      allZeroStock && Array.isArray(DB.state.productions) && DB.state.productions.length === 0 &&
      DB.state.settings.v100FreshSeedApplied === true && DB.state.settings.v200SeedMigrated === true && DB.state.settings.v210Migrated === true,
      'products=' + DB.state.products.length + ' raw=' + raw + ' fin=' + fin + ' branches=' + JSON.stringify(branchNames) + ' priced=' + priced.map((p) => p.name).join(','));
  }

  // ---- 2. Seed matches the LIVE backups: base ids 12-55 vs 2026-11-23 (latest live backup; the 19-Nov file predates the 22-Nov price merges for ids 50/51/52), video ids 63-158 vs 2026-11-23 ----
  {
    const liveItems = LIVE.items;
    const live23Items = LIVE23.items;
    const seedIds = SEED.products.map((p) => p.id);
    const baseIds = seedIds.filter((id) => id <= 55);
    const videoIds = seedIds.filter((id) => id >= 63);
    const baseMatch = SEED.products.filter((p) => p.id <= 55).every((p) => {
      const e = live23Items.find((x) => x.id === p.id);
      return e && e.name === p.name && e.type === p.type && e.unit === p.unit &&
        e.price === p.price && e.purchasePrice === p.purchasePrice && e.category === p.category;
    });
    const videoMatch = SEED.products.filter((p) => p.id >= 63).every((p) => {
      const e = live23Items.find((x) => x.id === p.id);
      return e && e.name === p.name && e.type === p.type && e.unit === p.unit &&
        e.price === p.price && e.purchasePrice === p.purchasePrice && e.category === p.category;
    });
    const photosBase = SEED.products.filter((p) => p.id <= 55).every((p) => {
      const e = EXPORT.items.find((x) => x.id === p.id);
      return e && e.desktopPhoto === p.image;
    });
    const photoById = {};
    PHOTOMAP.items.forEach((m) => { photoById[m.id] = m.target; });
    const photosVideo = SEED.products.filter((p) => p.id >= 63).every((p) =>
      p.id === 96 ? p.image === null : photoById[p.id] === p.image);
    const idsOk = JSON.stringify(baseIds) === JSON.stringify(live23Items.filter((i) => i.id <= 55).map((i) => i.id)) &&
      JSON.stringify(videoIds) === JSON.stringify(live23Items.filter((i) => i.id >= 63).map((i) => i.id));
    log('D2 seed.json matches live backups: base ids 12-55 vs 2026-11-23, video ids 63-158 vs 2026-11-23 (names/types/units/prices/categories); base photos match seed-export desktopPhoto, video photos match photo-map.json, id 96 image null',
      idsOk && baseMatch && videoMatch && photosBase && photosVideo && SEED.products.length === 140,
      'baseMatch=' + baseMatch + ' videoMatch=' + videoMatch + ' photosBase=' + photosBase + ' photosVideo=' + photosVideo + ' idsOk=' + idsOk);
  }

  // ---- 3. v2 PINs verify: Owner 1234, Manager 123 (same sha256 scheme) ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const owner = DB.state.appUsers.find((u) => u.role === 'Owner');
    const mgr = DB.state.appUsers.find((u) => u.role === 'Manager');
    const ownerHash = '59a52044930fc8ebb17b69c7733f2b5ad37d5758c3a574c0a36a70d3bea06f9e';
    const mgrHash = '11908e709ed39a955bc8a3d448b736f344d873aedb5a02dabcf0693a6ec64065';
    log('D3 v2.1.0 PINs verify: Owner 1234 (hash 59a52044…), Manager 123 (hash 11908e70…), Counter Manager 1234 (same hash as Owner, isPosOnly); old PIN 3333 fails; wrong PINs fail',
      DB.hashPin('1234') === ownerHash && owner.pinHash === ownerHash &&
      DB.hashPin('123') === mgrHash && mgr.pinHash === mgrHash &&
      DB.checkPin(owner, '1234') === true && DB.checkPin(mgr, '123') === true &&
      DB.checkPin(owner, '3333') === false && DB.checkPin(owner, '0000') === false &&
      DB.checkPin(mgr, '1234') === false && DB.checkPin(owner, '123') === false &&
      (() => { const c = DB.state.appUsers.find((u) => u.role === 'Counter Manager'); return c && c.username === 'counter' && c.isPosOnly === true && DB.checkPin(c, '1234') === true && c.pinHash === ownerHash; })(),
      'ownerHash=' + DB.hashPin('1234').slice(0, 8) + ' mgrHash=' + DB.hashPin('123').slice(0, 8));
  }

  // ---- 4. Lockout: 5 wrong PINs locks 15 min ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    let lockedAt = null;
    for (let i = 1; i <= 5; i++) { const r = DB.recordFailedLogin('rahmanullah'); if (i === 5) lockedAt = r.locked; }
    const st = DB.isLoginLocked('rahmanullah');
    log('D4 5 wrong PINs -> locked for 15 min (remainingMinutes 14-15), attempts=5',
      lockedAt === true && st.locked === true && st.attempts === 5 &&
      st.remainingMinutes >= 14 && st.remainingMinutes <= 15,
      'locked=' + st.locked + ' remainingMinutes=' + st.remainingMinutes + ' attempts=' + st.attempts);
    // successful login clears the counter
    DB.recordSuccessfulLogin('rahmanullah');
    const st2 = DB.isLoginLocked('rahmanullah');
    log('D5 successful login clears the lockout counter', st2.locked === false && st2.attempts === 0, JSON.stringify(st2));
  }

  // ---- 6. Lockout persists across reload ----
  {
    const dir = freshDir();
    let DB = loadDB(dir); DB.load();
    for (let i = 0; i < 5; i++) DB.recordFailedLogin('rahmanullah');
    DB = loadDB(dir); DB.load(); // fresh process-equivalent reload
    const st = DB.isLoginLocked('rahmanullah');
    log('D6 lockout persists across reload (same data dir, fresh DB object)',
      st.locked === true && st.attempts === 5, 'locked=' + st.locked + ' attempts=' + st.attempts);
  }

  // ---- 7. Expired lock auto-clears ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    for (let i = 0; i < 5; i++) DB.recordFailedLogin('rahmanullah');
    DB.state.loginSecurity.rahmanullah.lockedUntil = Date.now() - 1000;
    DB.save();
    const DB2 = loadDB(dir); DB2.load();
    const st = DB2.isLoginLocked('rahmanullah');
    log('D7 expired lock auto-clears on next check', st.locked === false && st.attempts === 0, JSON.stringify(st));
  }

  // ---- 8. Corrupt main file recovers from .bak ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load(); // seeds good state, saves file
    const goodBytes = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), goodBytes, 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json'), '{corrupt json!!!', 'utf8');
    const DB2 = loadDB(dir); DB2.load();
    const bakStillGood = JSON.parse(fs.readFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), 'utf8')).products.length === 140;
    log('D8 corrupt main file recovers 140 items from .bak, flags set, .bak still good',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true &&
      /pichli achi copy \(\.bak\)/.test(DB2.loadError || '') && bakStillGood,
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }

  // ---- 9. Corrupt main + corrupt .bak -> recovers from timestamped backup ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    writeBackup(dir, goodState(), '2026-11-17_10-00-00-000');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json'), 'not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), 'also not json', 'utf8');
    const DB2 = loadDB(dir); DB2.load();
    log('D9 corrupt main + corrupt .bak recovers 140 items from timestamped backup',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true,
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }

  // ---- 10. Empty file + newest EMPTY backup + older GOOD backup -> good wins ----
  {
    const dir = freshDir();
    writeState(dir, emptyStateWithFlag(true)); // flag already applied: no re-seed
    writeBackup(dir, goodState(), '2026-11-16_09-00-00-000'); // older GOOD
    const emptyName = writeBackup(dir, emptyStateWithFlag(true), '2026-11-17_10-00-00-000'); // newest EMPTY
    // force newest-empty to actually be newest by mtime
    const now = new Date(); fs.utimesSync(path.join(dir, 'backups', emptyName), now, now);
    const DB = loadDB(dir);
    const good = DB.newestGoodBackup();
    DB.load();
    log('D10 empty data file recovers from the OLDER good backup, NOT the newest empty one',
      good.ok === true && good.products === 140 && good.name.includes('2026-11-16') &&
      DB.state.products.length === 140 && DB.recoveredFromBackup === true,
      'newestGood=' + good.name + ' products=' + DB.state.products.length + ' loadError=' + DB.loadError);
  }

  // ---- 11. newestGoodBackup skips a corrupt newest backup ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    writeBackup(dir, goodState(), '2026-11-16_09-00-00-000');
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', 'sahara-bakers-backup-2026-11-17_10-00-00-000.json'), '{broken', 'utf8');
    const good = DB.newestGoodBackup();
    log('D11 newestGoodBackup skips a corrupt newest backup and returns the older good one',
      good.ok === true && good.products === 140 && good.name.includes('2026-11-16'),
      'picked=' + good.name);
  }

  // ---- 12. Login-only fallback ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const loginOnly = emptyStateWithFlag(true);
    loginOnly.appUsers = [{ id: 1, name: 'Rahmanullah', username: 'rahmanullah', role: 'Owner', pinHash: DB.hashPin('3333') }];
    writeBackup(dir, loginOnly, '2026-11-17_10-00-00-000');
    const good = DB.newestGoodBackup();
    log('D12 newestGoodBackup falls back to a login-only backup (0 products, 1 login) when no backup has products',
      good.ok === true && good.products === 0 && good.logins === 1, JSON.stringify({ products: good.products, logins: good.logins }));
  }

  // ---- 13. restoreLatestBackup returns counts; no-backup / empty-only fail ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    DB.state.products = DB.state.products.slice(0, 5); DB.save(); // simulate a damaged current state
    writeBackup(dir, goodState(), '2026-11-16_09-00-00-000');
    const res = DB.restoreLatestBackup();
    log('D13 restoreLatestBackup returns counts (140 products, 3 logins) and restores the state',
      res.ok === true && res.products === 140 && res.logins === 3 && DB.state.products.length === 140,
      JSON.stringify(res));
    const dir2 = freshDir();
    const DB2 = loadDB(dir2); DB2.load();
    const res2 = DB2.restoreLatestBackup();
    log('D14 restoreLatestBackup with no backups at all -> ok:false',
      res2.ok === false && /Koi backup nahi mila/.test(res2.message || ''), JSON.stringify(res2));
    const dir3 = freshDir();
    const DB3 = loadDB(dir3); DB3.load();
    writeBackup(dir3, emptyStateWithFlag(true), '2026-11-17_10-00-00-000');
    const res3 = DB3.restoreLatestBackup();
    log('D15 restoreLatestBackup with only empty backups -> ok:false (never restores the empty state)',
      res3.ok === false && /Koi acha backup nahi mila/.test(res3.message || ''), JSON.stringify(res3));
  }

  // ---- 16. backup() writes a verifiable backup and prunes to 7 ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const r1 = DB.backup();
    const info1 = DB.backupInfo();
    // create 8 more backups with distinct mtimes
    for (let i = 0; i < 8; i++) { sleepSync(15); DB.backup(); }
    const info2 = DB.backupInfo();
    log('D16 backup() writes a verified backup; 9 backups prune to the newest 7',
      r1.ok === true && info1.count === 1 && info2.count === 7,
      'first=' + JSON.stringify(r1.ok) + ' countAfter9=' + info2.count);
  }

  // ---- 17. _saveRecovered never overwrites .bak ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const goodBytes = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), goodBytes, 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json'), '{corrupt', 'utf8');
    const DB2 = loadDB(dir); DB2.load(); // recovery path uses _saveRecovered
    const bakAfter = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), 'utf8');
    log('D17 _saveRecovered after corrupt recovery leaves .bak byte-identical to the good copy',
      bakAfter === goodBytes && DB2.state.products.length === 140, 'bakUnchanged=' + (bakAfter === goodBytes));
  }

  // ---- 18. save() only refreshes .bak from a parsing previous file ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    DB.state.products[0].name = 'Ghee-EDITED'; DB.save();
    const bak = JSON.parse(fs.readFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), 'utf8'));
    const main = JSON.parse(fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8'));
    log('D18 save() keeps .bak as the PREVIOUS good state (pre-edit name) while main has the edit',
      bak.products[0].name === 'Ghee' && main.products[0].name === 'Ghee-EDITED',
      'bak=' + bak.products[0].name + ' main=' + main.products[0].name);
  }

  // ---- 19. Empty file + good .bak + no backups: NOW recovers from .bak (fix) ----
  // (Was OBSERVED pre-fix: stayed EMPTY, .bak never consulted on the empty
  // path. The fix consults .bak there too, so this case now recovers.)
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const goodBytes = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), goodBytes, 'utf8');
    writeState(dir, emptyStateWithFlag(true)); // empty, flag already applied
    const DB2 = loadDB(dir); DB2.load();
    const bakAfter = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), 'utf8');
    const mainAfter = JSON.parse(fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8'));
    log('D19 FIXED: empty file (flag applied) + good .bak + no timestamped backups recovers 140 items from .bak, flags set, .bak untouched, data file rewritten with 140 items',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true &&
      /Khaali data mila — pichli achi copy \(\.bak\)/.test(DB2.loadError || '') &&
      bakAfter === goodBytes && mainAfter.products.length === 140,
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }

  // ---- 20. Empty file + flag NOT applied -> fresh seed applies (by design) ----
  {
    const dir = freshDir();
    writeState(dir, emptyStateWithFlag(false));
    const DB = loadDB(dir); DB.load();
    log('D20 empty file with seed flag NOT yet applied re-seeds 140 items (fresh-start path)',
      DB.state.products.length === 140 && DB.state.settings.v100FreshSeedApplied === true,
      'products=' + DB.state.products.length);
  }

  // ---- 21. Fresh-seed merge: existing Owner survives, his PIN wins, no second Owner ----
  {
    const dir = freshDir();
    const DB0 = loadDB(dir); DB0.load();
    const existingOwner = { id: 99, name: 'Rahmanullah', username: 'rahmanullah', role: 'Owner', pinHash: DB0.hashPin('9999'), branchId: null, isActive: true };
    const st = emptyStateWithFlag(false);
    st.appUsers = [existingOwner];
    writeState(dir, st);
    const DB = loadDB(dir); DB.load();
    const owners = DB.state.appUsers.filter((u) => u.role === 'Owner');
    log('D21 fresh-seed merge: existing Owner survives with HIS PIN (9999 verifies, 1234 fails), never a second Owner',
      DB.state.products.length === 140 && owners.length === 1 &&
      DB.checkPin(owners[0], '9999') === true && DB.checkPin(owners[0], '1234') === false,
      'owners=' + owners.length + ' pin9999=' + DB.checkPin(owners[0], '9999'));
  }

  // ---- 22. setStock persists; negative clamps to 0 ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    DB.setStock(flour, DB.WAREHOUSE_ID, 25); DB.setStock(flour, 2, 10); DB.save();
    const DB2 = loadDB(dir); DB2.load();
    const f2 = DB2.state.products.find((p) => p.name === 'Flour');
    log('D22 setStock persists across reload (warehouse 25, branch 10, total 35); negative qty clamps to 0',
      DB2.stockOf(f2, DB.WAREHOUSE_ID) === 25 && DB2.stockOf(f2, 2) === 10 && DB2.stockOf(f2) === 35 &&
      (() => { DB2.setStock(f2, DB.WAREHOUSE_ID, -5); return DB2.stockOf(f2, DB.WAREHOUSE_ID) === 0; })(),
      'wh=' + DB2.stockOf(f2, DB.WAREHOUSE_ID) + ' br2=' + DB2.stockOf(f2, 2) + ' total=' + DB2.stockOf(f2));
  }

  // ---- 23. Uniqueness guards ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    DB.state.purchases.push({ id: 1, invoiceNo: 'INV-001' });
    const dupInv = DB.checkUniqueness('purchases', { invoiceNo: 'inv-001' }, null);
    const dupUser = DB.checkUniqueness('appUsers', { username: 'Rahmanullah' }, null);
    const dupBranch = DB.checkUniqueness('branches', { name: 'branch 1' }, null);
    const okInv = DB.checkUniqueness('purchases', { invoiceNo: 'INV-002' }, null);
    log('D23 uniqueness: duplicate invoice (case-insensitive), username and branch name (Branch 1) rejected; new invoice OK',
      dupInv.ok === false && dupUser.ok === false && dupBranch.ok === false && okInv.ok === true,
      'inv=' + dupInv.ok + ' user=' + dupUser.ok + ' branch=' + dupBranch.ok + ' new=' + okInv.ok);
  }

  // ---- 24. Transfer-bill math with null prices invents no price ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const t = { id: 1, items: [{ productId: 15, qty: 5 }, { productId: 12, qty: 2 }] }; // Flour 5, Ghee 2 — both price null
    const v = DB.transferBillValues(t, DB.state.products);
    const noInvented = v.rows.every((r) => r.lineValue == null && r.price == null) && v.totals.value === 0;
    log('D24 transfer bill with ALL prices null: lineValue null, total 0, priceMissing=true, valueKnown=false — no invented amount',
      v.priceMissing === true && v.totals.valueKnown === false && v.totals.qty === 7 && noInvented,
      JSON.stringify(v.totals) + ' rows=' + JSON.stringify(v.rows.map((r) => [r.name, r.lineValue])));
    // priced item: exact math
    DB.state.products.find((p) => p.id === 15).price = 100;
    const v2 = DB.transferBillValues(t, DB.state.products);
    log('D25 transfer bill with one priced item (Flour Rs 100 x5): line 500, total 500, valueKnown=false (Ghee still blank)',
      v2.rows.find((r) => r.name === 'Flour').lineValue === 500 && v2.totals.value === 500 && v2.totals.valueKnown === false,
      JSON.stringify(v2.totals));
  }

  // ---- 26. Sticky recovery flags survive a second load() on the same object ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const goodBytes = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), goodBytes, 'utf8');
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json'), '{corrupt', 'utf8');
    const DB2 = loadDB(dir); DB2.load();
    const flag1 = DB2.recoveredFromBackup; const err1 = DB2.loadError;
    DB2.load(); // second load on the SAME object (renderer modules each call load())
    log('D26 recovery flags are STICKY: a second load() on the same object does not wipe recoveredFromBackup/loadError',
      flag1 === true && DB2.recoveredFromBackup === true && DB2.loadError === err1,
      'flag=' + DB2.recoveredFromBackup + ' err=' + DB2.loadError);
  }

  // ---- 27. Low-stock limits: null = no limit; default applies; item limit wins ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const ghee = DB.state.products.find((p) => p.name === 'Ghee');
    const noLimit = DB.isLowStock(ghee, 1) === false && DB.lowLimitFor(ghee) === null;
    DB.state.settings.defaultLowStockLimit = 5;
    const withDefault = DB.lowLimitFor(ghee) === 5 && DB.isLowStock(ghee, 1) === true; // stock 0 <= 5
    ghee.lowThreshold = 2;
    const ownWins = DB.lowLimitFor(ghee) === 2 && DB.isLowStock(ghee, 1) === true;
    DB.setStock(ghee, 1, 3);
    const aboveOwn = DB.isLowStock(ghee, 1) === false; // 3 > 2
    log('D27 low-stock: null limit = never low; default 5 makes 0-stock low; item limit (2) wins over default; 3 > 2 not low',
      noLimit && withDefault && ownWins && aboveOwn,
      'noLimit=' + noLimit + ' withDefault=' + withDefault + ' ownWins=' + ownWins + ' aboveOwn=' + aboveOwn);
  }

  // ---- 28. backupOnClose guard exists in main.js (static check — main.js needs Electron to run) ----
  {
    const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
    const hasParseGuard = src.includes("try { parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) { return; }");
    const hasEmptyGuard = src.includes('if (products === 0 && logins === 0) return;');
    const wired = src.includes("win.on('close', () => { backupOnClose(); })");
    log('D28 STATIC: main.js backupOnClose skips corrupt (parse-fail return) and empty (0 products AND 0 logins) files, wired to window close',
      hasParseGuard && hasEmptyGuard && wired,
      'parseGuard=' + hasParseGuard + ' emptyGuard=' + hasEmptyGuard + ' wired=' + wired);
  }

  // ================= v2.0.0 cases =================

  // ---- V1. v1.0.0 data file migrates once: PIN 3333 -> 1234, Manager added, branches renamed, live prices applied ----
  {
    const dir = freshDir();
    const DB0 = loadDB(dir); DB0.load();
    const v1 = goodState();
    v1.appUsers = [{ id: 1, name: 'Rahmanullah', username: 'rahmanullah', role: 'Owner', pinHash: DB0.hashPin('3333'), branchId: null, isActive: true }];
    v1.branches = [
      { id: 1, name: 'sahara backers railway road', address: 'sahara backers main railway road', contact: '', manager: '' },
      { id: 2, name: 'TEHZEEB CAFE', address: '', contact: '', manager: '' },
      { id: 3, name: 'Branch 3', address: '', contact: '', manager: '' },
    ];
    v1.settings.v200SeedMigrated = false;
    v1.settings.v210Migrated = false;
    const ch = v1.products.find((p) => p.id === 18); ch.price = null; ch.purchasePrice = null; ch.unit = 'Kg';
    const ck = v1.products.find((p) => p.id === 55); ck.price = null; ck.purchasePrice = null; ck.unit = 'Pieces';
    writeState(dir, v1);
    const DB = loadDB(dir); DB.load();
    const owner = DB.state.appUsers.find((u) => u.role === 'Owner');
    const mgr = DB.state.appUsers.find((u) => u.role === 'Manager');
    const cheese = DB.state.products.find((p) => p.id === 18);
    const cake = DB.state.products.find((p) => p.id === 55);
    // second load: migration must NOT run again (no duplicate Manager)
    DB.load();
    log('V1 v1.0.0 data migrates once on load: Owner PIN 3333->1234, Manager (PIN 123) added, branches Branch 1/2/3, Cheese 8000/5000 "1 Kg", Bakery Cake 9000/7000 "10 Pieces", no duplicate Manager on second load; v210 also adds Counter Manager (PIN 1234) and renames Manager display to Warehouse',
      DB.checkPin(owner, '1234') === true && DB.checkPin(owner, '3333') === false &&
      mgr && DB.checkPin(mgr, '123') === true && mgr.name === 'Warehouse' && DB.state.appUsers.length === 3 &&
      (() => { const c = DB.state.appUsers.find((u) => u.role === 'Counter Manager'); return c && c.username === 'counter' && DB.checkPin(c, '1234') === true; })() &&
      JSON.stringify(DB.state.branches.map((b) => b.name)) === JSON.stringify(['Branch 1', 'Branch 2', 'Branch 3']) &&
      cheese.price === 8000 && cheese.purchasePrice === 5000 && cheese.unit === '1 Kg' &&
      cake.price === 9000 && cake.purchasePrice === 7000 && cake.unit === '10 Pieces' &&
      DB.state.settings.v200SeedMigrated === true,
      'users=' + DB.state.appUsers.map((u) => u.username).join(',') + ' branches=' + JSON.stringify(DB.state.branches.map((b) => b.name)));
  }

  // ---- V2. Production example 100 Kg raw -> 80 Kg finish: exact bill numbers ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    flour.purchasePrice = 100;
    DB.setStock(flour, DB.WAREHOUSE_ID, 100); DB.save();
    const res = DB.completeProduction({ finishProductId: 40, finishQty: 80, lines: [{ productId: 15, qty: 100 }], createdBy: 'Rahmanullah', clientRef: 'v2-test-1', warehouseBranchId: DB.WAREHOUSE_ID });
    DB.save();
    const gulab = DB.state.products.find((p) => p.id === 40);
    log('V2 production 100 Kg Flour (Rs 100/Kg) -> 80 Kg Gulab Jamun: bill PB-0001, total cost Rs 10,000, cost/unit Rs 125, raw remaining 0, finish stock 80, 2 movement legs',
      res.ok === true && res.production.billNo === 'PB-0001' && res.production.totalCost === 10000 &&
      res.production.costPerUnit === 125 && res.production.costKnown === true &&
      res.production.remainingRaw[0].remaining === 0 && res.production.finalFinishStock === 80 &&
      DB.stockOf(flour, DB.WAREHOUSE_ID) === 0 && DB.stockOf(gulab, DB.WAREHOUSE_ID) === 80 &&
      DB.state.productions.length === 1 && DB.state.stockMovements.length === 2,
      JSON.stringify({ billNo: res.production && res.production.billNo, totalCost: res.production && res.production.totalCost, costPerUnit: res.production && res.production.costPerUnit, remaining: res.production && res.production.remainingRaw, final: res.production && res.production.finalFinishStock }));
  }

  // ---- V3. Over-stock production rejected: NO stock moved, no production, no movements ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    flour.purchasePrice = 100;
    DB.setStock(flour, DB.WAREHOUSE_ID, 100); DB.save();
    const res = DB.completeProduction({ finishProductId: 40, finishQty: 80, lines: [{ productId: 15, qty: 101 }], createdBy: 'Rahmanullah', clientRef: 'v2-test-over', warehouseBranchId: DB.WAREHOUSE_ID });
    log('V3 over-stock cart (101 Kg Flour, only 100 in godown) rejected: ok=false, Flour still 100, Gulab Jamun still 0, no production, no movements',
      res.ok === false && /itna stock nahi hai/.test(res.message || '') &&
      DB.stockOf(flour, DB.WAREHOUSE_ID) === 100 && DB.stockOf(DB.state.products.find((p) => p.id === 40), DB.WAREHOUSE_ID) === 0 &&
      DB.state.productions.length === 0 && DB.state.stockMovements.length === 0,
      'message=' + res.message);
  }

  // ---- V4. clientRef dedupe: same production submitted twice produces once; same movement leg recorded once ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    flour.purchasePrice = 100;
    DB.setStock(flour, DB.WAREHOUSE_ID, 100); DB.save();
    const opts = { finishProductId: 40, finishQty: 80, lines: [{ productId: 15, qty: 100 }], createdBy: 'Rahmanullah', clientRef: 'v2-dup-1', warehouseBranchId: DB.WAREHOUSE_ID };
    const r1 = DB.completeProduction(opts);
    const r2 = DB.completeProduction(opts);
    const m1 = DB.addMovement({ productId: 15, productName: 'Flour', branchId: 1, qty: 5, reason: 'dup test', clientRef: 'move-dup-1' });
    const m2 = DB.addMovement({ productId: 15, productName: 'Flour', branchId: 1, qty: 5, reason: 'dup test', clientRef: 'move-dup-1' });
    log('V4 duplicate production (same clientRef) returns the ORIGINAL bill (duplicate=true), Flour still 0, Gulab still 80, still 1 production; duplicate movement leg recorded once (same id)',
      r1.ok === true && r2.ok === true && r2.duplicate === true && r2.production.billNo === 'PB-0001' &&
      DB.state.productions.length === 1 && DB.stockOf(flour, DB.WAREHOUSE_ID) === 0 &&
      m1.id === m2.id && DB.state.stockMovements.filter((m) => m.clientRef === 'move-dup-1').length === 1,
      'r2.duplicate=' + r2.duplicate + ' productions=' + DB.state.productions.length + ' m1.id=' + m1.id + ' m2.id=' + m2.id);
  }

  // ---- V5. Production with blank purchase price: costKnown=false, costPerUnit null, no invented cost ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour'); // purchasePrice null
    DB.setStock(flour, DB.WAREHOUSE_ID, 50); DB.save();
    const res = DB.completeProduction({ finishProductId: 40, finishQty: 40, lines: [{ productId: 15, qty: 50 }], createdBy: 'Rahmanullah', clientRef: 'v2-blank-cost', warehouseBranchId: DB.WAREHOUSE_ID });
    log('V5 production with blank purchase price still completes (stock moves) but costKnown=false, totalCost 0, costPerUnit null — no cost invented',
      res.ok === true && res.production.costKnown === false && res.production.totalCost === 0 &&
      res.production.costPerUnit === null && res.production.lines[0].lineCost === null &&
      DB.stockOf(flour, DB.WAREHOUSE_ID) === 0 && DB.stockOf(DB.state.products.find((p) => p.id === 40), DB.WAREHOUSE_ID) === 40,
      JSON.stringify({ costKnown: res.production.costKnown, totalCost: res.production.totalCost, costPerUnit: res.production.costPerUnit }));
  }

  // ---- V6. Transfer bill values with the live priced items (Cheese Rs 8000) ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const t = { id: 1, items: [{ productId: 18, qty: 2 }, { productId: 15, qty: 5 }] }; // Cheese 2 (priced), Flour 5 (blank)
    const v = DB.transferBillValues(t, DB.state.products);
    const cheeseRow = v.rows.find((r) => r.name === 'Cheese');
    log('V6 transfer bill: Cheese 2 x Rs 8000 = Rs 16,000 line; Flour blank keeps valueKnown=false; totals qty 7, value 16000',
      cheeseRow && cheeseRow.lineValue === 16000 && v.totals.qty === 7 && v.totals.value === 16000 && v.totals.valueKnown === false && v.priceMissing === true,
      JSON.stringify(v.totals) + ' cheeseLine=' + (cheeseRow && cheeseRow.lineValue));
    log('V7 productionBillNo: first production is PB-0001 (same pad-4 pattern as SB-0001)',
      DB.productionBillNo({ id: 1 }) === 'PB-0001' && DB.productionBillNo({ id: 12 }) === 'PB-0012',
      DB.productionBillNo({ id: 1 }));
  }

  // ---- V8. Manager lockout: 5 wrong PINs lock the Manager login too ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    for (let i = 0; i < 5; i++) DB.recordFailedLogin('manager');
    const st = DB.isLoginLocked('manager');
    const ownerSt = DB.isLoginLocked('rahmanullah');
    log('V8 Manager lockout: 5 wrong PINs lock "manager" for 15 min; Owner login is NOT locked by it (per-user)',
      st.locked === true && st.attempts === 5 && ownerSt.locked === false,
      'managerLocked=' + st.locked + ' ownerLocked=' + ownerSt.locked);
  }

  // ---- V9. Migration never overwrites a user-entered price ----
  {
    const dir = freshDir();
    const DB0 = loadDB(dir); DB0.load();
    const v1 = goodState();
    v1.settings.v200SeedMigrated = false;
    v1.settings.v210Migrated = false;
    const ch = v1.products.find((p) => p.id === 18);
    ch.price = 7500; ch.purchasePrice = 4000; ch.unit = 'Kg'; // user-entered in v1
    writeState(dir, v1);
    const DB = loadDB(dir); DB.load();
    const cheese = DB.state.products.find((p) => p.id === 18);
    log('V9 migration does NOT overwrite a user-entered Cheese price (7500/4000 kept, unit stays Kg)',
      cheese.price === 7500 && cheese.purchasePrice === 4000 && cheese.unit === 'Kg',
      'price=' + cheese.price + ' purchase=' + cheese.purchasePrice + ' unit=' + cheese.unit);
  }

  // ---- V10. Production validation: finish must be a finished item; qty must be > 0 ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    DB.setStock(flour, DB.WAREHOUSE_ID, 10); DB.save();
    const wrongType = DB.completeProduction({ finishProductId: 15, finishQty: 5, lines: [{ productId: 15, qty: 5 }], createdBy: 'Rahmanullah', clientRef: 'v2-bad-1', warehouseBranchId: DB.WAREHOUSE_ID });
    const zeroQty = DB.completeProduction({ finishProductId: 40, finishQty: 0, lines: [{ productId: 15, qty: 5 }], createdBy: 'Rahmanullah', clientRef: 'v2-bad-2', warehouseBranchId: DB.WAREHOUSE_ID });
    const noLines = DB.completeProduction({ finishProductId: 40, finishQty: 5, lines: [], createdBy: 'Rahmanullah', clientRef: 'v2-bad-3', warehouseBranchId: DB.WAREHOUSE_ID });
    log('V10 production validation: raw item as finish rejected; finishQty 0 rejected; empty cart rejected — Flour still 10, no productions',
      wrongType.ok === false && zeroQty.ok === false && noLines.ok === false &&
      DB.stockOf(flour, DB.WAREHOUSE_ID) === 10 && DB.state.productions.length === 0,
      'wrongType=' + wrongType.message + ' | zeroQty=' + zeroQty.message + ' | noLines=' + noLines.message);
  }

  // ---- V11. REGRESSION (Sold fix): production raw consumption is NOT sold ----
  // Production now runs at the Warehouse (a separate location, not a
  // branch), so the Warehouse's Sold stays 0 after a production run;
  // the branch Sold checks below use Branch 1 (a real branch).
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const W = DB.WAREHOUSE_ID;
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    flour.purchasePrice = 100;
    DB.setStock(flour, W, 100); DB.save();
    const soldBefore = DB.soldQtyForBranch(W);
    const res = DB.completeProduction({ finishProductId: 40, finishQty: 80, lines: [{ productId: 15, qty: 100 }], createdBy: 'Rahmanullah', clientRef: 'v11-sold-fix', warehouseBranchId: W });
    DB.save();
    const gulab = DB.state.products.find((p) => p.id === 40);
    const gulabAfterProduction = DB.stockOf(gulab, W);
    const soldAfterProduction = DB.soldQtyForBranch(W);
    // A real manual Stock Out (counter sale) at Branch 1 DOES count as sold...
    DB.setStock(gulab, 1, 80);
    DB.addMovement({ productId: 40, productName: 'Gulab Jamun', branchId: 1, qty: -5, reason: 'Stock Out', user: 'Rahmanullah', reference: '' });
    DB.setStock(gulab, 1, 75);
    const soldAfterStockOut = DB.soldQtyForBranch(1);
    // ...but a transfer leg out does NOT.
    DB.addMovement({ productId: 40, productName: 'Gulab Jamun', branchId: 1, qty: -3, reason: 'Transfer — Branch 2', user: 'Rahmanullah', reference: 'SB-0001' });
    DB.setStock(gulab, 1, 72);
    const soldAfterTransfer = DB.soldQtyForBranch(1);
    // ...and a stock correction from an item edit does NOT either.
    DB.addMovement({ productId: 15, productName: 'Flour', branchId: 1, qty: -4, reason: 'Raw Item Edit — stock set', user: 'Rahmanullah', reference: 'Edit Item' });
    const soldAfterStockSet = DB.soldQtyForBranch(1);
    log('V11 REGRESSION Sold fix: 100 Kg Flour -> 80 Kg Gulab Jamun production at the Warehouse leaves Warehouse Sold = 0 (raw consumption is not a sale); finish stock 80 at the Warehouse; manual Stock Out of 5 at Branch 1 counts as Sold = 5; transfer leg of 3 does not; stock-set correction of -4 does not; Branch 2 Sold = 0; isSaleMovement rejects Production/Transfer/Raw Item Edit/Finish Item Edit reasons and positive qty',
      res.ok === true && soldBefore === 0 && soldAfterProduction === 0 &&
      DB.stockOf(flour, W) === 0 && gulabAfterProduction === 80 &&
      soldAfterStockOut === 5 && soldAfterTransfer === 5 && soldAfterStockSet === 5 && DB.soldQtyForBranch(2) === 0 &&
      DB.isSaleMovement({ qty: -100, reason: 'Production PB-0001 — Gulab Jamun banane mein use hua' }) === false &&
      DB.isSaleMovement({ qty: -3, reason: 'Transfer — Branch 2' }) === false &&
      DB.isSaleMovement({ qty: -4, reason: 'Raw Item Edit — stock set' }) === false &&
      DB.isSaleMovement({ qty: -4, reason: 'Finish Item Edit — stock set' }) === false &&
      DB.isSaleMovement({ qty: -5, reason: 'Stock Out' }) === true &&
      DB.isSaleMovement({ qty: 10, reason: 'Stock Out' }) === false,
      'soldBefore=' + soldBefore + ' soldAfterProduction=' + soldAfterProduction + ' soldAfterStockOut=' + soldAfterStockOut + ' soldAfterTransfer=' + soldAfterTransfer + ' soldAfterStockSet=' + soldAfterStockSet + ' gulabAfterProduction=' + gulabAfterProduction);
  }

  // ================= Warehouse (v2.0.1) cases =================

  // ---- W1. Warehouse -> Branch 1 transfer works (both legs, totals unchanged) ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const W = DB.WAREHOUSE_ID;
    const gulab = DB.state.products.find((p) => p.id === 40);
    DB.setStock(gulab, W, 80); DB.save();
    const fromBefore = DB.stockOf(gulab, W);
    // The two legs exactly as transfer.js records them.
    DB.setStock(gulab, W, DB.stockOf(gulab, W) - 10);
    DB.addMovement({ productId: 40, productName: 'Gulab Jamun', branchId: W, qty: -10, reason: 'Transfer — Branch 1', user: 'Rahmanullah', reference: 'SB-0001', clientRef: 'w1-out' });
    DB.setStock(gulab, 1, DB.stockOf(gulab, 1) + 10);
    DB.addMovement({ productId: 40, productName: 'Gulab Jamun', branchId: 1, qty: 10, reason: 'Transfer — Warehouse se aaya', user: 'Rahmanullah', reference: 'SB-0001', clientRef: 'w1-in' });
    DB.state.transfers.unshift({ id: 1, date: new Date().toISOString(), fromBranchId: W, toBranchId: 1, items: [{ productId: 40, qty: 10 }], status: 'sent', createdBy: 'Rahmanullah', receivedBy: 'Ali', issuedBy: 'Rahmanullah' });
    DB.save();
    log('W1 warehouse -> Branch 1 transfer works: warehouse 80->70, Branch 1 0->10, total still 80, transfer fromBranchId is the warehouse id',
      fromBefore === 80 && DB.stockOf(gulab, W) === 70 && DB.stockOf(gulab, 1) === 10 && DB.stockOf(gulab) === 80 &&
      DB.state.transfers[0].fromBranchId === W && DB.state.transfers[0].toBranchId === 1 &&
      DB.state.stockMovements.length === 2,
      'wh=' + DB.stockOf(gulab, W) + ' br1=' + DB.stockOf(gulab, 1) + ' total=' + DB.stockOf(gulab) + ' from=' + DB.state.transfers[0].fromBranchId);
  }

  // ---- W2/W3. STATIC: bill From name + locked transfer source ----
  {
    const billSrc = fs.readFileSync(path.join(APP_DIR, 'src/transfer-bill.js'), 'utf8');
    const uiSrc = fs.readFileSync(path.join(APP_DIR, 'src/ui.js'), 'utf8');
    const tSrc = fs.readFileSync(path.join(APP_DIR, 'src/transfer.js'), 'utf8');
    log('W2 STATIC: transfer-bill.js and ui.js branchName return "Warehouse" for the warehouse id — the SB bill From line can never read "Branch 1"',
      billSrc.includes("if (String(id) === 'warehouse') return 'Warehouse';") &&
      uiSrc.includes("if (String(id) === 'warehouse') return 'Warehouse';"),
      'billHasCheck=' + billSrc.includes("if (String(id) === 'warehouse') return 'Warehouse';") + ' uiHasCheck=' + uiSrc.includes("if (String(id) === 'warehouse') return 'Warehouse';"));
    log('W3 STATIC: transfer form has NO From <select> (source is a fixed Warehouse line, #tr-from-static) and the To dropdown is built from ALL branches with no warehouse exclusion',
      !tSrc.includes('id="tr-from"') && tSrc.includes('id="tr-from-static"') &&
      !tSrc.includes("filter((b) => String(b.id) !== String(warehouseId))") &&
      tSrc.includes('const fromId = warehouseId;'),
      'hasFromSelect=' + tSrc.includes('id="tr-from"') + ' hasStatic=' + tSrc.includes('id="tr-from-static"'));
  }

  // ---- W4. v1.0.0 data file migrates: branch-1 stock becomes warehouse stock, nothing lost ----
  {
    const dir = freshDir();
    const DB0 = loadDB(dir); DB0.load();
    const v1 = goodState();
    v1.appUsers = [{ id: 1, name: 'Rahmanullah', username: 'rahmanullah', role: 'Owner', pinHash: DB0.hashPin('3333'), branchId: null, isActive: true }];
    v1.branches = [
      { id: 1, name: 'sahara backers railway road', address: '', contact: '', manager: '' },
      { id: 2, name: 'TEHZEEB CAFE', address: '', contact: '', manager: '' },
      { id: 3, name: 'Branch 3', address: '', contact: '', manager: '' },
    ];
    v1.settings.v200SeedMigrated = false;
    v1.settings.v201WarehouseMigrated = false;
    v1.settings.v210Migrated = false;
    v1.products = v1.products.filter((p) => p.id <= 55); // a real v2.0.0 file holds only the 44 base items
    // v1.0.0 stock lived at branch 1 (the old warehouse convention).
    const fl = v1.products.find((p) => p.name === 'Flour');
    fl.branchStocks = [{ branchId: 1, qty: 100 }, { branchId: 2, qty: 5 }, { branchId: 3, qty: 0 }];
    fl.stock = 105;
    const gj = v1.products.find((p) => p.id === 40);
    gj.branchStocks = [{ branchId: 1, qty: 80 }, { branchId: 2, qty: 0 }, { branchId: 3, qty: 0 }];
    gj.stock = 80;
    v1.stockMovements = [
      { id: 1, productId: 15, productName: 'Flour', branchId: 1, qty: 100, date: '2026-11-19T10:00:00.000Z', reason: 'Stock In', user: 'Rahmanullah', reference: '', clientRef: null },
      { id: 2, productId: 15, productName: 'Flour', branchId: 1, qty: -100, date: '2026-11-19T11:00:00.000Z', reason: 'Production PB-0001 — Gulab Jamun banane mein use hua', user: 'Rahmanullah', reference: 'PB-0001', clientRef: null },
    ];
    v1.transfers = [{ id: 1, billNo: 'SB-0001', date: '2026-11-19T12:00:00.000Z', fromBranchId: 1, toBranchId: 2, items: [{ productId: 40, qty: 10 }], status: 'sent', createdBy: 'Rahmanullah' }];
    writeState(dir, v1);
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    const gulab = DB.state.products.find((p) => p.id === 40);
    const noB1Rows = DB.state.products.every((p) => !(p.branchStocks || []).some((r) => String(r.branchId) === '1'));
    const whFlour = DB.stockOf(flour, DB.WAREHOUSE_ID);
    const whGulab = DB.stockOf(gulab, DB.WAREHOUSE_ID);
    // Second load: the migration must NOT run again (no duplication).
    DB.load();
    const whFlour2 = DB.stockOf(DB.state.products.find((p) => p.name === 'Flour'), DB.WAREHOUSE_ID);
    log('W4 v1.0.0 migration: branch-1 stock becomes warehouse stock — Flour 100 (branch 2 keeps 5, total 105 unchanged), Gulab 80, no branch-1 rows left, movements + transfer re-pointed to warehouse, flag set, second load does not duplicate; v210 merges the 96 video items (44 -> 140)',
      whFlour === 100 && DB.stockOf(flour, 1) === 0 && DB.stockOf(flour, 2) === 5 && DB.stockOf(flour) === 105 &&
      whGulab === 80 && DB.stockOf(gulab) === 80 && noB1Rows === true &&
      DB.state.stockMovements.every((m) => String(m.branchId) === DB.WAREHOUSE_ID) &&
      DB.state.transfers[0].fromBranchId === DB.WAREHOUSE_ID && DB.state.transfers[0].toBranchId === 2 &&
      DB.state.settings.v201WarehouseMigrated === true && DB.state.settings.v210Migrated === true && DB.state.products.length === 140 && whFlour2 === 100,
      'whFlour=' + whFlour + ' br1=' + DB.stockOf(flour, 1) + ' total=' + DB.stockOf(flour) + ' whGulab=' + whGulab + ' moves=' + JSON.stringify(DB.state.stockMovements.map((m) => m.branchId)) + ' transferFrom=' + DB.state.transfers[0].fromBranchId + ' whFlour2ndLoad=' + whFlour2);
  }

  // ---- W5. Fresh seed carries warehouse rows (and no branch-1 rows) ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const allHaveWh = DB.state.products.every((p) => (p.branchStocks || []).some((r) => String(r.branchId) === DB.WAREHOUSE_ID));
    const noneHaveB1 = DB.state.products.every((p) => !(p.branchStocks || []).some((r) => String(r.branchId) === '1'));
    const whZero = DB.state.products.every((p) => DB.stockOf(p, DB.WAREHOUSE_ID) === 0);
    log('W5 fresh seed: every product (140/140) has a warehouse stock row, no branch-1 rows, warehouse stock 0 everywhere (the live backup held no stock), flag v201WarehouseMigrated true, new v2.1.0 tables empty, flag v210Migrated true',
      allHaveWh && noneHaveB1 && whZero && DB.state.settings.v201WarehouseMigrated === true && DB.state.settings.v210Migrated === true &&
      DB.state.sales.length === 0 && DB.state.saleLines.length === 0 && DB.state.shifts.length === 0 && DB.state.heldOrders.length === 0 &&
      DB.state.khataCustomers.length === 0 && DB.state.recipes.length === 0 && DB.state.batches.length === 0 && DB.state.expenses.length === 0 &&
      DB.state.settings.managerCanSeeCost === false && DB.state.settings.posBillCopies === 1 && DB.state.settings.kotEnabled === true,
      'allHaveWh=' + allHaveWh + ' noneHaveB1=' + noneHaveB1 + ' whZero=' + whZero);
  }

  // ---- W6. completeProduction with NO warehouseBranchId defaults to the Warehouse ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    flour.purchasePrice = 100;
    DB.setStock(flour, DB.WAREHOUSE_ID, 100); DB.save();
    const res = DB.completeProduction({ finishProductId: 40, finishQty: 80, lines: [{ productId: 15, qty: 100 }], createdBy: 'Rahmanullah', clientRef: 'w6-default' });
    log('W6 completeProduction with NO warehouseBranchId defaults to the Warehouse: Flour warehouse 100->0, Gulab warehouse 0->80, Branch 1 stays 0, production.warehouseBranchId is the warehouse id',
      res.ok === true && res.production.warehouseBranchId === DB.WAREHOUSE_ID &&
      DB.stockOf(flour, DB.WAREHOUSE_ID) === 0 &&
      DB.stockOf(DB.state.products.find((p) => p.id === 40), DB.WAREHOUSE_ID) === 80 &&
      DB.stockOf(DB.state.products.find((p) => p.id === 40), 1) === 0,
      'warehouseBranchId=' + (res.production && res.production.warehouseBranchId) + ' flourWh=' + DB.stockOf(flour, DB.WAREHOUSE_ID));
  }

  // ================= v2.1.0 cases =================
  const stockUp = (DB, id, qty, branchId) => {
    const p = DB.state.products.find((x) => x.id === id);
    DB.setStock(p, branchId == null ? DB.WAREHOUSE_ID : branchId, qty);
    return p;
  };
  const openShift = (DB, opening = 5000) =>
    DB.startShift({ cashierName: 'Test Cashier', openingBalance: opening, recordedBy: 'Test' });
  const ownerUser = (DB) => DB.state.appUsers.find((u) => u.role === 'Owner');
  const mgrUser = (DB) => DB.state.appUsers.find((u) => u.role === 'Manager');
  const counterUser = (DB) => DB.state.appUsers.find((u) => u.role === 'Counter Manager');
  const yesterdayISO = () => new Date(Date.now() - 86400000).toISOString();

  // ---- D-MIG1: a real v2.0.0 file (44 items, 2 logins, user-edited Cheese) migrates to 140/3 ----
  {
    const dir = freshDir();
    const DB0 = loadDB(dir); DB0.load();
    const v2 = goodState();
    v2.products = v2.products.filter((p) => p.id <= 55);
    v2.appUsers = [
      { id: 1, name: 'Rahmanullah', username: 'rahmanullah', pinHash: DB0.hashPin('1234'), role: 'Owner', branchId: null, branchName: null, isActive: true },
      { id: 2, name: 'Manager', username: 'manager', pinHash: DB0.hashPin('123'), role: 'Manager', branchId: null, branchName: null, isActive: true },
    ];
    // Strip every v2.1.0 addition so the file looks like a real v2.0.0 file.
    ['sales', 'saleLines', 'heldOrders', 'khataCustomers', 'khataPayments', 'shifts', 'staff', 'staffAttendance', 'shiftExpenses', 'deletedSales', 'batches', 'wastage', 'expenses', 'recipes'].forEach((t) => delete v2[t]);
    ['v210Migrated', 'managerCanSeeCost', 'posServiceCharge', 'posBillCopies', 'kotEnabled', 'kotRemarks', 'backupFormatVersion'].forEach((k) => delete v2.settings[k]);
    const ch = v2.products.find((p) => p.id === 18);
    ch.price = 7500; ch.purchasePrice = 4000; // user-entered prices
    ch.branchStocks = [{ branchId: 'warehouse', qty: 7 }, { branchId: 2, qty: 0 }, { branchId: 3, qty: 0 }];
    ch.stock = 7; // user stock
    writeState(dir, v2);
    const DB = loadDB(dir); DB.load();
    const cheese = DB.state.products.find((p) => p.id === 18);
    const counter = counterUser(DB);
    const mgr = mgrUser(DB);
    const owner = ownerUser(DB);
    DB.load(); // second load: migration must NOT re-run
    log('D-MIG1 v2.0.0 file (44 items, user Cheese 7500/4000 + stock 7, 2 logins) migrates on load: 140 items, 3 logins, Counter Manager PIN 1234 works, Manager display Warehouse, user Cheese price/stock/PINs unchanged, migration does not re-run',
      DB.state.products.length === 140 && DB.state.appUsers.length === 3 &&
      counter && DB.checkPin(counter, '1234') === true && counter.isPosOnly === true &&
      mgr && mgr.name === 'Warehouse' && mgr.username === 'manager' && DB.checkPin(mgr, '123') === true &&
      DB.checkPin(owner, '1234') === true &&
      cheese.price === 7500 && cheese.purchasePrice === 4000 && DB.stockOf(cheese, DB.WAREHOUSE_ID) === 7 &&
      DB.state.settings.v210Migrated === true && DB.state.settings.managerCanSeeCost === false &&
      DB.state.products.filter((p) => p.id >= 63).length === 96,
      'products=' + DB.state.products.length + ' users=' + DB.state.appUsers.map((u) => u.username).join(',') + ' cheese=' + cheese.price + '/' + cheese.purchasePrice + ' stockWh=' + DB.stockOf(cheese, DB.WAREHOUSE_ID));
  }

  // ---- D-MIG2: fresh seed is already fully migrated ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const newTables = ['sales', 'saleLines', 'heldOrders', 'khataCustomers', 'khataPayments', 'shifts', 'staff', 'staffAttendance', 'shiftExpenses', 'deletedSales', 'batches', 'wastage', 'expenses', 'recipes'];
    const tablesEmpty = newTables.every((t) => Array.isArray(DB.state[t]) && DB.state[t].length === 0);
    log('D-MIG2 fresh seed: 140 items, 3 logins, all 14 new tables empty, flags true, settings defaults present',
      DB.state.products.length === 140 && DB.state.appUsers.length === 3 && tablesEmpty &&
      DB.state.settings.v210Migrated === true && DB.state.settings.managerCanSeeCost === false &&
      DB.state.settings.posBillCopies === 1 && DB.state.settings.kotEnabled === true &&
      DB.state.settings.posServiceCharge && DB.state.settings.posServiceCharge.type === 'flat' &&
      DB.state.settings.backupFormatVersion === 2,
      'products=' + DB.state.products.length + ' users=' + DB.state.appUsers.length + ' tablesEmpty=' + tablesEmpty);
  }

  // ---- D-MIG3: id 96 exists (the plan's "id 96 absent" was wrong) ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const p96 = DB.state.products.find((p) => p.id === 96);
    const videoIds = DB.state.products.filter((p) => p.id >= 63).map((p) => p.id).sort((a, b) => a - b);
    const allPresent = videoIds.length === 96 && videoIds[0] === 63 && videoIds[95] === 158 &&
      videoIds.every((id, i) => id === 63 + i);
    log('D-MIG3 id 96 PRESENT: "Sahara Sp 1 Meter Pizza", price 4000, image null; ids 63-158 all present (96 items, no gap)',
      p96 && p96.name === 'Sahara Sp 1 Meter Pizza' && p96.price === 4000 && p96.image === null && allPresent,
      'id96=' + JSON.stringify(p96 && { name: p96.name, price: p96.price, image: p96.image }) + ' videoCount=' + videoIds.length);
  }

  // ---- D-SALE1: cash sale math, stock cut, movement reason, bill number ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    const sh = openShift(DB);
    const res = DB.createSale({ lines: [{ productId: 64, qty: 2 }], discount: 100, deliveryCharges: 50, clientRef: 'sale-1', recordedBy: 'Test' });
    const fajita = DB.state.products.find((p) => p.id === 64);
    const move = DB.state.stockMovements.find((m) => m.reference === 'SL-0001');
    log('D-SALE1 cash sale 2x Fajita S (600) + discount 100 + delivery 50: subtotal 1200, total 1150, stock 10->8, movement reason "Sale SL-0001", bill SL-0001, orderNo 1',
      sh.ok === true && res.ok === true && res.billNo === 'SL-0001' && res.sale.saleNo === 1 && res.sale.orderNo === 1 &&
      res.sale.subtotal === 1200 && res.sale.total === 1150 && res.sale.serviceCharge === 0 &&
      DB.stockOf(fajita, DB.WAREHOUSE_ID) === 8 &&
      move && move.qty === -2 && move.reason === 'Sale SL-0001 — Fajita S' &&
      DB.state.saleLines.length === 1 && DB.state.saleLines[0].unitPrice === 600,
      JSON.stringify({ billNo: res.billNo, subtotal: res.sale && res.sale.subtotal, total: res.sale && res.sale.total, stock: DB.stockOf(fajita, DB.WAREHOUSE_ID), move: move && move.reason }));
  }

  // ---- D-SALE2: same clientRef twice -> one sale, stock cut once ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    const opts = { lines: [{ productId: 64, qty: 2 }], clientRef: 'sale-dup-1', recordedBy: 'Test' };
    const r1 = DB.createSale(opts);
    const r2 = DB.createSale(opts);
    const fajita = DB.state.products.find((p) => p.id === 64);
    log('D-SALE2 double-submit same clientRef: one sale only (duplicate=true, same id), stock cut once (10->8, not 6)',
      r1.ok === true && r2.ok === true && r2.duplicate === true && r2.sale.id === r1.sale.id &&
      DB.state.sales.length === 1 && DB.stockOf(fajita, DB.WAREHOUSE_ID) === 8,
      'sales=' + DB.state.sales.length + ' stock=' + DB.stockOf(fajita, DB.WAREHOUSE_ID) + ' duplicate=' + r2.duplicate);
  }

  // ---- D-SALE3: unpriced item (id 130 goll rask) rejects the whole sale ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 130, 5);
    openShift(DB);
    const res = DB.createSale({ lines: [{ productId: 130, qty: 1 }], clientRef: 'sale-noprice', recordedBy: 'Test' });
    const item = DB.state.products.find((p) => p.id === 130);
    log('D-SALE3 unpriced item (id 130 goll rask, price null) sale rejected: no sale row, stock still 5, no movement',
      res.ok === false && /rate nahi hai/.test(res.message || '') &&
      DB.state.sales.length === 0 && DB.stockOf(item, DB.WAREHOUSE_ID) === 5 && DB.state.stockMovements.length === 0,
      'message=' + res.message);
  }

  // ---- D-HOLD1: hold stores lines JSON without prices; resume uses current price ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const h = DB.holdOrder({ orderType: 'dine_in', tableNo: 3, lines: [{ itemId: 64, qty: 2 }], recordedBy: 'Test' });
    const stored = DB.state.heldOrders[0];
    const busyWhileHeld = DB.tableStatus(3).busy; // captured BEFORE the delete below
    const r1 = DB.resumeHoldOrder(h.heldOrder.id);
    DB.updateItem(64, { price: 650 }, ownerUser(DB));
    const r2 = DB.resumeHoldOrder(h.heldOrder.id);
    const del = DB.deleteHoldOrder(h.heldOrder.id);
    log('D-HOLD1 dine-in Table 3 hold: lines JSON has no prices; resume uses current price (600, then 650 after a price change); table busy while held, free after delete',
      h.ok === true && stored && stored.linesJson === JSON.stringify([{ itemId: 64, quantity: 2 }]) &&
      !stored.linesJson.includes('price') && busyWhileHeld === true &&
      r1.ok === true && r1.cart.lines[0].unitPrice === 600 &&
      r2.ok === true && r2.cart.lines[0].unitPrice === 650 &&
      del.ok === true && DB.tableStatus(3).busy === false,
      'linesJson=' + stored.linesJson + ' resume1=' + (r1.cart.lines[0].unitPrice) + ' resume2=' + (r2.cart.lines[0].unitPrice));
  }

  // ---- D-KHATA1: khata sale -> balance; payment -> balance down; ledger has both ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    const c = DB.addKhataCustomer({ name: 'Test Customer', phone: '0300-1234567' });
    const sale = DB.createSale({ lines: [{ productId: 64, qty: 2 }], discount: 200, paymentMethod: 'Khata', customerId: c.customer.id, amountPaid: 0, clientRef: 'khata-1', recordedBy: 'Test' });
    const bal1 = DB.khataBalance(c.customer.id);
    const pay = DB.recordKhataPayment({ customerId: c.customer.id, amount: 400, note: 'Jama', recordedBy: 'Test' });
    const ledger = DB.khataLedger(c.customer.id);
    log('D-KHATA1 khata sale Rs 1,000 (2x600 - 200 discount, paid 0) -> balance 1,000; payment 400 -> balance 600; ledger has the sale + the payment',
      c.ok === true && sale.ok === true && sale.sale.total === 1000 && bal1 === 1000 &&
      pay.ok === true && pay.balance === 600 && DB.khataBalance(c.customer.id) === 600 &&
      ledger.ok === true && ledger.entries.length === 2 &&
      ledger.entries.some((e) => e.type === 'sale' && e.total === 1000) &&
      ledger.entries.some((e) => e.type === 'payment' && e.amount === 400),
      'bal1=' + bal1 + ' bal2=' + pay.balance + ' entries=' + JSON.stringify(ledger.entries.map((e) => e.type)));
  }

  // ---- D-KHATA2: khata customer without a name is rejected; khata sale without a customer is rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    const noName = DB.addKhataCustomer({ name: '' });
    const noName2 = DB.addKhataCustomer({});
    const noCustomer = DB.createSale({ lines: [{ productId: 64, qty: 1 }], paymentMethod: 'Khata', clientRef: 'khata-nocust', recordedBy: 'Test' });
    log('D-KHATA2 khata customer without a name rejected; khata sale without a customer rejected; no sale row created',
      noName.ok === false && noName2.ok === false && noCustomer.ok === false &&
      DB.state.khataCustomers.length === 0 && DB.state.sales.length === 0,
      'noName=' + noName.message + ' | noCustomer=' + noCustomer.message);
  }

  // ---- D-SHIFT1: start -> 2 sales -> close with counted=expected; next shift orderNo restarts at 1 ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10); stockUp(DB, 63, 10);
    const sh = openShift(DB, 5000);
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], paymentMethod: 'Cash', clientRef: 'sh1-a', recordedBy: 'Test' });
    DB.createSale({ lines: [{ productId: 63, qty: 1 }], paymentMethod: 'JazzCash', clientRef: 'sh1-b', recordedBy: 'Test' });
    const close = DB.closeShift({ shiftId: sh.shift.id, countedDrawer: 5600, recordedBy: 'Test' });
    const cl = close.shift.closing;
    const sh2 = DB.startShift({ cashierName: 'Test Cashier', openingBalance: 5600, recordedBy: 'Test' });
    const s3 = DB.createSale({ lines: [{ productId: 64, qty: 1 }], paymentMethod: 'Cash', clientRef: 'sh1-c', recordedBy: 'Test' });
    log('D-SHIFT1 start opening 5,000 -> Cash 600 + JazzCash 1,500 -> close counted 5,600: snapshot totals correct (totalSales 2,100, bills 2, expected 5,600, difference 0, nextOpening 5,600); next shift orderNo restarts at 1',
      sh.ok === true && close.ok === true && cl.totalSales === 2100 && cl.billCount === 2 &&
      cl.cashSales === 600 && cl.byPayment.Cash === 600 && cl.byPayment.JazzCash === 1500 &&
      cl.expectedDrawer === 5600 && cl.difference === 0 && cl.nextOpening === 5600 &&
      sh2.ok === true && s3.ok === true && s3.sale.orderNo === 1 && s3.sale.saleNo === 3,
      JSON.stringify(cl) + ' nextOrderNo=' + (s3.sale && s3.sale.orderNo));
  }

  // ---- D-SHIFT2: sale without any open shift is rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    const res = DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'noshift-1', recordedBy: 'Test' });
    log('D-SHIFT2 sale with NO open shift rejected (shift required); no sale, no stock cut',
      res.ok === false && /shift start karein/.test(res.message || '') &&
      DB.state.sales.length === 0 && DB.stockOf(DB.state.products.find((p) => p.id === 64), DB.WAREHOUSE_ID) === 10,
      'message=' + res.message);
  }

  // ---- D-SHIFT3: one open shift at a time; shift expense appears in the close snapshot ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const sh1 = openShift(DB, 5000);
    const sh2 = DB.startShift({ cashierName: 'Other', openingBalance: 1000, recordedBy: 'Test' });
    const exp = DB.addShiftExpense({ shiftId: sh1.shift.id, amount: 200, note: 'Chai', recordedBy: 'Test' });
    const close = DB.closeShift({ shiftId: sh1.shift.id, countedDrawer: 4800, recordedBy: 'Test' });
    log('D-SHIFT3 second open shift rejected; shift expense Rs 200 lands in the close snapshot (expensesTotal 200, expected 4,800, difference 0)',
      sh2.ok === false && exp.ok === true && close.ok === true &&
      close.shift.closing.expensesTotal === 200 && close.shift.closing.expectedDrawer === 4800 &&
      close.shift.closing.difference === 0 && close.shift.status === 'closed',
      'second=' + sh2.message + ' closing=' + JSON.stringify(close.shift.closing));
  }

  // ---- D-SUM1: summary math, void excluded, tax always 0 ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10); stockUp(DB, 63, 10);
    openShift(DB);
    const s1 = DB.createSale({ lines: [{ productId: 64, qty: 1 }], paymentMethod: 'Cash', clientRef: 'sum-1', recordedBy: 'Test' });
    const s2 = DB.createSale({ lines: [{ productId: 64, qty: 1 }], paymentMethod: 'Cash', clientRef: 'sum-2', recordedBy: 'Test' });
    DB.createSale({ lines: [{ productId: 63, qty: 1 }], paymentMethod: 'JazzCash', clientRef: 'sum-3', recordedBy: 'Test' });
    DB.voidSale(s2.sale.id, mgrUser(DB));
    const sum = DB.getSalesSummary({});
    log('D-SUM1 3 sales (Cash 600 + Cash 600 + JazzCash 1,500) + 1 void: byPayment Cash 600 / JazzCash 1,500, totalSales 2,100, bills 2, voidCount 1, voidedTotal 600, tax always 0',
      sum.totalSales === 2100 && sum.bills === 2 && sum.byPayment.Cash === 600 && sum.byPayment.JazzCash === 1500 &&
      sum.voidCount === 1 && sum.voidedTotal === 600 && sum.tax === 0 && sum.deletedCount === 0,
      JSON.stringify(sum));
  }

  // ---- D-SUM2: POS dashboard date filter — yesterday's sale is not in today's list ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'sum2-today', recordedBy: 'Test' });
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], occurredAt: yesterdayISO(), clientRef: 'sum2-yest', recordedBy: 'Test' });
    const today = DB._todayLocal();
    const yest = yesterdayISO().slice(0, 10);
    const dashToday = DB.getPosDashboard({ date: today });
    const dashYest = DB.getPosDashboard({ date: yest });
    log('D-SUM2 POS dashboard date filter: today shows 1 bill (Rs 600), yesterday shows 1 bill (Rs 600) — neither day leaks into the other',
      dashToday.bills === 1 && dashToday.totalSales === 600 && dashToday.sales[0].billNo === 'SL-0001' &&
      dashYest.bills === 1 && dashYest.totalSales === 600 && dashYest.sales[0].billNo === 'SL-0002' &&
      !('cost' in dashToday) && !('profit' in dashToday),
      'today=' + JSON.stringify({ bills: dashToday.bills, total: dashToday.totalSales }) + ' yest=' + JSON.stringify({ bills: dashYest.bills, total: dashYest.totalSales }));
  }

  // ---- D-VOID1: void returns stock, drops the khata balance, excludes from totals, keeps the row ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    const c = DB.addKhataCustomer({ name: 'Void Customer' });
    const ks = DB.createSale({ lines: [{ productId: 64, qty: 2 }], discount: 200, paymentMethod: 'Khata', customerId: c.customer.id, amountPaid: 0, clientRef: 'void-1', recordedBy: 'Test' });
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], paymentMethod: 'Cash', clientRef: 'void-2', recordedBy: 'Test' });
    const stockBefore = DB.stockOf(DB.state.products.find((p) => p.id === 64), DB.WAREHOUSE_ID); // 7
    const v = DB.voidSale(ks.sale.id, mgrUser(DB));
    const fajita = DB.state.products.find((p) => p.id === 64);
    const sum = DB.getSalesSummary({});
    const kept = DB.state.sales.find((s) => s.id === ks.sale.id);
    log('D-VOID1 void khata sale: stock back 7->9, khata balance 1,000->0, summary keeps only the Cash 600, sale row kept with voidedAt/voidedBy stamp',
      v.ok === true && stockBefore === 7 && DB.stockOf(fajita, DB.WAREHOUSE_ID) === 9 &&
      DB.khataBalance(c.customer.id) === 0 && sum.totalSales === 600 && sum.bills === 1 && sum.voidCount === 1 &&
      kept && kept.voidedAt != null && kept.voidedBy === 'Warehouse' &&
      !DB.state.stockMovements.some((m) => m.reference === 'SL-0001'),
      'stock=' + DB.stockOf(fajita, DB.WAREHOUSE_ID) + ' balance=' + DB.khataBalance(c.customer.id) + ' voidedBy=' + (kept && kept.voidedBy));
  }

  // ---- D-VOID2: double void is rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    const s = DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'void2-1', recordedBy: 'Test' });
    const v1 = DB.voidSale(s.sale.id, mgrUser(DB));
    const v2 = DB.voidSale(s.sale.id, mgrUser(DB));
    log('D-VOID2 voiding an already-voided sale is rejected; stock returned exactly once (10->9->10, not 11)',
      v1.ok === true && v2.ok === false && /pehle se void/.test(v2.message || '') &&
      DB.stockOf(DB.state.products.find((p) => p.id === 64), DB.WAREHOUSE_ID) === 10,
      'v2=' + v2.message + ' stock=' + DB.stockOf(DB.state.products.find((p) => p.id === 64), DB.WAREHOUSE_ID));
  }

  // ---- D-DEL1: Owner delete removes the row + logs a snapshot; Manager delete is rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    const s1 = DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'del-1', recordedBy: 'Test' });
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'del-2', recordedBy: 'Test' });
    const mgrDel = DB.deleteSale(s1.sale.id, mgrUser(DB));
    const salesAfterMgrDel = DB.state.sales.length;
    const ownerDel = DB.deleteSale(s1.sale.id, ownerUser(DB));
    const snap = DB.state.deletedSales[0] ? JSON.parse(DB.state.deletedSales[0].snapshotJson) : null;
    log('D-DEL1 Manager delete rejected (both sales stay); Owner delete removes the row, stock back 8->9, deletedSales holds a snapshot (saleNo 1, total 600)',
      mgrDel.ok === false && salesAfterMgrDel === 2 &&
      ownerDel.ok === true && DB.state.sales.length === 1 && DB.state.deletedSales.length === 1 &&
      DB.state.deletedSales[0].saleNo === 1 && DB.state.deletedSales[0].total === 600 &&
      snap && snap.sale.saleNo === 1 && snap.lines.length === 1 &&
      DB.stockOf(DB.state.products.find((p) => p.id === 64), DB.WAREHOUSE_ID) === 9,
      'mgrDel=' + mgrDel.message + ' deleted=' + JSON.stringify(DB.state.deletedSales[0] && { saleNo: DB.state.deletedSales[0].saleNo, total: DB.state.deletedSales[0].total }));
  }

  // ---- D-OWN1: owner dashboard — counter vs dispatch kept separate, branch breakdown, per-bill lines ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    DB.setItemCostPrice(64, 400, ownerUser(DB));
    stockUp(DB, 64, 10); stockUp(DB, 64, 10, 2);
    openShift(DB);
    DB.createSale({ lines: [{ productId: 64, qty: 2 }], clientRef: 'own-1', recordedBy: 'Test' }); // warehouse counter, 1200
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], branchId: 2, clientRef: 'own-2', recordedBy: 'Test' }); // branch 2, 600
    DB.state.transfers.unshift({ id: 1, billNo: 'SB-0001', date: new Date().toISOString(), fromBranchId: DB.WAREHOUSE_ID, toBranchId: 2, items: [{ productId: 64, qty: 5, unitPrice: 600 }], status: 'sent', createdBy: 'Test' });
    const today = DB._todayLocal();
    const d = DB.getOwnerDashboard({ from: today, to: today });
    const counter = d.branches.find((b) => b.branchId == null);
    const br2 = d.branches.find((b) => String(b.branchId) === '2');
    const line = d.bills[0].lines[0];
    log('D-OWN1 owner dashboard Today: totalSales 1,800 / bills 2 / cost 1,200 / profit 600; counter 1,200 vs Branch 2 600; per-bill line qty 2 / sale 600 / cost 400 / lineCost 800 / lineProfit 400; dispatch separate — qty 5, value 3,000, cost 2,000, margin 1,000',
      d.totals.totalSales === 1800 && d.totals.bills === 2 && d.totals.cost === 1200 && d.totals.profit === 600 &&
      counter && counter.totalSales === 1200 && counter.cost === 800 && counter.profit === 400 &&
      br2 && br2.totalSales === 600 && br2.cost === 400 && br2.profit === 200 &&
      line.qty === 2 && line.unitPrice === 600 && line.costPrice === 400 && line.lineCost === 800 && line.lineProfit === 400 &&
      d.totals.totalStockTransferred === 5 && d.dispatchTotals.qty === 5 && d.dispatchTotals.value === 3000 &&
      d.dispatchTotals.cost === 2000 && d.dispatchTotals.margin === 1000,
      JSON.stringify(d.totals) + ' dispatch=' + JSON.stringify(d.dispatchTotals));
  }

  // ---- D-OWN2: a line with no purchasePrice makes cost/profit null, never 0 or guessed ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 63, 5); // Fajita L, purchasePrice null
    openShift(DB);
    DB.createSale({ lines: [{ productId: 63, qty: 1 }], clientRef: 'own2-1', recordedBy: 'Test' });
    const d = DB.getOwnerDashboard({ range: 'today' });
    const line = d.bills[0].lines[0];
    log('D-OWN2 sale of an item with no purchasePrice: totalSales 1,500 but cost null, profit null, line costPrice/lineCost/lineProfit all null',
      d.totals.totalSales === 1500 && d.totals.cost === null && d.totals.profit === null &&
      line.costPrice === null && line.lineCost === null && line.lineProfit === null &&
      d.branches[0].cost === null && d.branches[0].profit === null,
      JSON.stringify({ totalSales: d.totals.totalSales, cost: d.totals.cost, profit: d.totals.profit }));
  }

  // ---- D-OWN3: Yesterday / Custom ranges exclude today's sales ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'own3-today', recordedBy: 'Test' });
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], occurredAt: yesterdayISO(), clientRef: 'own3-yest', recordedBy: 'Test' });
    const today = DB._todayLocal();
    const yest = yesterdayISO().slice(0, 10);
    const dY = DB.getOwnerDashboard({ range: 'yesterday' });
    const dT = DB.getOwnerDashboard({ from: today, to: today });
    log('D-OWN3 Yesterday range shows only yesterday (1 bill, 600); Custom today-only shows only today (1 bill, 600)',
      dY.totals.bills === 1 && dY.totals.totalSales === 600 && dY.from === yest && dY.to === yest &&
      dT.totals.bills === 1 && dT.totals.totalSales === 600,
      'yest=' + JSON.stringify(dY.totals) + ' today=' + JSON.stringify(dT.totals));
  }

  // ---- D-COST1: Manager cannot see cost (toggle OFF); Manager updateItem cannot change purchasePrice ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const mgr = mgrUser(DB);
    const before = DB.state.products.find((p) => p.id === 18).purchasePrice; // 5000
    const r = DB.updateItem(18, { price: 8100, purchasePrice: 9999 }, mgr);
    const cheese = DB.state.products.find((p) => p.id === 18);
    log('D-COST1 toggle OFF: canSeeCost(Manager)=false, canSeeCost(Owner)=true, canSeeCost(Counter Manager)=false; Manager updateItem changes price (8000->8100) but purchasePrice stays 5000',
      DB.canSeeCost(mgr) === false && DB.canSeeCost(ownerUser(DB)) === true && DB.canSeeCost(counterUser(DB)) === false &&
      r.ok === true && cheese.price === 8100 && cheese.purchasePrice === 5000 && before === 5000,
      'price=' + cheese.price + ' purchasePrice=' + cheese.purchasePrice);
  }

  // ---- D-COST2: Owner updateItem also cannot change purchasePrice; only setItemCostPrice can; non-Owner setItemCostPrice rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const owner = ownerUser(DB);
    const mgr = mgrUser(DB);
    const r1 = DB.updateItem(18, { purchasePrice: 9999 }, owner);
    const still = DB.state.products.find((p) => p.id === 18).purchasePrice;
    const r2 = DB.setItemCostPrice(18, 4500, owner);
    const after = DB.state.products.find((p) => p.id === 18).purchasePrice;
    const r3 = DB.setItemCostPrice(18, 9999, mgr);
    const afterMgr = DB.state.products.find((p) => p.id === 18).purchasePrice;
    log('D-COST2 Owner updateItem leaves purchasePrice at 5000; Owner setItemCostPrice moves it to 4500; Manager setItemCostPrice rejected (stays 4500)',
      r1.ok === true && still === 5000 && r2.ok === true && after === 4500 &&
      r3.ok === false && afterMgr === 4500,
      'afterOwnerUpdate=' + still + ' afterSet=' + after + ' afterMgr=' + afterMgr);
  }

  // ---- D-COST3: a purchase (Manager or Owner) never changes the master purchasePrice ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    // Exactly what purchases.js records: a purchase + lines with a rate — the master price is untouched.
    DB.state.purchases.push({ id: 1, invoiceNo: 'INV-001', date: new Date().toISOString(), supplierId: null, supplierName: 'Test', total: 9999, paid: 0, remaining: 9999, branchId: DB.WAREHOUSE_ID, createdBy: 'Warehouse' });
    DB.state.purchaseLines.push({ purchaseId: 1, productId: 18, qty: 1, unitPrice: 9999, lineTotal: 9999 });
    const cheese = DB.state.products.find((p) => p.id === 18);
    const r = DB.updateItem(18, { costPrice: 123 }, ownerUser(DB));
    log('D-COST3 Manager purchase at Rs 9,999/line leaves master purchasePrice at 5000 (rate lives only on the purchase line); updateItem also drops costPrice (stays null)',
      cheese.purchasePrice === 5000 && r.ok === true && cheese.costPrice === null,
      'purchasePrice=' + cheese.purchasePrice + ' costPrice=' + cheese.costPrice);
  }

  // ---- D-COST4: toggle ON lets the Manager SEE cost but still not edit it ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    DB.state.settings.managerCanSeeCost = true;
    const mgr = mgrUser(DB);
    const r1 = DB.updateItem(18, { purchasePrice: 7777 }, mgr);
    const r2 = DB.setItemCostPrice(18, 7777, mgr);
    const cheese = DB.state.products.find((p) => p.id === 18);
    log('D-COST4 toggle ON: Manager canSeeCost=true, but updateItem still cannot change purchasePrice (5000) and setItemCostPrice is still rejected',
      DB.canSeeCost(mgr) === true && r1.ok === true && cheese.purchasePrice === 5000 && r2.ok === false,
      'canSee=' + DB.canSeeCost(mgr) + ' purchasePrice=' + cheese.purchasePrice);
  }

  // ---- D-REC1: recipe save -> production from recipe -> PB bill + stock moves; Owner production rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    flour.purchasePrice = 100;
    stockUp(DB, 15, 100);
    const ownerProd = DB.completeProduction({ finishProductId: 40, finishQty: 80, lines: [{ productId: 15, qty: 100 }], createdBy: 'Rahmanullah', clientRef: 'rec-owner', user: ownerUser(DB) });
    const flourAfterOwnerReject = DB.stockOf(flour, DB.WAREHOUSE_ID);
    const rec = DB.saveRecipe({ finishProductId: 40, name: 'Gulab Jamun Recipe', lines: [{ productId: 15, qty: 100 }], createdBy: 'Warehouse' });
    const res = DB.completeProduction({ finishProductId: 40, finishQty: 80, recipeId: rec.recipe.id, createdBy: 'Warehouse', clientRef: 'rec-1' });
    const gulab = DB.state.products.find((p) => p.id === 40);
    log('D-REC1 Owner production rejected (Flour still 100); recipe saved -> production from recipe: bill PB-0001, Flour 100->0, Gulab 0->80, cost/unit 125, finish costPrice set to 125 by production only',
      ownerProd.ok === false && flourAfterOwnerReject === 100 &&
      rec.ok === true && res.ok === true && res.production.billNo === 'PB-0001' &&
      res.production.costPerUnit === 125 && res.production.recipeId === rec.recipe.id &&
      DB.stockOf(flour, DB.WAREHOUSE_ID) === 0 && DB.stockOf(gulab, DB.WAREHOUSE_ID) === 80 && gulab.costPrice === 125,
      'ownerProd=' + ownerProd.message + ' bill=' + (res.production && res.production.billNo) + ' costPrice=' + gulab.costPrice);
  }

  // ---- D-EXP1: FEFO picks the earlier-expiry batch first; expired batches block dispatch ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    DB.updateItem(15, { expiryTracked: true }, ownerUser(DB));
    stockUp(DB, 15, 100);
    const today = DB._todayLocal();
    const bA = DB.addBatch({ productId: 15, qty: 10, expiryDate: DB._addDays(today, 30) }); // later expiry
    const bB = DB.addBatch({ productId: 15, qty: 10, expiryDate: DB._addDays(today, 1) }); // earlier expiry
    DB.addBatch({ productId: 15, qty: 50, expiryDate: DB._addDays(today, -1) }); // EXPIRED
    const pick = DB.fefoPick(15, DB.WAREHOUSE_ID, 12);
    const blocked = DB.fefoPick(15, DB.WAREHOUSE_ID, 25); // fresh is only 20
    log('D-EXP1 FEFO: 12 units come from the earlier-expiry batch first (10) then the later one (2); asking 25 is rejected because only 20 fresh units exist (the expired 50 are never used)',
      bA.ok === true && bB.ok === true && pick.ok === true &&
      pick.picks.length === 2 && pick.picks[0].batchId === bB.batch.id && pick.picks[0].qty === 10 &&
      pick.picks[1].batchId === bA.batch.id && pick.picks[1].qty === 2 &&
      blocked.ok === false && /expired/.test(blocked.message || ''),
      'picks=' + JSON.stringify(pick.picks) + ' blocked=' + blocked.message);
  }

  // ---- D-EXP2: wastage cuts stock, is not a sale ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 15, 100);
    const soldBefore = DB.soldQtyForBranch(DB.WAREHOUSE_ID);
    const w = DB.recordWastage({ productId: 15, qty: 5, reason: 'Kharab ho gaya', recordedBy: 'Warehouse' });
    const flour = DB.state.products.find((p) => p.name === 'Flour');
    const lastMove = DB.state.stockMovements[DB.state.stockMovements.length - 1];
    log('D-EXP2 wastage 5 Kg Flour: stock 100->95, movement reason "Wastage — …", isSaleMovement=false, Sold figure unchanged',
      w.ok === true && DB.stockOf(flour, DB.WAREHOUSE_ID) === 95 &&
      lastMove.reason === 'Wastage — Kharab ho gaya' && DB.isSaleMovement(lastMove) === false &&
      DB.soldQtyForBranch(DB.WAREHOUSE_ID) === soldBefore,
      'stock=' + DB.stockOf(flour, DB.WAREHOUSE_ID) + ' reason=' + lastMove.reason);
  }

  // ---- D-SUP1: supplier add/list + supplier-wise purchases; duplicate name rejected ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const s1 = DB.addSupplier({ name: 'Test Supplier', phone: '0300-1' });
    const dup = DB.addSupplier({ name: 'test supplier' });
    const noName = DB.addSupplier({ name: '' });
    DB.state.purchases.push({ id: 1, invoiceNo: 'INV-1', date: new Date().toISOString(), supplierId: s1.supplier.id, supplierName: 'Test Supplier', total: 5000, paid: 5000, remaining: 0, branchId: DB.WAREHOUSE_ID, createdBy: 'Warehouse' });
    const list = DB.supplierPurchases(s1.supplier.id);
    log('D-SUP1 supplier added; duplicate name (case-insensitive) rejected; nameless rejected; supplier-wise purchases list the one purchase',
      s1.ok === true && dup.ok === false && noName.ok === false &&
      DB.state.suppliers.length === 1 && list.length === 1 && list[0].invoiceNo === 'INV-1',
      'suppliers=' + DB.state.suppliers.length + ' purchases=' + list.length);
  }

  // ---- D-SALE4 (REGRESSION): a multi-line sale gives every saleLine a distinct id ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10); stockUp(DB, 63, 10);
    openShift(DB);
    const res = DB.createSale({ lines: [{ productId: 64, qty: 1 }, { productId: 63, qty: 2 }], clientRef: 'sale4-1', recordedBy: 'Test' });
    const ids = DB.state.saleLines.map((l) => l.id);
    const bill = DB.getSaleBill(res.sale.id);
    log('D-SALE4 multi-line sale (Fajita S x1 + Fajita L x2): subtotal 3,600, 2 saleLines with DISTINCT ids, getSaleBill returns both lines with names',
      res.ok === true && res.sale.subtotal === 3600 && DB.state.saleLines.length === 2 &&
      new Set(ids).size === 2 && bill && bill.lines.length === 2 &&
      bill.lines.some((l) => l.name === 'Fajita S') && bill.lines.some((l) => l.name === 'Fajita L'),
      'saleLineIds=' + JSON.stringify(ids) + ' subtotal=' + (res.sale && res.sale.subtotal));
  }

  // ---- D-BKP1: backup guard rejects every bad backup; valid round-trip restores SL-0001 + SB-0001 ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    stockUp(DB, 64, 10);
    openShift(DB);
    DB.createSale({ lines: [{ productId: 64, qty: 1 }], clientRef: 'bkp-1', recordedBy: 'Test' });
    DB.state.transfers.unshift({ id: 1, billNo: 'SB-0001', date: new Date().toISOString(), fromBranchId: DB.WAREHOUSE_ID, toBranchId: 2, items: [{ productId: 64, qty: 2, unitPrice: 600 }], status: 'sent', createdBy: 'Test' });
    DB.save();
    const untouched = () => DB.state.products.length === 140 && DB.state.sales.length === 1 && DB.state.transfers.length === 1;
    const rBadJson = DB.importBackup('{oops');
    const rEmpty = DB.importBackup({});
    const w0 = DB.exportBackup(); w0.data = JSON.parse(JSON.stringify(w0.data)); w0.data.products = [];
    const r0items = DB.importBackup(w0);
    const wApp = DB.exportBackup(); wApp.app = 'rara-pos';
    const rApp = DB.importBackup(wApp);
    const wVer = DB.exportBackup(); wVer.version = 99;
    const rVer = DB.importBackup(wVer);
    const wMov = DB.exportBackup(); wMov.data = JSON.parse(JSON.stringify(wMov.data)); delete wMov.data.stockMovements;
    const rMov = DB.importBackup(wMov);
    const wOwn = DB.exportBackup(); wOwn.data = JSON.parse(JSON.stringify(wOwn.data));
    wOwn.data.appUsers = wOwn.data.appUsers.filter((u) => u.role !== 'Owner');
    const rOwn = DB.importBackup(wOwn);
    const rWeb = DB.importBackup(LIVE23);
    const allRejected = [rBadJson, rEmpty, r0items, rApp, rVer, rMov, rOwn, rWeb].every((r) => r.ok === false);
    const webMsg = /WEB app/.test(rWeb.message || '');
    const stillUntouched = untouched(); // captured BEFORE the round-trip reset below
    const exp = JSON.stringify(DB.exportBackup());
    DB.state.sales = []; DB.state.transfers = []; DB.save();
    const rt = DB.importBackup(exp);
    log('D-BKP1 guard: bad JSON / {} / 0-items / wrong app / version 99 / movements missing / no active Owner / WEB-format backup ALL rejected, current data untouched; valid round-trip restores SL-0001 + SB-0001',
      allRejected && webMsg && stillUntouched === true &&
      rt.ok === true && DB.state.sales.length === 1 && DB.state.sales[0].saleNo === 1 &&
      DB.state.transfers.length === 1 && DB.state.transfers[0].billNo === 'SB-0001' && DB.state.products.length === 140,
      'rejected=' + [rBadJson, rEmpty, r0items, rApp, rVer, rMov, rOwn, rWeb].map((r) => r.ok).join(',') + ' webMsg=' + webMsg + ' roundTrip=' + JSON.stringify(rt));
  }

  // ---- D-BKP2: legacy raw format (no wrapper) is accepted with a warning ----
  {
    const dir = freshDir();
    const DB = loadDB(dir); DB.load();
    const raw = goodState();
    const r1 = DB.importBackup(raw);
    const r2 = DB.importBackup(JSON.stringify(goodState()));
    log('D-BKP2 legacy raw desktop state (object and JSON string) accepted WITH a warning; products 140, logins 3',
      r1.ok === true && r1.warning != null && r2.ok === true && r2.warning != null &&
      DB.state.products.length === 140 && DB.state.appUsers.length === 3,
      'warning=' + r1.warning);
  }

  // ---- D-PHOTO1: every seed item with a photo has its file in assets/products/ ----
  {
    const withPhoto = SEED.products.filter((p) => p.image);
    const missing = withPhoto.filter((p) => !fs.existsSync(path.join(APP_DIR, 'assets', 'products', path.basename(p.image))));
    const p96 = SEED.products.find((p) => p.id === 96);
    log('D-PHOTO1 every seed item with a non-null image has its file in assets/products/ (139 files); id 96 image null',
      withPhoto.length === 139 && missing.length === 0 && p96 && p96.image === null,
      'withPhoto=' + withPhoto.length + ' missing=' + missing.map((p) => p.id).join(','));
  }

} catch (e) {
  log('HARNESS ERROR: ' + (e && e.stack ? e.stack : e.message), false);
} finally {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n==== SUMMARY: ${passed}/${total} passed, ${total - passed} failed ====`);
  process.exit(passed === total ? 0 : 1);
}
