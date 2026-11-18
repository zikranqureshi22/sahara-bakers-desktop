# Sahara Bakers — Desktop App (v1.0.0)

Godown stock system for Sahara Bakers (bakery business, separate from RARA
perfumes). A central **Warehouse (godown)** supplies 3 branches. Stock in/out
only — no sale/billing.

## What it does

- **PIN login** — the app opens to a PIN screen (Sahara logo on top, PIN
  field only). Owner **Rahmanullah** logs in with PIN **3333** (change it in
  Logins > Change PIN). 5 wrong PINs = 15-minute lockout, persisted per user.
- **Sidebar** (exact order): Dashboard, Items, Dark Theme toggle, Logins,
  Settings, Branches, Stock In/Out, Stock, Purchases.
- **Dashboard** — the summary panel lives ONLY here: Kul Items, Stock Value,
  Aaj Aaya, Aaj Gaya, Kam Stock count + alerts banner.
- **Items** — 2 categories: Raw Materials (28) / Finished Goods (16).
  Search bar ("Search Item"). A whole card click opens that item's Stock In
  sheet. Exactly one English button per card: "Edit Item" (or "History" for
  logins that cannot edit).
- **Stock In/Out** — simple form: Item + Miqdaar + Save. Pre-save preview
  ("Abhi godown mein: X — save ke baad kul Y") and a clear confirmation
  after saving, with a low-stock inline note when the item falls below its
  limit.
- **Branches** — branch list + edit (name, address, contact, manager);
  Branch Transfer form (warehouse → branch, multi-item staging) with an
  **80mm thermal bill** (Sahara circular logo, Bill No SB-0001…, date/time,
  From → To, Sent By, item lines, TOTAL VALUE, "Bill Print Karein (80mm
  Thermal)" button). Re-print from Transfer History rows.
- **Stock** — clean stock-levels page (warehouse + each branch) with
  low-stock rows (bold border + "Kam Stock" tag + notice line).
- **Purchases** — unique invoice number (duplicates rejected), supplier,
  lines, auto stock-in on save.
- **Logins** — details only (Naam, Username, Role, Branch), Change PIN,
  create-login (PIN 4–8 digits, validated).
- **Settings** — business settings, Notifications — Low Stock card (ON/OFF +
  Default Low Stock Limit; an item's own limit always wins), Backup &
  Restore (Backup Now, Restore Latest Backup, Export/Import JSON), printer
  choice, theme toggle, version 1.0.0.
- **Notices everywhere** — success = black "Ho Gaya ✓" notice, issue =
  white notice with a thick black border ("Issue — …"). Every notice has a
  5-second countdown line at its bottom and auto-dismisses after 5s; ×
  closes it early.
- **Theme** — black & white (white background, black text/accents; dark mode
  = inverted), big fonts (base 17.5px, bill 15px), simple and professional.

## Data safety (copied from RARA POS v1.1.9 hardening)

- Local JSON database in the app's userData folder
  (`%APPDATA%\com.sahara.bakers\sahara-bakers-data.json`) with a `.bak`
  last-good copy and a `backups/` folder (timestamped, keeps the last 7).
- `DB.load()` auto-recovers from the newest GOOD backup (products > 0,
  fallback logins > 0) when the data file is corrupt or empty, with sticky
  recovery flags. It never trusts the newest backup blindly.
- One-click restore WITHOUT login from the login screen ⋮ menu
  ("Backup se Data Wapas Layein").
- Backup on close NEVER backs up an empty or corrupt file.
- Fresh-seed migration (flag `v100FreshSeedApplied`): fires when
  products == 0, replaces products/branches with the seed but MERGES users
  (existing users win, never a second Owner).

## Seed data (v1.0.0)

44 items (28 Raw Materials, 16 Finished Goods) with exact names/units from
the live web-app export (`seed-export.json`, kept in the repo root for
reference). **All prices blank (null)** — the user enters them in-app.
3 branches: "sahara backers railway road" (the godown, branch 1),
"TEHZEEB CAFE", "Branch 3". 1 user: Rahmanullah (Owner, username
`rahmanullah`, PIN 3333, hashed sha256 `3333:sahara-bakers-salt`).
All other tables start empty.

## No auto-update in v1.0.0

Delivery is by manual installer download only. There is no
`electron-updater` dependency, no updater code in `main.js`, no `update-*`
IPC, and no Updates card in Settings.

## Develop / build

```bash
npm install
npm start            # run the app locally
npm run pack         # unpacked Windows build (dir)
npm run build        # NSIS installer (must run on Windows)
```

Release procedure: bump the version in `package.json`, tag `v*`, the
Windows workflow builds the NSIS installer and attaches it to a GitHub
Release. Deliver by the temporary-public-repo + PowerShell `curl` route
(see `INSTALL.md`).
