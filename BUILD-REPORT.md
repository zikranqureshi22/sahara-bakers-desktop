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
- **Branch model (v2.0.0 — changed 2026-11-19, was v1.0.0 "branch 1 is the
  godown"):** the Warehouse/Godown is a REAL separate location
  (`DB.WAREHOUSE_ID = 'warehouse'`, `DB.WAREHOUSE_NAME = 'Warehouse'`),
  NOT a branch. The 3 branches are Branch 1, Branch 2, Branch 3, each a
  real branch. Stock is per-location (`branchStocks`, with a `warehouse`
  row per product). Transfers are ALWAYS Warehouse → branch: the form's
  From is a fixed "Warehouse (Godown)" line (no select, no branch-to-branch
  transfer possible) and To lists all 3 branches. The SB transfer bill's
  From line reads "Warehouse", never "Branch 1". **v1.0.0 migration**
  (`settings.v201WarehouseMigrated`, one-time, flag-guarded): on first load
  of a v1.0.0 data file, each product's branch-1 stock moves into the
  warehouse row (added to any existing warehouse qty, never duplicated),
  the branch-1 row is removed, and stock movements / transfers / purchases
  with branchId 1 are re-pointed to `'warehouse'`; totals never change.
  Fresh seed (`src/seed.json`) gives every product a `{branchId:
  'warehouse', qty: 0}` row and sets the flag true.
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

## v2.0.0 changes (2026-11-19) — Warehouse as a real location

Fixes the v2.0.0 verification blocker (item 7): the Warehouse/Godown is
now a real location separate from the 3 branches — see the updated
"Branch model" bullet above. What changed, file by file:

- `src/db.js` — `DB.WAREHOUSE_ID = 'warehouse'`; `completeProduction()`
  defaults to the Warehouse; one-time `v201WarehouseMigrated` migration
  (branch-1 stock → warehouse stock, no loss, no duplication).
- `src/ui.js` — `warehouseBranchId()` returns the warehouse id;
  `branchName('warehouse')` = `'Warehouse'`.
- `src/transfer.js` — source LOCKED to Warehouse (fixed static line, no
  From select); To lists all 3 branches.
- `src/transfer-bill.js` — SB bill From line reads "Warehouse".
- `src/warehouse.js`, `src/dashboard.js`, `src/branches.js`, `src/stock.js`,
  `src/purchases.js`, `src/raw.js` — Warehouse shown as its own location
  (Stock page renders a Warehouse card first; Stock In/Out and Purchases
  default to Warehouse); all "Branch 1 = godown" wording removed.
- `src/seed.json` — all 44 products have a warehouse stock row (qty 0,
  matching the live backup, which held no stock); no branch-1 rows;
  `settings.v201WarehouseMigrated: true`.

Logins (Owner Rahmanullah PIN 1234, Manager PIN 123), white theme,
splash/login flow and all other verified behaviour unchanged. Version
stays 2.0.0 (unreleased). Re-verified 2026-11-19: Node DB 45/45 (incl. new
W1–W6 warehouse cases), recovery-fix 8/8, headless Electron 29/29 (incl.
new E11a form-lock + E11b transfer-to-Branch-1), fix-recovery 6/6 — zero
console errors. Evidence:
`~/workspace/sahara-bakers-desktop-test-evidence/` (`db-test.log`,
`electron-final-run.log`, `11-transfer-to-branch1.png`).

## SmartPOS theme + Professional & Bilingual (2026-11-19, v2.0.0 unreleased)

SmartPOS look (user-supplied screenshot): off-white page + big red curved
shape behind the white rounded app card; left sidebar with the Sahara logo
and "SAHARA BAKERS"; active nav item = yellow pill (#ffc107); breadcrumb +
pill search top-right; big bold headings; product cards in a grid (photo,
bold name, gray unit line, price in bold yellow; no price -> stock shown,
never invented). Login-selection screen: ONLY two buttons — Owner and
Manager — in elegant Georgia serif, nothing else on the screen (logo, menu
and all other text hidden in select-mode; they return on the PIN page).

Professional & bilingual (user brief, same day):
- Main screens no longer show "Edit Item" / stock correction: the Products
  cards have NO Edit/Delete buttons and the Raw/Finish rows have NO Edit
  button. Clicking a card/row opens the product's OWN detail/manage screen
  (`App.showProductDetail` in `src/ui.js`): photo, prices, details, stock
  per location (Warehouse + Branch 1/2/3 + Total), production history
  (finish items), stock history, and — editors only — Edit, Delete and
  Close. Stock correction stays inside the Edit form (the manage screen),
  never on a listing. The dead `src/items.js` screen is untouched.
- "+ New Product" button (was "+ Product Add Karein"); "+ New Raw Item",
  "+ New Finish Item" likewise.
- Bilingual everywhere on the main surface: main headings/buttons in
  English, Roman Urdu supporting/sub-text alongside — nav items carry a
  small Roman Urdu sub-label (Dashboard "Aaj ka hisaab", Products "Sab
  items", Raw Material "Kacha maal", Production "Tayyar karna", Finish
  Goods "Tayyar cheezein", Warehouse "Godown", Stock Transfer "Branch ko
  bhejo", Branches "Teeno branches", Billing "Bill aur invoices", Stock
  In/Out "Maal aaya / gaya", Stock "Stock dekho", Reports "Hisaab report",
  Purchases "Kharidari", Logins "Login details", Settings "Settings");
  every screen shows a Roman Urdu line under the breadcrumb; Dashboard
  stat labels are English ("Total Items", "Received Today", "Sent Today",
  "Low Stock") with Roman Urdu subs; Dashboard shows 3 big daily-jobs
  buttons — Stock In / Maal godown mein aaya, Transfer to Branch / Maal
  branch ko bhejo, View Stock / Godown aur branch stock dekho — and
  bilingual quick-action buttons; main action buttons are English
  (Save, Close, Login, Transfer & View Bill, Complete Production & View
  Bill, Print Bill, Save PDF, Restore from Backup, Logout, Change PIN).
- No feature or data deleted: 44 items, Branch 1/2/3, Manager PIN 123 /
  Owner PIN 1234, production cart + PB bills, transfers + SB bills,
  history, search/filter, backup all unchanged. Separate-warehouse model
  (`DB.WAREHOUSE_ID = 'warehouse'`, transfers locked to Warehouse, bill
  From = "Warehouse") and all data-loss hardening untouched.

Changed files (16): `index.html`, `styles.css`, `src/ui.js`,
`src/dashboard.js`, `src/products.js`, `src/raw.js`, `src/finished.js`,
`src/stock.js`, `src/transfer.js`, `src/production.js`, `src/warehouse.js`,
`src/branches.js`, `src/settings.js`, `src/purchases.js`, `src/logins.js`,
`src/transfer-bill.js`. Binaries unchanged (44 photos, logo, icons).

Re-verified 2026-11-19 from scratch: Node DB 45/45, recovery-fix 8/8,
fix-recovery 6/6 (one stale label assert updated: "Kul Items" ->
"Total Items"), headless Electron 33/33 REAL clicks — zero console
errors. New checks: E1 (only two login buttons, Georgia serif, no
logo/menu), E6 (44 cards, "+ New Product", 0 Edit/Delete on the
listing), E7b1 (detail screen opens on card click, Edit + Delete
inside), E8b1 (Raw rows: 0 Edit, 28 Details), E16/E16b (yellow active
pill rgb(255,193,7), nav sub-labels, breadcrumb sub-lines, 3 daily
jobs, bilingual quick actions, yellow price rgb(184,134,11), pill
search 999px). Fresh screenshots: `01-login-cards.png`,
`03-dashboard-owner.png`, `04-products.png`, `12-product-detail.png`.
Evidence: `~/workspace/sahara-bakers-desktop-test-evidence/`.
