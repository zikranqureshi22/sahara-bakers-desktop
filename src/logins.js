/* Sahara Bakers — Logins (v1.0.0).
 * Details only (Naam, Username, Role, Branch) — no badges or inline
 * edit forms. Change PIN button (with a wrong-current-PIN notice) and
 * a create-login form (Naam, Username, PIN, Role, Branch) with PIN
 * validation (4–8 digits, notice on invalid). Wrapped in an IIFE.
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

const ROLES = ['Owner', 'Manager', 'Warehouse Staff', 'Branch'];

function renderLogins(container) {
  container.innerHTML = '';
  const st = S();
  const users = st.appUsers || [];
  const branches = st.branches || [];

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Logins</h1></div>'));

  // ---- Login details only ----
  const listCard = el('<div class="card"><h2>Login Details</h2></div>');
  if (users.length === 0) listCard.appendChild(el('<p class="muted">Koi login nahi hai.</p>'));
  else {
    const rows = users.map((u) => {
      const branch = u.branchId != null ? window.App.branchName(u.branchId) : 'Sab Branches';
      return '<tr><td><b>' + esc(u.name || '') + '</b></td><td>' + esc(u.username || '') + '</td><td>' + esc(u.role || '') + '</td><td>' + esc(branch) + '</td><td><button type="button" class="btn btn-sm" data-pin="' + esc(u.id) + '">Change PIN</button></td></tr>';
    }).join('');
    listCard.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Naam</th><th>Username</th><th>Role</th><th>Branch</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }
  wrap.appendChild(listCard);

  listCard.querySelectorAll('button[data-pin]').forEach((btn) => btn.addEventListener('click', () => {
    const u = users.find((x) => String(x.id) === String(btn.getAttribute('data-pin')));
    if (!u) return;
    openChangePin(u);
  }));

  function openChangePin(u) {
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = 'Change PIN — ' + (u.name || '');
    bodyEl.innerHTML = '';
    const form = el('<form></form>');
    const curIn = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="Maujooda PIN">');
    const newIn = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="Naya PIN (4–8 digit)">');
    const new2In = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="Naya PIN dobara likhein">');
    form.appendChild(el('<label>Maujooda PIN</label>')); form.appendChild(curIn);
    form.appendChild(el('<label>Naya PIN (4–8 digit)</label>')); form.appendChild(newIn);
    form.appendChild(el('<label>Naya PIN Confirm Karein</label>')); form.appendChild(new2In);
    const row = el('<div class="form-actions"><button type="submit" class="btn btn-primary">PIN Change Karein</button><button type="button" class="btn" id="pin-cancel">Cancel</button></div>');
    form.appendChild(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const cur = curIn.value.trim();
      const np = newIn.value.trim();
      const np2 = new2In.value.trim();
      // A non-Owner changing someone else's PIN must still know the
      // current PIN; the Owner changing his own PIN also proves it.
      let ok = false;
      try { ok = DB.checkPin ? DB.checkPin(u, cur) : false; } catch (e) { ok = false; }
      if (!ok) { notify('Issue — Maujooda PIN ghalat hai', 'error'); return; }
      if (!/^\d{4,8}$/.test(np)) { notify('Issue — PIN 4 se 8 number ka hona chahiye', 'error'); return; }
      if (np !== np2) { notify('Issue — Dono naye PIN match nahi karte', 'error'); return; }
      u.pinHash = DB.hashPin(np);
      window.App.save();
      overlay.hidden = true; overlay.style.display = 'none';
      notify('Ho Gaya ✓ — PIN change ho gaya: ' + u.name, 'success');
    });
    row.querySelector('#pin-cancel').addEventListener('click', () => { overlay.hidden = true; overlay.style.display = 'none'; });
    bodyEl.appendChild(form);
    overlay.hidden = false;
    overlay.style.display = 'flex';
    curIn.focus();
  }

  // ---- Create login ----
  const createCard = el('<div class="card"><h2>Naya Login Banayein</h2></div>');
  const form = el('<form></form>');
  const nameIn = el('<input class="input" type="text" required placeholder="Naam (jaise Ahmed)">');
  const userIn = el('<input class="input" type="text" required placeholder="Username (jaise ahmed)">');
  const pinIn = el('<input class="input pin-input" type="password" inputmode="numeric" maxlength="8" required placeholder="PIN (4–8 digit)">');
  const roleSel = el('<select class="input">' + ROLES.map((r) => '<option value="' + r + '"' + (r === 'Warehouse Staff' ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>');
  const branchSel = el('<select class="input"><option value="">Sab Branches (Owner / Manager)</option>' + branches.map((b) =>
    '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'
  ).join('') + '</select>');
  form.appendChild(el('<label>Naam</label>')); form.appendChild(nameIn);
  form.appendChild(el('<label>Username</label>')); form.appendChild(userIn);
  form.appendChild(el('<label>PIN (4–8 digit)</label>')); form.appendChild(pinIn);
  form.appendChild(el('<label>Role</label>')); form.appendChild(roleSel);
  form.appendChild(el('<label>Branch</label>')); form.appendChild(branchSel);
  form.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Login Banayein</button></div>'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    const username = userIn.value.trim();
    const pin = pinIn.value.trim();
    const role = roleSel.value;
    if (!name || !username) { notify('Issue — Naam aur username zaroori hain', 'error'); return; }
    if (!/^\d{4,8}$/.test(pin)) { notify('Issue — PIN 4 se 8 number ka hona chahiye', 'error'); return; }
    if (DB.checkUniqueness) {
      const chk = DB.checkUniqueness('appUsers', { username }, null);
      if (!chk.ok) { notify('Issue — ' + chk.message, 'error'); return; }
    }
    if (role === 'Owner' && users.some((u) => u.role === 'Owner')) {
      notify('Issue — Owner pehle se mojood hai — sirf aik Owner ho sakta hai', 'error');
      return;
    }
    const branchId = branchSel.value === '' ? null : window.App.normBranchId(branchSel.value);
    const nu = {
      id: DB.nextId('appUsers'),
      name, username,
      pinHash: DB.hashPin(pin),
      role, branchId,
      branchName: branchId != null ? window.App.branchName(branchId) : null,
      isActive: true,
    };
    S().appUsers.push(nu);
    window.App.save();
    notify('Ho Gaya ✓ — Login ban gaya: ' + name + ' (' + role + ')', 'success');
    renderLogins(container);
  });
  createCard.appendChild(form);
  wrap.appendChild(createCard);

  container.appendChild(wrap);
}

window.Screens.logins = renderLogins;
})();
