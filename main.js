// Sahara Bakers — Electron main process (v1.0.0).
// Local-only offline desktop app. No remote content is ever loaded:
// the window only loads the bundled local index.html.
// NO auto-update in v1.0.0 — delivery is by manual installer download.
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWin = null;

// ---------------------------------------------------------------------------
// Thermal bill printing: the printed bill must be exactly one page whose
// length matches the bill content. CSS alone cannot do that (@page
// size:80mm auto is invalid in Blink; a square 80mm page splits a bill
// across 2 pages mid-bill). So the renderer measures the rendered bill
// height and the main process prints it with Electron's pageSize option
// — 80mm wide, content height, one copy, no margins.
// ---------------------------------------------------------------------------
ipcMain.handle('printer-list', async () => {
  try {
    if (!mainWin || mainWin.isDestroyed()) return [];
    const printers = await mainWin.webContents.getPrintersAsync();
    return (printers || []).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  } catch (e) { return []; }
});
ipcMain.handle('print-receipt', async (_e, opts) => {
  try {
    if (!mainWin || mainWin.isDestroyed()) return { ok: false, error: 'no-window' };
    const height = opts && Number(opts.heightMicrons);
    const deviceName = opts && typeof opts.deviceName === 'string' ? opts.deviceName.trim() : '';
    if (!deviceName) return { ok: false, error: 'no-printer' };
    if (!height || height < 20000 || height > 600000) return { ok: false, error: 'bad-height' };
    await mainWin.webContents.print({
      silent: true,
      deviceName,
      pageSize: { width: 80000, height: Math.round(height) },
      margins: { marginType: 'none' },
      printBackground: false,
      copies: 1
    });
    return { ok: true };
  } catch (e) {
    // Never surface raw errors (they can contain paths); the renderer
    // shows a short Roman Urdu notice and falls back to the dialog.
    return { ok: false, error: 'print-failed' };
  }
});

// Automatic backup on close: copy the live data file into
// <userData>/backups with a timestamp and verify it parses, so the
// last good state always survives a bad shutdown. Keeps the last 7.
// Runs synchronously in the window 'close' handler — any failure is
// swallowed, never shown as a crash.
//
// Data-safety rule (RARA v1.1.9, 2026-11-15 incident): NEVER back up an
// empty or corrupt data file. An empty close-backup becomes the "newest"
// backup, so the next restore brings back nothing — and pruning to the
// last 7 then pushes a good backup out. Parse first and skip when the
// file has 0 products AND 0 logins, or does not parse.
function backupOnClose() {
  try {
    const userData = app.getPath('userData');
    const dataFile = path.join(userData, 'sahara-bakers-data.json');
    if (!fs.existsSync(dataFile)) return;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const products = Array.isArray(parsed.products) ? parsed.products.length : 0;
    const logins = Array.isArray(parsed.appUsers) ? parsed.appUsers.length : 0;
    if (products === 0 && logins === 0) return;
    const backupDir = path.join(userData, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const now = new Date();
    const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') +
      '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0') +
      '-' + String(now.getMilliseconds()).padStart(3, '0');
    const dest = path.join(backupDir, 'sahara-bakers-backup-' + stamp + '.json');
    fs.copyFileSync(dataFile, dest);
    // Verify the copy parses — a backup that cannot be read is useless.
    JSON.parse(fs.readFileSync(dest, 'utf8'));
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('sahara-bakers-backup-') && f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.slice(7).forEach((f) => { try { fs.unlinkSync(path.join(backupDir, f.name)); } catch (e) { /* ignore */ } });
  } catch (e) { /* backup failure must never stop the app closing */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWin = win;

  win.on('close', () => { backupOnClose(); });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // The renderer cannot call app.getPath() itself (app lives in the
  // main process), so hand it the data folder through the environment
  // before the window is created — src/db.js reads SAHARA_DATA_DIR
  // first and stores the live data in <userData>/sahara-bakers-data.json.
  process.env.SAHARA_DATA_DIR = app.getPath('userData');
  // No default application menu — the app provides its own in-app navigation.
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On Windows (and Linux) quit when every window is closed.
  if (process.platform !== 'darwin') app.quit();
});
