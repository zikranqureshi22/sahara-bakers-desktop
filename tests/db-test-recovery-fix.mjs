// Sahara Bakers Desktop v1.0.0 — Node DB tests for the empty-file .bak
// recovery fix (src/db.js DB.load(): the empty-file path now also consults
// the .bak copy, not only the corrupt-file path).
// Plain node, no framework. Same harness pattern as db-test.mjs: each case
// gets a fresh temp dir; SAHARA_DATA_DIR is set before (re-)requiring
// src/db.js (cache-busted per case).
// Run: node db-test-recovery-fix.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(APP_DIR, 'src/db.js');
const SEED = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'src/seed.json'), 'utf8'));

const results = [];
function log(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sahara-db-fix-')); }
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
// A good .bak the way the app itself leaves one: the seeded data file.
function seedGoodBak(dir) {
  const DB = loadDB(dir); DB.load(); // seeds 140 items, saves the data file
  const goodBytes = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), goodBytes, 'utf8');
  return goodBytes;
}

try {
  // ---- F1 (a). Empty file + good .bak + no timestamped backups -> recovers 140 ----
  {
    const dir = freshDir();
    const goodBytes = seedGoodBak(dir);
    writeState(dir, emptyStateWithFlag(true)); // empty, flag already applied
    const DB2 = loadDB(dir); DB2.load();
    const bakAfter = fs.readFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), 'utf8');
    const mainAfter = JSON.parse(fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8'));
    const owner = DB2.state.appUsers.find((u) => u.role === 'Owner');
    log('F1 (a) empty file + good .bak + no backups recovers 140 items, flags set, .bak notice, .bak untouched, data file rewritten, Owner PIN 1234 still works',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true &&
      DB2.loadError === 'Khaali data mila — pichli achi copy (.bak) se data wapas laya gaya hai.' &&
      bakAfter === goodBytes && mainAfter.products.length === 140 &&
      owner && DB2.checkPin(owner, '1234') === true,
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }

  // ---- F2 (b). Empty file + corrupt .bak + no backups -> stays empty, same notice ----
  {
    const dir = freshDir();
    seedGoodBak(dir);
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json.bak'), '{corrupt bak!!!', 'utf8');
    writeState(dir, emptyStateWithFlag(true));
    const DB2 = loadDB(dir); DB2.load();
    const mainAfter = JSON.parse(fs.readFileSync(path.join(dir, 'sahara-bakers-data.json'), 'utf8'));
    log('F2 (b) empty file + corrupt .bak + no backups stays EMPTY with the unchanged notice, recovered flag false',
      DB2.state.products.length === 0 && DB2.recoveredFromBackup === false &&
      DB2.loadError === 'Khaali data mila aur koi acha backup nahi mila — Backup se restore karein ya naya item add karein.' &&
      mainAfter.products.length === 0,
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }

  // ---- F3 (c). Empty file + good .bak + good timestamped backup -> still recovers 140 ----
  {
    const dir = freshDir();
    const goodBytes = seedGoodBak(dir);
    // Timestamped backup holds the same 140 items but one product renamed,
    // so the winning source is identifiable.
    const backupState = goodState();
    backupState.products.find((p) => p.name === 'Ghee').name = 'Ghee-FromBackup';
    writeBackup(dir, backupState, '2026-11-17_10-00-00-000');
    writeState(dir, emptyStateWithFlag(true));
    const DB2 = loadDB(dir); DB2.load();
    const gheeName = (DB2.state.products.find((p) => p.id === 12) || {}).name;
    log('F3 (c) empty file + good .bak + good timestamped backup recovers 140 items (either source accepted; .bak is tried first, so Ghee keeps its .bak name)',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true &&
      (gheeName === 'Ghee' || gheeName === 'Ghee-FromBackup'),
      'products=' + DB2.state.products.length + ' gheeName=' + gheeName + ' loadError=' + DB2.loadError);
  }

  // ---- F4. Empty file + .bak that parses but is EMPTY (0 products, 0 logins) -> stays empty ----
  {
    const dir = freshDir();
    seedGoodBak(dir);
    writeState(dir, emptyStateWithFlag(true), 'sahara-bakers-data.json.bak'); // empty .bak
    writeState(dir, emptyStateWithFlag(true)); // empty main file
    const DB2 = loadDB(dir); DB2.load();
    log('F4 empty file + parseable-but-empty .bak (0 products, 0 logins) + no backups stays EMPTY with the unchanged notice',
      DB2.state.products.length === 0 && DB2.recoveredFromBackup === false &&
      DB2.loadError === 'Khaali data mila aur koi acha backup nahi mila — Backup se restore karein ya naya item add karein.',
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }

  // ---- F5. Empty file + login-only .bak (0 products, 1 login) -> logins recover (fallback) ----
  {
    const dir = freshDir();
    const DB0 = loadDB(dir); DB0.load();
    const loginOnly = emptyStateWithFlag(true);
    loginOnly.appUsers = [{ id: 1, name: 'Rahmanullah', username: 'rahmanullah', role: 'Owner', pinHash: DB0.hashPin('1234') }];
    writeState(dir, loginOnly, 'sahara-bakers-data.json.bak');
    writeState(dir, emptyStateWithFlag(true));
    const DB2 = loadDB(dir); DB2.load();
    log('F5 empty file + login-only .bak (0 products, 1 login) recovers the login; v2/v2.1.0 migrations add Warehouse (PIN 123) + Counter Manager (PIN 1234) alongside the recovered Owner (PIN 1234); products stay 0 (the video merge only runs on files that already hold products)',
      DB2.state.products.length === 0 && DB2.state.appUsers.length === 3 &&
      DB2.recoveredFromBackup === true && DB2.checkPin(DB2.state.appUsers[0], '1234') === true &&
      DB2.checkPin(DB2.state.appUsers[1], '123') === true &&
      DB2.checkPin(DB2.state.appUsers.find((u) => u.role === 'Counter Manager'), '1234') === true &&
      /pichli achi copy \(\.bak\)/.test(DB2.loadError || ''),
      'products=' + DB2.state.products.length + ' logins=' + DB2.state.appUsers.length + ' loadError=' + DB2.loadError);
  }

  // ---- F6. Missing .bak entirely -> unchanged behaviour (stays empty) ----
  {
    const dir = freshDir();
    writeState(dir, emptyStateWithFlag(true)); // no .bak file at all, no backups
    const DB = loadDB(dir); DB.load();
    log('F6 empty file + no .bak at all + no backups stays EMPTY with the unchanged notice',
      DB.state.products.length === 0 && DB.recoveredFromBackup === false &&
      DB.loadError === 'Khaali data mila aur koi acha backup nahi mila — Backup se restore karein ya naya item add karein.',
      'products=' + DB.state.products.length + ' loadError=' + DB.loadError);
  }

  // ---- F7. Sticky flags: a second load() on the same object keeps the .bak recovery report ----
  {
    const dir = freshDir();
    seedGoodBak(dir);
    writeState(dir, emptyStateWithFlag(true));
    const DB2 = loadDB(dir); DB2.load();
    const err1 = DB2.loadError;
    DB2.load(); // second load on the SAME object (renderer modules each call load())
    log('F7 recovery flags are STICKY after a .bak recovery: a second load() on the same object does not wipe recoveredFromBackup/loadError',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true && DB2.loadError === err1,
      'flag=' + DB2.recoveredFromBackup + ' err=' + DB2.loadError);
  }

  // ---- F8. Corrupt path unchanged: corrupt main + good .bak still recovers with the OLD notice ----
  {
    const dir = freshDir();
    seedGoodBak(dir);
    fs.writeFileSync(path.join(dir, 'sahara-bakers-data.json'), '{corrupt json!!!', 'utf8');
    const DB2 = loadDB(dir); DB2.load();
    log('F8 corrupt path UNCHANGED: corrupt main + good .bak recovers 140 items with the original corrupt-path notice',
      DB2.state.products.length === 140 && DB2.recoveredFromBackup === true &&
      DB2.loadError === 'Main data file kharab thi — pichli achi copy (.bak) se data wapas laya gaya hai.',
      'products=' + DB2.state.products.length + ' loadError=' + DB2.loadError);
  }
} catch (e) {
  log('HARNESS ERROR: ' + (e && e.stack ? e.stack : e.message), false);
} finally {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n==== SUMMARY: ${passed}/${total} passed, ${total - passed} failed ====`);
  process.exit(passed === total ? 0 : 1);
}
