// Sahara Bakers Desktop v2.1.0 — headless Electron tests.
// Xvfb + real Electron 38 + CDP. REAL mouse clicks via
// Input.dispatchMouseEvent only (never el.click()). Fresh HOME per launch.
// Launch 1 (fresh HOME): splash -> login-selection cards, wrong PIN +
// countdown, Owner 1234 login -> Owner Dashboard (v2.1.0), sidebar,
// Products (140 rows, search, add/edit/delete), Manager stock-in Flour
// 100, Owner raw cost edit Rs 100, Manager Production 100 Kg -> 80 Kg
// (PB-0001 exact numbers), over-stock rejection, Manager Transfer
// SB-0001 Warehouse -> Branch 2 (both legs, bill fields, From:
// Warehouse), Transfer SB-0002 Warehouse -> Branch 1 (previously
// impossible), Billing re-print, Manager 123 login (daily-ops
// dashboard, no Reports/Logins/Settings), Settings version 2.1.0,
// close -> backupOnClose writes a good backup (140 products, 3 logins).
// Launch 4 (fresh HOME): Counter Manager 1234 -> dark Sale screen
// (POS-only shell), Start Shift, Cash sale SL-0001 + Print Bill,
// Khata sale SL-0002 (discount -> Rs 1,000), KOT latest-sale print,
// Hold/Resume, Khata payment Rs 400 -> balance Rs 600, Close Shift
// (counted = expected), Sale History + void SL-0001, close ->
// backupOnClose (140 products, 3 logins, sales 2, 1 voided).
// Launch 5 (pre-seeded v2.0.0 data: 44 items, 2 logins, Cheese
// 7500/4000): v210 migration, Owner Dashboard + gating, Manager cost
// hidden, recipe -> production PB bill, FEFO transfer (earlier-expiry
// first), expired dispatch blocked, backup import wrong-JSON rejected,
// Counter Manager POS-only.
// Launch 2 (pre-seeded corrupt data + good .bak): cold-start recovery.
// Launch 3 (pre-seeded empty data, flag applied, no backups): Owner Setup.
// Run: node test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(os.tmpdir(), 'sahara-test-200');
const HOME1 = path.join(RUN_DIR, 'home1');
const HOME2 = path.join(RUN_DIR, 'home2');
const HOME3 = path.join(RUN_DIR, 'home3');
const HOME4 = path.join(RUN_DIR, 'home4');
const HOME5 = path.join(RUN_DIR, 'home5');
const DISPLAY = ':99';
const CDP_PORT = 9227;
const EVIDENCE = path.join(APP_DIR, '..', 'sahara-bakers-desktop-test-evidence');

fs.rmSync(RUN_DIR, { recursive: true, force: true });
for (const h of [HOME1, HOME2, HOME3, HOME4, HOME5]) fs.mkdirSync(h, { recursive: true });
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
async function dismissNotices() {
  try { await ev(`document.querySelectorAll('.notice').forEach(n => n.remove())`); } catch (e) { /* page gone */ }
}
async function clickEl(finderExpr, label, yFrac = 0.5) {
  await dismissNotices();
  for (let attempt = 0; attempt < 2; attempt++) {
    const rect = await ev(`(() => { const el = (${finderExpr}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height*${yFrac}; const top = document.elementFromPoint(x, y); return {x, y, clear: !!(top && (top === el || el.contains(top)))}; })()`);
    if (!rect) throw new Error('click target not found: ' + label);
    if (!rect.clear && attempt === 0) { await dismissNotices(); await sleep(200); continue; }
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
async function setSelect(finderExpr, value) {
  await ev(`(() => { const s = (${finderExpr}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
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
function findFileRecursive(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFileRecursive(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}
async function loginAs(username, pin) {
  await clickEl(`document.querySelector('.login-role-card[data-username="${username}"]')`, 'login card ' + username);
  await waitFor(`document.querySelector('.pin-input')`, 8000, 'PIN page for ' + username);
  await typeInto(`document.querySelector('.pin-input')`, 'PIN field', pin);
  await clickEl(`document.querySelector('#login-body button[type=submit]')`, 'Login submit');
}
async function navTo(label) {
  // Nav buttons now hold an English .nav-label + a Roman Urdu .nav-sub:
  // match the button by its main label only.
  await clickEl(`[...document.querySelectorAll('#sidebar button')].find(b => ((b.querySelector('.nav-label') || {}).textContent || '').trim() === ${JSON.stringify(label)})`, 'nav ' + label);
}
async function noticeText() {
  return await ev(`[...document.querySelectorAll('.notice')].map(n => n.textContent).join(' || ')`);
}

let userDataRel = null;

try {
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x900x24'], { stdio: 'ignore' });
  await sleep(1500);

  // ================= LAUNCH 1: full v2 UI flow =================
  launchElectron(HOME1);
  if (!(await connectCDP())) throw new Error('CDP connect failed (launch 1)');

  // E1: splash shows, then login-selection cards (Owner + Manager + Counter Manager).
  // v2.1.0: each card shows the display NAME big (user.name) and the role small.
  const splashSeen = await ev(`!!document.getElementById('splash-screen')`);
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 30000, 'login cards');
  const e1 = await ev(`(() => { const cards = [...document.querySelectorAll('.login-role-card')].map(b => b.getAttribute('data-username') + ':' + b.textContent.trim()); const img = document.getElementById('login-logo-img'); const menu = document.getElementById('login-menu-btn'); const nameEl = document.querySelector('.login-role-card .login-role-name'); const font = nameEl ? getComputedStyle(nameEl).fontFamily : ''; const bodyText = document.getElementById('login-body').innerText.replace(/\\s+/g, ' ').trim(); return { cards, logoShown: !!img && img.offsetParent !== null, menuShown: !!menu && menu.offsetParent !== null, font, bodyText, restoreBtn: !!document.getElementById('login-restore-btn'), oldUserBtns: document.querySelectorAll('.login-user-btn').length }; })()`);
  log('E1 splash exists; login-selection shows three buttons with display names (Rahmanullah/Owner, Warehouse/Manager, Counter Manager/Counter Manager) in elegant serif, no logo/menu/extra text on the screen, restore present',
    splashSeen === true && e1.cards.length === 3 &&
    e1.cards[0] === 'rahmanullah:RahmanullahOwner' && e1.cards[1] === 'manager:WarehouseManager' && e1.cards[2] === 'counter:Counter ManagerCounter Manager' &&
    e1.logoShown === false && e1.menuShown === false && /Georgia/.test(e1.font) &&
    e1.bodyText === 'RahmanullahOwner WarehouseManager Counter ManagerCounter Manager' && e1.restoreBtn === true && e1.oldUserBtns === 0,
    JSON.stringify(e1));
  await screenshot('01-login-cards.png');

  // E2: wrong PIN on the Owner card -> notice with draining countdown.
  await clickEl(`document.querySelector('.login-role-card[data-username="rahmanullah"]')`, 'Owner card');
  await waitFor(`document.querySelector('.pin-input')`, 8000, 'Owner PIN page');
  const pinPage = await ev(`document.getElementById('login-body').innerText.slice(0, 120)`);
  await typeInto(`document.querySelector('.pin-input')`, 'PIN field wrong', '0000');
  await clickEl(`document.querySelector('#login-body button[type=submit]')`, 'submit wrong PIN');
  await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('PIN ghalat hai'))`, 8000, 'wrong PIN notice');
  const bar0 = await ev(`(() => { const b = document.querySelector('.notice .notice-bar'); return b ? Math.round(b.getBoundingClientRect().width) : null; })()`);
  const noticeTxt = await noticeText();
  await sleep(2000);
  const bar1 = await ev(`(() => { const b = document.querySelector('.notice .notice-bar'); return b ? Math.round(b.getBoundingClientRect().width) : null; })()`);
  log('E2 Owner PIN page opens; wrong PIN 0000 -> "Issue — PIN ghalat hai" with a countdown line that DRAINS',
    /Rahmanullah/.test(pinPage) && /Issue — PIN ghalat hai/.test(noticeTxt) && bar0 != null && bar1 != null && bar1 < bar0,
    'pinPage=' + pinPage.replace(/\n/g, ' ') + ' barWidth t0=' + bar0 + ' t+2s=' + bar1);
  await screenshot('02-login-wrong-pin-notice.png');
  await waitFor(`document.querySelectorAll('.notice').length === 0`, 8000, 'notice auto-dismiss');
  log('E3 wrong-PIN notice auto-dismisses after ~5s with no click', true, 'no .notice elements left');

  // E4: Owner PIN 1234 logs in -> Owner Dashboard (v2.1.0 landing page).
  await typeInto(`document.querySelector('.pin-input')`, 'PIN field 1234', '1234');
  await clickEl(`document.querySelector('#login-body button[type=submit]')`, 'Login submit');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'logged in');
  await ev(`(() => { DB.state.settings.sessionTimeoutMinutes = 120; DB.save(); return true; })()`);
  const dataDir1 = await ev(`process.env.SAHARA_DATA_DIR`);
  userDataRel = path.relative(HOME1, dataDir1);
  const dash1 = await ev(`(() => { const stats = [...document.querySelectorAll('.stat')].map(s => s.innerText.replace(/\\n/g, ' | ')); return { head: (document.querySelector('#screen h1') || {}).textContent, greeting: (document.querySelector('.od-greeting') || {}).textContent, stats }; })()`);
  log('E4 Owner PIN 1234 logs in; Owner Dashboard lands with greeting "Assalamualaikum wa Rahmatullah, Rahmanullah" and cards Total Sales Rs 0 / Total Bills 0 / Cost Rs 0 / Profit Rs 0 (no bills yet, so cost is exact 0, not "—") / Total Stock Transferred 0 items (fresh, no sales yet)',
    dash1.head === 'Owner Dashboard' &&
    dash1.greeting === 'Assalamualaikum wa Rahmatullah, Rahmanullah' &&
    dash1.stats.some((s) => s.startsWith('Total Sales | Rs 0')) &&
    dash1.stats.some((s) => s.startsWith('Total Bills | 0')) &&
    dash1.stats.some((s) => s.startsWith('Cost | Rs 0')) &&
    dash1.stats.some((s) => s.startsWith('Profit | Rs 0')) &&
    dash1.stats.some((s) => s.startsWith('Total Stock Transferred | 0 items')),
    JSON.stringify(dash1));
  await screenshot('03-dashboard-owner.png');

  // E5: Owner sidebar order exact (v2.1.0: no Dashboard/Production/Sale/POS screens).
  const side = await ev(`[...document.querySelectorAll('#sidebar button .nav-label')].map(b => b.textContent.trim())`);
  log('E5 Owner sidebar: Owner Dashboard, Products, Raw Material, Finish Goods, Warehouse, Stock Transfer, Branches, Billing, Stock In/Out, Stock, Expiry & Wastage, Suppliers, Expenses, Reports, Purchases, Logins, Settings, Dark Theme (NO Dashboard, NO Production, NO Counter Sale)',
    JSON.stringify(side) === JSON.stringify(['Owner Dashboard', 'Products', 'Raw Material', 'Finish Goods', 'Warehouse', 'Stock Transfer', 'Branches', 'Billing', 'Stock In/Out', 'Stock', 'Expiry & Wastage', 'Suppliers', 'Expenses', 'Reports', 'Purchases', 'Logins', 'Settings', 'Dark Theme']),
    JSON.stringify(side));

  // E6: Products — one full screen, 140 CARDS (SmartPOS grid), search, live prices.
  await navTo('Products');
  await waitFor(`document.querySelectorAll('.product-card').length === 140`, 15000, 'products cards 140');
  const e6 = await ev(`(() => { const cards = [...document.querySelectorAll('.product-card')]; const cheese = cards.find(c => c.innerText.includes('Cheese')); const cake = cards.find(c => c.innerText.includes('Bakery Cake')); return { count: cards.length, cheesePrice: cheese ? cheese.innerText.replace(/\\n/g, ' | ') : null, cakePrice: cake ? cake.innerText.replace(/\\n/g, ' | ') : null, searchPh: (document.getElementById('products-search') || {}).placeholder, addBtn: (document.getElementById('add-product-btn') || {}).textContent, editBtns: document.querySelectorAll('.prod-edit').length, delBtns: document.querySelectorAll('.prod-delete').length }; })()`);
  log('E6 Products screen: 140 cards on ONE screen; Cheese shows Rs 8,000, Bakery Cake Rs 9,000 (live prices); search box present; "+ New Product" button; NO Edit/Delete buttons on the main listing',
    e6.count === 140 && /Rs 8,000/.test(e6.cheesePrice || '') && /Rs 9,000/.test(e6.cakePrice || '') && /Search Product/.test(e6.searchPh || '') && /New Product/.test(e6.addBtn || '') && e6.editBtns === 0 && e6.delBtns === 0,
    JSON.stringify(e6));
  await typeInto(`document.getElementById('products-search')`, 'products search', 'Ghee');
  await sleep(700);
  const searchCount = await ev(`document.querySelectorAll('.product-card').length`);
  const searchName = await ev(`(document.querySelector('.product-card .p-name') || {}).textContent`);
  log('E6b Products search "Ghee" filters to exactly 1 card', searchCount === 1 && /Ghee/.test(searchName || ''), 'count=' + searchCount + ' name=' + searchName);
  await ev(`(() => { const i = document.getElementById('products-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(700);
  await screenshot('04-products.png');

  // E7: add / edit / delete a product — Edit + Delete live on the
  // product's own detail screen, reached by clicking its card.
  await clickEl(`document.getElementById('add-product-btn')`, 'New Product button');
  await waitFor(`document.getElementById('item-form-overlay').style.display === 'flex'`, 8000, 'add product form');
  await typeInto(`document.getElementById('pf-name')`, 'new product name', 'Test Mithai');
  await setSelect(`document.getElementById('pf-type')`, 'finished');
  await typeInto(`document.getElementById('pf-price')`, 'new product price', '500');
  await typeInto(`document.getElementById('pf-details')`, 'new product details', 'test item');
  await clickEl(`document.querySelector('#item-form-body form button[type=submit]')`, 'Save new product');
  await waitFor(`document.querySelectorAll('.product-card').length === 141`, 8000, '141 cards after add');
  const added = await ev(`(() => { const c = [...document.querySelectorAll('.product-card')].find(x => x.innerText.includes('Test Mithai')); return c ? c.innerText.replace(/\\n/g, ' | ') : null; })()`);
  log('E7a Add Product (Test Mithai, finished, Rs 500) -> 141 cards, new card visible',
    /Test Mithai/.test(added || '') && /Rs 500/.test(added || ''), added);
  await clickEl(`[...document.querySelectorAll('.product-card')].find(c => c.innerText.includes('Test Mithai'))`, 'Open Test Mithai card');
  await waitFor(`document.getElementById('detail-edit-btn')`, 8000, 'product detail screen');
  const detailTxt = await ev(`(() => { const t = document.getElementById('item-form-title').textContent; const b = document.getElementById('item-form-body').innerText; return { title: t, hasStock: /Stock — Godown aur Branches/.test(b), hasHistory: /Stock History/.test(b), hasEdit: !!document.getElementById('detail-edit-btn'), hasDelete: !!document.getElementById('detail-delete-btn') }; })()`);
  log('E7b1 Card click opens the product detail screen: title, stock per location, history, Edit + Delete buttons',
    detailTxt.title === 'Product Details — Test Mithai' && detailTxt.hasStock && detailTxt.hasHistory && detailTxt.hasEdit && detailTxt.hasDelete,
    JSON.stringify(detailTxt));
  await screenshot('12-product-detail.png');
  // E7b: v2.1.0 — the Owner can ONLY edit Cost Price (all other fields
  // are disabled for him), so the sale-price edit runs as the Manager.
  await clickEl(`document.getElementById('detail-close-btn')`, 'Close Test Mithai detail (owner)');
  await clickEl(`document.getElementById('logout-btn')`, 'logout owner before manager edit');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards for manager edit');
  await loginAs('manager', '123');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'manager logged in for edit');
  await navTo('Products');
  await typeInto(`document.getElementById('products-search')`, 'search test mithai', 'Test Mithai');
  await sleep(700);
  await clickEl(`[...document.querySelectorAll('.product-card')].find(c => c.innerText.includes('Test Mithai'))`, 'Open Test Mithai card (manager)');
  await waitFor(`document.getElementById('detail-edit-btn')`, 8000, 'product detail screen (manager)');
  await clickEl(`document.getElementById('detail-edit-btn')`, 'Edit in detail screen (manager)');
  await waitFor(`document.getElementById('pf-price')`, 8000, 'edit form (manager)');
  await ev(`(() => { const i = document.getElementById('pf-price'); i.value = ''; return true; })()`);
  await typeInto(`document.getElementById('pf-price')`, 'edit price', '600');
  await clickEl(`document.querySelector('#item-form-body form button[type=submit]')`, 'Save edit');
  await waitFor(`[...document.querySelectorAll('.product-card')].some(c => c.innerText.includes('Test Mithai') && c.innerText.includes('Rs 600'))`, 8000, 'price 600 saved');
  const edited = await ev(`(() => { const c = [...document.querySelectorAll('.product-card')].find(x => x.innerText.includes('Test Mithai')); return c ? c.innerText.replace(/\\n/g, ' | ') : null; })()`);
  log('E7b Manager Edit Product price 500 -> 600 persists on the card', /Rs 600/.test(edited || ''), edited);
  await clickEl(`[...document.querySelectorAll('.product-card')].find(c => c.innerText.includes('Test Mithai'))`, 'Open Test Mithai card again');
  await waitFor(`document.getElementById('detail-delete-btn')`, 8000, 'detail screen again');
  await clickEl(`document.getElementById('detail-delete-btn')`, 'Delete in detail screen');
  await waitFor(`document.getElementById('confirm-overlay').style.display === 'flex'`, 8000, 'delete confirm');
  await clickEl(`document.getElementById('confirm-yes')`, 'Confirm delete');
  // The search box still holds 'Test Mithai' — clear it, then all 140 cards show again.
  await ev(`(() => { const i = document.getElementById('products-search'); if (!i) return false; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(700);
  await waitFor(`document.querySelectorAll('.product-card').length === 140`, 8000, '140 cards after delete');
  log('E7c Delete Product from the detail screen (confirm dialog) -> back to 140 cards', true, 'cards=140');

  // E8: v2.1.0 roles — Stock In is Warehouse (Manager) work, the cost
  // edit is Owner-only. Manager stocks Flour 100 in, then the Owner
  // sets Flour's purchase price Rs 100 via the Raw Material edit
  // (only the Cost Price field is editable for the Owner).
  await clickEl(`document.getElementById('logout-btn')`, 'logout owner before stock-in');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards for manager');
  await loginAs('manager', '123');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'manager logged in for stock-in');
  await navTo('Stock In/Out');
  await setSelect(`document.getElementById('sio-item')`, '15');
  await typeInto(`document.querySelector('#screen .card form input[type=number]')`, 'stock-in qty', '100');
  await clickEl(`document.querySelector('#screen .card form button[type=submit]')`, 'Stock In Save');
  await waitFor(`document.getElementById('sio-confirm') && document.getElementById('sio-confirm').innerText.includes('Ab kul stock: 100 Kg')`, 8000, 'stock-in confirm');
  const stockFlour = await ev(`DB.stockOf(DB.state.products.find(p => p.name === 'Flour'), DB.WAREHOUSE_ID)`);
  log('E8a Manager Stock In Flour 100 Kg -> godown stock 100', stockFlour === 100, 'stock=' + stockFlour);
  await navTo('Raw Material');
  await waitFor(`document.querySelectorAll('#raw-table tbody tr').length === 28`, 10000, 'raw table 28 rows');
  const rawBtns = await ev(`({ edit: document.querySelectorAll('.raw-edit').length, details: document.querySelectorAll('.raw-details').length, addBtn: (document.getElementById('add-raw-btn') || {}).textContent })`);
  log('E8b1 Raw Material listing: NO Edit button on the main screen; every row has a Details button; "+ New Raw Item" button',
    rawBtns.edit === 0 && rawBtns.details === 28 && /New Raw Item/.test(rawBtns.addBtn || ''), JSON.stringify(rawBtns));
  // Manager has NO cost field in the edit form (E gating) — prove it,
  // then let the Owner set the cost.
  await clickEl(`[...document.querySelectorAll('#raw-table tbody tr')].find(r => r.innerText.includes('Flour')).querySelector('.raw-details')`, 'Flour details as manager');
  await waitFor(`document.getElementById('detail-edit-btn')`, 8000, 'Flour detail screen as manager');
  const mgrDetail = await ev(`(() => { const b = document.getElementById('item-form-body').innerText; return { hasCostRow: /Purchase Price/.test(b), hasCostDash: /Purchase Price \\/ Cost[\\s\\S]*—/.test(b) }; })()`);
  log('E8b2 Manager product detail shows NO Purchase Price row (cost hidden, toggle OFF)',
    mgrDetail.hasCostRow === false, JSON.stringify(mgrDetail));
  await clickEl(`document.getElementById('detail-edit-btn')`, 'Edit Flour in detail screen as manager');
  await waitFor(`document.getElementById('rf-price')`, 8000, 'raw edit form as manager');
  const mgrForm = await ev(`({ hasCostField: !!document.getElementById('rf-purchase') })`);
  log('E8b3 Manager raw edit form has NO Cost Price field', mgrForm.hasCostField === false, JSON.stringify(mgrForm));
  await clickEl(`document.getElementById('rf-cancel')`, 'Cancel manager raw edit');
  await clickEl(`document.getElementById('logout-btn')`, 'logout manager before owner cost edit');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards for owner again');
  await loginAs('rahmanullah', '1234');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'owner logged in for cost edit');
  await navTo('Raw Material');
  await waitFor(`document.querySelectorAll('#raw-table tbody tr').length === 28`, 10000, 'raw table 28 rows (owner)');
  await clickEl(`[...document.querySelectorAll('#raw-table tbody tr')].find(r => r.innerText.includes('Flour')).querySelector('.raw-details')`, 'Flour details as owner');
  await waitFor(`document.getElementById('detail-edit-btn')`, 8000, 'Flour detail screen as owner');
  await clickEl(`document.getElementById('detail-edit-btn')`, 'Edit Flour in detail screen as owner');
  await waitFor(`document.getElementById('rf-purchase')`, 8000, 'raw edit form as owner');
  await typeInto(`document.getElementById('rf-purchase')`, 'flour purchase price', '100');
  await clickEl(`document.querySelector('#item-form-body form button[type=submit]')`, 'Save raw edit');
  await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('Cost price update ho gaya'))`, 8000, 'raw cost edit notice');
  const flourPrice = await ev(`DB.state.products.find(p => p.name === 'Flour').purchasePrice`);
  log('E8b Owner Raw Material edit sets Flour purchase price Rs 100 (only Cost editable; stock stays 100)', flourPrice === 100, 'purchasePrice=' + flourPrice);

  // E9: Production 100 Kg Flour -> 80 Kg Gulab Jamun, bill PB-0001 exact numbers.
  // v2.1.0: Production is Warehouse (Manager) work — Owner is blocked.
  await clickEl(`document.getElementById('logout-btn')`, 'logout owner before production');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards for production');
  await loginAs('manager', '123');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'manager logged in for production');
  await navTo('Production');
  await waitFor(`document.querySelector('#prod-raw-list')`, 10000, 'production raw list');
  await typeInto(`document.querySelector('.prod-cart-qty[data-id="15"]')`, 'cart flour qty', '100');
  await clickEl(`document.querySelector('.prod-add-cart[data-id="15"]')`, 'Add Flour to cart');
  await waitFor(`document.getElementById('prod-cart-total-cost')`, 8000, 'cart totals');
  const cartTxt = await ev(`(document.getElementById('prod-cart-total-cost') || {}).innerText`);
  log('E9a cart shows total used material + costing: 1 item, Rs 10,000',
    /Total Cost:/.test(cartTxt || '') && /Rs 10,000/.test(cartTxt || ''), (cartTxt || '').replace(/\n/g, ' '));
  await setSelect(`document.getElementById('prod-finish-sel')`, '40');
  await typeInto(`document.getElementById('prod-finish-qty')`, 'finish qty', '80');
  await clickEl(`document.getElementById('prod-complete-btn')`, 'Complete production');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'production bill preview');
  const pbill = await ev(`document.getElementById('bill-preview-body').innerText`);
  const pstocks = await ev(`(() => { const f = DB.state.products.find(p => p.name === 'Flour'); const g = DB.state.products.find(p => p.id === 40); return { fWh: DB.stockOf(f, DB.WAREHOUSE_ID), gWh: DB.stockOf(g, DB.WAREHOUSE_ID), prods: DB.state.productions.length, moves: DB.state.stockMovements.length }; })()`);
  log('E9b Production bill PB-0001 auto-opens: TOTAL COST Rs 10,000, Cost per Kg Rs 125, Flour remaining 0, Final Finish Stock 80 Kg; Flour 100->0, Gulab Jamun 0->80',
    /PB-0001/.test(pbill) && /TOTAL COST/.test(pbill) && /Rs 10,000/.test(pbill) && /Rs 125/.test(pbill) &&
    /Flour: 0 Kg bacha/.test(pbill) && /Final Finish Stock: 80 Kg/.test(pbill) &&
    pstocks.fWh === 0 && pstocks.gWh === 80 && pstocks.prods === 1,
    'bill=' + pbill.replace(/\n/g, ' | ').slice(0, 400) + ' stocks=' + JSON.stringify(pstocks));
  await screenshot('05-production-bill-pb0001.png');
  await clickEl(`document.getElementById('bill-preview-close')`, 'close production bill');
  await sleep(300);

  // E10: over-stock production rejected — nothing moves.
  await typeInto(`document.querySelector('.prod-cart-qty[data-id="15"]')`, 'cart flour qty over', '5');
  await clickEl(`document.querySelector('.prod-add-cart[data-id="15"]')`, 'Add Flour 5 to cart');
  await setSelect(`document.getElementById('prod-finish-sel')`, '40');
  await typeInto(`document.getElementById('prod-finish-qty')`, 'finish qty 10', '10');
  await clickEl(`document.getElementById('prod-complete-btn')`, 'Complete over-stock production');
  await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('itna stock nahi hai'))`, 8000, 'over-stock notice');
  const over = await ev(`(() => ({ prods: DB.state.productions.length, fWh: DB.stockOf(DB.state.products.find(p => p.name === 'Flour'), DB.WAREHOUSE_ID), gWh: DB.stockOf(DB.state.products.find(p => p.id === 40), DB.WAREHOUSE_ID) }))()`);
  const noBill = await ev(`document.getElementById('bill-preview-overlay').style.display !== 'flex'`);
  log('E10 over-stock cart (Flour 5, godown 0) rejected with "itna stock nahi hai" — no bill opens, still 1 production, Flour 0, Gulab 80',
    over.prods === 1 && over.fWh === 0 && over.gWh === 80 && noBill === true, JSON.stringify(over));

  // E11: Transfer Gulab Jamun 10 Kg Warehouse -> Branch 2, bill SB-0001.
  // E11a first proves the source is LOCKED: no From <select> exists,
  // the static Warehouse line is shown, and To lists ALL THREE branches.
  await navTo('Stock Transfer');
  await waitFor(`document.querySelector('#transfer-stage')`, 10000, 'transfer form');
  const trForm = await ev(`(() => { const to = document.getElementById('tr-to'); const opts = to ? [...to.options].map(o => o.value) : []; return { hasFromSelect: !!document.getElementById('tr-from'), hasFromStatic: !!document.getElementById('tr-from-static'), toOpts: opts, fromText: (document.getElementById('tr-from-static') || {}).textContent }; })()`);
  log('E11a transfer form: NO From select (source locked to Warehouse, static line shown); To dropdown lists ALL THREE branches (1, 2, 3)',
    trForm.hasFromSelect === false && trForm.hasFromStatic === true &&
    JSON.stringify(trForm.toOpts) === JSON.stringify(['1', '2', '3']) && /Warehouse/.test(trForm.fromText || ''),
    JSON.stringify(trForm));
  await setSelect(`document.getElementById('tr-to')`, '2');
  await setSelect(`document.getElementById('tr-item')`, '40');
  await typeInto(`document.getElementById('tr-qty')`, 'transfer qty', '10');
  await clickEl(`document.getElementById('tr-add-btn')`, 'Add Gulab to transfer');
  await typeInto(`document.getElementById('tr-received-by')`, 'received by', 'Ali');
  await clickEl(`[...document.querySelectorAll('#screen .card form button[type=submit]')].find(b => b.textContent.trim() === 'Transfer & View Bill')`, 'Transfer submit');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'transfer bill preview');
  const tbill = await ev(`document.getElementById('bill-preview-body').innerText`);
  const tstocks = await ev(`(() => { const g = DB.state.products.find(p => p.id === 40); return { gWh: DB.stockOf(g, DB.WAREHOUSE_ID), gBr2: DB.stockOf(g, 2), transfers: DB.state.transfers.length }; })()`);
  log('E11 Transfer bill SB-0001 auto-opens: From Warehouse, To Branch 2, Gulab Jamun 10 Kg, TOTAL ITEMS 10, GRAND TOTAL / STOCK VALUE, Received By Ali, Sent By Warehouse, Issued By Warehouse (Manager did the transfer); both legs moved (Warehouse: 80->70, Branch 2: 0->10)',
    /SB-0001/.test(tbill) && /From: Warehouse/.test(tbill) && !/From: Branch 1/.test(tbill) && /To: Branch 2/.test(tbill) &&
    /Gulab Jamun/.test(tbill) && /TOTAL ITEMS/.test(tbill) && /10/.test(tbill) &&
    /GRAND TOTAL \/ STOCK VALUE/.test(tbill) && /Received By: Ali/.test(tbill) && /Sent By: Warehouse/.test(tbill) && /Issued By: Warehouse/.test(tbill) &&
    tstocks.gWh === 70 && tstocks.gBr2 === 10 && tstocks.transfers === 1,
    'bill=' + tbill.replace(/\n/g, ' | ').slice(0, 400) + ' stocks=' + JSON.stringify(tstocks));
  await screenshot('06-transfer-bill-sb0001.png');
  await clickEl(`document.getElementById('bill-preview-close')`, 'close transfer bill');
  await sleep(300);

  // E11b: Transfer to Branch 1 (impossible before the Warehouse fix) — SB-0002.
  await waitFor(`document.querySelector('#transfer-stage')`, 10000, 'transfer form again');
  await setSelect(`document.getElementById('tr-to')`, '1');
  await setSelect(`document.getElementById('tr-item')`, '40');
  await typeInto(`document.getElementById('tr-qty')`, 'transfer qty to branch 1', '5');
  await clickEl(`document.getElementById('tr-add-btn')`, 'Add Gulab to transfer (Branch 1)');
  await typeInto(`document.getElementById('tr-received-by')`, 'received by b1', 'Ali');
  await clickEl(`[...document.querySelectorAll('#screen .card form button[type=submit]')].find(b => b.textContent.trim() === 'Transfer & View Bill')`, 'Transfer submit to Branch 1');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'transfer bill SB-0002 preview');
  const tbill2 = await ev(`document.getElementById('bill-preview-body').innerText`);
  const tstocks2 = await ev(`(() => { const g = DB.state.products.find(p => p.id === 40); return { gWh: DB.stockOf(g, DB.WAREHOUSE_ID), gBr1: DB.stockOf(g, 1), transfers: DB.state.transfers.length }; })()`);
  log('E11b Transfer to Branch 1 works: bill SB-0002 From: Warehouse, To: Branch 1, Gulab Jamun 5 Kg; Warehouse 70->65, Branch 1 0->5',
    /SB-0002/.test(tbill2) && /From: Warehouse/.test(tbill2) && /To: Branch 1/.test(tbill2) && /Gulab Jamun/.test(tbill2) &&
    tstocks2.gWh === 65 && tstocks2.gBr1 === 5 && tstocks2.transfers === 2,
    'bill=' + tbill2.replace(/\n/g, ' | ').slice(0, 300) + ' stocks=' + JSON.stringify(tstocks2));
  await screenshot('11-transfer-to-branch1.png');
  await clickEl(`document.getElementById('bill-preview-close')`, 'close transfer bill 2');
  await sleep(300);

  // E12: Billing screen lists both bills; PB-0001 re-opens.
  await navTo('Billing');
  const billingTxt = await ev(`document.getElementById('screen').innerText`);
  log('E12 Billing screen lists PB-0001 and SB-0001', /PB-0001/.test(billingTxt) && /SB-0001/.test(billingTxt), billingTxt.slice(0, 200).replace(/\n/g, ' | '));
  await clickEl(`document.querySelector('button[data-pbill="1"]')`, 'Billing PB-0001 button');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 8000, 'PB-0001 from Billing');
  const pbill2 = await ev(`document.getElementById('bill-preview-body').innerText`);
  log('E12b Billing "Bill" button re-opens the SAME production bill PB-0001 (Rs 10,000)',
    /PB-0001/.test(pbill2) && /Rs 10,000/.test(pbill2), pbill2.slice(0, 150).replace(/\n/g, ' | '));
  await clickEl(`document.getElementById('bill-preview-close')`, 'close bill again');
  await sleep(300);

  // E13: Manager login (PIN 123) -> Manager Dashboard, Owner-only screens hidden.
  await clickEl(`document.getElementById('logout-btn')`, 'logout');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards again');
  await loginAs('manager', '123');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'manager logged in');
  const mgr = await ev(`(() => { const head = (document.querySelector('#screen h1') || {}).textContent; const side = [...document.querySelectorAll('#sidebar button .nav-label')].map(b => b.textContent.trim()); const stats = [...document.querySelectorAll('.stat')].map(s => s.innerText.replace(/\\n/g, ' | ')); return { head, side, stats }; })()`);
  log('E13 Manager PIN 123 logs in; Manager Dashboard (daily ops) with NO Reports/Logins/Settings in the sidebar; quick actions include Production + Stock Transfer',
    mgr.head === 'Manager Dashboard' &&
    mgr.side.indexOf('Reports') === -1 && mgr.side.indexOf('Logins') === -1 && mgr.side.indexOf('Settings') === -1 &&
    mgr.side.indexOf('Production') !== -1 && mgr.side.indexOf('Stock Transfer') !== -1 && mgr.side.indexOf('Billing') !== -1 &&
    mgr.stats.some((s) => s.startsWith('Total Raw Stock')) && mgr.stats.some((s) => s.startsWith('Total Finish Stock')),
    JSON.stringify(mgr));
  await screenshot('07-dashboard-manager.png');

  // E14: Owner again -> Settings shows version 2.1.0.
  await clickEl(`document.getElementById('logout-btn')`, 'logout again');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards third time');
  await loginAs('rahmanullah', '1234');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'owner logged in again');
  await navTo('Settings');
  const ver = await ev(`document.getElementById('screen').innerText`);
  log('E14 Settings shows Version 2.1.0', /Version:\s*2\.1\.0/.test(ver), ver.slice(0, 120).replace(/\n/g, ' | '));
  await screenshot('08-settings-v2.png');

  // E16: SmartPOS theme + bilingual spot-checks (Manager Dashboard —
  // v2.1.0: the Owner no longer has the Manager 'dashboard' screen).
  await clickEl(`document.getElementById('logout-btn')`, 'logout owner before theme check');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards for theme check');
  await loginAs('manager', '123');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'manager logged in for theme check');
  await navTo('Dashboard');
  const theme = await ev(`(() => { const active = document.querySelector('#sidebar button.nav-item.active'); const ac = active ? getComputedStyle(active) : null; const subs = [...document.querySelectorAll('#sidebar .nav-sub')].map(s => s.textContent.trim()); const crumbSub = (document.querySelector('.screen-sub') || {}).textContent || ''; const jobs = [...document.querySelectorAll('.daily-job')].map(b => b.innerText.replace(/\\n/g, ' | ')); const qa = [...document.querySelectorAll('.btn-bilingual')].map(b => b.innerText.replace(/\\n/g, ' | ')); return { activeBg: ac ? ac.backgroundColor : null, navSub0: subs[0], navSubs: subs.length, crumbSub, jobs, qa }; })()`);
  log('E16 SmartPOS theme + bilingual: active nav pill is yellow rgb(255, 193, 7); nav items carry Roman Urdu sub-labels (16 with subs); breadcrumb has a Roman Urdu sub-line; Dashboard shows 3 daily-jobs buttons (English title + Roman Urdu sub) and 7 bilingual quick actions (Manager: no Reports)',
    theme.activeBg === 'rgb(255, 193, 7)' && theme.navSub0 === 'Aaj ka hisaab' && theme.navSubs === 16 &&
    /Aaj ka hisaab/.test(theme.crumbSub) &&
    theme.jobs.length === 3 && /Stock In/.test(theme.jobs[0] || '') && /Maal godown mein aaya/.test(theme.jobs[0] || '') && /Transfer to Branch/.test(theme.jobs[1] || '') && /Maal branch ko bhejo/.test(theme.jobs[1] || '') && /View Stock/.test(theme.jobs[2] || '') &&
    theme.qa.length === 7 && /Raw Material/.test(theme.qa[0] || '') && /Kacha maal/.test(theme.qa[0] || ''),
    JSON.stringify(theme));
  // E16b: yellow price on a priced card + pill search radius on Products.
  await navTo('Products');
  const theme2 = await ev(`(() => { const price = document.querySelector('.product-card .p-price'); const pc = price ? getComputedStyle(price).color : null; const search = document.getElementById('products-search'); const sr = search ? getComputedStyle(search).borderRadius : null; const brand = (document.querySelector('.sidebar-brand-name') || {}).textContent; const crumb = (document.querySelector('.crumb') || {}).innerText.replace(/\\n/g, ' '); const crumbSub = (document.querySelector('.screen-sub') || {}).textContent || ''; return { priceColor: pc, searchRadius: sr, brand, crumb, crumbSub }; })()`);
  log('E16b Priced card shows price in bold yellow rgb(184, 134, 11); search bar is a pill (radius 999px); sidebar brand SAHARA BAKERS; breadcrumb + Roman Urdu sub on Products',
    theme2.priceColor === 'rgb(184, 134, 11)' && theme2.searchRadius === '999px' && theme2.brand === 'SAHARA BAKERS' && /Products/.test(theme2.crumb || '') && /Sab items/.test(theme2.crumbSub || ''),
    JSON.stringify(theme2));

  // E15: close the app -> backupOnClose writes a GOOD backup (140 products, 3 logins).
  try { await ev(`window.close()`); } catch (e) { /* page closing */ }
  const exited1 = await waitForAppExit();
  let backupOk = false, backupDetail = '';
  if (exited1) {
    const dataFile = findFileRecursive(HOME1, 'sahara-bakers-data.json');
    const backupDir = dataFile ? path.join(path.dirname(dataFile), 'backups') : null;
    if (backupDir && fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        const newest = files.map((f) => ({ f, m: fs.statSync(path.join(backupDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
        const parsed = JSON.parse(fs.readFileSync(path.join(backupDir, newest), 'utf8'));
        backupOk = parsed.products.length === 140 && parsed.appUsers.length === 3 && (parsed.productions || []).length === 1 && (parsed.transfers || []).length === 2;
        backupDetail = 'backups=' + files.length + ' newest=' + newest + ' products=' + parsed.products.length + ' logins=' + parsed.appUsers.length + ' productions=' + (parsed.productions || []).length + ' transfers=' + (parsed.transfers || []).length;
      } else backupDetail = 'backups dir exists but empty';
    } else backupDetail = 'no backups dir under ' + (dataFile ? path.dirname(dataFile) : 'unknown userData');
  }
  log('E15 app closes cleanly AND backupOnClose wrote a good backup (140 products, 3 logins, 1 production PB-0001, 2 transfers SB-0001/SB-0002)',
    exited1 === true && backupOk === true, 'exited=' + exited1 + ' ' + backupDetail);

  // ================= LAUNCH 4: Counter Manager POS flow (fresh HOME) =================
  launchElectron(HOME4);
  if (!(await connectCDP())) throw new Error('CDP connect failed (launch 4)');
  await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 30000, 'login cards launch 4');
  // Test setup (not app behaviour): the fresh seed has 0 stock for every
  // item, so the counter cannot sell until stock exists. Seed 10 Fajita S
  // at the warehouse counter via the DB API, like the pre-seeded launches.
  const seedStock4 = await ev(`(() => { const f = DB.state.products.find(p => p.id === 64); DB.setStock(f, DB.WAREHOUSE_ID, 10); DB.save(); return DB.stockOf(f, DB.WAREHOUSE_ID); })()`);
  log('L4-0 test setup: Fajita S (id 64, Rs 600) warehouse stock seeded to 10', seedStock4 === 10, 'stock=' + seedStock4);
  await loginAs('counter', '1234');
  await waitFor(`document.getElementById('logout-btn')`, 15000, 'counter logged in');
  await waitFor(`document.querySelector('.pos-wrap')`, 10000, 'dark sale screen');
  const posShell = await ev(`(() => { const wrap = document.querySelector('.pos-wrap'); const bg = wrap ? getComputedStyle(wrap).backgroundColor : null; const side = [...document.querySelectorAll('#sidebar button .nav-label')].map(b => b.textContent.trim()); const chip = (document.getElementById('user-chip') || {}).textContent || ''; const chipShown = (() => { const c = document.getElementById('user-chip'); return !!c && c.offsetParent !== null; })(); const branchShown = (() => { const b = document.getElementById('branch-select'); return !!b && b.offsetParent !== null; })(); const themeShown = (() => { const b = document.getElementById('theme-toggle'); return !!b && b.offsetParent !== null; })(); return { head: (document.querySelector('#screen h1') || {}).textContent, bg, side, chip, chipShown, branchShown, themeShown, logoutShown: (() => { const b = document.getElementById('logout-btn'); return !!b && b.offsetParent !== null; })() }; })()`);
  log('L4 Counter Manager 1234 lands STRAIGHT on the dark Sale screen (#171310, "Counter Sale"); POS-only shell: sidebar shows ONLY the 8 POS screens, top bar shows the user chip "Counter Manager (Counter Manager)" + Logout, branch selector + theme toggle hidden',
    posShell.head === 'Counter Sale' && posShell.bg === 'rgb(23, 19, 16)' &&
    JSON.stringify(posShell.side) === JSON.stringify(['Counter Sale', 'Sale History', 'Shifts', 'Sales Summary', 'POS Dashboard', 'Khata', 'Staff', 'POS Settings', 'Dark Theme']) &&
    posShell.chip === 'Counter Manager (Counter Manager)' && posShell.chipShown === true && posShell.branchShown === false && posShell.themeShown === false && posShell.logoutShown === true,
    JSON.stringify(posShell));
  await screenshot('13-pos-sale.png');
  // Godown route rejected -> redirected to sale (isPosOnly flag).
  const redirect = await ev(`(() => { window.App.go('dashboard'); const a = window.App.currentScreen; window.App.go('products'); const b = window.App.currentScreen; return { a, b }; })()`);
  log('L4b POS-only godown routes rejected: App.go("dashboard") and App.go("products") both redirect to "sale"',
    redirect.a === 'sale' && redirect.b === 'sale', JSON.stringify(redirect));
  // Stub window.print BEFORE any print step: headless has no printer, so
  // the app falls back to window.print() — the stub proves the full print
  // chain (preview -> IPC no-printer -> window.print) ran. Physical
  // printer output is still unverified (needs the user's XP-D1).
  await ev(`window.print = function () { window.__printCalled = true; }; window.__printCalled = false; true`);
  // Start Shift (opening 1000, cashier Ali) from the Sale banner.
  await clickEl(`document.getElementById('pos-shift-start')`, 'Start Shift from sale banner');
  await waitFor(`document.querySelector('#sh-cashier-name')`, 8000, 'shifts screen');
  await typeInto(`document.getElementById('sh-cashier-name')`, 'cashier name', 'Ali');
  // The opening input ships with value "0" — clear it first, or the
  // typed digits append after it (1000 -> 10000).
  await ev(`(() => { const i = document.getElementById('sh-opening'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await typeInto(`document.getElementById('sh-opening')`, 'opening balance', '1000');
  await clickEl(`document.querySelector('.shift-pos form button[type=submit]')`, 'Start Shift submit');
  await waitFor(`document.body.innerText.includes('Shift Khuli Hui Hai')`, 8000, 'open shift banner');
  const shift1 = await ev(`(() => { const s = DB.getOpenShift(); return s ? { opening: s.openingBalance, cashier: s.cashierName } : null; })()`);
  log('L4c Start Shift (opening Rs 1,000, cashier Ali) -> open shift, banner "Shift Khuli Hui Hai"',
    shift1 && shift1.opening === 1000 && shift1.cashier === 'Ali', JSON.stringify(shift1));
  await clickEl(`[...document.querySelectorAll('#screen button')].find(b => b.textContent.includes('Sale Screen Par Jayein'))`, 'back to sale');
  await waitFor(`document.querySelector('.pos-wrap')`, 8000, 'sale screen again');
  // Cash sale: 2 x Fajita S = Rs 1,200 -> SL-0001 bill preview -> Print Bill.
  const fajitaCard = `[...document.querySelectorAll('.pos-card')].find(c => ((c.querySelector('.pos-card-name') || {}).textContent || '').trim() === 'Fajita S')`;
  await clickEl(fajitaCard, 'Fajita S card (1st)');
  await clickEl(fajitaCard, 'Fajita S card (2nd)');
  await waitFor(`(document.querySelector('.pos-qty') || {}).textContent === '2'`, 8000, 'cart qty 2');
  const cart1 = await ev(`(document.getElementById('pos-t-total') || {}).textContent`);
  log('L4d cart: 2 x Fajita S -> TOTAL Rs 1,200', cart1 === 'Rs 1,200', 'total=' + cart1);
  await clickEl(`document.getElementById('pos-complete')`, 'Complete Sale Cash');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'SL-0001 bill preview');
  const bill1 = await ev(`document.getElementById('bill-preview-body').innerText`);
  log('L4e Cash sale completes -> bill preview SL-0001, Rs 1,200, Fajita S x2',
    /SL-0001/.test(bill1) && /Rs 1,200/.test(bill1) && /Fajita S/.test(bill1), bill1.slice(0, 200).replace(/\n/g, ' | '));
  await screenshot('14-pos-bill-sl0001.png');
  await ev(`window.__printCalled = false; true`);
  await clickEl(`document.getElementById('bill-preview-print')`, 'Print Bill SL-0001');
  await waitFor(`window.__printCalled === true`, 8000, 'window.print called');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display !== 'flex'`, 8000, 'preview closed after print');
  const stockAfter1 = await ev(`DB.stockOf(DB.state.products.find(p => p.id === 64), DB.WAREHOUSE_ID)`);
  log('L4f Print Bill runs the full print chain (IPC no-printer -> window.print) and closes with a success notice; Fajita S stock 10 -> 8',
    stockAfter1 === 8, 'stock=' + stockAfter1);
  // Khata sale: 2 x Fajita S, discount Rs 200 -> total Rs 1,000, customer Ahmed.
  await clickEl(`[...document.querySelectorAll('.pos-pay-btn')].find(b => b.textContent.trim() === 'Khata')`, 'Khata payment');
  await waitFor(`document.querySelector('.pos-khata-add')`, 8000, 'khata picker');
  await typeInto(`document.querySelectorAll('.pos-khata-add input')[0]`, 'khata customer name', 'Ahmed');
  await clickEl(`document.querySelector('.pos-khata-add .btn')`, 'Add khata customer');
  await waitFor(`document.body.innerText.includes('Ahmed ka baqaya balance')`, 8000, 'khata customer picked');
  await clickEl(fajitaCard, 'Fajita S card (khata 1st)');
  await clickEl(fajitaCard, 'Fajita S card (khata 2nd)');
  await ev(`(() => { const i = document.querySelector('#pos-discount'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await typeInto(`document.getElementById('pos-discount')`, 'discount 200', '200');
  await waitFor(`(document.getElementById('pos-t-total') || {}).textContent === 'Rs 1,000'`, 8000, 'khata total 1000');
  await clickEl(`document.getElementById('pos-complete')`, 'Complete Sale Khata');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'SL-0002 bill preview');
  const bill2 = await ev(`document.getElementById('bill-preview-body').innerText`);
  const khataBal = await ev(`(() => { const c = (DB.state.khataCustomers || []).find(x => x.name === 'Ahmed'); return c ? DB.khataBalance(c.id) : null; })()`);
  log('L4g Khata sale 2 x Fajita S - discount 200 -> SL-0002 Rs 1,000, Ahmed balance Rs 1,000 (D-Khata first half)',
    /SL-0002/.test(bill2) && /Rs 1,000/.test(bill2) && khataBal === 1000, 'balance=' + khataBal);
  await clickEl(`document.getElementById('bill-preview-close')`, 'close SL-0002 preview');
  await sleep(300);
  // KOT: Print Last KOT must be the LATEST sale (SL-0002), not SL-0001.
  await ev(`window.__printCalled = false; true`);
  await clickEl(`document.getElementById('pos-kot-last')`, 'Print Last KOT');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 8000, 'KOT preview');
  const kotTxt = await ev(`document.getElementById('bill-preview-body').innerText`);
  log('L4h Print Last KOT shows the LATEST sale: KOT ticket, Bill No SL-0002, Fajita S x2, no prices',
    /KOT/.test(kotTxt) && /SL-0002/.test(kotTxt) && !/SL-0001/.test(kotTxt) && /Fajita S/.test(kotTxt) && !/Rs 1,000/.test(kotTxt), kotTxt.slice(0, 200).replace(/\n/g, ' | '));
  await clickEl(`document.getElementById('bill-preview-print')`, 'Print KOT');
  await waitFor(`window.__printCalled === true`, 8000, 'KOT window.print called');
  await waitFor(`document.getElementById('bill-preview-overlay').style.display !== 'flex'`, 8000, 'KOT preview closed');
  log('L4i KOT print runs the same 80mm print chain', true, 'print called');
  // Hold / Resume (no third sale): hold 1 x Fajita S, resume, clear cart.
  await clickEl(fajitaCard, 'Fajita S card (hold)');
  await clickEl(`document.getElementById('pos-hold')`, 'Hold Order');
  await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('hold ho gaya'))`, 8000, 'hold notice');
  const heldN = await ev(`(DB.state.heldOrders || []).length`);
  log('L4j Hold Order: 1 x Fajita S held (heldOrders 1)', heldN === 1, 'held=' + heldN);
  await clickEl(`document.querySelector('button[data-resume]')`, 'Resume held order');
  await waitFor(`(document.querySelector('.pos-qty') || {}).textContent === '1'`, 8000, 'cart back after resume');
  const heldAfter = await ev(`(DB.state.heldOrders || []).length`);
  await clickEl(`document.getElementById('pos-clear')`, 'Clear cart after resume');
  await waitFor(`document.body.innerText.includes('Cart khali hai')`, 8000, 'cart empty');
  log('L4k Resume brings the held cart back (qty 1, current price) and clears the hold; cart cleared without a sale (still 2 sales)',
    heldAfter === 0, 'heldAfter=' + heldAfter);
  // D-Khata second half (Worker D checklist): Ahmed pays Rs 400 -> balance Rs 600.
  await navTo('Khata');
  await waitFor(`(document.querySelector('#screen h1') || {}).textContent === 'Khata'`, 8000, 'khata screen');
  await clickEl(`document.querySelector('button[data-ledger]')`, 'Ahmed ledger');
  await waitFor(`document.querySelector('.khata-balance-big')`, 8000, 'ledger balance box');
  const balBefore = await ev(`(document.querySelector('.khata-balance-big') || {}).textContent`);
  const payForm = `[...document.querySelectorAll('#screen .card form')].find(f => f.innerText.includes('Payment Save Karein'))`;
  await typeInto(`(${payForm}).querySelector('input[type=number]')`, 'khata payment 400', '400');
  await clickEl(`(${payForm}).querySelector('button[type=submit]')`, 'Save khata payment');
  await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('baqi khata Rs 600'))`, 8000, 'payment notice 600');
  const balAfter = await ev(`(document.querySelector('.khata-balance-big') || {}).textContent`);
  log('L4l D-Khata flow 1000 -> 600: Ahmed balance Rs 1,000, payment Rs 400 recorded, balance Rs 600',
    /Rs 1,000/.test(balBefore || '') && /Rs 600/.test(balAfter || ''), 'before=' + balBefore + ' after=' + balAfter);
  // Close Shift: counted = expected (1000 opening + 1200 cash sales) = 2200.
  await navTo('Shifts');
  await waitFor(`document.querySelector('#sh-counted')`, 8000, 'close shift form');
  await typeInto(`document.getElementById('sh-counted')`, 'counted drawer', '2200');
  await clickEl(`document.querySelector('#sh-counted').closest('form').querySelector('button[type=submit]')`, 'Close Shift submit');
  await waitFor(`document.querySelector('.shift-report-card')`, 10000, 'closing report');
  const report = await ev(`(document.querySelector('.shift-report-card') || {}).innerText`);
  log('L4m Close Shift (counted Rs 2,200 = expected): closing report shows Cash Sales Rs 1,200, Total Sales (2 bills) Rs 2,200, Expected Drawer Rs 2,200, Difference Rs 0 — Barabar',
    /Cash Sales/.test(report) && /Rs 1,200/.test(report) && /Total Sales \(2 bills\)/.test(report) && /Rs 2,200/.test(report) &&
    /Expected Drawer/.test(report) && /Difference/.test(report) && /Rs 0/.test(report) && /Barabar/.test(report),
    report.replace(/\n/g, ' | ').slice(0, 400));
  await screenshot('15-shift-report.png');
  // Sale History shows both bills; void SL-0001 -> stock back, totals exclude it.
  await navTo('Sale History');
  await waitFor(`document.body.innerText.includes('SL-0002')`, 8000, 'history lists SL-0002');
  const histTxt = await ev(`document.getElementById('screen').innerText`);
  log('L4n Sale History lists both bills SL-0001 and SL-0002 (live total Rs 2,200)',
    /SL-0001/.test(histTxt) && /SL-0002/.test(histTxt), histTxt.slice(0, 200).replace(/\n/g, ' | '));
  const saleIds = await ev(`DB.state.sales.map(s => ({ id: s.id, saleNo: s.saleNo }))`);
  const sl1 = saleIds.find((s) => s.saleNo === 1);
  await clickEl(`document.querySelector('button[data-view="${sl1.id}"]')`, 'Open SL-0001 detail');
  await waitFor(`document.body.innerText.includes('Bill Detail — SL-0001')`, 8000, 'SL-0001 detail');
  await clickEl(`[...document.querySelectorAll('#screen button')].find(b => b.textContent.trim() === 'Void Sale')`, 'Void SL-0001');
  await waitFor(`document.getElementById('confirm-overlay').style.display === 'flex'`, 8000, 'void confirm');
  await clickEl(`document.getElementById('confirm-yes')`, 'Confirm void');
  await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('void ho gayi'))`, 8000, 'void notice');
  const voidCheck = await ev(`(() => { const s = DB.state.sales.find(x => x.saleNo === 1); return { voided: !!s.voidedAt, stock: DB.stockOf(DB.state.products.find(p => p.id === 64), DB.WAREHOUSE_ID), sales: DB.state.sales.length, voidedCount: DB.state.sales.filter(x => x.voidedAt).length }; })()`);
  log('L4o Void SL-0001: row stays with VOID stamp, stock returns (Fajita S 6 -> 8), sales still 2, 1 voided',
    voidCheck.voided === true && voidCheck.stock === 8 && voidCheck.sales === 2 && voidCheck.voidedCount === 1, JSON.stringify(voidCheck));
  try { await ev(`window.close()`); } catch (e) { /* page closing */ }
  const exited4 = await waitForAppExit();
  let backupOk4 = false, backupDetail4 = '';
  if (exited4) {
    const dataFile4 = findFileRecursive(HOME4, 'sahara-bakers-data.json');
    const backupDir4 = dataFile4 ? path.join(path.dirname(dataFile4), 'backups') : null;
    if (backupDir4 && fs.existsSync(backupDir4)) {
      const files = fs.readdirSync(backupDir4).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        const newest = files.map((f) => ({ f, m: fs.statSync(path.join(backupDir4, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
        const parsed = JSON.parse(fs.readFileSync(path.join(backupDir4, newest), 'utf8'));
        backupOk4 = parsed.products.length === 140 && parsed.appUsers.length === 3 && (parsed.sales || []).length === 2 && (parsed.sales || []).filter((s) => s.voidedAt).length === 1;
        backupDetail4 = 'products=' + parsed.products.length + ' logins=' + parsed.appUsers.length + ' sales=' + (parsed.sales || []).length + ' voided=' + (parsed.sales || []).filter((s) => s.voidedAt).length;
      } else backupDetail4 = 'backups dir exists but empty';
    } else backupDetail4 = 'no backups dir';
  }
  log('L4p app closes cleanly AND backupOnClose wrote a good backup (140 products, 3 logins, sales 2, 1 voided)',
    exited4 === true && backupOk4 === true, 'exited=' + exited4 + ' ' + backupDetail4);
  if (!exited4) { try { app.kill('SIGKILL'); } catch (e) {} }

  // ================= LAUNCH 5: pre-seeded v2.0.0 data -> v210 migration + gating =================
  if (userDataRel) {
    const ud5 = path.join(HOME5, userDataRel);
    fs.mkdirSync(ud5, { recursive: true });
    const v2 = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'src/seed.json'), 'utf8'));
    // Strip the v2.1.0 seed back to a v2.0.0-shaped file: 44 base items,
    // 2 logins, Manager still named 'Manager', user-edited Cheese price
    // 7500/4000 + 5 Kg warehouse stock, no v2.1.0 tables or settings keys.
    v2.products = v2.products.filter((p) => p.id >= 12 && p.id <= 55);
    const v2cheese = v2.products.find((p) => p.id === 18);
    v2cheese.price = 7500; v2cheese.purchasePrice = 4000;
    v2cheese.branchStocks = [{ branchId: 'warehouse', qty: 5 }, { branchId: 2, qty: 0 }, { branchId: 3, qty: 0 }];
    v2cheese.stock = 5;
    v2.appUsers = v2.appUsers.filter((u) => u.username !== 'counter');
    v2.appUsers.find((u) => u.username === 'manager').name = 'Manager';
    for (const t of ['sales', 'saleLines', 'heldOrders', 'khataCustomers', 'khataPayments', 'shifts', 'staff', 'staffAttendance', 'shiftExpenses', 'deletedSales', 'batches', 'wastage', 'expenses', 'recipes']) delete v2[t];
    for (const k of ['managerCanSeeCost', 'posServiceCharge', 'posBillCopies', 'kotEnabled', 'kotRemarks', 'backupFormatVersion']) delete v2.settings[k];
    v2.settings.v210Migrated = false;
    fs.writeFileSync(path.join(ud5, 'sahara-bakers-data.json'), JSON.stringify(v2, null, 2), 'utf8');
    launchElectron(HOME5);
    if (!(await connectCDP())) throw new Error('CDP connect failed (launch 5)');
    await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 30000, 'login cards launch 5');
    const mig = await ev(`(() => { const c = DB.state.products.find(p => p.id === 18); const m = DB.state.appUsers.find(u => u.username === 'manager'); const cm = DB.state.appUsers.find(u => u.username === 'counter'); return { products: DB.state.products.length, cheesePrice: c.price, cheeseCost: c.purchasePrice, cheeseStock: DB.stockOf(c, DB.WAREHOUSE_ID), mgrName: m && m.name, mgrPinOk: DB.checkPin(m, '123'), counterRole: cm && cm.role, counterPosOnly: !!(cm && cm.isPosOnly), v210: DB.state.settings.v210Migrated }; })()`);
    log('L5-MIG v2.0.0 file migrates on load: 44 -> 140 items (96 merged, 0 overwritten), Cheese keeps user price 7500/4000 + stock 5, Manager renamed "Warehouse" (PIN 123 kept), Counter Manager login added (isPosOnly), v210Migrated true',
      mig.products === 140 && mig.cheesePrice === 7500 && mig.cheeseCost === 4000 && mig.cheeseStock === 5 &&
      mig.mgrName === 'Warehouse' && mig.mgrPinOk === true && mig.counterRole === 'Counter Manager' && mig.counterPosOnly === true && mig.v210 === true,
      JSON.stringify(mig));
    // Owner: owner-dashboard, greeting, figures, no Production/Sale/Recipes nav.
    await loginAs('rahmanullah', '1234');
    await waitFor(`document.getElementById('logout-btn')`, 15000, 'owner logged in launch 5');
    await waitFor(`document.querySelector('.od-greeting')`, 10000, 'owner dashboard greeting');
    const od5 = await ev(`(() => { const side = [...document.querySelectorAll('#sidebar button .nav-label')].map(b => b.textContent.trim()); return { head: (document.querySelector('#screen h1') || {}).textContent, greeting: (document.querySelector('.od-greeting') || {}).textContent, hasTotalSales: [...document.querySelectorAll('.stat-label')].some(s => s.textContent.trim() === 'Total Sales'), side }; })()`);
    log('L5-OWN Owner lands on owner-dashboard with greeting + figures; nav has NO Production / Counter Sale / Recipes',
      od5.head === 'Owner Dashboard' && od5.greeting === 'Assalamualaikum wa Rahmatullah, Rahmanullah' && od5.hasTotalSales === true &&
      od5.side.indexOf('Production') === -1 && od5.side.indexOf('Counter Sale') === -1 && od5.side.indexOf('Recipes') === -1,
      JSON.stringify(od5));
    await screenshot('16-migration-owner-dash.png');
    // Owner Products edit: only Cost Price editable.
    await navTo('Products');
    await typeInto(`document.getElementById('products-search')`, 'search cheese', 'Cheese');
    await sleep(700);
    await clickEl(`[...document.querySelectorAll('.product-card')].find(c => ((c.querySelector('.p-name') || {}).textContent || '').trim() === 'Cheese')`, 'Cheese card (owner)');
    await waitFor(`document.getElementById('detail-edit-btn')`, 8000, 'cheese detail (owner)');
    await clickEl(`document.getElementById('detail-edit-btn')`, 'Edit Cheese (owner)');
    await waitFor(`document.getElementById('pf-purchase')`, 8000, 'cheese edit form (owner)');
    const ownEdit = await ev(`({ costEnabled: !document.getElementById('pf-purchase').disabled, nameDisabled: document.getElementById('pf-name').disabled, priceDisabled: document.getElementById('pf-price').disabled })`);
    log('L5-OWN-EDIT Owner product edit: ONLY Cost Price editable (name + sale price disabled)',
      ownEdit.costEnabled === true && ownEdit.nameDisabled === true && ownEdit.priceDisabled === true, JSON.stringify(ownEdit));
    await clickEl(`document.getElementById('pf-cancel')`, 'Cancel cheese edit (owner)');
    // Owner Transfer: create form hidden (read-only).
    await navTo('Stock Transfer');
    await waitFor(`document.querySelector('#screen h1')`, 8000, 'transfer screen (owner)');
    const trOwn = await ev(`({ hasCreateForm: !!document.getElementById('tr-to'), readOnly: document.getElementById('screen').innerText.includes('Read-Only') })`);
    log('L5-OWN-TR Owner transfer is read-only: no create form, "Read-Only" notice, history still visible',
      trOwn.hasCreateForm === false && trOwn.readOnly === true, JSON.stringify(trOwn));
    // Manager (display "Warehouse"): no Reports/Logins/Settings, cost hidden.
    await clickEl(`document.getElementById('logout-btn')`, 'logout owner launch 5');
    await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards manager launch 5');
    await loginAs('manager', '123');
    await waitFor(`document.getElementById('logout-btn')`, 15000, 'manager logged in launch 5');
    const mgr5 = await ev(`(() => { const side = [...document.querySelectorAll('#sidebar button .nav-label')].map(b => b.textContent.trim()); const chip = (document.getElementById('user-chip') || {}).textContent || ''; return { side, chip }; })()`);
    log('L5-MGR Manager login shows display name "Warehouse (Manager)"; sidebar has NO Reports / Logins / Settings',
      mgr5.chip === 'Warehouse (Manager)' && mgr5.side.indexOf('Reports') === -1 && mgr5.side.indexOf('Logins') === -1 && mgr5.side.indexOf('Settings') === -1,
      JSON.stringify(mgr5));
    await navTo('Products');
    // The Owner's 'Cheese' search from L5-OWN-EDIT persists in the
    // Products module (currentQuery) — clear it first, or typing
    // appends and 'CheeseCheese' matches nothing.
    await ev(`(() => { const i = document.getElementById('products-search'); if (!i) return false; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(700);
    await typeInto(`document.getElementById('products-search')`, 'search cheese mgr', 'Cheese');
    await sleep(700);
    await clickEl(`[...document.querySelectorAll('.product-card')].find(c => ((c.querySelector('.p-name') || {}).textContent || '').trim() === 'Cheese')`, 'Cheese card (manager)');
    await waitFor(`document.getElementById('detail-edit-btn')`, 8000, 'cheese detail (manager)');
    const mgrDetail5 = await ev(`document.getElementById('item-form-body').innerText`);
    log('L5-MGR-COST Manager product detail shows NO Purchase Price / Cost row (toggle OFF)',
      /Purchase Price/.test(mgrDetail5) === false, mgrDetail5.slice(0, 200).replace(/\n/g, ' | '));
    await clickEl(`document.getElementById('detail-close-btn')`, 'Close cheese detail (manager)');
    // Recipe -> Production PB bill (Worker F checklist, as Manager).
    await ev(`(() => { const f = DB.state.products.find(p => p.id === 15); DB.setStock(f, DB.WAREHOUSE_ID, 100); DB.save(); return DB.stockOf(f, DB.WAREHOUSE_ID); })()`);
    await navTo('Recipes');
    await waitFor(`document.getElementById('add-recipe-btn')`, 8000, 'recipes screen');
    await clickEl(`document.getElementById('add-recipe-btn')`, 'New Recipe');
    await waitFor(`document.getElementById('rf-finish')`, 8000, 'recipe form');
    await setSelect(`document.getElementById('rf-finish')`, '40');
    await typeInto(`document.getElementById('rf-name')`, 'recipe name', 'Gulab Jamun Recipe');
    await setSelect(`document.getElementById('rf-raw-sel')`, '15');
    await typeInto(`document.getElementById('rf-raw-qty')`, 'recipe flour qty', '100');
    await clickEl(`document.getElementById('rf-raw-add')`, 'Add recipe line');
    await clickEl(`document.querySelector('#item-form-body form button[type=submit]')`, 'Save recipe');
    await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('Recipe save ho gayi'))`, 8000, 'recipe saved notice');
    await navTo('Production');
    await waitFor(`document.querySelector('#prod-finish-sel')`, 10000, 'production screen');
    await setSelect(`document.getElementById('prod-finish-sel')`, '40');
    await waitFor(`!document.getElementById('prod-recipe-load').disabled`, 8000, 'recipe picker enabled');
    await clickEl(`document.getElementById('prod-recipe-load')`, 'Load recipe into cart');
    await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('Recipe se cart bhar gaya'))`, 8000, 'recipe loaded notice');
    await typeInto(`document.getElementById('prod-finish-qty')`, 'finish qty 80', '80');
    await clickEl(`document.getElementById('prod-complete-btn')`, 'Complete production from recipe');
    await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'PB bill preview');
    const pbill5 = await ev(`document.getElementById('bill-preview-body').innerText`);
    const prodStocks = await ev(`(() => ({ fWh: DB.stockOf(DB.state.products.find(p => p.id === 15), DB.WAREHOUSE_ID), gWh: DB.stockOf(DB.state.products.find(p => p.id === 40), DB.WAREHOUSE_ID) }))()`);
    log('L5-REC recipe -> production: Gulab Jamun recipe (Flour 100) loads into the cart, PB-0001 bill opens, Flour 100 -> 0, Gulab Jamun 0 -> 80',
      /PB-0001/.test(pbill5) && prodStocks.fWh === 0 && prodStocks.gWh === 80, 'stocks=' + JSON.stringify(prodStocks));
    await clickEl(`document.getElementById('bill-preview-close')`, 'close PB bill');
    await sleep(300);
    // FEFO (Worker H checklist): Flour batches, earlier expiry consumed first.
    await ev(`(() => { const f = DB.state.products.find(p => p.id === 15); f.expiryTracked = true; DB.setStock(f, DB.WAREHOUSE_ID, 100); DB.addBatch({ productId: 15, qty: 50, expiryDate: '2026-12-01', branchId: DB.WAREHOUSE_ID }); DB.addBatch({ productId: 15, qty: 50, expiryDate: '2027-06-01', branchId: DB.WAREHOUSE_ID }); DB.save(); return true; })()`);
    await navTo('Stock Transfer');
    await waitFor(`document.querySelector('#transfer-stage')`, 10000, 'transfer form (FEFO)');
    await setSelect(`document.getElementById('tr-to')`, '2');
    await setSelect(`document.getElementById('tr-item')`, '15');
    await typeInto(`document.getElementById('tr-qty')`, 'FEFO transfer qty', '60');
    await clickEl(`document.getElementById('tr-add-btn')`, 'Add Flour to transfer (FEFO)');
    await typeInto(`document.getElementById('tr-received-by')`, 'received by FEFO', 'Ali');
    await clickEl(`[...document.querySelectorAll('#screen .card form button[type=submit]')].find(b => b.textContent.trim() === 'Transfer & View Bill')`, 'FEFO transfer submit');
    await waitFor(`document.getElementById('bill-preview-overlay').style.display === 'flex'`, 10000, 'FEFO transfer bill');
    const fefoBill = await ev(`document.getElementById('bill-preview-body').innerText`);
    const fefoBatches = await ev(`(DB.state.batches || []).filter(b => b.productId === 15).map(b => ({ exp: b.expiryDate, qty: b.qty }))`);
    log('L5-FEFO transfer 60 Kg Flour consumes the EARLIER-expiry batch first (Dec-2026 batch 50 -> 0, Jun-2027 batch 50 -> 40); bill SB-0001 opens',
      /SB-0001/.test(fefoBill) && JSON.stringify(fefoBatches) === JSON.stringify([{ exp: '2026-12-01', qty: 0 }, { exp: '2027-06-01', qty: 40 }]),
      'batches=' + JSON.stringify(fefoBatches));
    await clickEl(`document.getElementById('bill-preview-close')`, 'close FEFO bill');
    await sleep(300);
    // Expired dispatch blocked: Sugar has ONLY an expired batch.
    await ev(`(() => { const s = DB.state.products.find(p => p.id === 13); s.expiryTracked = true; DB.setStock(s, DB.WAREHOUSE_ID, 10); DB.addBatch({ productId: 13, qty: 10, expiryDate: '2026-01-01', branchId: DB.WAREHOUSE_ID }); DB.save(); return true; })()`);
    await waitFor(`document.querySelector('#transfer-stage')`, 10000, 'transfer form again (expired)');
    await setSelect(`document.getElementById('tr-to')`, '2');
    await setSelect(`document.getElementById('tr-item')`, '13');
    await typeInto(`document.getElementById('tr-qty')`, 'expired transfer qty', '5');
    await clickEl(`document.getElementById('tr-add-btn')`, 'Add Sugar to transfer (expired)');
    await typeInto(`document.getElementById('tr-received-by')`, 'received by expired', 'Ali');
    await clickEl(`[...document.querySelectorAll('#screen .card form button[type=submit]')].find(b => b.textContent.trim() === 'Transfer & View Bill')`, 'Expired transfer submit');
    await waitFor(`[...document.querySelectorAll('.notice')].some(n => n.textContent.includes('expired batch se dispatch nahi ho sakta'))`, 8000, 'expired block notice');
    const expCheck = await ev(`({ transfers: DB.state.transfers.length, sugar: DB.stockOf(DB.state.products.find(p => p.id === 13), DB.WAREHOUSE_ID) })`);
    log('L5-EXP expired dispatch BLOCKED with the FEFO notice — no transfer created (still 1), Sugar stock still 10',
      expCheck.transfers === 1 && expCheck.sugar === 10, JSON.stringify(expCheck));
    // Backup guard (Worker H checklist): wrong JSON / {} / version 99 rejected, data untouched.
    await clickEl(`document.getElementById('logout-btn')`, 'logout manager launch 5');
    await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards owner launch 5 again');
    await loginAs('rahmanullah', '1234');
    await waitFor(`document.getElementById('logout-btn')`, 15000, 'owner logged in launch 5 again');
    await navTo('Settings');
    const bkp = await ev(`(() => { const a = DB.importBackup('this is not json'); const b = DB.importBackup('{}'); const c = DB.importBackup(JSON.stringify({ app: 'sahara-bakers-backup', version: 99, data: {} })); return { a: a.ok, b: b.ok, c: c.ok, products: DB.state.products.length }; })()`);
    log('L5-BKP backup import guard: wrong JSON / {} / version 99 ALL rejected, current data untouched (140 products)',
      bkp.a === false && bkp.b === false && bkp.c === false && bkp.products === 140, JSON.stringify(bkp));
    // Counter Manager POS-only (Launch 5 tail).
    await clickEl(`document.getElementById('logout-btn')`, 'logout owner for counter check');
    await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 8000, 'login cards counter launch 5');
    await loginAs('counter', '1234');
    await waitFor(`document.querySelector('.pos-wrap')`, 10000, 'counter sale screen launch 5');
    const pos5 = await ev(`(() => { const side = [...document.querySelectorAll('#sidebar button .nav-label')].map(b => b.textContent.trim()); const r = window.App.go('dashboard'); return { head: (document.querySelector('#screen h1') || {}).textContent, side, afterGo: window.App.currentScreen }; })()`);
    log('L5-POS Counter Manager lands on dark Sale screen, sidebar POS-only, godown route redirects to sale',
      pos5.head === 'Counter Sale' && pos5.side.indexOf('Products') === -1 && pos5.side.indexOf('Counter Sale') !== -1 && pos5.afterGo === 'sale',
      JSON.stringify(pos5));
    await screenshot('17-pos-counter.png');
    try { await ev(`window.close()`); } catch (e) { /* page closing */ }
    const exited5 = await waitForAppExit();
    let backupOk5 = false, backupDetail5 = '';
    if (exited5) {
      const dataFile5 = findFileRecursive(HOME5, 'sahara-bakers-data.json');
      const backupDir5 = dataFile5 ? path.join(path.dirname(dataFile5), 'backups') : null;
      if (backupDir5 && fs.existsSync(backupDir5)) {
        const files = fs.readdirSync(backupDir5).filter((f) => f.endsWith('.json'));
        if (files.length > 0) {
          const newest = files.map((f) => ({ f, m: fs.statSync(path.join(backupDir5, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
          const parsed = JSON.parse(fs.readFileSync(path.join(backupDir5, newest), 'utf8'));
          backupOk5 = parsed.products.length === 140 && parsed.appUsers.length === 3;
          backupDetail5 = 'products=' + parsed.products.length + ' logins=' + parsed.appUsers.length;
        } else backupDetail5 = 'backups dir exists but empty';
      } else backupDetail5 = 'no backups dir';
    }
    log('L5b app closes cleanly AND backupOnClose wrote a good backup (140 products, 3 logins)',
      exited5 === true && backupOk5 === true, 'exited=' + exited5 + ' ' + backupDetail5);
    if (!exited5) { try { app.kill('SIGKILL'); } catch (e) {} }
  } else {
    log('L5 SKIPPED: userData relative path was not discovered in launch 1', false, 'userDataRel=' + userDataRel);
  }

  // ================= LAUNCH 2: corrupt data + good .bak =================
  if (userDataRel) {
    const ud2 = path.join(HOME2, userDataRel);
    fs.mkdirSync(ud2, { recursive: true });
    const seedState = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'src/seed.json'), 'utf8'));
    delete seedState._note;
    fs.writeFileSync(path.join(ud2, 'sahara-bakers-data.json'), '{this file is corrupt!!!', 'utf8');
    fs.writeFileSync(path.join(ud2, 'sahara-bakers-data.json.bak'), JSON.stringify(seedState, null, 2), 'utf8');
    launchElectron(HOME2);
    if (!(await connectCDP())) throw new Error('CDP connect failed (launch 2)');
    await waitFor(`document.querySelectorAll('.login-role-card').length === 3`, 30000, 'login cards launch 2');
    const recFlags = await ev(`({ recovered: DB.recoveredFromBackup, loadError: DB.loadError })`);
    log('L2 corrupt data file + good .bak: app still opens to the login-selection screen (3 cards); sticky flags prove the .bak recovery',
      recFlags.recovered === true && /pichli achi copy \(\.bak\)/.test(recFlags.loadError || ''),
      JSON.stringify(recFlags));
    await screenshot('09-recovery-corrupt-login.png');
    await loginAs('rahmanullah', '1234');
    await waitFor(`document.getElementById('logout-btn')`, 15000, 'logged in after recovery');
    const recCount = await ev(`DB.state.products.length`);
    log('L2b after recovery Owner login works (PIN 1234) and all 140 items are back', recCount === 140, 'products=' + recCount);
    try { await ev(`window.close()`); } catch (e) { /* page closing */ }
    const exited2 = await waitForAppExit();
    if (!exited2) { try { app.kill('SIGKILL'); } catch (e) {} }
    log('L2c recovery launch closes cleanly', exited2 === true, 'exited=' + exited2);
  } else {
    log('L2 SKIPPED: userData relative path was not discovered in launch 1', false, 'userDataRel=' + userDataRel);
  }

  // ================= LAUNCH 3: empty data, flag applied, no backups =================
  if (userDataRel) {
    const ud3 = path.join(HOME3, userDataRel);
    fs.mkdirSync(ud3, { recursive: true });
    const emptyState = { products: [], branches: [], stockMovements: [], transfers: [], productions: [], purchases: [], purchaseLines: [], suppliers: [], appUsers: [], loginSecurity: {}, settings: { businessName: 'Sahara Bakers', currency: 'PKR', v100FreshSeedApplied: true } };
    fs.writeFileSync(path.join(ud3, 'sahara-bakers-data.json'), JSON.stringify(emptyState, null, 2), 'utf8');
    launchElectron(HOME3);
    if (!(await connectCDP())) throw new Error('CDP connect failed (launch 3)');
    await waitFor(`document.getElementById('login-screen').style.display !== 'none'`, 30000, 'login screen launch 3');
    await waitFor(`document.getElementById('login-body').innerText.includes('Owner Setup')`, 15000, 'owner setup form');
    const e3state = await ev(`(() => ({ setupShown: document.getElementById('login-body').innerText.includes('Owner Setup'), loadError: DB.loadError, products: DB.state.products.length }))()`);
    log('L3 empty data file (no backups): login screen shows Owner Setup (no logins); sticky loadError proves the empty-data notice path',
      e3state.setupShown === true && /Khaali data mila/.test(e3state.loadError || '') && e3state.products === 0,
      JSON.stringify(e3state));
    await screenshot('10-empty-state-login.png');
    try { await ev(`window.close()`); } catch (e) { /* page closing */ }
    const exited3 = await waitForAppExit();
    let noBackup = false, bDetail = '';
    if (exited3) {
      const bdir = path.join(ud3, 'backups');
      noBackup = !fs.existsSync(bdir) || fs.readdirSync(bdir).filter((f) => f.endsWith('.json')).length === 0;
      bDetail = fs.existsSync(bdir) ? ('files=' + fs.readdirSync(bdir).length) : 'no backups dir';
    }
    log('L3b closing the empty-state app writes NO backup (backupOnClose empty guard, live)',
      exited3 === true && noBackup === true, 'exited=' + exited3 + ' ' + bDetail);
    if (!exited3) { try { app.kill('SIGKILL'); } catch (e) {} }
  } else {
    log('L3 SKIPPED: userData relative path was not discovered in launch 1', false);
  }

  log('zero console errors / exceptions across all 5 launches', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' ; '));
} catch (e) {
  log('HARNESS ERROR: ' + e.message, false);
} finally {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = `\n==== SUMMARY: ${passed}/${total} passed, ${total - passed} failed ====\n`;
  console.log(summary);
  fs.writeFileSync(path.join(EVIDENCE, 'electron-final-run.log'), results.map((r) => (r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : '')).join('\n') + summary);
  try { if (ws) ws.close(); } catch (e) {}
  try { if (app && app.exitCode === null) app.kill('SIGKILL'); } catch (e) {}
  try { if (xvfb) xvfb.kill('SIGKILL'); } catch (e) {}
  await sleep(500);
  process.exit(passed === total ? 0 : 1);
}
