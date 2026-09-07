// Familienmeeting — mobile-first, synchronisiert über Supabase.
// State im localStorage zwischengespeichert, pro Haushalt in Supabase gesynct.

(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Storage & State
  // ------------------------------------------------------------------
  const STORAGE_KEY = 'familienmeeting.v1';

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const DEFAULT_TAGS = ['vegetarisch', 'vegan', 'schnell', 'aufwendig', 'kinderfreundlich', 'klassiker', 'saisonal', 'süß', 'suppe', 'ofen', 'pfanne', 'salat'];

  const DEFAULT_STATE = () => ({
    members: [],
    recipes: [],
    packages: [],
    weeks: {},
    settings: { seenSeedPrompt: false, bringApiBase: '' },
    bring: null,
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_STATE();
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE(), ...parsed };
    } catch (e) {
      console.warn('State corrupt, resetting.', e);
      return DEFAULT_STATE();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    schedulePush();
  }

  // ------------------------------------------------------------------
  // Supabase: Auth & Haushalt-Sync
  // ------------------------------------------------------------------
  let sb = null;
  let householdId = null;
  let currentSession = null;
  let appWired = false;
  let pushTimer = null;

  function showOnly(id) {
    ['auth-gate', 'household-gate', 'app-shell'].forEach(elId => {
      document.getElementById(elId).hidden = elId !== id;
    });
  }

  function magicLinkRedirectUrl() {
    return window.location.origin + window.location.pathname;
  }

  async function sendMagicLink(email) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: magicLinkRedirectUrl() } });
    if (error) throw error;
  }

  async function resolveHousehold(session) {
    await sb.rpc('claim_pending_household_invites');
    const { data, error } = await sb
      .from('household_members')
      .select('household_id, role, households(name)')
      .eq('user_id', session.user.id)
      .limit(1);
    if (error) throw error;
    if (!data || !data.length) return null;
    return { id: data[0].household_id, role: data[0].role, name: data[0].households?.name || 'Familie' };
  }

  async function createHousehold(session) {
    // ID selbst erzeugen und ohne .select() einfügen: .insert().select() würde die neue
    // Zeile sofort zurücklesen wollen, aber die households_select_members-Policy lässt das
    // erst zu, sobald man Mitglied ist — das ist man direkt nach dem Insert noch nicht.
    const householdId = crypto.randomUUID();
    const { error: hhErr } = await sb.from('households').insert({ id: householdId, name: 'Familie', created_by: session.user.id });
    if (hhErr) throw hhErr;
    const { error: memErr } = await sb.from('household_members').insert({ household_id: householdId, email: session.user.email, user_id: session.user.id, role: 'owner' });
    if (memErr) throw memErr;
    const { error: dataErr } = await sb.from('household_data').insert({ household_id: householdId, data: DEFAULT_STATE() });
    if (dataErr) throw dataErr;
    return { id: householdId, role: 'owner', name: 'Familie' };
  }

  async function fetchRemoteState() {
    const { data, error } = await sb.from('household_data').select('data').eq('household_id', householdId).single();
    if (error) throw error;
    return data?.data || null;
  }

  async function pushRemoteState() {
    if (!householdId) return;
    const { error } = await sb.from('household_data').update({ data: state, updated_at: new Date().toISOString() }).eq('household_id', householdId);
    if (error) console.warn('Sync fehlgeschlagen', error);
  }

  function schedulePush() {
    if (!householdId) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushRemoteState, 800);
  }

  async function enterApp(session) {
    currentSession = session;
    if (appWired) return; // Token-Refresh o.ä. — App läuft schon
    let hh = null;
    try {
      hh = await resolveHousehold(session);
    } catch (e) {
      console.error('Haushalt konnte nicht geladen werden', e);
    }
    if (!hh) {
      document.getElementById('household-gate-email').textContent = session.user.email;
      showOnly('household-gate');
      return;
    }
    await activateHousehold(hh);
  }

  async function activateHousehold(hh) {
    householdId = hh.id;
    try {
      const remote = await fetchRemoteState();
      if (remote) {
        state = { ...DEFAULT_STATE(), ...remote };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch (e) {
      console.warn('Konnte nicht synchronisieren, nutze lokalen Stand.', e);
    }
    showOnly('app-shell');
    if (!appWired) {
      wire();
      appWired = true;
    }
    go('meeting');

    if (!state.recipes.length && !state.members.length && !state.settings.seenSeedPrompt) {
      state.settings.seenSeedPrompt = true;
      save();
      setTimeout(openWelcomeModal, 300);
    }
  }

  function wireAuthGate() {
    const emailInput = document.getElementById('auth-email');
    const sendBtn = document.getElementById('auth-send-link');
    const errorEl = document.getElementById('auth-error');
    sendBtn.addEventListener('click', async () => {
      const email = emailInput.value.trim();
      if (!email) return;
      errorEl.hidden = true;
      sendBtn.disabled = true; sendBtn.textContent = 'Sende…';
      try {
        await sendMagicLink(email);
        document.getElementById('auth-sent-email').textContent = email;
        document.getElementById('auth-step-email').hidden = true;
        document.getElementById('auth-step-sent').hidden = false;
      } catch (e) {
        errorEl.textContent = e.message || 'Senden fehlgeschlagen';
        errorEl.hidden = false;
      } finally {
        sendBtn.disabled = false; sendBtn.textContent = 'Link senden';
      }
    });
    document.getElementById('auth-resend').addEventListener('click', () => {
      document.getElementById('auth-step-sent').hidden = true;
      document.getElementById('auth-step-email').hidden = false;
    });
  }

  function wireHouseholdGate() {
    document.getElementById('household-create').addEventListener('click', async () => {
      const btn = document.getElementById('household-create');
      btn.disabled = true;
      try {
        const hh = await createHousehold(currentSession);
        await activateHousehold(hh);
      } catch (e) {
        toast(e.message || 'Anlegen fehlgeschlagen');
        btn.disabled = false;
      }
    });
    document.getElementById('household-gate-retry').addEventListener('click', () => enterApp(currentSession));
    document.getElementById('household-gate-signout').addEventListener('click', async () => {
      await sb.auth.signOut();
      window.location.reload();
    });
  }

  async function renderHouseholdSettings() {
    const nameLabel = document.getElementById('household-name-label');
    const list = document.getElementById('household-member-list');
    if (!householdId || !currentSession) return;
    nameLabel.textContent = `Angemeldet als ${currentSession.user.email}`;
    const { data, error } = await sb.from('household_members').select('email, role').eq('household_id', householdId).order('invited_at');
    if (error) { list.innerHTML = `<li class="member-row muted small">Mitglieder konnten nicht geladen werden.</li>`; return; }
    list.innerHTML = '';
    (data || []).forEach(m => {
      const li = document.createElement('li');
      li.className = 'member-row';
      li.innerHTML = `<span class="name">${escapeHtml(m.email)}</span><span class="muted small">${m.role === 'owner' ? 'Besitzer' : 'Mitglied'}</span>`;
      list.appendChild(li);
    });
  }

  function openWelcomeModal() {
    openModal(`
      <h3>Willkommen 👋</h3>
      <p>Möchtest du mit ein paar Beispieldaten starten, um das Tool auszuprobieren? Du kannst später alles anpassen oder zurücksetzen.</p>
      <div class="actions">
        <button class="btn ghost" data-close>Leer starten</button>
        <button class="btn" id="seed-ok">Beispieldaten laden</button>
      </div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#seed-ok').addEventListener('click', () => { seedData(); closeModal(); });
    });
  }

  // ------------------------------------------------------------------
  // Datum-Helper (ISO-Wochen, Mo als erster Tag)
  // ------------------------------------------------------------------
  const DAY_NAMES_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const DAY_NAMES_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const wd = (x.getDay() + 6) % 7; // Montag=0
    x.setDate(x.getDate() - wd);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function isoWeekKey(d) {
    // ISO week: donnerstagsverankert
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (t.getDay() + 6) % 7;
    t.setDate(t.getDate() - day + 3);
    const firstThursday = new Date(t.getFullYear(), 0, 4);
    const firstDay = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
    const week = 1 + Math.round((t - firstThursday) / (7 * 24 * 3600 * 1000));
    return `${t.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function formatDateShort(d) {
    return `${d.getDate()}. ${MONTH_NAMES[d.getMonth()]}`;
  }

  function formatWeekRange(monday) {
    const sunday = addDays(monday, 6);
    return `${formatDateShort(monday)} – ${formatDateShort(sunday)} ${sunday.getFullYear()}`;
  }

  function today() { return new Date(); }

  // Default-Woche für das Meeting: wenn heute Sonntag ist, planen wir die kommende Woche (morgen Montag).
  function defaultPlanningMonday() {
    const t = today();
    if (t.getDay() === 0) return addDays(t, 1); // Sonntag → nächste Mo
    return startOfWeek(t);
  }

  // ------------------------------------------------------------------
  // Week-State-Zugriff
  // ------------------------------------------------------------------
  function getWeek(monday) {
    const key = isoWeekKey(monday);
    if (!state.weeks[key]) {
      state.weeks[key] = { menus: {}, duties: {}, notes: [] };
    }
    const week = state.weeks[key];
    week.shoppingChecked = week.shoppingChecked || {};
    week.shoppingExtra = week.shoppingExtra || [];
    return week;
  }

  // ------------------------------------------------------------------
  // View-Routing
  // ------------------------------------------------------------------
  const VIEW_TITLES = {
    meeting: 'Sonntag',
    menus: 'Menüs der Woche',
    shopping: 'Einkaufsliste',
    recipes: 'Rezepte',
    duties: 'Verantwortungen',
    packages: 'Pakete & Familie',
    notes: 'Themen & Notizen',
    more: 'Mehr',
    settings: 'Einstellungen',
  };

  // Views ohne eigenen Tab, die über den "Mehr"-Tab erreicht werden (Mobil/Tablet).
  const MORE_VIEWS = new Set(['duties', 'packages', 'notes', 'settings', 'more']);

  let currentView = 'meeting';
  let planningMonday = defaultPlanningMonday();
  let dutyMonday = defaultPlanningMonday();
  let recipeFilter = { text: '', tags: [] };

  function go(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach(el => {
      el.hidden = el.dataset.view !== view;
    });
    document.querySelectorAll('.tab').forEach(el => {
      const isMoreTab = el.dataset.go === 'more';
      el.classList.toggle('active', isMoreTab ? MORE_VIEWS.has(view) : el.dataset.go === view);
    });
    document.querySelectorAll('.sidebar-item').forEach(el => {
      el.classList.toggle('active', el.dataset.go === view);
    });
    document.getElementById('view-title').textContent = VIEW_TITLES[view] || 'Familienmeeting';
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function render() {
    switch (currentView) {
      case 'meeting': return renderMeeting();
      case 'menus': return renderMenus();
      case 'shopping': return renderShopping();
      case 'recipes': return renderRecipes();
      case 'duties': return renderDuties();
      case 'packages': return renderPackages();
      case 'notes': return renderNotes();
      case 'settings': return renderSettings();
    }
  }

  function renderMeeting() {
    const mon = defaultPlanningMonday();
    document.getElementById('hero-week').textContent = `KW ${isoWeekKey(mon).split('-W')[1]}`;
    document.getElementById('hero-date').textContent = formatWeekRange(mon);

    const week = getWeek(mon);
    const wm = document.getElementById('week-mini');
    wm.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const key = isoDate(d);
      const slot = week.menus[key];
      const name = slotName(slot);
      const li = document.createElement('li');
      li.innerHTML = `<span class="day-tag">${DAY_NAMES_SHORT[i]}</span><span class="day-meal ${name ? '' : 'empty'}">${escapeHtml(name || 'noch offen')}</span>`;
      wm.appendChild(li);
    }

    const dm = document.getElementById('duty-mini');
    dm.innerHTML = '';
    if (!state.packages.length) {
      dm.innerHTML = `<li><span class="day-meal empty">Noch keine Pakete angelegt.</span></li>`;
    } else {
      state.packages.forEach(pkg => {
        const memberId = week.duties[pkg.id];
        const member = state.members.find(m => m.id === memberId);
        const li = document.createElement('li');
        li.innerHTML = `<span class="day-meal">${escapeHtml(pkg.name)}</span><span class="day-tag" style="flex:0 0 auto;text-transform:none;font-size:12px;letter-spacing:0;color:${member ? 'var(--text)' : 'var(--muted)'}">${escapeHtml(member ? member.name : 'offen')}</span>`;
        dm.appendChild(li);
      });
    }
  }

  function slotName(slot) {
    if (!slot) return '';
    if (slot.customName) return slot.customName;
    if (slot.recipeId) {
      const r = state.recipes.find(x => x.id === slot.recipeId);
      return r ? r.name : '(gelöscht)';
    }
    return '';
  }

  function renderMenus() {
    document.getElementById('menus-week-label').textContent = `KW ${isoWeekKey(planningMonday).split('-W')[1]} · ${formatWeekRange(planningMonday)}`;
    const week = getWeek(planningMonday);
    const list = document.getElementById('week-list');
    list.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(planningMonday, i);
      const key = isoDate(d);
      const slot = week.menus[key];
      const name = slotName(slot);

      const li = document.createElement('li');
      li.innerHTML = `
        <div class="day-name">${DAY_NAMES_LONG[i]}<small>${formatDateShort(d)}</small></div>
        <div class="day-content">
          <button class="meal-pill ${name ? '' : 'empty'}" data-pick="${key}">
            <span class="name">${escapeHtml(name || '+ Menü wählen')}</span>
          </button>
        </div>
      `;
      if (name) {
        const clear = document.createElement('button');
        clear.className = 'icon-btn';
        clear.style.width = '36px'; clear.style.height = '36px'; clear.style.fontSize = '16px';
        clear.textContent = '×';
        clear.title = 'Menü entfernen';
        clear.addEventListener('click', () => {
          delete week.menus[key];
          save(); renderMenus(); toast('Menü gelöscht');
        });
        li.appendChild(clear);
      }
      list.appendChild(li);
    }
    list.querySelectorAll('[data-pick]').forEach(btn => {
      btn.addEventListener('click', () => openMealPicker(btn.dataset.pick));
    });
  }

  // ------------------------------------------------------------------
  // Einkaufsliste
  // ------------------------------------------------------------------
  function buildShoppingGroups(monday) {
    const week = getWeek(monday);
    const groups = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      const key = isoDate(d);
      const slot = week.menus[key];
      if (!slot?.recipeId) continue;
      const r = state.recipes.find(x => x.id === slot.recipeId);
      if (!r || !r.ingredients?.length) continue;
      groups.push({
        label: `${DAY_NAMES_SHORT[i]} · ${r.name}`,
        items: r.ingredients.map(ing => ({
          checkKey: `${r.id}:${ing.id}`,
          text: [ing.quantity, ing.unit, ing.name].filter(Boolean).join(' ').trim(),
        })),
      });
    }
    return groups;
  }

  function shoppingOpenItems(monday) {
    const week = getWeek(monday);
    const out = [];
    buildShoppingGroups(monday).forEach(g => g.items.forEach(item => {
      if (!week.shoppingChecked[item.checkKey]) out.push(item.text);
    }));
    week.shoppingExtra.forEach(ex => { if (!ex.done) out.push(ex.text); });
    return out;
  }

  function renderShopping() {
    document.getElementById('shopping-week-label').textContent = `KW ${isoWeekKey(planningMonday).split('-W')[1]} · ${formatWeekRange(planningMonday)}`;
    const week = getWeek(planningMonday);
    const groups = buildShoppingGroups(planningMonday);
    const list = document.getElementById('shopping-list');
    list.innerHTML = '';

    if (!groups.length && !week.shoppingExtra.length) {
      list.innerHTML = `<li class="note-row"><div class="info muted small">Keine Zutaten geplant. Hinterlege Zutaten bei den Rezepten dieser Woche, oder füge unten Artikel von Hand hinzu.</div></li>`;
    }

    groups.forEach(g => {
      const head = document.createElement('li');
      head.className = 'shopping-group-head';
      head.textContent = g.label;
      list.appendChild(head);
      g.items.forEach(item => {
        const done = !!week.shoppingChecked[item.checkKey];
        const li = document.createElement('li');
        li.className = 'shopping-row';
        li.innerHTML = `
          <label class="shopping-check">
            <input type="checkbox" data-check="${item.checkKey}" ${done ? 'checked' : ''} />
            <span style="text-decoration:${done ? 'line-through' : 'none'};opacity:${done ? .55 : 1}">${escapeHtml(item.text)}</span>
          </label>
        `;
        list.appendChild(li);
      });
    });

    if (week.shoppingExtra.length) {
      const head = document.createElement('li');
      head.className = 'shopping-group-head';
      head.textContent = 'Weitere Artikel';
      list.appendChild(head);
      week.shoppingExtra.forEach(ex => {
        const li = document.createElement('li');
        li.className = 'shopping-row';
        li.innerHTML = `
          <label class="shopping-check">
            <input type="checkbox" data-check-extra="${ex.id}" ${ex.done ? 'checked' : ''} />
            <span style="text-decoration:${ex.done ? 'line-through' : 'none'};opacity:${ex.done ? .55 : 1}">${escapeHtml(ex.text)}</span>
          </label>
          <button class="icon-btn" data-del-extra="${ex.id}" aria-label="Löschen">🗑</button>
        `;
        list.appendChild(li);
      });
    }

    list.querySelectorAll('[data-check]').forEach(cb => cb.addEventListener('change', () => {
      week.shoppingChecked[cb.dataset.check] = cb.checked;
      save(); renderShopping();
    }));
    list.querySelectorAll('[data-check-extra]').forEach(cb => cb.addEventListener('change', () => {
      const ex = week.shoppingExtra.find(x => x.id === cb.dataset.checkExtra);
      if (ex) { ex.done = cb.checked; save(); renderShopping(); }
    }));
    list.querySelectorAll('[data-del-extra]').forEach(btn => btn.addEventListener('click', () => {
      week.shoppingExtra = week.shoppingExtra.filter(x => x.id !== btn.dataset.delExtra);
      save(); renderShopping();
    }));
  }

  function addShoppingExtra() {
    const input = document.getElementById('shopping-add-input');
    const text = input.value.trim();
    if (!text) return;
    const week = getWeek(planningMonday);
    week.shoppingExtra.push({ id: uid(), text, done: false });
    input.value = '';
    save();
    renderShopping();
  }

  async function copyShoppingList() {
    const items = shoppingOpenItems(planningMonday);
    if (!items.length) { toast('Liste ist leer'); return; }
    const text = items.join('\n');
    if (navigator.share) {
      try { await navigator.share({ text, title: 'Einkaufsliste' }); return; } catch (e) { /* Abbruch oder nicht unterstützt: auf Zwischenablage ausweichen */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('In Zwischenablage kopiert');
    } catch (e) {
      toast('Kopieren nicht möglich');
    }
  }

  function renderRecipes() {
    const chips = document.getElementById('recipe-tag-filter');
    const allTags = uniqueTags();
    chips.innerHTML = '';
    allTags.forEach(t => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (recipeFilter.tags.includes(t) ? ' on' : '');
      chip.textContent = t;
      chip.addEventListener('click', () => {
        if (recipeFilter.tags.includes(t)) {
          recipeFilter.tags = recipeFilter.tags.filter(x => x !== t);
        } else {
          recipeFilter.tags = [...recipeFilter.tags, t];
        }
        renderRecipes();
      });
      chips.appendChild(chip);
    });

    const list = document.getElementById('recipe-list');
    list.innerHTML = '';
    const filtered = filterRecipes(state.recipes, recipeFilter);
    if (!filtered.length) {
      list.innerHTML = `<li class="recipe-row"><div class="info muted small">Noch keine Rezepte. Tippe „+ Neu" oder lade in den Einstellungen Beispieldaten.</div></li>`;
      return;
    }
    filtered
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'de'))
      .forEach(r => {
        const li = document.createElement('li');
        li.className = 'recipe-row';
        const stars = '★'.repeat(r.rating || 0) + '☆'.repeat(5 - (r.rating || 0));
        const last = r.lastUsedAt ? `zuletzt ${relativeDaysLabel(r.lastUsedAt)}` : 'noch nie gekocht';
        const ingCount = r.ingredients?.length || 0;
        li.innerHTML = `
          <div class="info">
            <div class="title">${escapeHtml(r.name)}</div>
            <div class="meta">${r.tags.map(escapeHtml).join(' · ') || '—'} · ${last}${ingCount ? ' · ' + ingCount + ' Zutaten' : ''}</div>
            <div class="stars">${stars}</div>
          </div>
          <div class="row-actions-inline">
            <button class="icon-btn" data-edit="${r.id}" aria-label="Bearbeiten">✎</button>
            <button class="icon-btn" data-del="${r.id}" aria-label="Löschen">🗑</button>
          </div>
        `;
        list.appendChild(li);
      });
    list.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => openRecipeEditor(btn.dataset.edit)));
    list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => confirmDeleteRecipe(btn.dataset.del)));
  }

  function packageItemsText(pkg) {
    if (pkg.items && pkg.items.length) return pkg.items.map(i => i.text).join(' · ');
    return pkg.description || '';
  }

  function packageItemsListHtml(pkg) {
    if (pkg.items && pkg.items.length) {
      return `<ul class="package-items">${pkg.items.map(i => `<li>${escapeHtml(i.text)}</li>`).join('')}</ul>`;
    }
    if (pkg.description) return `<div class="meta">${escapeHtml(pkg.description)}</div>`;
    return '';
  }

  function renderDuties() {
    document.getElementById('duties-week-label').textContent = `KW ${isoWeekKey(dutyMonday).split('-W')[1]} · ${formatWeekRange(dutyMonday)}`;
    const week = getWeek(dutyMonday);
    const list = document.getElementById('duty-list');
    list.innerHTML = '';
    if (!state.packages.length) {
      list.innerHTML = `<li class="duty-row"><div class="info muted small">Lege im Tab „Pakete" Verantwortungspakete an.</div></li>`;
      return;
    }
    state.packages.forEach(pkg => {
      const memberId = week.duties[pkg.id];
      const member = state.members.find(m => m.id === memberId);
      const li = document.createElement('li');
      li.className = 'duty-row';
      li.innerHTML = `
        <div class="info">
          <div class="title">${escapeHtml(pkg.name)}</div>
          <div class="meta">${escapeHtml(packageItemsText(pkg) || pkg.frequency || 'wöchentlich')}</div>
        </div>
        <button class="assignee ${member ? '' : 'empty'}" data-assign="${pkg.id}">${escapeHtml(member ? member.name : 'zuweisen')}</button>
      `;
      list.appendChild(li);
    });
    list.querySelectorAll('[data-assign]').forEach(btn => {
      btn.addEventListener('click', () => openAssignPicker(btn.dataset.assign));
    });
  }

  function renderPackages() {
    const pl = document.getElementById('package-list');
    pl.innerHTML = '';
    if (!state.packages.length) {
      pl.innerHTML = `<li class="package-row"><div class="info muted small">Noch keine Pakete. Tippe „+ Neu".</div></li>`;
    } else {
      state.packages.forEach(p => {
        const li = document.createElement('li');
        li.className = 'package-row';
        li.innerHTML = `
          <div class="info">
            <div class="title">${escapeHtml(p.name)}</div>
            <div class="meta">${escapeHtml(p.frequency || '')}</div>
            ${packageItemsListHtml(p)}
          </div>
          <div class="row-actions-inline">
            <button class="icon-btn" data-edit-pkg="${p.id}" aria-label="Bearbeiten">✎</button>
            <button class="icon-btn" data-del-pkg="${p.id}" aria-label="Löschen">🗑</button>
          </div>
        `;
        pl.appendChild(li);
      });
    }
    pl.querySelectorAll('[data-edit-pkg]').forEach(btn => btn.addEventListener('click', () => openPackageEditor(btn.dataset.editPkg)));
    pl.querySelectorAll('[data-del-pkg]').forEach(btn => btn.addEventListener('click', () => confirmDeletePackage(btn.dataset.delPkg)));

    const ml = document.getElementById('member-list');
    ml.innerHTML = '';
    if (!state.members.length) {
      ml.innerHTML = `<li class="member-row"><div class="info muted small">Füge Familienmitglieder hinzu, damit du Aufgaben zuweisen kannst.</div></li>`;
    } else {
      state.members.forEach(m => {
        const li = document.createElement('li');
        li.className = 'member-row';
        li.innerHTML = `
          <span class="swatch" style="background:${m.color}"></span>
          <span class="name">${escapeHtml(m.name)}</span>
          <div class="row-actions-inline">
            <button class="icon-btn" data-edit-m="${m.id}" aria-label="Bearbeiten">✎</button>
            <button class="icon-btn" data-del-m="${m.id}" aria-label="Löschen">🗑</button>
          </div>
        `;
        ml.appendChild(li);
      });
    }
    ml.querySelectorAll('[data-edit-m]').forEach(btn => btn.addEventListener('click', () => openMemberEditor(btn.dataset.editM)));
    ml.querySelectorAll('[data-del-m]').forEach(btn => btn.addEventListener('click', () => confirmDeleteMember(btn.dataset.delM)));
  }

  function renderNotes() {
    const list = document.getElementById('note-list');
    const week = getWeek(defaultPlanningMonday());
    list.innerHTML = '';
    if (!week.notes.length) {
      list.innerHTML = `<li class="note-row"><div class="info muted small">Noch keine Themen für diese Woche.</div></li>`;
      return;
    }
    week.notes.forEach(n => {
      const li = document.createElement('li');
      li.className = 'note-row';
      li.innerHTML = `
        <div class="info">
          <div class="title" style="text-decoration:${n.done ? 'line-through' : 'none'};opacity:${n.done ? .6 : 1}">${escapeHtml(n.text)}</div>
        </div>
        <div class="row-actions-inline">
          <button class="icon-btn" data-toggle-n="${n.id}" aria-label="Erledigt">${n.done ? '↺' : '✓'}</button>
          <button class="icon-btn" data-del-n="${n.id}" aria-label="Löschen">🗑</button>
        </div>
      `;
      list.appendChild(li);
    });
    list.querySelectorAll('[data-toggle-n]').forEach(btn => btn.addEventListener('click', () => {
      const n = week.notes.find(x => x.id === btn.dataset.toggleN);
      if (n) { n.done = !n.done; save(); renderNotes(); }
    }));
    list.querySelectorAll('[data-del-n]').forEach(btn => btn.addEventListener('click', () => {
      week.notes = week.notes.filter(x => x.id !== btn.dataset.delN);
      save(); renderNotes();
    }));
  }

  function renderSettings() {
    renderHouseholdSettings();
    const baseInput = document.getElementById('bring-api-base');
    if (document.activeElement !== baseInput) baseInput.value = state.settings.bringApiBase || '';
    const status = document.getElementById('bring-status');
    const disBtn = document.getElementById('btn-bring-disconnect');
    if (state.bring?.accessToken) {
      status.textContent = `Verbunden als ${state.bring.email}${state.bring.listName ? ` · Liste „${state.bring.listName}"` : ''}`;
      disBtn.hidden = false;
    } else {
      status.textContent = 'Nicht verbunden.';
      disBtn.hidden = true;
    }
  }

  // ------------------------------------------------------------------
  // Filter & Helpers
  // ------------------------------------------------------------------
  function uniqueTags() {
    const s = new Set(DEFAULT_TAGS);
    state.recipes.forEach(r => r.tags.forEach(t => s.add(t)));
    return [...s].sort((a, b) => a.localeCompare(b, 'de'));
  }

  function filterRecipes(list, f) {
    const q = (f.text || '').trim().toLowerCase();
    return list.filter(r => {
      if (q && !r.name.toLowerCase().includes(q) && !(r.notes || '').toLowerCase().includes(q)) return false;
      if (f.tags.length && !f.tags.every(t => r.tags.includes(t))) return false;
      return true;
    });
  }

  function relativeDaysLabel(iso) {
    const d = parseISO(iso);
    const diff = Math.round((today() - d) / (1000 * 3600 * 24));
    if (diff <= 0) return 'heute';
    if (diff === 1) return 'gestern';
    if (diff < 7) return `vor ${diff} Tagen`;
    if (diff < 14) return 'vor 1 Woche';
    if (diff < 30) return `vor ${Math.floor(diff / 7)} Wochen`;
    if (diff < 60) return 'vor 1 Monat';
    return `vor ${Math.floor(diff / 30)} Monaten`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------
  // Rezept-Vorschlagslogik
  // ------------------------------------------------------------------
  function suggestRecipes({ excludeIds = [], limit = 6 } = {}) {
    const now = today();
    return state.recipes
      .filter(r => !excludeIds.includes(r.id))
      .map(r => {
        const lastDays = r.lastUsedAt ? Math.max(0, Math.round((now - parseISO(r.lastUsedAt)) / 86400000)) : 999;
        const freshness = Math.min(lastDays / 7, 12); // je länger her, desto besser (Cap 12)
        const rating = r.rating || 3;
        const wear = Math.min((r.useCount || 0) * 0.1, 2);
        const score = rating * 1.4 + freshness - wear + Math.random() * 0.6;
        let reason;
        if (!r.lastUsedAt) reason = 'noch nie gekocht';
        else if (lastDays >= 30) reason = `zuletzt ${relativeDaysLabel(r.lastUsedAt)}`;
        else if (rating >= 4) reason = `${rating}★-Favorit`;
        else reason = `zuletzt ${relativeDaysLabel(r.lastUsedAt)}`;
        return { r, score, reason };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function fillWeekWithSuggestions() {
    const week = getWeek(planningMonday);
    const used = new Set();
    Object.values(week.menus).forEach(s => { if (s?.recipeId) used.add(s.recipeId); });
    for (let i = 0; i < 7; i++) {
      const d = addDays(planningMonday, i);
      const key = isoDate(d);
      if (week.menus[key]) continue;
      const sug = suggestRecipes({ excludeIds: [...used], limit: 1 })[0];
      if (!sug) break;
      week.menus[key] = { recipeId: sug.r.id, customName: null };
      used.add(sug.r.id);
    }
    save();
    renderMenus();
    toast('Woche mit Vorschlägen gefüllt');
  }

  // ------------------------------------------------------------------
  // Verantwortungs-Verteilung (fair)
  // ------------------------------------------------------------------
  function autoDistributeDuties() {
    if (!state.members.length) { toast('Erst Familienmitglieder anlegen.'); return; }
    if (!state.packages.length) { toast('Erst Pakete anlegen.'); return; }
    const week = getWeek(dutyMonday);

    // Zähle Zuweisungen der letzten 8 Wochen pro (memberId, packageId)
    const currentKey = isoWeekKey(dutyMonday);
    const historyCounts = {}; // memberId -> total
    const packageHistory = {}; // packageId -> [memberId] letzter Träger
    for (const [wk, w] of Object.entries(state.weeks)) {
      if (wk === currentKey) continue;
      for (const [pkgId, mId] of Object.entries(w.duties || {})) {
        if (!mId) continue;
        historyCounts[mId] = (historyCounts[mId] || 0) + 1;
        packageHistory[pkgId] = packageHistory[pkgId] || [];
        packageHistory[pkgId].push({ wk, mId });
      }
    }

    const perMember = {};
    state.members.forEach(m => { perMember[m.id] = historyCounts[m.id] || 0; });

    state.packages.forEach(pkg => {
      const lastEntries = (packageHistory[pkg.id] || []).sort((a, b) => a.wk < b.wk ? 1 : -1);
      const lastM = lastEntries[0]?.mId;

      let candidates = state.members.slice().sort((a, b) => {
        const aTot = perMember[a.id], bTot = perMember[b.id];
        if (aTot !== bTot) return aTot - bTot;
        return Math.random() - 0.5;
      });
      // Wenn möglich, nicht dieselbe Person wie letzte Woche für dieses Paket
      if (candidates.length > 1 && lastM) {
        const nonRepeat = candidates.filter(m => m.id !== lastM);
        if (nonRepeat.length) candidates = nonRepeat;
      }
      const chosen = candidates[0];
      week.duties[pkg.id] = chosen.id;
      perMember[chosen.id] += 1;
    });

    save();
    renderDuties();
    toast('Fair verteilt');
  }

  // ------------------------------------------------------------------
  // Modal-Framework
  // ------------------------------------------------------------------
  const modalEl = document.getElementById('modal');
  const modalCard = document.getElementById('modal-card');

  function openModal(html, onMount) {
    modalCard.innerHTML = html;
    modalEl.hidden = false;
    document.body.style.overflow = 'hidden';
    onMount?.(modalCard);
  }
  function closeModal() {
    modalEl.hidden = true;
    modalCard.innerHTML = '';
    document.body.style.overflow = '';
  }
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });

  // ------------------------------------------------------------------
  // Meal-Picker
  // ------------------------------------------------------------------
  function openMealPicker(dateKey) {
    const week = getWeek(planningMonday);
    const usedIds = Object.values(week.menus).map(s => s?.recipeId).filter(Boolean);
    const suggestions = suggestRecipes({ excludeIds: usedIds, limit: 5 });

    openModal(`
      <h3>Menü für ${DAY_NAMES_LONG[weekdayIndexOf(dateKey)]}</h3>
      <label>Vorschläge</label>
      <ul class="suggest-list" id="pick-suggest">
        ${suggestions.length ? suggestions.map(s => `
          <li>
            <div class="info">
              <div class="title" style="font-weight:600">${escapeHtml(s.r.name)}</div>
              <div class="reason">${escapeHtml(s.reason)} · ${'★'.repeat(s.r.rating || 0) || '☆'}</div>
            </div>
            <button class="btn" data-suggest="${s.r.id}">Wählen</button>
          </li>
        `).join('') : `<li><div class="info muted small">Keine Rezepte in der Bibliothek — lege welche an oder gib unten einen freien Text ein.</div></li>`}
      </ul>

      <label>Aus Bibliothek</label>
      <select id="pick-select">
        <option value="">— wählen —</option>
        ${state.recipes.slice().sort((a,b)=>a.name.localeCompare(b.name,'de')).map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
      </select>

      <label>Oder freier Text</label>
      <input type="text" id="pick-free" placeholder="z. B. Reste vom Vortag" />

      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn" id="pick-save">Übernehmen</button>
      </div>
    `, (root) => {
      root.querySelectorAll('[data-suggest]').forEach(btn => btn.addEventListener('click', () => {
        setSlot(dateKey, { recipeId: btn.dataset.suggest, customName: null });
      }));
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#pick-save').addEventListener('click', () => {
        const sel = root.querySelector('#pick-select').value;
        const free = root.querySelector('#pick-free').value.trim();
        if (sel) setSlot(dateKey, { recipeId: sel, customName: null });
        else if (free) setSlot(dateKey, { recipeId: null, customName: free });
        else closeModal();
      });
    });
  }

  function weekdayIndexOf(dateKey) {
    const d = parseISO(dateKey);
    return (d.getDay() + 6) % 7;
  }

  function setSlot(dateKey, slot) {
    const week = getWeek(planningMonday);
    week.menus[dateKey] = slot;
    if (slot.recipeId) {
      const r = state.recipes.find(x => x.id === slot.recipeId);
      if (r) {
        r.lastUsedAt = dateKey;
        r.useCount = (r.useCount || 0) + 1;
      }
    }
    save();
    closeModal();
    renderMenus();
    toast('Gespeichert');
  }

  // ------------------------------------------------------------------
  // Rezept-Editor
  // ------------------------------------------------------------------
  function openRecipeEditor(id) {
    const isNew = !id;
    const r = isNew ? { id: uid(), name: '', tags: [], notes: '', rating: 0, ingredients: [], createdAt: isoDate(today()), lastUsedAt: null, useCount: 0 }
                    : { ...state.recipes.find(x => x.id === id) };

    openModal(`
      <h3>${isNew ? 'Neues Rezept' : 'Rezept bearbeiten'}</h3>
      <label>Name</label>
      <input type="text" id="r-name" value="${escapeHtml(r.name)}" placeholder="z. B. Linsencurry" />

      <label>Tags</label>
      <div class="chips" id="r-tags"></div>
      <input type="text" id="r-tag-new" placeholder="Tag hinzufügen…" />

      <label>Bewertung</label>
      <div class="stars-input" id="r-stars"></div>

      <label>Zutaten <span class="muted small">(für die Einkaufsliste)</span></label>
      <div class="ingredient-rows" id="r-ingredients"></div>
      <button type="button" class="btn ghost" id="r-add-ingredient">+ Zutat</button>

      <label>Notizen / Zubereitung</label>
      <textarea id="r-notes" placeholder="Kurze Notiz zur Zubereitung">${escapeHtml(r.notes || '')}</textarea>

      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn" id="r-save">Speichern</button>
      </div>
    `, (root) => {
      let chosenTags = [...r.tags];
      let rating = r.rating || 0;
      let ingredients = (r.ingredients || []).map(i => ({ ...i }));

      const renderIngredientRows = () => {
        const box = root.querySelector('#r-ingredients');
        box.innerHTML = ingredients.map((ing, idx) => `
          <div class="ingredient-row" data-idx="${idx}">
            <input type="text" class="ing-qty" placeholder="Menge" value="${escapeHtml(ing.quantity || '')}" />
            <input type="text" class="ing-unit" placeholder="Einheit" value="${escapeHtml(ing.unit || '')}" />
            <input type="text" class="ing-name" placeholder="Zutat" value="${escapeHtml(ing.name || '')}" />
            <button type="button" class="icon-btn ing-del" aria-label="Entfernen">×</button>
          </div>
        `).join('') || `<p class="muted small">Noch keine Zutaten.</p>`;
        box.querySelectorAll('.ingredient-row').forEach(row => {
          const idx = Number(row.dataset.idx);
          row.querySelector('.ing-qty').addEventListener('input', e => { ingredients[idx].quantity = e.target.value; });
          row.querySelector('.ing-unit').addEventListener('input', e => { ingredients[idx].unit = e.target.value; });
          row.querySelector('.ing-name').addEventListener('input', e => { ingredients[idx].name = e.target.value; });
          row.querySelector('.ing-del').addEventListener('click', () => { ingredients.splice(idx, 1); renderIngredientRows(); });
        });
      };
      renderIngredientRows();
      root.querySelector('#r-add-ingredient').addEventListener('click', () => {
        ingredients.push({ id: uid(), quantity: '', unit: '', name: '' });
        renderIngredientRows();
      });

      const renderTags = () => {
        const box = root.querySelector('#r-tags');
        const all = uniqueTags();
        box.innerHTML = all.map(t => `<button type="button" class="chip ${chosenTags.includes(t) ? 'on' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
        box.querySelectorAll('[data-tag]').forEach(btn => btn.addEventListener('click', () => {
          const t = btn.dataset.tag;
          chosenTags = chosenTags.includes(t) ? chosenTags.filter(x => x !== t) : [...chosenTags, t];
          renderTags();
        }));
      };
      renderTags();

      const renderStars = () => {
        const box = root.querySelector('#r-stars');
        box.innerHTML = '';
        for (let i = 1; i <= 5; i++) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = i <= rating ? '★' : '☆';
          b.className = i <= rating ? 'on' : '';
          b.addEventListener('click', () => { rating = (rating === i ? i - 1 : i); renderStars(); });
          box.appendChild(b);
        }
      };
      renderStars();

      root.querySelector('#r-tag-new').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = e.target.value.trim().toLowerCase();
          if (v && !chosenTags.includes(v)) chosenTags.push(v);
          e.target.value = '';
          renderTags();
        }
      });

      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#r-save').addEventListener('click', () => {
        const name = root.querySelector('#r-name').value.trim();
        if (!name) { toast('Name fehlt'); return; }
        r.name = name;
        r.tags = chosenTags;
        r.rating = rating;
        r.ingredients = ingredients
          .filter(i => (i.name || '').trim())
          .map(i => ({ id: i.id || uid(), quantity: (i.quantity || '').trim(), unit: (i.unit || '').trim(), name: i.name.trim() }));
        r.notes = root.querySelector('#r-notes').value.trim();
        if (isNew) state.recipes.push(r);
        else {
          const idx = state.recipes.findIndex(x => x.id === r.id);
          state.recipes[idx] = { ...state.recipes[idx], ...r };
        }
        save();
        closeModal();
        renderRecipes();
        toast(isNew ? 'Rezept angelegt' : 'Gespeichert');
      });
    });
  }

  function confirmDeleteRecipe(id) {
    const r = state.recipes.find(x => x.id === id);
    if (!r) return;
    openModal(`
      <h3>Rezept löschen?</h3>
      <p>„${escapeHtml(r.name)}" wird aus der Bibliothek entfernt. Bereits geplante Menüs bleiben als Text erhalten.</p>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn danger" id="del-ok">Löschen</button>
      </div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#del-ok').addEventListener('click', () => {
        // Menüs, die auf dieses Rezept zeigen, in customName umwandeln
        Object.values(state.weeks).forEach(w => {
          Object.entries(w.menus).forEach(([k, s]) => {
            if (s?.recipeId === id) w.menus[k] = { recipeId: null, customName: r.name };
          });
        });
        state.recipes = state.recipes.filter(x => x.id !== id);
        save();
        closeModal();
        renderRecipes();
        toast('Gelöscht');
      });
    });
  }

  // ------------------------------------------------------------------
  // Paket-Editor
  // ------------------------------------------------------------------
  function openPackageEditor(id) {
    const isNew = !id;
    const p = isNew ? { id: uid(), name: '', items: [], frequency: 'wöchentlich' }
                    : { ...state.packages.find(x => x.id === id) };

    openModal(`
      <h3>${isNew ? 'Neues Paket' : 'Paket bearbeiten'}</h3>
      <label>Name</label>
      <input type="text" id="p-name" value="${escapeHtml(p.name)}" placeholder="z. B. Küche wischen" />

      <label>Punkte <span class="muted small">(was gehört dazu?)</span></label>
      <div class="item-rows" id="p-items"></div>
      <button type="button" class="btn ghost" id="p-add-item">+ Punkt</button>

      <label>Häufigkeit</label>
      <select id="p-freq">
        <option ${p.frequency === 'wöchentlich' ? 'selected' : ''}>wöchentlich</option>
        <option ${p.frequency === '2× pro Woche' ? 'selected' : ''}>2× pro Woche</option>
        <option ${p.frequency === 'täglich' ? 'selected' : ''}>täglich</option>
        <option ${p.frequency === '14-täglich' ? 'selected' : ''}>14-täglich</option>
        <option ${p.frequency === 'monatlich' ? 'selected' : ''}>monatlich</option>
      </select>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn" id="p-save">Speichern</button>
      </div>
    `, (root) => {
      // Ältere Pakete hatten ein Freitext-"description"-Feld statt einer Liste —
      // beim Öffnen an Kommas aufsplitten, damit bestehende Inhalte nicht verloren gehen.
      let items = p.items && p.items.length
        ? p.items.map(i => ({ ...i }))
        : (p.description || '').split(',').map(s => s.trim()).filter(Boolean).map(text => ({ id: uid(), text }));

      const renderItemRows = () => {
        const box = root.querySelector('#p-items');
        box.innerHTML = items.map((item, idx) => `
          <div class="item-row" data-idx="${idx}">
            <input type="text" class="item-text" placeholder="z. B. Boden wischen" value="${escapeHtml(item.text || '')}" />
            <button type="button" class="icon-btn item-del" aria-label="Entfernen">×</button>
          </div>
        `).join('') || `<p class="muted small">Noch keine Punkte.</p>`;
        box.querySelectorAll('.item-row').forEach(row => {
          const idx = Number(row.dataset.idx);
          row.querySelector('.item-text').addEventListener('input', e => { items[idx].text = e.target.value; });
          row.querySelector('.item-del').addEventListener('click', () => { items.splice(idx, 1); renderItemRows(); });
        });
      };
      renderItemRows();
      root.querySelector('#p-add-item').addEventListener('click', () => {
        items.push({ id: uid(), text: '' });
        renderItemRows();
      });

      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#p-save').addEventListener('click', () => {
        const name = root.querySelector('#p-name').value.trim();
        if (!name) { toast('Name fehlt'); return; }
        p.name = name;
        p.items = items
          .filter(i => (i.text || '').trim())
          .map(i => ({ id: i.id || uid(), text: i.text.trim() }));
        delete p.description;
        p.frequency = root.querySelector('#p-freq').value;
        if (isNew) state.packages.push(p);
        else {
          const idx = state.packages.findIndex(x => x.id === p.id);
          state.packages[idx] = { ...state.packages[idx], ...p };
          delete state.packages[idx].description;
        }
        save();
        closeModal();
        renderPackages();
        toast(isNew ? 'Paket angelegt' : 'Gespeichert');
      });
    });
  }

  function confirmDeletePackage(id) {
    const p = state.packages.find(x => x.id === id);
    if (!p) return;
    openModal(`
      <h3>Paket löschen?</h3>
      <p>„${escapeHtml(p.name)}" wird aus der Bibliothek entfernt.</p>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn danger" id="del-ok">Löschen</button>
      </div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#del-ok').addEventListener('click', () => {
        state.packages = state.packages.filter(x => x.id !== id);
        Object.values(state.weeks).forEach(w => { if (w.duties) delete w.duties[id]; });
        save();
        closeModal();
        renderPackages();
        toast('Gelöscht');
      });
    });
  }

  // ------------------------------------------------------------------
  // Mitglieder-Editor
  // ------------------------------------------------------------------
  const MEMBER_COLORS = ['#7aa8ff', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#38bdf8', '#f472b6', '#fb923c'];

  function openMemberEditor(id) {
    const isNew = !id;
    const m = isNew ? { id: uid(), name: '', color: MEMBER_COLORS[state.members.length % MEMBER_COLORS.length] }
                    : { ...state.members.find(x => x.id === id) };

    openModal(`
      <h3>${isNew ? 'Neue Person' : 'Person bearbeiten'}</h3>
      <label>Name</label>
      <input type="text" id="m-name" value="${escapeHtml(m.name)}" placeholder="z. B. Anna" />
      <label>Farbe</label>
      <div class="chips" id="m-colors">
        ${MEMBER_COLORS.map(c => `<button type="button" class="chip" data-color="${c}" style="border-color:${c === m.color ? c : 'var(--line)'};background:${c === m.color ? c : 'var(--card-2)'};color:${c === m.color ? '#0b1020' : 'var(--text)'}">●</button>`).join('')}
      </div>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn" id="m-save">Speichern</button>
      </div>
    `, (root) => {
      let color = m.color;
      root.querySelectorAll('[data-color]').forEach(btn => btn.addEventListener('click', () => {
        color = btn.dataset.color;
        root.querySelectorAll('[data-color]').forEach(b => {
          const c = b.dataset.color;
          b.style.borderColor = c === color ? c : 'var(--line)';
          b.style.background = c === color ? c : 'var(--card-2)';
          b.style.color = c === color ? '#0b1020' : 'var(--text)';
        });
      }));
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#m-save').addEventListener('click', () => {
        const name = root.querySelector('#m-name').value.trim();
        if (!name) { toast('Name fehlt'); return; }
        m.name = name; m.color = color;
        if (isNew) state.members.push(m);
        else {
          const idx = state.members.findIndex(x => x.id === m.id);
          state.members[idx] = { ...state.members[idx], ...m };
        }
        save();
        closeModal();
        renderPackages();
        toast(isNew ? 'Person hinzugefügt' : 'Gespeichert');
      });
    });
  }

  function confirmDeleteMember(id) {
    const m = state.members.find(x => x.id === id);
    if (!m) return;
    openModal(`
      <h3>Person entfernen?</h3>
      <p>„${escapeHtml(m.name)}" wird gelöscht. Zuweisungen dieser Person bleiben in vergangenen Wochen als Referenz erhalten, werden aber als „gelöscht" angezeigt.</p>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn danger" id="del-ok">Entfernen</button>
      </div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#del-ok').addEventListener('click', () => {
        state.members = state.members.filter(x => x.id !== id);
        save();
        closeModal();
        renderPackages();
        toast('Entfernt');
      });
    });
  }

  // ------------------------------------------------------------------
  // Assign-Picker
  // ------------------------------------------------------------------
  function openAssignPicker(pkgId) {
    const week = getWeek(dutyMonday);
    const pkg = state.packages.find(p => p.id === pkgId);
    const current = week.duties[pkgId];
    if (!state.members.length) {
      openModal(`
        <h3>Keine Familienmitglieder</h3>
        <p>Lege im Tab „Pakete" unter „Familie" mindestens eine Person an.</p>
        <div class="actions"><button class="btn" data-close>Ok</button></div>
      `, (root) => root.querySelector('[data-close]').addEventListener('click', closeModal));
      return;
    }
    openModal(`
      <h3>${escapeHtml(pkg.name)} zuweisen</h3>
      <ul class="suggest-list">
        <li>
          <div class="info"><div class="title">Niemand</div></div>
          <button class="btn ghost" data-choose="">Wählen</button>
        </li>
        ${state.members.map(m => `
          <li>
            <div class="info">
              <div class="title" style="display:flex;align-items:center;gap:8px">
                <span class="swatch" style="background:${m.color};width:14px;height:14px;border-radius:50%"></span>
                ${escapeHtml(m.name)}
              </div>
              <div class="reason">${current === m.id ? 'aktuell zugewiesen' : ''}</div>
            </div>
            <button class="btn" data-choose="${m.id}">Wählen</button>
          </li>
        `).join('')}
      </ul>
      <div class="actions"><button class="btn ghost" data-close>Abbrechen</button></div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelectorAll('[data-choose]').forEach(btn => btn.addEventListener('click', () => {
        const v = btn.dataset.choose;
        if (v) week.duties[pkgId] = v;
        else delete week.duties[pkgId];
        save();
        closeModal();
        renderDuties();
        toast('Zugewiesen');
      }));
    });
  }

  // ------------------------------------------------------------------
  // Toast
  // ------------------------------------------------------------------
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // ------------------------------------------------------------------
  // Bring! Anbindung (über eigenen Proxy — Bring hat keine öffentliche API)
  // ------------------------------------------------------------------
  function bringBase() {
    return (state.settings.bringApiBase || '').replace(/\/+$/, '');
  }

  async function bringLogin(email, password) {
    const base = bringBase();
    if (!base) throw new Error('Backend-URL fehlt');
    const res = await fetch(`${base}/api/bring/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.accessToken) throw new Error(data?.error || 'Login fehlgeschlagen');
    state.bring = {
      ...(state.bring || {}),
      uuid: data.uuid,
      accessToken: data.accessToken,
      expiresAt: Date.now() + (data.expiresIn || 3600) * 1000,
      email,
    };
    save();
    return bringFetchLists();
  }

  async function bringFetchLists() {
    const base = bringBase();
    const res = await fetch(`${base}/api/bring/lists?uuid=${encodeURIComponent(state.bring.uuid)}`, {
      headers: { Authorization: `Bearer ${state.bring.accessToken}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Listen konnten nicht geladen werden');
    return data.lists || [];
  }

  async function bringSendItems(items) {
    if (!state.bring?.accessToken) throw new Error('Nicht verbunden');
    if (!state.bring.listUuid) throw new Error('Keine Bring-Liste ausgewählt');
    const base = bringBase();
    const res = await fetch(`${base}/api/bring/item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.bring.accessToken}` },
      body: JSON.stringify({ uuid: state.bring.uuid, listUuid: state.bring.listUuid, items }),
    });
    if (res.status === 401 || res.status === 403) throw new Error('EXPIRED');
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Senden fehlgeschlagen');
    return data;
  }

  function openBringConnectModal() {
    openModal(`
      <h3>Mit Bring! verbinden</h3>
      <label>E-Mail</label>
      <input type="email" id="bring-email" value="${escapeHtml(state.bring?.email || '')}" placeholder="deine@email.de" />
      <label>Passwort</label>
      <input type="password" id="bring-password" placeholder="Passwort" />
      <p class="muted small">Wird nicht gespeichert, nur über euren eigenen Proxy zum Anmelden bei Bring verwendet.</p>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn" id="bring-login-go">Anmelden</button>
      </div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#bring-login-go').addEventListener('click', async () => {
        const email = root.querySelector('#bring-email').value.trim();
        const password = root.querySelector('#bring-password').value;
        if (!email || !password) { toast('E-Mail und Passwort fehlen'); return; }
        const btn = root.querySelector('#bring-login-go');
        btn.disabled = true; btn.textContent = 'Verbinde…';
        try {
          const lists = await bringLogin(email, password);
          closeModal();
          const prev = lists.find(l => l.listUuid === state.bring.listUuid);
          if (prev) {
            toast(`Verbunden mit „${prev.name}"`);
            if (currentView === 'settings') renderSettings();
          } else {
            openBringListPicker(lists);
          }
        } catch (e) {
          toast(e.message || 'Verbindung fehlgeschlagen');
          btn.disabled = false; btn.textContent = 'Anmelden';
        }
      });
    });
  }

  function openBringListPicker(lists) {
    if (!lists.length) { toast('Keine Bring-Listen gefunden'); return; }
    openModal(`
      <h3>Welche Bring-Liste?</h3>
      <ul class="suggest-list">
        ${lists.map(l => `
          <li>
            <div class="info"><div class="title">${escapeHtml(l.name)}</div></div>
            <button class="btn" data-pick-list="${l.listUuid}" data-pick-name="${escapeHtml(l.name)}">Wählen</button>
          </li>
        `).join('')}
      </ul>
      <div class="actions"><button class="btn ghost" data-close>Abbrechen</button></div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelectorAll('[data-pick-list]').forEach(btn => btn.addEventListener('click', () => {
        state.bring.listUuid = btn.dataset.pickList;
        state.bring.listName = btn.dataset.pickName;
        save();
        closeModal();
        toast(`Verbunden mit „${btn.dataset.pickName}"`);
        if (currentView === 'settings') renderSettings();
      }));
    });
  }

  // ------------------------------------------------------------------
  // Import / Export / Seed / Reset
  // ------------------------------------------------------------------
  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  function seedData() {
    const anna = { id: uid(), name: 'Anna', color: MEMBER_COLORS[0] };
    const ben = { id: uid(), name: 'Ben', color: MEMBER_COLORS[1] };
    const kids = { id: uid(), name: 'Kids', color: MEMBER_COLORS[2] };
    state.members = [anna, ben, kids];
    state.recipes = [
      { id: uid(), name: 'Linsencurry', tags: ['vegetarisch', 'schnell', 'klassiker'], notes: 'Rote Linsen, Kokosmilch, Curry.', rating: 5, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0, ingredients: [
        { id: uid(), quantity: '200', unit: 'g', name: 'rote Linsen' },
        { id: uid(), quantity: '400', unit: 'ml', name: 'Kokosmilch' },
        { id: uid(), quantity: '1', unit: 'EL', name: 'Currypulver' },
        { id: uid(), quantity: '1', unit: '', name: 'Zwiebel' },
      ] },
      { id: uid(), name: 'Ofengemüse mit Feta', tags: ['vegetarisch', 'ofen', 'schnell'], notes: '', rating: 4, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0, ingredients: [
        { id: uid(), quantity: '500', unit: 'g', name: 'Ofengemüse (Mix)' },
        { id: uid(), quantity: '200', unit: 'g', name: 'Feta' },
        { id: uid(), quantity: '2', unit: 'EL', name: 'Olivenöl' },
      ] },
      { id: uid(), name: 'Spaghetti Bolognese', tags: ['klassiker', 'kinderfreundlich'], notes: '', rating: 5, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0, ingredients: [
        { id: uid(), quantity: '500', unit: 'g', name: 'Spaghetti' },
        { id: uid(), quantity: '400', unit: 'g', name: 'Hackfleisch' },
        { id: uid(), quantity: '1', unit: 'Dose', name: 'stückige Tomaten' },
      ] },
      { id: uid(), name: 'Kürbissuppe', tags: ['suppe', 'saisonal', 'vegetarisch'], notes: '', rating: 4, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0, ingredients: [] },
      { id: uid(), name: 'Pfannkuchen', tags: ['süß', 'kinderfreundlich', 'schnell'], notes: '', rating: 3, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0 },
      { id: uid(), name: 'Wraps mit Hummus', tags: ['vegetarisch', 'schnell'], notes: '', rating: 4, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0 },
      { id: uid(), name: 'Fischstäbchen mit Kartoffelbrei', tags: ['klassiker', 'kinderfreundlich'], notes: '', rating: 3, createdAt: isoDate(today()), lastUsedAt: null, useCount: 0 },
    ];
    state.packages = [
      { id: uid(), name: 'Bad putzen', frequency: 'wöchentlich', items: [
        { id: uid(), text: 'WC, Lavabo, Dusche' },
        { id: uid(), text: 'Spiegel & Armaturen' },
        { id: uid(), text: 'Boden wischen' },
        { id: uid(), text: 'Handtücher wechseln' },
      ] },
      { id: uid(), name: 'Wohnbereich ordnen', frequency: 'wöchentlich', items: [
        { id: uid(), text: 'Spielsachen einräumen' },
        { id: uid(), text: 'Sofa & Teppich richten' },
        { id: uid(), text: 'Tische abräumen & wischen' },
        { id: uid(), text: 'Kissen & Decken aufschütteln' },
      ] },
      { id: uid(), name: 'Boden saugen & wischen', frequency: 'wöchentlich', items: [
        { id: uid(), text: 'Alle Wohnräume saugen' },
        { id: uid(), text: 'Hartböden feucht wischen' },
        { id: uid(), text: 'Teppich-Flecken behandeln' },
        { id: uid(), text: 'Staubsaugerbeutel im Blick' },
      ] },
      { id: uid(), name: 'Lüften & Betten', frequency: 'täglich', items: [
        { id: uid(), text: 'Morgens stosslüften' },
        { id: uid(), text: 'Betten aufschütteln & richten' },
        { id: uid(), text: 'Pyjamas zusammenlegen & versorgen' },
        { id: uid(), text: 'Nach Duschen & Kochen lüften' },
      ] },
      { id: uid(), name: 'Zmorge vorbereiten', frequency: 'täglich', items: [
        { id: uid(), text: 'Tisch decken' },
        { id: uid(), text: 'Brot, Müesli, Aufstrich bereit' },
        { id: uid(), text: 'Tee, Milch, Saft' },
        { id: uid(), text: 'An Vorlieben der Kinder denken' },
      ] },
      { id: uid(), name: 'Haustiere füttern', frequency: 'täglich', items: [
        { id: uid(), text: 'Morgens & abends füttern' },
        { id: uid(), text: 'Frisches Wasser täglich' },
        { id: uid(), text: 'Schlafplatz / Kistchen sauber' },
        { id: uid(), text: 'Futtervorrat im Blick' },
      ] },
      { id: uid(), name: 'Pflanzen giessen', frequency: 'wöchentlich', items: [
        { id: uid(), text: 'Innen & draussen schauen' },
        { id: uid(), text: 'Wer braucht Wasser?' },
        { id: uid(), text: 'Gelbe Blätter zupfen' },
        { id: uid(), text: 'Bei Hitze öfter giessen' },
      ] },
      { id: uid(), name: 'Wochenkalender', frequency: 'wöchentlich', items: [
        { id: uid(), text: 'Alle Termine eintragen' },
        { id: uid(), text: 'Family-Sharing aktualisieren' },
        { id: uid(), text: 'Doppelbuchungen klären' },
        { id: uid(), text: 'Erinnerungen rechtzeitig setzen' },
      ] },
    ];
    save();
    render();
    toast('Beispieldaten geladen');
  }

  function resetAll() {
    openModal(`
      <h3>Alles zurücksetzen?</h3>
      <p>Rezepte, Pakete, Wochenpläne und Personen werden gelöscht. Nicht rückgängig zu machen.</p>
      <div class="actions">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn danger" id="reset-ok">Zurücksetzen</button>
      </div>
    `, (root) => {
      root.querySelector('[data-close]').addEventListener('click', closeModal);
      root.querySelector('#reset-ok').addEventListener('click', () => {
        state = DEFAULT_STATE();
        save();
        closeModal();
        go('meeting');
        toast('Zurückgesetzt');
      });
    });
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        state = { ...DEFAULT_STATE(), ...data };
        save();
        render();
        toast('Importiert');
      } catch (e) {
        toast('Datei konnte nicht gelesen werden');
      }
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------
  // Event Wiring
  // ------------------------------------------------------------------
  function wire() {
    document.querySelectorAll('[data-go]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); go(el.dataset.go); });
    });

    // Meeting
    // (Agenda-Links greifen über [data-go])

    // Menüs
    document.getElementById('btn-week-prev').addEventListener('click', () => { planningMonday = addDays(planningMonday, -7); renderMenus(); });
    document.getElementById('btn-week-next').addEventListener('click', () => { planningMonday = addDays(planningMonday, 7); renderMenus(); });
    document.getElementById('btn-week-clear').addEventListener('click', () => {
      const w = getWeek(planningMonday);
      w.menus = {};
      save(); renderMenus(); toast('Woche geleert');
    });
    document.getElementById('btn-week-fill').addEventListener('click', fillWeekWithSuggestions);
    document.getElementById('btn-go-shopping').addEventListener('click', () => go('shopping'));

    // Einkaufsliste
    document.getElementById('btn-shop-week-prev').addEventListener('click', () => { planningMonday = addDays(planningMonday, -7); renderShopping(); });
    document.getElementById('btn-shop-week-next').addEventListener('click', () => { planningMonday = addDays(planningMonday, 7); renderShopping(); });
    document.getElementById('btn-shopping-add').addEventListener('click', addShoppingExtra);
    document.getElementById('shopping-add-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addShoppingExtra(); }
    });
    document.getElementById('btn-shopping-clear-done').addEventListener('click', () => {
      const week = getWeek(planningMonday);
      week.shoppingChecked = {};
      week.shoppingExtra = week.shoppingExtra.filter(x => !x.done);
      save(); renderShopping(); toast('Erledigte entfernt');
    });
    document.getElementById('btn-shopping-copy').addEventListener('click', copyShoppingList);
    document.getElementById('btn-shopping-bring').addEventListener('click', async () => {
      const texts = shoppingOpenItems(planningMonday);
      if (!texts.length) { toast('Liste ist leer'); return; }
      if (!state.settings.bringApiBase) { toast('Erst in Einstellungen Bring verbinden'); go('settings'); return; }
      if (!state.bring?.accessToken) { openBringConnectModal(); return; }
      if (state.bring.expiresAt && Date.now() > state.bring.expiresAt) {
        toast('Bring-Sitzung abgelaufen, bitte neu verbinden');
        openBringConnectModal();
        return;
      }
      try {
        await bringSendItems(texts.map(name => ({ name })));
        toast('An Bring gesendet');
      } catch (e) {
        if (e.message === 'EXPIRED') {
          toast('Bring-Sitzung abgelaufen, bitte neu verbinden');
          openBringConnectModal();
        } else {
          toast(e.message || 'Senden fehlgeschlagen');
        }
      }
    });

    // Rezepte
    document.getElementById('btn-add-recipe').addEventListener('click', () => openRecipeEditor(null));
    document.getElementById('recipe-search').addEventListener('input', (e) => {
      recipeFilter.text = e.target.value;
      renderRecipes();
    });

    // Duties
    document.getElementById('btn-duty-week-prev').addEventListener('click', () => { dutyMonday = addDays(dutyMonday, -7); renderDuties(); });
    document.getElementById('btn-duty-week-next').addEventListener('click', () => { dutyMonday = addDays(dutyMonday, 7); renderDuties(); });
    document.getElementById('btn-duty-clear').addEventListener('click', () => {
      const w = getWeek(dutyMonday);
      w.duties = {};
      save(); renderDuties(); toast('Zurückgesetzt');
    });
    document.getElementById('btn-duty-auto').addEventListener('click', autoDistributeDuties);

    // Pakete & Familie
    document.getElementById('btn-add-package').addEventListener('click', () => openPackageEditor(null));
    document.getElementById('btn-add-member').addEventListener('click', () => openMemberEditor(null));

    // Notizen
    document.getElementById('btn-add-note').addEventListener('click', () => {
      openModal(`
        <h3>Neues Thema</h3>
        <label>Thema</label>
        <textarea id="n-text" placeholder="Worüber wollt ihr sprechen?"></textarea>
        <div class="actions">
          <button class="btn ghost" data-close>Abbrechen</button>
          <button class="btn" id="n-save">Hinzufügen</button>
        </div>
      `, (root) => {
        root.querySelector('[data-close]').addEventListener('click', closeModal);
        root.querySelector('#n-save').addEventListener('click', () => {
          const text = root.querySelector('#n-text').value.trim();
          if (!text) { toast('Text fehlt'); return; }
          const week = getWeek(defaultPlanningMonday());
          week.notes.push({ id: uid(), text, done: false });
          save(); closeModal(); renderNotes();
        });
      });
    });

    // Einstellungen
    document.getElementById('btn-export').addEventListener('click', () => {
      download(`familienmeeting-${isoDate(today())}.json`, JSON.stringify(state, null, 2));
    });
    document.getElementById('file-import').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });
    document.getElementById('btn-seed').addEventListener('click', seedData);
    document.getElementById('btn-reset').addEventListener('click', resetAll);

    document.getElementById('bring-api-base').addEventListener('change', (e) => {
      state.settings.bringApiBase = e.target.value.trim();
      save();
    });
    document.getElementById('btn-bring-connect').addEventListener('click', () => {
      if (!state.settings.bringApiBase) { toast('Erst Backend-URL eintragen'); return; }
      openBringConnectModal();
    });
    document.getElementById('btn-bring-disconnect').addEventListener('click', () => {
      state.bring = null;
      save();
      renderSettings();
      toast('Getrennt');
    });

    // Haushalt
    document.getElementById('btn-household-invite').addEventListener('click', async () => {
      const input = document.getElementById('household-invite-email');
      const email = input.value.trim();
      if (!email || !householdId) return;
      try {
        const { error } = await sb.from('household_members').insert({ household_id: householdId, email, role: 'member' });
        if (error) throw error;
        input.value = '';
        toast('Eingeladen');
        renderHouseholdSettings();
      } catch (e) {
        toast(e.message || 'Einladen fehlgeschlagen');
      }
    });
    document.getElementById('btn-signout').addEventListener('click', async () => {
      await sb.auth.signOut();
      window.location.reload();
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    wireAuthGate();
    wireHouseholdGate();
    showOnly('auth-gate');

    if (!window.supabase) {
      document.getElementById('auth-step-email').hidden = true;
      const errorEl = document.getElementById('auth-error');
      errorEl.textContent = 'Verbindung zu Supabase konnte nicht geladen werden. Internetverbindung prüfen und Seite neu laden.';
      errorEl.hidden = false;
      return;
    }

    sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.publishableKey);
    sb.auth.onAuthStateChange((_event, session) => {
      if (session) {
        enterApp(session);
      } else {
        currentSession = null;
        showOnly('auth-gate');
      }
    });
  });
})();
