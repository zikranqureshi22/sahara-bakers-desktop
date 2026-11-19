/* Sahara Bakers — Settings (v2.0.0).
 * Business settings (name/address/phone), Notifications — Low Stock
 * card (notices ON/OFF + Default Low Stock Limit + Save; an item's own
 * limit always wins), Backup & Restore card (Backup Now, Restore
 * Latest Backup, Export Data JSON, Import), printer choice, theme
 * toggle, version display (1.0.0). No Updates card — there is no
 * auto-update in v1.0.0. Wrapped in an IIFE.
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

const APP_VERSION = '2.0.0';

function renderSettings(container) {
  container.innerHTML = '';
  const st = S();
  const settings = st.settings || {};

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Settings</h1><span class="muted">Version ' + APP_VERSION + '</span></div>'));

  // ---- Business settings ----
  const bCard = el('<div class="card"><h2>Business Settings</h2></div>');
  const bForm = el('<form></form>');
  const nameIn = el('<input class="input" type="text" value="' + esc(settings.businessName || '') + '">');
  const addrIn = el('<input class="input" type="text" value="' + esc(settings.address || '') + '" placeholder="Address">');
  const phoneIn = el('<input class="input" type="text" value="' + esc(settings.phone || '') + '" placeholder="Phone">');
  bForm.appendChild(el('<label>Business Name</label>')); bForm.appendChild(nameIn);
  bForm.appendChild(el('<label>Address</label>')); bForm.appendChild(addrIn);
  bForm.appendChild(el('<label>Phone</label>')); bForm.appendChild(phoneIn);
  bForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div>'));
  bForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) { notify('Issue — Business ka naam zaroori hai', 'error'); return; }
    settings.businessName = name;
    settings.address = addrIn.value.trim();
    settings.phone = phoneIn.value.trim();
    window.App.save();
    notify('Ho Gaya ✓ — Business settings save ho gayi', 'success');
  });
  bCard.appendChild(bForm);
  wrap.appendChild(bCard);

  // ---- Notifications — Low Stock ----
  const nCard = el('<div class="card"><h2>Notifications — Low Stock</h2></div>');
  const nForm = el('<form></form>');
  const onOff = el('<label style="display:flex;align-items:center;gap:10px;font-weight:600"><input type="checkbox" id="low-notif-on"' + (settings.lowStockNotifications ? ' checked' : '') + '> Low Stock Notices ON karein</label>');
  const limitIn = el('<input class="input" type="number" min="0" step="1" value="' + (settings.defaultLowStockLimit != null ? esc(settings.defaultLowStockLimit) : '') + '" placeholder="Default Low Stock Limit (blank = koi default nahi)">');
  nForm.appendChild(onOff);
  nForm.appendChild(el('<label>Default Low Stock Limit</label>')); nForm.appendChild(limitIn);
  nForm.appendChild(el('<p class="muted">Item ki apni limit pehle lagti hai — jo item par limit lagi ho, wohi use hoti hai. Default limit sirf un items ke liye hai jin par apni limit nahi lagi.</p>'));
  nForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div>'));
  nForm.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.lowStockNotifications = !!nForm.querySelector('#low-notif-on').checked;
    settings.defaultLowStockLimit = limitIn.value === '' ? null : Number(limitIn.value);
    window.App.save();
    notify('Ho Gaya ✓ — Low stock notification settings save ho gayi', 'success');
  });
  nCard.appendChild(nForm);
  wrap.appendChild(nCard);

  // ---- Printer (thermal bill) ----
  const prCard = el('<div class="card"><h2>Printer — Thermal Bill</h2></div>');
  const prForm = el('<form></form>');
  const prSel = el('<select class="input" id="printer-select"><option value="">Printer chunein…</option></select>');
  prForm.appendChild(el('<label>Printer</label>')); prForm.appendChild(prSel);
  prForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save</button></div>'));
  prForm.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.printerName = prSel.value || '';
    window.App.save();
    notify('Ho Gaya ✓ — Printer save ho gaya: ' + (settings.printerName || 'koi printer nahi'), 'success');
  });
  prCard.appendChild(prForm);
  wrap.appendChild(prCard);
  // Load the printer list (async; the select fills in when ready).
  window.App.printerList().then((list) => {
    const sel = document.getElementById('printer-select');
    if (!sel) return;
    list.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.displayName || p.name;
      if (p.name === settings.printerName) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Koi printer nahi mila — print dialog use hoga';
      sel.appendChild(opt);
    }
  }).catch(() => { /* printer list is optional */ });

  // ---- Backup & Restore ----
  const bkCard = el('<div class="card"><h2>Backup &amp; Restore</h2></div>');
  const info = DB.backupInfo ? DB.backupInfo() : { lastBackup: null, count: 0 };
  bkCard.appendChild(el('<p class="muted">Aakhri backup: ' + (info.lastBackup ? esc(new Date(info.lastBackup).toLocaleString('en-GB')) : 'abhi tak koi backup nahi') + ' — kul ' + info.count + ' backups (aakhri 7 rakhe jate hain).</p>'));
  const bkRow = el('<div class="btn-row">' +
    '<button type="button" class="btn btn-primary" id="bk-now">Backup Now</button>' +
    '<button type="button" class="btn" id="bk-restore">Restore Latest Backup</button>' +
    '<button type="button" class="btn" id="bk-export">Export Data JSON</button>' +
    '<button type="button" class="btn" id="bk-import">Import Data JSON</button>' +
    '<input type="file" id="bk-import-file" accept=".json,application/json" hidden>' +
    '</div>');
  bkCard.appendChild(bkRow);
  bkRow.querySelector('#bk-now').addEventListener('click', () => {
    const res = DB.backup ? DB.backup() : { ok: false };
    if (res.ok) notify('Ho Gaya ✓ — Backup ban gaya: ' + res.name, 'success');
    else notify('Issue — Backup nahi ban saka', 'error');
    renderSettings(container);
  });
  bkRow.querySelector('#bk-restore').addEventListener('click', async () => {
    const ok = await window.App.confirmDialog('Restore Latest Backup?', 'Maujooda data ki jagah aakhri achi backup aa jayegi. Pehle maujooda data ka safety backup ban jayega.');
    if (!ok) return;
    let res = { ok: false, message: 'Restore available nahi hai' };
    try { res = DB.restoreLatestBackup ? DB.restoreLatestBackup() : res; } catch (e) { res = { ok: false, message: e && e.message ? e.message : 'Restore nahi ho saka' }; }
    if (res.ok) {
      window.App.state = DB.state;
      notify('Ho Gaya ✓ — Backup se data wapas aa gaya — Items ' + res.products + ', Logins ' + res.logins, 'success');
      renderSettings(container);
    } else {
      notify('Issue — ' + (res.message || 'Restore nahi ho saka'), 'error');
    }
  });
  bkRow.querySelector('#bk-export').addEventListener('click', () => {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const dest = path.join(os.homedir(), 'Desktop', 'sahara-bakers-export-' + new Date().toISOString().slice(0, 10) + '.json');
      fs.writeFileSync(dest, JSON.stringify(DB.state, null, 2), 'utf8');
      notify('Ho Gaya ✓ — Data export ho gaya: ' + dest, 'success');
    } catch (e) {
      // Fallback: download via a blob (works even without fs access).
      try {
        const blob = new Blob([JSON.stringify(DB.state, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'sahara-bakers-export.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        notify('Ho Gaya ✓ — Data export download ho gaya', 'success');
      } catch (e2) {
        notify('Issue — Export nahi ho saka', 'error');
      }
    }
  });
  bkRow.querySelector('#bk-import').addEventListener('click', () => {
    bkRow.querySelector('#bk-import-file').click();
  });
  bkRow.querySelector('#bk-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const ok = await window.App.confirmDialog('Import Data JSON?', 'Maujooda data ki jagah is file ka data aa jayega. Pehle maujooda data ka backup bana lein.');
    if (!ok) { e.target.value = ''; return; }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.appUsers)) throw new Error('File ka format durust nahi hai');
      // Safety copy of the current state first.
      try { if (DB.backup) DB.backup(); } catch (e2) { /* ignore */ }
      DB.state = Object.assign(DB.state, parsed);
      window.App.state = DB.state;
      window.App.save();
      notify('Ho Gaya ✓ — Data import ho gaya — Items ' + (parsed.products || []).length + ', Logins ' + (parsed.appUsers || []).length, 'success');
      renderSettings(container);
    } catch (err) {
      notify('Issue — Import nahi ho saka: file ka format durust nahi hai', 'error');
    }
    e.target.value = '';
  });
  wrap.appendChild(bkCard);

  // ---- Theme + version ----
  const miscCard = el('<div class="card"><h2>Theme aur Version</h2></div>');
  miscCard.appendChild(el('<p>Theme: <b>' + (window.App.theme === 'dark' ? 'Dark' : 'Light') + '</b> — sidebar se Dark/Light badla ja sakta hai.</p>'));
  miscCard.appendChild(el('<p>Version: <b>' + APP_VERSION + '</b></p>'));
  const themeBtn = el('<button type="button" class="btn">Theme Badlein (Dark / Light)</button>');
  themeBtn.addEventListener('click', () => { window.App.toggleTheme(); renderSettings(container); });
  miscCard.appendChild(themeBtn);
  wrap.appendChild(miscCard);

  container.appendChild(wrap);
}

window.Screens.settings = renderSettings;
window.AppVersion = APP_VERSION;
})();
