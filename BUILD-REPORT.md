# Sahara Bakers Desktop v1.0.0 — Build Report

Built 2026-11-17. Complete Electron app in `~/workspace/sahara-bakers-desktop/`.
No GitHub push, no tag/release, no change to the web artifact or to
`~/workspace/rara-pos-desktop/` (read-only reference).

## Files created

| File | Purpose |
|---|---|
| `package.json` | Identity: `sahara-bakers` 1.0.0, appId `com.sahara.bakers`, productName "Sahara Bakers", NSIS (oneClick false, allowToChangeInstallationDirectory true, Desktop + Start Menu shortcuts, shortcutName "Sahara Bakers", NO deleteAppDataOnUninstall). No `electron-updater` dep. |
| `package-lock.json` | Pinned deps (Electron 38.8.6, electron-builder 26). |
| `main.js` | Window (1280×800, `build/icon.png`), `SAHARA_DATA_DIR` env, printer-list + print-receipt IPC (80mm measured-height), backupOnClose with the empty/corrupt guard. NO updater code. |
| `index.html` | Shell: PIN login screen (Sahara logo, ⋮ menu), confirm dialog, item-form modal, bill-preview modal, app shell (header/sidebar/screen), hidden 80mm receipt print area. Script order: ui, dashboard, items, stock, branches, transfer-bill, purchases, logins, settings. |
| `styles.css` | Black & white theme (light default, dark = inverted), base font 17.5px, bill 15px, 5s notices, 80mm bill + print CSS. System fonts only, no CDN. |
| `src/db.js` | Database + RARA v1.1.9 hardening (see below). |
| `src/seed.json` | First-run seed: 44 items, 3 branches, Owner Rahmanullah (PIN 3333 hashed). Generated from `seed-export.json` — nothing invented. |
| `src/ui.js` | App core: nav, PIN login + lockout, session timeout, notices (5s + countdown line), theme, bill preview + measured-height print, confirm dialog. |
| `src/dashboard.js` | Summary panel ONLY here (Kul Items, Stock Value, Aaj Aaya, Aaj Gaya, Kam Stock + banner). |
| `src/items.js` | Raw Materials (28) / Finished Goods (16), "Search Item", whole-card click → Stock In sheet, exactly ONE button per card ("Edit Item" / "History"). |
| `src/stock.js` | Stock In/Out (Item + Miqdaar + Save, pre-save preview, post-save confirmation + low-stock note) and Stock levels page (warehouse + each branch, low-stock bold rows + notice line). |
| `src/branches.js` | Branch list + edit; Branch Transfer form (warehouse → branch, multi-item staging); Transfer History per branch with re-print. |
| `src/transfer-bill.js` | 80mm thermal bill HTML (logo, SB-0001…, date/time, From → To, Sent By, lines, TOTAL VALUE), preview + print via ui.js. |
| `src/purchases.js` | Unique invoice no (duplicates rejected), supplier, lines, auto stock-in. |
| `src/logins.js` | Details only (Naam, Username, Role, Branch), Change PIN, create-login (PIN 4–8 digits). |
| `src/settings.js` | Business settings, Notifications — Low Stock card, Backup & Restore (Backup Now / Restore Latest / Export / Import JSON), printer choice, theme, version 1.0.0. No Updates card. |
| `src/receipt-logo.js` | Sahara circular logo as a base64 data URL (240px, resized only) for offline bill printing. |
| `assets/sahara-logo.png` | Circular Sahara logo (copy of `~/workspace/sahara_bakers/Sahara-Bakers-Logo-Circle.png`, unmodified) for login/header. |
| `assets/products/` | Empty at build time — see Photo check below. |
| `build/icon.png` | 512×512, resized ONLY with Pillow. Verified mean abs diff 0.0 vs source. |
| `build/icon.ico` | 256/128/64/48/32/16, resized ONLY with Pillow. |
| `README.md` / `INSTALL.md` | App overview + Windows install steps (PIN 3333, change PIN, Start Menu, delete Setup file, backup-restore note). |
| `ARCHITECTURE.md` / `seed-export.json` | Input briefs (pre-existing, not created by this build). |
| `BUILD-REPORT.md` | This file. |

## Key decisions

- **PIN scheme (overrides password-free web entry, desktop only):** app
  opens to a RARA-style PIN login screen. Owner Rahmanullah's entry PIN is
  **3333**, seeded as `pinHash = sha256('3333:sahara-bakers-salt')`
  = `3aff3fa99ef649345f1540a796bac5e4bcab4ba465ca703df90bf534afca884e`
  (Node `crypto`, same helper pattern as RARA, Sahara salt suffix). The
  web app's `pinHashWeb` value from `seed-export.json` was NOT used (different
  scheme, preserved for reference only in the export file). The web app stays
  password-free; only the desktop app asks for a PIN.
- **Lockout:** 5 wrong PINs = 15-minute lockout, persisted per user in
  `state.loginSecurity` (survives app restart). Wrong PIN → top notice
  "Issue — PIN ghalat hai". 5th wrong PIN → "Issue — 5 ghalat PIN — ye login
  15 minute ke liye lock ho gaya hai". Lock notice states remaining minutes.
- **PIN validation:** 4–8 digits everywhere (login input maxlength 8,
  create-login and Change PIN enforce `/^\d{4,8}$/` with notices).
- **Notices:** 5 seconds (not RARA's 9s), per the task. Success = black
  "Ho Gaya ✓" notice; issue = white notice with thick black border starting
  "Issue — …". Every notice has a countdown line draining over 5s, then
  auto-dismiss; × closes early.
- **Theme:** black & white, light default (white bg, black text/accents);
  dark mode = inverted. Base font 17.5px, bill 15px. No emoji in UI.
- **Sidebar order (exact):** Dashboard, Items, Dark Theme toggle, Logins,
  Settings, Branches, Stock In/Out, Stock, Purchases. The theme toggle is a
  sidebar action (not a screen). Production, Expiry, Wastage, Suppliers,
  Expenses, Employees, Reports are NOT built (no sidebar items, no screens;
  their tables are not in v1.0.0 scope). Suppliers exist only as a minimal
  table backing the Purchases supplier name (auto-created on purchase save);
  there is no Suppliers screen.
- **Branch model:** branch 1 ("sahara backers railway road") is the central
  godown/Warehouse. Transfers default From = branch 1, To = branch 2 or 3
  (any branch except From is selectable). Stock is per-branch
  (`branchStocks`); warehouse stock is branch 1's stock.
- **Transfer bill prices:** the item's CURRENT price. All 44 prices are
  null, so a line shows quantity + "price blank" and no invented amount;
  TOTAL VALUE carries a `*` + plain note when any line price is missing
  (same "never invent a price" pattern as RARA's cost-0/franchise-0 notes).
- **Purchases:** invoice number uniqueness enforced at the data layer
  (`DB.checkUniqueness('purchases')`) and in the form; auto stock-in goes
  to the chosen branch (default Warehouse).
- **Data safety (RARA v1.1.9 hardening, copied):** `sahara-bakers-data.json`
  in userData + `.bak` last-good copy; `backups/` timestamped, keep last 7;
  `DB.load()` auto-recovers from newest GOOD backup (products > 0, fallback
  logins > 0) on corrupt/empty file, sticky `recoveredFromBackup`/`loadError`
  flags; `restoreLatestBackup()` returns counts; one-click restore WITHOUT
  login from the login ⋮ menu; `backupOnClose()` never backs up an
  empty/corrupt file; `_saveRecovered()` never lets an empty/corrupt file
  overwrite `.bak`; fresh-seed migration flag `v100FreshSeedApplied`
  (fires when products == 0, replaces products/branches/history with seed
  but MERGES users — existing users win, never a second Owner).
- **No auto-update:** no `electron-updater` dep, no updater code in
  `main.js`, no `update-*` IPC, no Updates card. Delivery by manual
  installer download only.
- **Seed data:** exactly from `seed-export.json` (live web-app export
  2026-11-17): 44 items with exact names/units/categories/types and
  `desktopPhoto` paths `assets/products/<id>-<slug>.jpg`; all prices null;
  3 branches with exact names/addresses; 1 user (Rahmanullah, Owner);
  settings businessName "Sahara Bakers", currency PKR,
  lowStockNotifications true, defaultLowStockLimit null; all other tables
  empty. `syncFlags` from the export were not carried into the desktop seed
  (web-only bookkeeping).
- **Printing:** 80mm wide (pageSize width 80000 microns), measured-height
  via `printReceiptHtml` (+6mm cutter feed), fallback to the print dialog
  when no printer is set; 12s timeout rule (no double-print) copied from
  RARA.
- **Roles:** Owner (everything), Manager (dashboard/items/branches/
  stockio/stock/purchases), Warehouse Staff (dashboard/items/branches/
  stockio/stock), Branch (dashboard/items/stock, own branch only). Only
  Owner/Manager see "Edit Item"; others get the single "History" button.
  Logins + Settings are Owner-only.

## Photo-existence check — GAP: all 44 photos missing

Checked at end of build (2026-11-17 ~20:40 PST): `assets/products/` is
**empty — 0 of 44 files present**. Every expected file is missing:

12-ghee, 13-sugar, 14-eggs, 15-flour, 16-dry-fruit, 17-butter, 18-cheese,
19-sooji-semolina, 20-chocolate-syrup, 21-cocoa-powder, 22-egg-powder,
23-baking-powder, 24-baking-soda, 25-glucose, 26-cream, 27-cream-cheese,
28-oil, 29-cherry, 30-jelly, 31-dry-milk, 32-fresh-milk, 33-khoya,
34-copra, 35-plastic-bag, 36-cornflour, 37-custard, 38-kheer-mix,
39-angoori-grapes, 40-gulab-jamun, 41-rasgulla, 42-barfi,
43-sugarfree-patisa, 44-sugarfree-barfi, 45-sohan-halwa,
46-sugarfree-sohan-halwa, 47-chocolate-sohan-halwa, 48-rasmalai,
49-three-milky-cake, 50-fancy-biscuit, 51-sada-biscuit, 52-double-roti,
53-cake-rusk, 54-cake-piece, 55-bakery-cake (all `.jpg` under
`assets/products/`).

The parallel photo-sourcing agent had not delivered them when this build
finished (only research files exist under `/tmp/sahara-photos/`). The app
handles missing photos gracefully: a card whose image fails to load hides
the `<img>` and shows the item name in a placeholder box (verified in the
headless smoke test — 28 raw cards rendered with placeholders). No code
change is needed when the photos land; drop the 44 JPEGs into
`assets/products/` with the exact `<id>-<slug>.jpg` names and they will
show. Re-run the JPEG-decode check after delivery.

## Smoke-check results

- `node --check` on `main.js` + all 12 `src/*.js` files: **all pass**.
- `npm install` in `~/workspace/sahara-bakers-desktop/`: Electron **38.8.6**
  (same as RARA), electron-builder 26. Install clean.
- **Node DB smoke** (`/tmp/sahara-smoke/db-smoke.mjs`): **22/22 passed** —
  seed loads 44 products (28 raw / 16 finished), 3 branches with exact
  names, all prices null, all stock 0, Owner login seeded, PIN 3333
  verifies / wrong PIN fails / pinHash matches the Sahara scheme, setStock
  persists, 5 wrong PINs lock for 15 min and the lock persists across
  reload, expired lock auto-clears, `newestGoodBackup` skips an empty
  newest backup, corrupt main file recovers 44 products, empty state with
  flag set + no backup stays empty with a loadError, `restoreLatestBackup`
  returns counts (44 products, 1 login), transfer-bill null price produces
  no invented amount.
- **Headless Electron smoke** (Xvfb + real Electron 38.8.6 + CDP,
  `/tmp/sahara-smoke/electron-smoke.mjs`, fresh HOME): **26/26 passed,
  zero console errors** — login screen shows Rahmanullah; wrong PIN shows
  "Issue — PIN ghalat hai" error notice with countdown line; PIN 3333 logs
  in; sidebar order exact; Dashboard summary panel present; Items shows
  Raw Materials 28 cards, one "Edit Item" button per card, search
  placeholder "Search Item"; card click opens Stock In/Out; Settings shows
  version 1.0.0 + Low Stock card; Stock In preview ("Abhi godown mein: 0
  Liter — save ke baad kul 5 Liter") and save confirmation ("Ab kul stock:
  5"); transfer creates bill **SB-0001**, bill preview opens automatically,
  print button reads "Bill Print Karein (80mm Thermal)", bill shows To
  branch TEHZEEB CAFE; Logins shows details only.
- **Not yet done (for the tester subagent):** full Node + headless-Electron
  real-click suite (the smoke tests above used CDP `Runtime.evaluate`
  clicks, not real mouse events); physical thermal-printer print check on
  the user's machine; NSIS installer build (Windows-only, `npm run build`).

## Gaps / open items

1. **All 44 product photos missing** (see above) — pending the parallel
   photo agent. App works without them (name placeholders).
2. Physical 80mm thermal print not verified on a real printer (only the
   measured-height print path + preview, as in RARA).
3. No NSIS installer built (Linux host cannot build NSIS; Windows CI or a
   Windows machine must run `npm run build`). No GitHub repo/release
   created — deliberately out of scope for this task.
4. `Export Data JSON` writes to the user's Desktop via `fs` in the
   renderer; falls back to a blob download if that fails.
