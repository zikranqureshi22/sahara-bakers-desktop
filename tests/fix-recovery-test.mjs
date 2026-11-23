// Sahara Bakers Desktop v2.0.0 — focused headless Electron test for the
// empty-file .bak recovery fix (src/db.js DB.load()).
// ONE launch, fresh HOME, pre-seeded userData: EMPTY data file (seed flag
// already applied) + GOOD .bak (140 items, Owner PIN 1234) + NO timestamped
// backups. Expects: login-selection screen with Rahmanullah + Manager
// (not Owner Setup), sticky .bak recovery flags, PIN 1234 logs in,
// 140 items present, zero console errors. Xvfb + real Electron 38 +
// CDP, REAL mouse clicks only.
// Run: node fix-recovery-test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(os.tmpdir(), 'sahara-test-fix');
const HOME = path.join(RUN_DIR, 'home');
const DISPLAY = ':99';
const CDP_PORT = 9227;
const EVIDENCE = path.join(APP_DIR, '..', 'sahara-bakers-desktop-test-evidence');
const LOG_FILE = path.join(EVIDENCE, 'fix-recovery-test.log');

fs.rmSync(RUN_DIR, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

const results = [];
const consoleErrors = [];
function log(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let xvfb = null, app = null, ws = null, msgId = 0;
const pending = new Map();
const electronBin = path.join(APP_DIR, 'node_modules/.bin/electron');

function launchElectron(home) {
  const env = { ...process.env, HOME: home, DISPLAY, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  app = spawn(electronBin, ['.', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox'], { cwd: APP_DIR, env, stdio: 'ignore' });
}
async function connectCDP() {
  msgId = 0; pending.clear(); ws = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await Promise.race([
          new Promise((res2, rej) => { ws.onopen = res2; ws.onerror = rej; }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ws open timeout')), 10000)),
        ]);
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
          else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push('console.error: ' + JSON.stringify(m.params.args).slice(0, 400));
        };
        await cdp('Runtime.enable'); await cdp('Page.enable');
        return true;
      }
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  return false;
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, 20000);
  });
}
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' | expr=' + String(expr).slice(0, 300));
  return r.result ? r.result.value : undefined;
}
async function waitFor(expr, timeoutMs = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await ev(expr)) return true; } catch (e) { /* retry */ }
    await sleep(300);
  }
  throw new Error('timeout waiting for: ' + (label || expr));
}
async function clickEl(finderExpr, label, yFrac = 0.5) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rect = await ev(`(() => { const el = (${finderExpr}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height*${yFrac}; const top = document.elementFromPoint(x, y); return {x, y, clear: !!(top && (top === el || el.contains(top)))}; })()`);
    if (!rect) throw new Error('click target not found: ' + label);
    if (!rect.clear) throw new Error('click target covered by another element: ' + label);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sleep(400);
    return;
  }
}
async function typeInto(finderExpr, label, text) {
  await clickEl(finderExpr, label);
  await cdp('Input.insertText', { text });
  await sleep(300);
}
async function screenshot(name) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync(path.join(EVIDENCE, name), Buffer.from(shot.data, 'base64'));
}
async function waitForAppExit(timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (app.exitCode !== null && app.exitCode !== undefined) return true;
    await sleep(200);
  }
  return false;
}

try {
  // ---- Pre-seed userData: empty data file + good .bak, NO backups ----
  const userData = path.join(HOME, '.config', 'Sahara Bakers');
  fs.mkdirSync(userData, { recursive: true });
  const seedState = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'src/seed.json'), 'utf8'));
  delete seedState._note;
  const emptyState = { products: [], branches: [], stockMovements: [], transfers: [], purchases: [], purchaseLines: [], suppliers: [], appUsers: [], loginSecurity: {}, settings: { businessName: 'Sahara Bakers', currency: 'PKR', v100FreshSeedApplied: true } };
  fs.writeFileSync(path.join(userData, 'sahara-bakers-data.json'), JSON.stringify(emptyState, null, 2), 'utf8');
  fs.writeFileSync(path.join(userData, 'sahara-bakers-data.json.bak'), JSON.stringify(seedState, null, 2), 'utf8');
  // No backups/ directory at all — the login-screen one-click restore
  // cannot help here (it needs a timestamped backup).
  log('SETUP pre-seeded userData: empty data file (flag applied) + good .bak (140 items) + no backups dir',
    fs.existsSync(path.join(userData, 'sahara-bakers-data.json.bak')) && !fs.existsSync(path.join(userData, 'backups')),
    'userData=' + userData);

  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x900x24'], { stdio: 'ignore' });
  await sleep(1500);

  launchElectron(HOME);
  if (!(await connectCDP())) throw new Error('CDP connect failed');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 30000, 'login screen with three login cards');

  // R1: PIN screen shows Rahmanullah (recovered login), NOT Owner Setup.
  const r1 = await ev(`(() => { const users = [...document.querySelectorAll('.login-role-card')].map(b => b.getAttribute('data-username')); const body = document.getElementById('login-body').innerText; return { users, setupShown: body.includes('Owner Setup'), recovered: DB.recoveredFromBackup, loadError: DB.loadError, products: DB.state.products.length, noticeNow: [...document.querySelectorAll('.notice')].map(n => n.textContent).join(' || ') }; })()`);
  log('R1 empty file + good .bak + no backups: app opens to the login-selection screen with Rahmanullah + Warehouse + Counter Manager cards (NOT Owner Setup); sticky flags prove the .bak recovery',
    r1.users.length === 3 && r1.users.includes('rahmanullah') && r1.users.includes('manager') && r1.users.includes('counter') && r1.setupShown === false &&
    r1.recovered === true &&
    r1.loadError === 'Khaali data mila — pichli achi copy (.bak) se data wapas laya gaya hai.' &&
    r1.products === 140,
    JSON.stringify(r1));
  await screenshot('fix-recovery-login.png');

  // R2: PIN 1234 logs in (real mouse clicks) and all 140 items are present.
  await clickEl(`document.querySelector('.login-role-card[data-username="rahmanullah"]')`, 'login card Rahmanullah');
  await waitFor(`document.querySelector('.pin-input')`, 8000, 'Owner PIN page');
  await typeInto(`document.querySelector('.pin-input')`, 'PIN field', '1234');
  await clickEl(`document.querySelector('#login-body button[type=submit]')`, 'Login Karein submit');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'logged in');
  await ev(`(() => { DB.state.settings.sessionTimeoutMinutes = 120; DB.save(); return true; })()`);
  const r2 = await ev(`(() => { return { products: DB.state.products.length, raw: DB.state.products.filter(p => p.type === 'raw').length, fin: DB.state.products.filter(p => p.type === 'finished').length, head: (document.querySelector('#screen h1') || {}).textContent, greeting: (document.querySelector('.od-greeting') || {}).textContent }; })()`);
  log('R2 PIN 1234 logs in after the .bak recovery; Owner Dashboard lands (greeting shown) with all 140 items present (28 raw / 112 finished)',
    r2.products === 140 && r2.raw === 28 && r2.fin === 112 && r2.head === 'Owner Dashboard' && /Assalamualaikum wa Rahmatullah, Rahmanullah/.test(r2.greeting || ''),
    JSON.stringify(r2));
  await screenshot('fix-recovery-electron.png');

  // R3: the on-disk data file was rewritten with the recovered 140 items.
  const mainAfter = JSON.parse(fs.readFileSync(path.join(userData, 'sahara-bakers-data.json'), 'utf8'));
  const bakAfter = JSON.parse(fs.readFileSync(path.join(userData, 'sahara-bakers-data.json.bak'), 'utf8'));
  log('R3 on-disk data file now holds the recovered 140 items; .bak still holds its good 140 items',
    mainAfter.products.length === 140 && bakAfter.products.length === 140,
    'main=' + mainAfter.products.length + ' bak=' + bakAfter.products.length);

  try { await ev(`window.close()`); } catch (e) { /* page closing */ }
  const exited = await waitForAppExit();
  log('R4 app closes cleanly after the recovery launch', exited === true, 'exited=' + exited);
  if (!exited) { try { app.kill('SIGKILL'); } catch (e) {} }

  log('R5 zero console errors / exceptions during the recovery launch', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' ; '));
} catch (e) {
  log('HARNESS ERROR: ' + e.message, false);
} finally {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = `\n==== SUMMARY: ${passed}/${total} passed, ${total - passed} failed ====\n`;
  console.log(summary);
  fs.writeFileSync(LOG_FILE, results.map((r) => (r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : '')).join('\n') + summary);
  try { if (ws) ws.close(); } catch (e) {}
  try { if (app && app.exitCode === null) app.kill('SIGKILL'); } catch (e) {}
  try { if (xvfb) xvfb.kill('SIGKILL'); } catch (e) {}
  await sleep(500);
  process.exit(passed === total ? 0 : 1);
}
