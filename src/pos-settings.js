/* Sahara Bakers — POS Settings Hub (v2.1.0).
 * One hub screen for the POS: POS settings (service charge flat Rs /
 * percent + bill copies), KOT settings (KOT print on/off, remarks
 * on/off), and links to the existing Branches / Products / Prices
 * screens (Prices lives on the Products screen — there is no
 * separate Prices screen). All writes go through the frozen
 * settings keys only (settings.posServiceCharge,
 * settings.posBillCopies, settings.kotEnabled, settings.kotRemarks)
 * via window.App.save(). No order-type-defaults setting exists in
 * the frozen API, so none is offered here — order types are picked
 * on the Sale screen at sale time. No cost or profit appears here.
 * Wrapped in an IIFE.
 *
 * Route: 'pos-settings' (Worker I wires the nav + script tag).
 * Exports: window.Screens['pos-settings'] = render (router) and
 * window.Screens.PosSettings = { render }.
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

function renderPosSettings(container) {
  container.innerHTML = '';
  const st = S();
  const settings = st.settings || {};
  // Frozen defaults (db.js load() fills these too — read defensively).
  const sc = settings.posServiceCharge || { type: 'flat', value: 0 };
  const billCopies = settings.posBillCopies != null ? settings.posBillCopies : 1;
  const kotEnabled = settings.kotEnabled !== false; // default on
  const kotRemarks = settings.kotRemarks !== false; // default on

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>POS Settings</h1></div>'));
  wrap.appendChild(el('<p class="muted">Sale screen ki settings — service charge, bill copies aur KOT. Ye settings agle sale se lagti hain.</p>'));

  // ---- POS settings ----
  const pCard = el('<div class="card"><h2>POS Settings</h2></div>');
  const pForm = el('<form></form>');
  const scTypeSel = el('<select class="input" id="ps-sc-type">' +
    '<option value="flat"' + (sc.type === 'percent' ? '' : ' selected') + '>Flat — Rs (har sale par aik raqam)</option>' +
    '<option value="percent"' + (sc.type === 'percent' ? ' selected' : '') + '>Percent — % (subtotal ka hissa)</option>' +
    '</select>');
  const scValIn = el('<input class="input" id="ps-sc-value" type="number" min="0" step="any" value="' + esc(sc.value != null ? sc.value : 0) + '" placeholder="Service charge value">');
  const copiesIn = el('<input class="input" id="ps-bill-copies" type="number" min="1" step="1" value="' + esc(billCopies) + '" placeholder="Bill copies">');
  pForm.appendChild(el('<label>Service Charge Type</label>')); pForm.appendChild(scTypeSel);
  pForm.appendChild(el('<label>Service Charge Value</label>')); pForm.appendChild(scValIn);
  pForm.appendChild(el('<p class="muted">Flat ho to har sale par yahi Rs lagte hain; Percent ho to subtotal ka utna % lagta hai. 0 ka matlab hai koi service charge nahi.</p>'));
  pForm.appendChild(el('<label>Bill Copies — Har sale par kitne bill print hon</label>')); pForm.appendChild(copiesIn);
  pForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save POS Settings</button></div>'));
  pForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const type = scTypeSel.value === 'percent' ? 'percent' : 'flat';
    const value = Number(scValIn.value);
    const copies = Number(copiesIn.value);
    if (isNaN(value) || value < 0) { notify('Issue — Service charge ki value durust likhein (0 ya zyada)', 'error'); return; }
    if (type === 'percent' && value > 100) { notify('Issue — Service charge percent 100 se zyada nahi ho sakta', 'error'); return; }
    if (!copies || copies < 1 || !Number.isInteger(copies)) { notify('Issue — Bill copies kam az kam 1 honi chahiye', 'error'); return; }
    settings.posServiceCharge = { type, value };
    settings.posBillCopies = copies;
    window.App.save();
    notify('Ho Gaya ✓ — POS settings save ho gayi', 'success');
    renderPosSettings(container);
  });
  pCard.appendChild(pForm);
  wrap.appendChild(pCard);

  // ---- KOT settings ----
  const kCard = el('<div class="card"><h2>KOT Settings — Kitchen Order Ticket</h2></div>');
  const kForm = el('<form></form>');
  const kotOn = el('<label style="display:flex;align-items:center;gap:10px;font-weight:600"><input type="checkbox" id="ps-kot-on"' + (kotEnabled ? ' checked' : '') + '> KOT Print ON karein</label>');
  const kotRem = el('<label style="display:flex;align-items:center;gap:10px;font-weight:600"><input type="checkbox" id="ps-kot-remarks"' + (kotRemarks ? ' checked' : '') + '> KOT par Remarks dikhayein</label>');
  kForm.appendChild(kotOn);
  kForm.appendChild(kotRem);
  kForm.appendChild(el('<p class="muted">KOT print band ho to sale ke baad KOT nahi chhapega — sirf notice aayega. Remarks band hon to sale ka note KOT par nahi aata. KOT par kabhi price nahi aati — sirf kitchen ticket hota hai.</p>'));
  kForm.appendChild(el('<div class="form-actions"><button type="submit" class="btn btn-primary">Save KOT Settings</button></div>'));
  kForm.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.kotEnabled = !!kForm.querySelector('#ps-kot-on').checked;
    settings.kotRemarks = !!kForm.querySelector('#ps-kot-remarks').checked;
    window.App.save();
    notify('Ho Gaya ✓ — KOT settings save ho gayi', 'success');
    renderPosSettings(container);
  });
  kCard.appendChild(kForm);
  wrap.appendChild(kCard);

  // ---- Links to existing screens ----
  const lCard = el('<div class="card"><h2>Links — Branches, Products, Prices</h2></div>');
  lCard.appendChild(el('<p class="muted">Ye screens pehle se hain — yahan se seedha khol lein.</p>'));
  const linkRow = el('<div class="btn-row">' +
    '<button type="button" class="btn btn-primary btn-bilingual" id="ps-go-branches">Branches<span class="btn-sub">Teeno branches</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="ps-go-products">Products<span class="btn-sub">Sab items</span></button>' +
    '<button type="button" class="btn btn-bilingual" id="ps-go-prices">Prices<span class="btn-sub">Products screen par prices set karein</span></button>' +
    '</div>');
  lCard.appendChild(linkRow);
  linkRow.querySelector('#ps-go-branches').addEventListener('click', () => window.App.go('branches'));
  linkRow.querySelector('#ps-go-products').addEventListener('click', () => window.App.go('products'));
  // Prices live on the Products screen (Edit Item) — no separate screen.
  linkRow.querySelector('#ps-go-prices').addEventListener('click', () => window.App.go('products'));
  wrap.appendChild(lCard);

  container.appendChild(wrap);
}

window.Screens['pos-settings'] = renderPosSettings;
window.Screens.PosSettings = { render: renderPosSettings };
})();
