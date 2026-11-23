/* Sahara Bakers — Recipes (v2.1.0).
 * Saved production recipes: one finish item + its raw lines.
 * A recipe is a per-batch list — the quantities stored on the recipe
 * are the quantities used for ONE production run of that recipe
 * (DB.completeProduction uses them as-is when lines are empty; it does
 * NOT scale them by finishQty).
 *
 * Frozen DB contract (src/db.js, api-freeze.md §4.6–4.7):
 *   DB.saveRecipe({finishProductId, name, lines:[{productId, qty}], createdBy})
 *     — finish must be 'finished', every line must be a 'raw' item
 *       with qty > 0; MULTIPLE recipes per finish product are allowed
 *       (no uniqueness check in the freeze).
 *   DB.listRecipes(finishProductId?) — all recipes, or one finish item's.
 *   DB.deleteRecipe(recipeId)
 *   DB.completeProduction({finishProductId, finishQty, recipeId, ...})
 *     — when `lines` is empty, the saved recipe's lines are used.
 * There is NO DB.updateRecipe in the freeze, so Edit below mutates the
 * row in place after re-running the same validation saveRecipe applies
 * (finish is finished, lines are raw with qty > 0) — the same in-place
 * pattern products.js uses for item edits. If Worker A adds
 * DB.updateRecipe, swap the edit save to it.
 *
 * Contract for production.js (Worker E): window.Screens.Recipes
 *   .loadForProduction(finishProductId)
 *     → null when the finish item has no recipe, else
 *       { recipeId, name, lines: [{productId, qty, name, unit, purchasePrice}] }
 *       (the FIRST recipe by id when several exist for one finish item).
 *   .listForProduction(finishProductId)
 *     → [{recipeId, name, lines:[...]}] — every recipe for the finish
 *       item, so production.js can offer a picker when there is more
 *       than one.
 *   .recipeLinesForProduction(recipeId)
 *     → [{productId, qty}] (plain lines for DB.completeProduction) or null.
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

function productById(id) {
  return (S().products || []).find((p) => String(p.id) === String(id));
}
function rawProducts() {
  return (S().products || []).filter((p) => p.type === 'raw');
}
function finishProducts() {
  return (S().products || []).filter((p) => p.type === 'finished');
}
/* Enrich stored recipe lines with the live product row (name/unit and
 * the CURRENT purchasePrice — cost is never stamped on a recipe, so a
 * blank purchasePrice shows as "—", never as 0 or a guess). */
function enrichLines(lines) {
  return (lines || []).map((l) => {
    const p = productById(l.productId);
    return {
      productId: l.productId, qty: Number(l.qty),
      name: p ? p.name : ('Item #' + l.productId),
      unit: p ? (p.unit || '') : '',
      purchasePrice: p ? p.purchasePrice : null,
    };
  });
}
function lineCostOf(enriched) {
  let total = 0, known = true;
  enriched.forEach((l) => {
    if (l.purchasePrice == null) known = false;
    else total += l.qty * Number(l.purchasePrice);
  });
  return { total, known };
}

/* ----- Contract for Worker E (production.js) ----- */
function listForProduction(finishProductId) {
  if (finishProductId == null) return [];
  const recipes = DB.listRecipes ? DB.listRecipes(finishProductId) : (S().recipes || []).filter((r) => String(r.finishProductId) === String(finishProductId));
  return recipes.slice().sort((a, b) => Number(a.id) - Number(b.id)).map((r) => ({
    recipeId: r.id, name: r.name, lines: enrichLines(r.lines),
  }));
}
function loadForProduction(finishProductId) {
  const all = listForProduction(finishProductId);
  if (all.length === 0) return null;
  return all[0]; // first recipe by id when several exist
}
function recipeLinesForProduction(recipeId) {
  const r = (S().recipes || []).find((x) => String(x.id) === String(recipeId));
  if (!r) return null;
  return (r.lines || []).map((l) => ({ productId: l.productId, qty: Number(l.qty) }));
}

function renderRecipes(container) {
  container.innerHTML = '';
  const st = S();
  const canManage = window.App.canEditItems(); // Owner / Manager only
  const finishes = finishProducts();
  const raws = rawProducts();
  let filterFinish = 'all';

  const wrap = el('<div></div>');
  wrap.appendChild(el('<div class="screen-head"><h1>Recipes</h1>' +
    (canManage ? '<button type="button" class="btn btn-primary" id="add-recipe-btn">+ New Recipe</button>' : '') + '</div>'));
  wrap.appendChild(el('<p class="muted">Saved recipes — aik finish item ke liye kaunsa raw maal, kitna. Production mein recipe chunein to cart khud bhar jayega; recipe na ho to ad-hoc cart waisa hi kaam karega. Aik finish item ki aik se zyada recipes ho sakti hain.</p>'));

  const filterRow = el('<div class="pos-search-row"><label style="align-self:center"><b>Finish Item</b></label>' +
    '<select id="recipes-filter" class="input" style="max-width:320px"><option value="all">Sab Recipes</option>' +
    finishes.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>').join('') +
    '</select></div>');
  wrap.appendChild(filterRow);
  const listWrap = el('<div id="recipes-list-wrap"></div>');
  wrap.appendChild(listWrap);

  function drawList() {
    const recipes = DB.listRecipes ? DB.listRecipes() : (S().recipes || []);
    const list = recipes.slice().sort((a, b) => Number(a.id) - Number(b.id))
      .filter((r) => filterFinish === 'all' || String(r.finishProductId) === String(filterFinish));
    listWrap.innerHTML = '';
    if (list.length === 0) {
      listWrap.appendChild(el('<div class="card"><p class="muted">' +
        (recipes.length === 0
          ? 'Abhi koi recipe nahi — upar "+ New Recipe" se pehli recipe banayein (jaise Gulab Jamun: Flour, Sugar…).'
          : 'Is finish item ki koi recipe nahi hai.') +
        '</p></div>'));
      return;
    }
    list.forEach((r) => {
      const finish = productById(r.finishProductId);
      const lines = enrichLines(r.lines);
      const cost = lineCostOf(lines);
      const card = el('<div class="card recipe-card"></div>');
      card.appendChild(el('<div class="screen-head"><h2>' + esc(r.name || (finish ? finish.name + ' Recipe' : 'Recipe')) + '</h2>' +
        (canManage
          ? '<span><button type="button" class="btn btn-sm recipe-edit" data-id="' + esc(r.id) + '">Edit</button> ' +
            '<button type="button" class="btn btn-sm btn-danger recipe-delete" data-id="' + esc(r.id) + '">Delete</button></span>'
          : '') + '</div>'));
      card.appendChild(el('<p class="muted">Finish item: <b>' + esc(finish ? finish.name : ('#' + r.finishProductId)) + '</b>' +
        (finish ? ' (' + esc(finish.unit || '') + ')' : '') +
        (r.createdBy ? ' · Banane wala: ' + esc(r.createdBy) : '') + '</p>'));
      const rows = lines.map((l) => {
        const lineCost = l.purchasePrice == null ? null : l.qty * Number(l.purchasePrice);
        return '<tr><td><b>' + esc(l.name) + '</b></td><td><b>' + l.qty + '</b> ' + esc(l.unit) + '</td><td>' +
          (l.purchasePrice != null ? window.App.money(l.purchasePrice) + ' / ' + esc(l.unit) : 'cost blank') + '</td><td>' +
          (lineCost != null ? window.App.money(lineCost) : '—') + '</td></tr>';
      }).join('');
      card.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Raw Item</th><th>Miqdaar (aik batch)</th><th>Purchase Price</th><th>Line Cost</th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
      card.appendChild(el('<p><b>Batch Cost:</b> ' + (cost.known ? window.App.money(cost.total) : window.App.money(cost.total) + ' * (kuch raw items ki purchase price blank hai)') + '</p>'));
      card.appendChild(el('<p class="muted">Production mein is recipe se cart bhar jayega — miqdaar recipe wali hi hogi (finish miqdaar se scale nahi hoti).</p>'));
      listWrap.appendChild(card);
    });
    listWrap.querySelectorAll('.recipe-edit').forEach((b) => b.addEventListener('click', () => {
      const r = (S().recipes || []).find((x) => String(x.id) === String(b.getAttribute('data-id')));
      if (r) openRecipeForm(r);
    }));
    listWrap.querySelectorAll('.recipe-delete').forEach((b) => b.addEventListener('click', async () => {
      const r = (S().recipes || []).find((x) => String(x.id) === String(b.getAttribute('data-id')));
      if (!r) return;
      const ok = await window.App.confirmDialog('Recipe Delete Karein?',
        '"' + (r.name || '') + '" delete ho jayegi. Purani productions (PB bills) par koi asar nahi parega — woh apni lines khud rakhti hain.');
      if (!ok) return;
      const res = DB.deleteRecipe ? DB.deleteRecipe(r.id) : { ok: false, message: 'Recipe delete available nahi hai' };
      if (!res.ok) { notify('Issue — ' + (res.message || 'Recipe delete nahi ho saki'), 'error'); return; }
      window.App.save();
      notify('Ho Gaya ✓ — Recipe delete ho gayi: ' + (r.name || ''), 'success');
      drawList();
    }));
  }

  /* Recipe form: finish select + name + a lines editor (raw + qty rows).
   * The same form is used for New and Edit. Lines live in a local array
   * until Save, so a half-built recipe never touches the DB. */
  function openRecipeForm(existing) {
    const isNew = !existing;
    const overlay = document.getElementById('item-form-overlay');
    const bodyEl = document.getElementById('item-form-body');
    const titleEl = document.getElementById('item-form-title');
    if (!overlay || !bodyEl) return;
    if (finishes.length === 0) { notify('Issue — Pehle koi Finish Goods item banayein', 'error'); return; }
    if (raws.length === 0) { notify('Issue — Pehle koi Raw Material item banayein', 'error'); return; }
    titleEl.textContent = isNew ? 'New Recipe' : 'Edit Recipe — ' + (existing.name || '');
    bodyEl.innerHTML = '';
    const lines = isNew ? [] : (existing.lines || []).map((l) => ({ productId: l.productId, qty: Number(l.qty) }));

    const form = el('<form></form>');
    const finishSel = el('<select id="rf-finish" class="input">' + finishes.map((p) =>
      '<option value="' + esc(p.id) + '"' + (existing && String(existing.finishProductId) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
    ).join('') + '</select>');
    const nameIn = el('<input id="rf-name" class="input" type="text" maxlength="80" value="' + esc(existing ? (existing.name || '') : '') + '" placeholder="Recipe ka naam (blank ho to finish item ka naam lag jayega)">');
    form.appendChild(el('<label>Finish Item</label>')); form.appendChild(finishSel);
    form.appendChild(el('<label>Recipe Name</label>')); form.appendChild(nameIn);
    form.appendChild(el('<label>Raw Lines — aik batch ke liye</label>'));
    const linesWrap = el('<div id="rf-lines"></div>');
    form.appendChild(linesWrap);
    const addRow = el('<div class="pos-search-row"></div>');
    const rawSel = el('<select id="rf-raw-sel" class="input">' + raws.map((p) =>
      '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.unit || '') + ')</option>'
    ).join('') + '</select>');
    const rawQty = el('<input id="rf-raw-qty" class="input" type="number" min="0" step="any" placeholder="Qty" style="max-width:130px">');
    const rawAdd = el('<button type="button" class="btn" id="rf-raw-add">+ Add Line</button>');
    addRow.appendChild(rawSel); addRow.appendChild(rawQty); addRow.appendChild(rawAdd);
    form.appendChild(addRow);
    const costEl = el('<p id="rf-cost" class="muted"></p>');
    form.appendChild(costEl);
    const row = el('<div class="form-actions"></div>');
    row.appendChild(el('<button type="submit" class="btn btn-primary">Save Recipe</button>'));
    row.appendChild(el('<button type="button" class="btn" id="rf-cancel">Cancel</button>'));
    form.appendChild(row);

    function drawLines() {
      linesWrap.innerHTML = '';
      if (lines.length === 0) {
        linesWrap.appendChild(el('<p class="muted">Abhi koi line nahi — upar se raw item + qty add karein.</p>'));
      } else {
        const rows = lines.map((l, i) => {
          const p = productById(l.productId);
          return '<tr><td><b>' + esc(p ? p.name : ('#' + l.productId)) + '</b></td><td><b>' + l.qty + '</b> ' + esc(p ? (p.unit || '') : '') + '</td><td><button type="button" class="btn btn-sm" data-i="' + i + '">Hataein</button></td></tr>';
        }).join('');
        linesWrap.appendChild(el('<div class="table-wrap"><table><thead><tr><th>Raw Item</th><th>Qty</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'));
        linesWrap.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
          lines.splice(Number(b.getAttribute('data-i')), 1);
          drawLines();
        }));
      }
      const cost = lineCostOf(enrichLines(lines));
      costEl.textContent = lines.length === 0 ? '' : ('Batch cost: ' + (cost.known ? window.App.money(cost.total) : window.App.money(cost.total) + ' * (kuch raw items ki purchase price blank hai)'));
    }
    rawAdd.addEventListener('click', () => {
      const pid = rawSel.value;
      const qty = Number(rawQty.value);
      const p = productById(pid);
      if (!p) return;
      if (!qty || qty <= 0) { notify('Issue — Miqdaar durust likhein (0 se zyada)', 'error'); return; }
      const ex = lines.find((l) => String(l.productId) === String(pid));
      if (ex) ex.qty = qty;
      else lines.push({ productId: p.id, qty });
      rawQty.value = '';
      drawLines();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const finishId = finishSel.value;
      const name = nameIn.value.trim();
      const finish = productById(finishId);
      if (!finish) { notify('Issue — Pehle finish item chunein', 'error'); return; }
      if (finish.type !== 'finished') { notify('Issue — Recipe sirf Finish Goods ke liye hai', 'error'); return; }
      if (lines.length === 0) { notify('Issue — Recipe mein kam az kam aik raw item chahiye', 'error'); return; }
      for (const l of lines) {
        const raw = productById(l.productId);
        if (!raw || raw.type !== 'raw') { notify('Issue — "' + (raw ? raw.name : l.productId) + '" raw item nahi hai', 'error'); return; }
        if (!(Number(l.qty) > 0)) { notify('Issue — Miqdaar durust likhein', 'error'); return; }
      }
      const cleanLines = lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) }));
      if (isNew) {
        const res = DB.saveRecipe ? DB.saveRecipe({
          finishProductId: finish.id, name: name || (finish.name + ' Recipe'),
          lines: cleanLines, createdBy: window.App.user ? window.App.user.name : '',
        }) : { ok: false, message: 'Recipe save available nahi hai' };
        if (!res.ok) { notify('Issue — ' + (res.message || 'Recipe save nahi ho saki'), 'error'); return; }
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Recipe save ho gayi: ' + (res.recipe.name || ''), 'success');
      } else {
        // No DB.updateRecipe in the freeze: validated in-place edit
        // (same rules saveRecipe applies — see the checks above).
        existing.finishProductId = finish.id;
        existing.name = name || (finish.name + ' Recipe');
        existing.lines = cleanLines;
        window.App.save();
        closeForm();
        notify('Ho Gaya ✓ — Recipe update ho gayi: ' + existing.name, 'success');
      }
      drawList();
    });
    row.querySelector('#rf-cancel').addEventListener('click', closeForm);
    bodyEl.appendChild(form);
    overlay.hidden = false;
    overlay.style.display = 'flex';
    drawLines();
    nameIn.focus();
  }
  function closeForm() {
    const overlay = document.getElementById('item-form-overlay');
    if (overlay) { overlay.hidden = true; overlay.style.display = 'none'; }
  }

  filterRow.querySelector('#recipes-filter').addEventListener('change', (e) => { filterFinish = e.target.value; drawList(); });
  const addBtn = wrap.querySelector('#add-recipe-btn');
  if (addBtn) addBtn.addEventListener('click', () => openRecipeForm(null));
  const closeBtn = document.getElementById('item-form-x');
  if (closeBtn) closeBtn.onclick = closeForm;

  drawList();
  container.appendChild(wrap);
}

/* The render function IS the module object: go('recipes') calls it as
 * a function, production.js calls .loadForProduction() on it. Both
 * spellings point at the same function so Worker I can wire either
 * route id. */
renderRecipes.loadForProduction = loadForProduction;
renderRecipes.listForProduction = listForProduction;
renderRecipes.recipeLinesForProduction = recipeLinesForProduction;
window.Screens.recipes = renderRecipes;
window.Screens.Recipes = renderRecipes;
})();
