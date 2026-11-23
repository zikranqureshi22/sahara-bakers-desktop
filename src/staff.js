/* Sahara Bakers — Manage Staff (v2.1.0).
 * POS staff only: Cashier / Rider / Road Side Waiter / Waiter.
 * Staff are NOT logins (PIN logins live in logins.js) — a staff row is
 * just a name the cashier picker, bills and reports use. Godown
 * Employees are a DIFFERENT, deferred thing — not built here.
 *
 * Frozen DB contract (src/db.js, api-freeze.md §4.6):
 *   DB.addStaff({name, role, phone, nic, clientRef})
 *   DB.deactivateStaff(staffId)          — soft remove (active = 0)
 *   DB.markAttendance({staffId, day, status, recordedBy})
 * There is NO DB.updateStaff in the freeze, so Edit below mutates the
 * row in place with the same validation addStaff applies (name
 * required, role must be one of the four) — the same in-place pattern
 * products.js uses for item edits. If Worker A adds DB.updateStaff,
 * swap the edit save to it.
 * There is NO staff photo store on desktop (imageBlobKey stays null) —
 * web photos live in blobs; desktop has no blob store. Photo UI is
 * deliberately not built.
 *
 * History rule: deleting (deactivating) a staff member NEVER rewrites
 * history — past sales keep their stamped cashierName (DB.createSale
 * stamps it at sale time) and closings keep theirs. Deactivate only
 * sets active = 0, so the name drops out of the pickers.
 *
 * Contract for pos.js (Worker B): window.Screens.Staff.cashierOptions()
 * returns [{id, name}] of ACTIVE staff with role 'Cashier', for the
 * cashier picker (Start Shift / sale screen).
 * Wrapped in an IIFE.
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
function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const STAFF_ROLES = ['Cashier', 'Rider', 'Road Side Waiter', 'Waiter'];

function todayLocal() {
  try { if (DB._todayLocal) return DB._todayLocal(); } catch (e) { /* fall through */ }
  return new Date().toISOString().slice(0, 10);
}

function activeStaff() {
  return (S().staff || []).filter((s) => s.active !== 0 && s.active !== false);
}
function staffById(id) {
  return (S().staff || []).find((s) => String(s.id) === String(id));
}
function attendanceFor(day) {
  const map = {};
  (S().staffAttendance || []).forEach((r) => {
    if (r.day === day) map[String(r.staffId)] = r.status;
  });
  return map;
}

/* ----- Contract for Worker B (pos.js cashier picker) ----- */
function cashierOptions() {
  return activeStaff()
    .filter((s) => s.role === 'Cashier')
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((s) => ({ id: s.id, name: s.name }));
}

function renderStaff(container) {
  container.innerHTML = '';
  const st = S();
  const canManage = window.App.canEditItems(); // Owner / Manager only
  let currentDay = todayLocal();

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Manage Staff</h1>' +
    (canManage ? '<button type="button" class="btn btn-primary" id="add-staff-btn">+ New Staff</button>' : '') + '</div>'));
  wrap.appendChild(el('<p class="muted">Counter staff — Cashier, Rider, Road Side Waiter, Waiter. Ye logins nahi hain; cashier Start Shift par yahin se chuna jata hai. Staff hatane se purani sale/bill ki history nahi badalti — naam sirf picker se hat jata hai.</p>'));

  // ---- Attendance (aaj ka din, koi bhi logged-in user mark kar sakta hai) ----
  const attCard = el('<div class="card"><h2>Attendance — Haazri</h2></div>');
  const dayRow = el('<div class="pos-search-row"><label style="align-self:center"><b>Din</b></label>' +
    '<input id="staff-att-day" class="input" type="date" value="' + esc(currentDay) + '" style="max-width:200px">' +
    '<span class="muted" id="staff-att-count"></span></div>');
  attCard.appendChild(dayRow);
  const attWrap = el('<div id="staff-att-wrap"></div>');
  attCard.appendChild(attWrap);
  wrap.appendChild(attCard);

  // ---- Staff list ----
  const listCard = el('<div class="card"><h2>Staff List</h2></div>');
  const listWrap = el('<div id="staff-list-wrap"></div>');
  listCard.appendChild(listWrap);
  wrap.appendChild(listCard);

  function drawAttendance() {
    const marks = attendanceFor(currentDay);
    const list = activeStaff();
    const present = list.filter((s) => marks[String(s.id)] === 'present').length;
    const absent = list.filter((s) => marks[String(s.id)] === 'absent').length;
    const countEl = dayRow.querySelector('#staff-att-count');
    if (countEl) countEl.textContent = list.length + ' active staff — ' + present + ' present, ' + absent + ' absent (' + currentDay + ')';
    attWrap.innerHTML = '';
    if (list.length === 0) {
      attWrap.appendChild(el('<p class="muted">Abhi koi staff nahi — neeche se add karein.</p>'));
      return;
    }
    const rows = list.map((s) => {
      const mark = marks[String(s.id)];
      const badge = mark === 'present'
        ? '<span class="att-badge att-present">Present</span>'
        : mark === 'absent' ? '<span class="att-badge att-absent">Absent</span>' : '<span class="muted">—</span>';
      return '<tr><td><b>' + esc(s.name) + '</b><br><span class="muted">' + esc(s.role) + '</span></td>' +
        '<td>' + badge + '</td>' +
        '<td><button type="button" class="btn btn-sm att-mark" data-id="' + esc(s.id) + '" data-status="present">Present</button> ' +
        '<button type="button" class="btn btn-sm att-mark" data-id="' + esc(s.id) + '" data-status="absent">Absent</button></td></tr>';
    }).join('');
    attWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Haazri — ' + esc(currentDay) + '</th><th>Mark Karein</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    attWrap.querySelectorAll('.att-mark').forEach((b) => b.addEventListener('click', () => {
      const member = staffById(b.getAttribute('data-id'));
      if (!member) return;
      const status = b.getAttribute('data-status');
      const res = DB.markAttendance ? DB.markAttendance({
        staffId: member.id, day: currentDay, status,
        recordedBy: window.App.user ? window.App.user.name : '',
      }) : { ok: false, message: 'Attendance available nahi hai' };
      if (!res.ok) { notify('Issue — ' + (res.message || 'Attendance mark nahi ho saki'), 'error'); return; }
      window.App.save();
      // Re-marking the same day UPDATES the same row (DB.markAttendance
      // returns updated:true) — never a duplicate row.
      notify('Ho Gaya ✓ — ' + member.name + ' (' + currentDay + '): ' + (status === 'present' ? 'Present' : 'Absent') + (res.updated ? ' — pehle wala mark update ho gaya' : ''), 'success');
      drawAttendance();
    }));
  }

  function drawList() {
    const list = (S().staff || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
    const active = list.filter((s) => s.active !== 0 && s.active !== false);
    const removed = list.filter((s) => s.active === 0 || s.active === false);
    listWrap.innerHTML = '';
    if (active.length === 0) {
      listWrap.appendChild(el('<p class="muted">Abhi koi staff nahi — upar "+ New Staff" se pehla staff add karein.</p>'));
    } else {
      const rows = active.map((s) => {
        const sCode = 'S' + s.id;
        return '<tr><td><b>' + esc(sCode) + ' — ' + esc(s.name) + '</b></td>' +
          '<td>' + esc(s.role) + '</td>' +
          '<td>' + esc(s.phone || '—') + '</td>' +
          '<td>' + esc(s.nic || '—') + '</td>' +
          '<td>' + (canManage
            ? '<button type="button" class="btn btn-sm staff-edit" data-id="' + esc(s.id) + '">Edit</button> ' +
              '<button type="button" class="btn btn-sm btn-danger staff-remove" data-id="' + esc(s.id) + '">Remove</button>'
            : '<span class="muted">—</span>') + '</td></tr>';
      }).join('');
      listWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Naam</th><th>Role</th><th>Phone</th><th>NIC</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
      listWrap.querySelectorAll('.staff-edit').forEach((b) => b.addEventListener('click', () => openStaffForm(staffById(b.getAttribute('data-id')))));
      listWrap.querySelectorAll('.staff-remove').forEach((b) => b.addEventListener('click', async () => {
        const member = staffById(b.getAttribute('data-id'));
        if (!member) return;
        const ok = await window.App.confirmDialog('Staff Remove Karein?',
          '"' + (member.name || '') + '" picker se hat jayega (soft remove). Purani sales aur bills par us ka naam waisa hi rahega — history nahi badlegi.');
        if (!ok) return;
        const res = DB.deactivateStaff ? DB.deactivateStaff(member.id) : { ok: false, message: 'Remove available nahi hai' };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Staff remove nahi ho saka'), 'error'); return; }
        window.App.save();
        notify('Ho Gaya ✓ — ' + member.name + ' remove ho gaya (history waisi hi rahegi)', 'success');
        drawAttendance();
        drawList();
      }));
    }
    if (removed.length > 0) {
      const rows = removed.map((s) => '<tr><td><b>S' + esc(s.id) + ' — ' + esc(s.name) + '</b></td><td>' + esc(s.role) + '</td><td><span class="muted">Removed — purani history mein naam waisa hi hai</span></td></tr>').join('');
      listWrap.appendChild(el('<h3 style="margin-top:14px">Removed Staff</h3>'));
      listWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Naam</th><th>Role</th><th>Note</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
    }
  }

  function openStaffForm(member) {
    const isNew = !member;
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    titleEl.textContent = isNew ? 'New Staff' : 'Edit Staff — ' + (member.name || '');
    bodyEl.innerHTML = '';
    const form = el('<form></form>');
    const nameIn = el('<input id="sf-name" class="input" type="text" required maxlength="80" value="' + esc(member ? (member.name || '') : '') + '" placeholder="Staff ka naam">');
    const roleSel = el('<select id="sf-role" class="input">' + STAFF_ROLES.map((r) =>
      '<option value="' + esc(r) + '"' + (member && member.role === r ? ' selected' : (!member && r === 'Cashier' ? ' selected' : '')) + '>' + esc(r) + '</option>'
    ).join('') + '</select>');
    const phoneIn = el('<input id="sf-phone" class="input" type="text" maxlength="30" value="' + esc(member ? (member.phone || '') : '') + '" placeholder="Phone (optional)">');
    const nicIn = el('<input id="sf-nic" class="input" type="text" maxlength="30" value="' + esc(member ? (member.nic || '') : '') + '" placeholder="NIC (optional)">');
    form.appendChild(el('<label>Name *</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Role</label>')); form.appendChild(roleSel);
    form.appendChild(el('<label>Phone</label>')); form.appendChild(phoneIn);
    form.appendChild(el('<label>NIC (optional)</label>')); form.appendChild(nicIn);
    form.appendChild(el('<p class="muted">Staff logins nahi hain — ye sirf cashier picker, bill aur report ke liye naam hai. Photo desktop par nahi rakhi jati.</p>'));
    const row = el('<div class="form-actions"></div>');
    row.appendChild(el('<button type="submit" class="btn btn-primary">Save</button>'));
    row.appendChild(el('<button type="button" class="btn" id="sf-cancel">Cancel</button>'));
    form.appendChild(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      const role = roleSel.value;
      const phone = phoneIn.value.trim();
      const nic = nicIn.value.trim() || null;
      if (!name) { notify('Issue — Staff ka naam zaroori hai', 'error'); return; }
      if (STAFF_ROLES.indexOf(role) === -1) { notify('Issue — Staff role durust chunein (Cashier / Rider / Road Side Waiter / Waiter)', 'error'); return; }
      if (isNew) {
        const res = DB.addStaff ? DB.addStaff({ name, role, phone, nic, clientRef: uid('staff') }) : { ok: false, message: 'Staff add available nahi hai' };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Staff add nahi ho saka'), 'error'); return; }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Staff add ho gaya: ' + name + (role === 'Cashier' ? ' — ab cashier picker mein aayega' : ''), 'success');
      } else {
        // No DB.updateStaff in the freeze: validated in-place edit
        // (same pattern as products.js item edits).
        member.name = name;
        member.role = role;
        member.phone = phone;
        member.nic = nic;
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Staff update ho gaya: ' + name, 'success');
      }
      drawAttendance();
      drawList();
    });
    row.querySelector('#sf-cancel').addEventListener('click', closeForm);
    bodyEl.appendChild(form);
    overlay.hidden = false;
    overlay.style.display = 'flex';
    nameIn.focus();
  }
  function closeForm() {
    const overlay = document.getElementById('item-form-overlay');
    if (overlay) { overlay.hidden = true; overlay.style.display = 'none'; }
  }

  dayRow.querySelector('#staff-att-day').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { notify('Issue — Din durust likhein (YYYY-MM-DD)', 'error'); e.target.value = currentDay; return; }
    currentDay = v;
    drawAttendance();
  });
  const addBtn = wrap.querySelector('#add-staff-btn');
  if (addBtn) addBtn.addEventListener('click', () => openStaffForm(null));
  const closeBtn = document.getElementById('item-form-x');
  if (closeBtn) closeBtn.onclick = closeForm;

  drawAttendance();
  drawList();
  container.appendChild(wrap);
}

/* The render function IS the module object: go('staff') calls it as a
 * function, pos.js calls .cashierOptions() on it. Both spellings point
 * at the same function so Worker I can wire either route id. */
renderStaff.cashierOptions = cashierOptions;
renderStaff.activeStaff = activeStaff;
renderStaff.roles = STAFF_ROLES;
window.Screens.staff = renderStaff;
window.Screens.Staff = renderStaff;
})();
