// ─── State ───────────────────────────────────────────────────────────
const SESSION_KEY = 'viberegress_session_id';
const TRIAL_RUNS_KEY = 'viberegress_trial_runs_used';

let scenarios = [];
let activeScenarioId = null;
let selectedSiteUrl = null;
let discoveredScenarios = null;
let authProfiles = [];
let authProfileValidity = new Map();
let activeStepEditIndex = null;

let sessionId = null;
let supabaseClient = null;
let accessToken = null;
let authConfigured = false;
let cachedUserEmail = '';

function isLoggedIn() {
  return !!accessToken;
}

function trialRunsUsed() {
  return Number(sessionStorage.getItem(TRIAL_RUNS_KEY) || '0');
}

function trialRunsRemaining() {
  return Math.max(0, 2 - trialRunsUsed());
}

// ─── DOM refs ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const views = {
  welcome:      $('view-welcome'),
  discovery:    $('view-discovery'),
  scenario:     $('view-scenario'),
  authProfiles: $('view-auth-profiles'),
  site:         $('view-site'),
};

// ─── View switching ──────────────────────────────────────────────────
function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

// ─── Overlay ─────────────────────────────────────────────────────────
function showOverlay(msg) {
  $('overlay-msg').textContent = msg;
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ─── API helpers ─────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
  else if (sessionId) headers['X-Session-Id'] = sessionId;
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function initAuth() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    authConfigured = !!cfg.authConfigured;
    sessionId = sessionStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, sessionId);
    }
    const hintEl = $('auth-config-hint');
    if (hintEl) {
      hintEl.hidden = authConfigured;
    }
    const g = typeof supabase !== 'undefined' ? supabase : null;
    if (authConfigured && cfg.supabaseUrl && cfg.supabaseAnonKey && g && typeof g.createClient === 'function') {
      supabaseClient = g.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { detectSessionInUrl: true, flowType: 'pkce' },
      });
      const { data: { session } } = await supabaseClient.auth.getSession();
      accessToken = session?.access_token ?? null;
      cachedUserEmail = session?.user?.email || '';
      supabaseClient.auth.onAuthStateChange(async (_event, sess) => {
        const prev = accessToken;
        accessToken = sess?.access_token ?? null;
        cachedUserEmail = sess?.user?.email || '';
        if (accessToken && !prev && sessionId) {
          try {
            await fetch('/api/auth/claim-session', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + accessToken,
              },
              body: JSON.stringify({ sessionId }),
            });
            sessionStorage.removeItem(TRIAL_RUNS_KEY);
          } catch (_) { /* ignore */ }
        }
        updateAuthChrome();
        try {
          await loadScenarios();
          renderSidebarList();
          await loadAuthProfiles();
          if ($('auth-profiles-list')) renderAuthProfilesList();
          if (views.site && views.site.classList.contains('active')) renderSiteView();
          if (activeScenarioId && scenarios.some(s => s.id === activeScenarioId)) {
            openScenario(activeScenarioId);
          } else if (scenarios.length > 0) {
            openScenario(scenarios[0].id);
          } else {
            activeScenarioId = null;
            showView('welcome');
          }
        } catch (_) { /* ignore */ }
      });
    }
  } catch (e) {
    console.warn('Auth init failed', e);
  }
  updateAuthChrome();
}

function updateAuthChrome() {
  const banner = $('trial-banner');
  const runsText = $('trial-runs-text');
  const emailEl = $('auth-user-email');
  const btnOut = $('btn-sign-out');
  if (!banner || !runsText || !emailEl) return;
  if (isLoggedIn()) {
    banner.hidden = true;
    emailEl.textContent = cachedUserEmail || 'Signed in';
    const anonActions = $('auth-user-actions-anon');
    if (anonActions) anonActions.classList.add('hidden');
    if (btnOut) btnOut.hidden = false;
  } else {
    banner.hidden = false;
    const left = trialRunsRemaining();
    runsText.textContent = left > 0 ? left + ' free run' + (left === 1 ? '' : 's') + ' left' : 'No runs left — sign up to continue';
    emailEl.textContent = 'Trial mode';
    const anonActions = $('auth-user-actions-anon');
    if (anonActions) anonActions.classList.remove('hidden');
    if (btnOut) btnOut.hidden = true;
  }
}

function openAuthModal() {
  const ov = $('auth-overlay');
  if (ov) {
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
  }
  const err = $('auth-error');
  if (err) { err.classList.add('hidden'); err.textContent = ''; }
}

function closeAuthModal() {
  const ov = $('auth-overlay');
  if (ov) {
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
  }
}

let authModalTab = 'signup';

function switchAuthTab(tab) {
  authModalTab = tab;
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-auth-tab') === tab);
  });
  const sub = $('auth-submit-email');
  if (sub) sub.textContent = tab === 'signup' ? 'Create account' : 'Sign in';
}

function bindAuthUi() {
  $('btn-auth-signup')?.addEventListener('click', () => {
    switchAuthTab('signup');
    openAuthModal();
  });
  $('btn-auth-signin')?.addEventListener('click', () => {
    switchAuthTab('signin');
    openAuthModal();
  });
  $('auth-modal-close')?.addEventListener('click', closeAuthModal);
  $('auth-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'auth-overlay') closeAuthModal();
  });
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.addEventListener('click', () => switchAuthTab(t.getAttribute('data-auth-tab') || 'signup'));
  });
  $('auth-form-email')?.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('auth-error');
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
    const email = $('auth-email')?.value?.trim();
    const password = $('auth-password')?.value;
    if (!email || !password) return;
    if (!supabaseClient) {
      if (errEl) {
        errEl.textContent = 'Sign-in is not configured. Add Supabase keys to .env.';
        errEl.classList.remove('hidden');
      }
      return;
    }
    try {
      if (authModalTab === 'signup') {
        const { error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
          closeAuthModal();
        } else if (errEl) {
          errEl.textContent = 'Check your email to confirm, then sign in.';
          errEl.classList.remove('hidden');
        }
      } else {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        closeAuthModal();
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Something went wrong';
        errEl.classList.remove('hidden');
      }
    }
  });
  $('auth-google')?.addEventListener('click', async () => {
    const errEl = $('auth-error');
    if (!supabaseClient) {
      if (errEl) {
        errEl.textContent = 'Configure Supabase in .env (see SUPABASE_SETUP.md).';
        errEl.classList.remove('hidden');
      }
      return;
    }
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/' },
    });
    if (error && errEl) {
      errEl.textContent = error.message;
      errEl.classList.remove('hidden');
    }
  });
  $('btn-sign-out')?.addEventListener('click', async () => {
    if (supabaseClient) await supabaseClient.auth.signOut();
    accessToken = null;
    cachedUserEmail = '';
    updateAuthChrome();
    try {
      await loadScenarios();
      renderSidebarList();
      await loadAuthProfiles();
      if (scenarios.length > 0) openScenario(scenarios[0].id);
      else { activeScenarioId = null; showView('welcome'); }
    } catch (_) {}
  });
}

// ─── Scenario list (sidebar) ─────────────────────────────────────────
const expandedSites = new Set();

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function toggleSiteGroup(siteUrl) {
  if (expandedSites.has(siteUrl)) expandedSites.delete(siteUrl);
  else expandedSites.add(siteUrl);
  renderSidebarList();
}

function renderSidebarList() {
  const ul = $('scenario-list');
  if (!scenarios.length) {
    ul.innerHTML = '<li class="empty-state">No scenarios yet.<br/>Scan a site to get started.</li>';
    return;
  }

  const grouped = new Map();
  for (const s of scenarios) {
    const key = s.siteUrl || 'Unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s);
  }

  // Auto-expand all groups on first render
  if (expandedSites.size === 0) {
    for (const key of grouped.keys()) expandedSites.add(key);
  }

  let html = '';
  const esc = u => u.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  for (const [siteUrl, items] of grouped) {
    const isOpen = expandedSites.has(siteUrl);
    const hostname = hostnameFromUrl(siteUrl);

    html += `
      <li class="site-group">
        <div class="site-header">
          <span class="site-chevron ${isOpen ? 'open' : ''}" onclick="event.stopPropagation(); toggleSiteGroup('${esc(siteUrl)}')" role="button" aria-label="Expand/collapse">›</span>
          <span class="site-favicon" title="${escapeHtml(siteUrl)}">⬡</span>
          <span class="site-hostname site-open-link" role="button" onclick="event.stopPropagation(); openSite('${esc(siteUrl)}')">${hostname}</span>
          <span class="site-count">${items.length}</span>
        </div>
        ${isOpen ? `<ul class="site-scenarios">
          ${items.map(s => `
            <li class="scenario-item ${s.lastStatus || 'never'} ${s.id === activeScenarioId ? 'active' : ''}"
                data-id="${s.id}" onclick="openScenario('${s.id}')">
              <span class="s-dot"></span>
              <span class="s-name">${s.name}</span>
            </li>
          `).join('')}
        </ul>` : ''}
      </li>`;
  }

  ul.innerHTML = html;
}

function openSite(siteUrl) {
  selectedSiteUrl = siteUrl || null;
  if (views.site) {
    renderSiteView();
    showView('site');
  }
}

function renderSiteView() {
  if (!selectedSiteUrl || !views.site) return;
  const hostname = hostnameFromUrl(selectedSiteUrl);
  $('site-page-title').textContent = hostname;
  $('site-page-url').textContent = selectedSiteUrl;

  const siteScenarios = scenarios.filter(s => (s.siteUrl || '') === selectedSiteUrl);
  const listEl = $('site-scenario-list');
  if (!listEl) return;
  if (!siteScenarios.length) {
    listEl.innerHTML = '<li class="empty-state">No scenarios for this site. Create one with "New scenario (AI)".</li>';
  } else {
    listEl.innerHTML = siteScenarios.map(s => `
      <li class="site-scenario-row" data-id="${s.id}">
        <span class="scenario-item ${s.lastStatus || 'never'} ${s.id === activeScenarioId ? 'active' : ''}"
              onclick="openScenario('${s.id}')">
          <span class="s-dot"></span>
          <span class="s-name">${escapeHtml(s.name)}</span>
        </span>
        <button type="button" class="btn-secondary btn-sm site-scenario-delete" data-id="${s.id}">Delete</button>
      </li>
    `).join('');
    listEl.querySelectorAll('.site-scenario-delete').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); deleteScenarioFromSite(btn.dataset.id); };
    });
  }

  $('site-auth-form-base-url').value = selectedSiteUrl;
  renderSiteAuthList();
}

function renderSiteAuthList() {
  const listEl = $('site-auth-list');
  if (!listEl || !selectedSiteUrl) return;
  const base = selectedSiteUrl.replace(/\/$/, '');
  const forSite = authProfiles.filter(p => {
    const pBase = (p.baseUrl || '').replace(/\/$/, '');
    return pBase === base || selectedSiteUrl.startsWith(pBase) || pBase.startsWith(base);
  });
  if (!forSite.length) {
    listEl.innerHTML = '<p class="empty-state">No auth profile yet. Expand <strong>Add auth profile</strong> below and paste cookies after you log in.</p>';
  } else {
    listEl.innerHTML = forSite.map(p => `
      <div class="auth-profile-card" data-id="${p.id}">
        <div class="auth-profile-info">
          <span class="auth-profile-name">${escapeHtml(p.name)}</span>
          <span class="auth-profile-meta">${escapeHtml(p.baseUrl)} · ${escapeHtml(formatAuthMode(p.mode))}</span>
          ${renderAuthProfileValidityBadge(p.id)}
        </div>
        <div class="auth-profile-actions">
          <button type="button" class="btn-secondary btn-sm auth-profile-edit-toggle" data-id="${p.id}">Edit</button>
          <button type="button" class="btn-secondary btn-sm auth-profile-delete" data-id="${p.id}">Delete</button>
        </div>
        <div class="auth-profile-edit-inline hidden">
          <p class="auth-form-help auth-cookie-intro">To refresh your login: sign in again in Chrome → <kbd>F12</kbd> → <strong>Application</strong> → <strong>Cookies</strong> → your site. Select all in the table, copy, paste below. Leave blank to keep the cookies we already have.</p>
          <div class="auth-form-row">
            <input type="text" class="auth-edit-name" value="${escapeHtml(p.name)}" />
            <input type="url" class="auth-edit-base-url" value="${escapeHtml(p.baseUrl)}" />
          </div>
          <label class="auth-form-json-label">New cookies (optional)</label>
          <textarea class="auth-form-payload auth-edit-cookies-paste" rows="3" placeholder="Full cookie table from Chrome, or leave blank"></textarea>
          <details class="auth-advanced"${p.mode !== 'session' ? ' open' : ''}>
            <summary>Advanced (mode, JSON)</summary>
            <p class="auth-form-help">Change only if you use API keys or custom headers—not needed for normal cookie login.</p>
            <label class="auth-form-json-label">How this profile authenticates</label>
            <select class="auth-edit-mode auth-form-fullwidth">
              <option value="session" ${p.mode === 'session' ? 'selected' : ''}>Cookies (box above)</option>
              <option value="headers_cookies" ${p.mode === 'headers_cookies' ? 'selected' : ''}>Headers / JSON only</option>
              <option value="hybrid" ${p.mode === 'hybrid' ? 'selected' : ''}>Cookies + JSON headers</option>
            </select>
            <label class="auth-form-json-label">New JSON (optional)</label>
            <textarea class="auth-form-payload auth-edit-payload" rows="3" placeholder="Leave blank to keep current. Paste full JSON to replace."></textarea>
          </details>
          <p class="hint auth-edit-hint"></p>
          <div class="auth-profile-actions">
            <button type="button" class="btn-primary btn-sm auth-profile-save" data-id="${p.id}">Save</button>
            <button type="button" class="btn-secondary btn-sm auth-profile-edit-cancel" data-id="${p.id}">Cancel</button>
          </div>
        </div>
      </div>
    `).join('');
    bindAuthProfileCardActions(listEl);
  }
}

function deleteScenarioFromSite(id) {
  if (!confirm('Delete this scenario?')) return;
  api('DELETE', '/scenarios/' + id).then(async () => {
    if (activeScenarioId === id) activeScenarioId = null;
    await loadScenarios();
    renderSidebarList();
    renderSiteView();
  }).catch(err => alert('Failed to delete: ' + err.message));
}

$('btn-site-new-scenario').onclick = () => {
  const panel = $('site-create-scenario-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    const startInput = $('site-create-starting-webpage');
    if (startInput && selectedSiteUrl) {
      startInput.value = selectedSiteUrl;
      startInput.placeholder = selectedSiteUrl;
    }
    $('site-create-prompt').focus();
  }
};

function normalizedUrlFromScanField() {
  return normalizeUrlInput(($('scan-url') && $('scan-url').value.trim()) || '');
}

function normalizeUrlInput(raw) {
  let s = (raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    return new URL(s).href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function authProfileNameFromUrl(urlString) {
  const normalized = normalizeUrlInput(urlString);
  if (!normalized) return '';
  try {
    const host = new URL(normalized).hostname || '';
    return host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function syncScanWelcomeAuthNameFromUrl(urlString) {
  const nameEl = $('scan-welcome-auth-name');
  if (!nameEl) return;
  const autoName = authProfileNameFromUrl(urlString);
  if (!autoName) return;
  const current = nameEl.value.trim();
  const prevAuto = nameEl.dataset.autoName || '';
  const userEdited = nameEl.dataset.userEdited === '1';
  if (!current || current === prevAuto || !userEdited) {
    nameEl.value = autoName;
    nameEl.dataset.userEdited = '0';
  }
  nameEl.dataset.autoName = autoName;
}

function syncScanWelcomeAuthDefaults() {
  const normalizedScanUrl = normalizedUrlFromScanField();
  const baseEl = $('scan-welcome-auth-base-url');
  if (baseEl && normalizedScanUrl && document.activeElement !== baseEl) {
    baseEl.value = normalizedScanUrl;
  }
  const sourceUrl = (baseEl && baseEl.value.trim()) || normalizedScanUrl;
  syncScanWelcomeAuthNameFromUrl(sourceUrl);
}

const scanWelcomeAuthDetails = $('scan-welcome-auth-details');
if (scanWelcomeAuthDetails) {
  scanWelcomeAuthDetails.addEventListener('toggle', () => {
    if (!scanWelcomeAuthDetails.open) return;
    syncScanWelcomeAuthDefaults();
  });
}

$('btn-scan-welcome-auth-submit').onclick = async () => {
  let name = ($('scan-welcome-auth-name') && $('scan-welcome-auth-name').value.trim()) || '';
  const baseInput = ($('scan-welcome-auth-base-url') && $('scan-welcome-auth-base-url').value.trim()) || '';
  let baseUrl = normalizeUrlInput(baseInput || normalizedUrlFromScanField());
  const baseInputEl = $('scan-welcome-auth-base-url');
  if (baseInputEl && baseUrl) baseInputEl.value = baseUrl;
  if (!name) name = authProfileNameFromUrl(baseUrl);
  const mode = $('scan-welcome-auth-mode') ? $('scan-welcome-auth-mode').value : 'session';
  const cookiesPaste = $('scan-welcome-auth-cookies-paste') ? $('scan-welcome-auth-cookies-paste').value.trim() : '';
  const payloadStr = $('scan-welcome-auth-payload') ? $('scan-welcome-auth-payload').value.trim() : '';
  const hintEl = $('scan-welcome-auth-hint');
  if (!name || !baseUrl) {
    if (hintEl) {
      hintEl.textContent = 'Add a profile name and a valid site URL (enter the URL above first, or fill the site field).';
      hintEl.className = 'hint error';
    }
    return;
  }
  if (!cookiesPaste && !payloadStr) {
    if (hintEl) {
      hintEl.textContent = 'Paste the cookie table from Chrome after you log in—or open Advanced if you use JSON only.';
      hintEl.className = 'hint error';
    }
    return;
  }
  let payload;
  if (payloadStr) {
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      if (hintEl) {
        hintEl.textContent = 'Advanced box is not valid JSON—fix it or clear it.';
        hintEl.className = 'hint error';
      }
      return;
    }
  }
  if (hintEl) hintEl.textContent = '';
  try {
    const body = { name, baseUrl, mode };
    if (cookiesPaste) body.cookiesPaste = cookiesPaste;
    if (payload && Object.keys(payload).length) body.payload = payload;
    const created = await api('POST', '/auth-profiles', body);
    if ($('scan-welcome-auth-name')) $('scan-welcome-auth-name').value = '';
    if ($('scan-welcome-auth-cookies-paste')) $('scan-welcome-auth-cookies-paste').value = '';
    if ($('scan-welcome-auth-payload')) $('scan-welcome-auth-payload').value = '';
    const m = $('scan-welcome-auth-mode');
    if (m) m.value = 'session';
    const adv = $('scan-welcome-auth-advanced');
    if (adv) adv.open = false;
    await loadAuthProfiles();
    const sel = $('scan-auth-profile');
    if (sel && created && created.id) sel.value = created.id;
    if (hintEl) {
      hintEl.textContent = 'Profile created. It’s selected above—click Scan when ready.';
      hintEl.className = 'hint';
    }
  } catch (err) {
    if (hintEl) {
      hintEl.textContent = 'Error: ' + err.message;
      hintEl.className = 'hint error';
    }
  }
};

$('btn-site-auth-submit').onclick = async () => {
  const name = $('site-auth-form-name').value.trim();
  const rawBaseUrl = ($('site-auth-form-base-url') && $('site-auth-form-base-url').value.trim()) || selectedSiteUrl || '';
  const baseUrl = normalizeUrlInput(rawBaseUrl);
  if ($('site-auth-form-base-url') && baseUrl) $('site-auth-form-base-url').value = baseUrl;
  const mode = $('site-auth-form-mode') ? $('site-auth-form-mode').value : 'session';
  const cookiesPaste = $('site-auth-form-cookies-paste') ? $('site-auth-form-cookies-paste').value.trim() : '';
  const payloadStr = $('site-auth-form-payload') ? $('site-auth-form-payload').value.trim() : '';
  const hintEl = $('site-auth-form-hint');
  if (!name || !baseUrl) {
    if (hintEl) { hintEl.textContent = 'Add a name and site URL (the site address is usually already filled).'; hintEl.className = 'hint error'; }
    return;
  }
  if (!cookiesPaste && !payloadStr) {
    if (hintEl) { hintEl.textContent = 'Paste the cookie table from Chrome after you log in—or open Advanced if you use JSON only.'; hintEl.className = 'hint error'; }
    return;
  }
  let payload;
  if (payloadStr) {
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      if (hintEl) { hintEl.textContent = 'Advanced box is not valid JSON—fix it or clear it.'; hintEl.className = 'hint error'; }
      return;
    }
  }
  if (hintEl) hintEl.textContent = '';
  try {
    const body = { name, baseUrl, mode };
    if (cookiesPaste) body.cookiesPaste = cookiesPaste;
    if (payload && Object.keys(payload).length) body.payload = payload;
    await api('POST', '/auth-profiles', body);
    if ($('site-auth-form-name')) $('site-auth-form-name').value = '';
    if ($('site-auth-form-cookies-paste')) $('site-auth-form-cookies-paste').value = '';
    if ($('site-auth-form-payload')) $('site-auth-form-payload').value = '';
    const siteMode = $('site-auth-form-mode');
    if (siteMode) siteMode.value = 'session';
    const siteAdv = $('site-auth-form-advanced');
    if (siteAdv) siteAdv.open = false;
    if (hintEl) { hintEl.textContent = 'Saved. Pick this auth profile when you scan or run.'; hintEl.className = 'hint'; }
    await loadAuthProfiles();
    renderSiteAuthList();
  } catch (err) {
    if (hintEl) { hintEl.textContent = 'Error: ' + err.message; hintEl.className = 'hint error'; }
  }
};

$('btn-site-create-apply').onclick = async () => {
  if (!selectedSiteUrl) return;
  const input = $('site-create-prompt');
  const userMessage = input ? input.value.trim() : '';
  const hintEl = $('site-create-hint');
  if (!userMessage) {
    if (hintEl) { hintEl.textContent = 'Describe what you want to test.'; hintEl.className = 'hint error'; hintEl.style.display = 'block'; }
    return;
  }
  showOverlay('Creating scenario…');
  if (hintEl) { hintEl.style.display = 'none'; hintEl.textContent = ''; }
  const startInput = $('site-create-starting-webpage');
  const startingWebpageRaw = startInput ? startInput.value.trim() : '';
  const startingWebpage = startingWebpageRaw || null;
  const body = { siteUrl: selectedSiteUrl, userMessage };
  if (startingWebpage) body.startingWebpage = startingWebpage;
  try {
    const created = await api('POST', '/scenarios/create-from-prompt', body);
    await loadScenarios();
    renderSidebarList();
    renderSiteView();
    $('site-create-scenario-panel').classList.add('hidden');
    if (input) input.value = '';
    openScenario(created.id);
  } catch (err) {
    if (hintEl) { hintEl.textContent = 'Error: ' + err.message; hintEl.className = 'hint error'; hintEl.style.display = 'block'; }
  } finally {
    hideOverlay();
  }
};

async function loadScenarios() {
  scenarios = await api('GET', '/scenarios');
  renderSidebarList();
}

async function loadAuthProfiles() {
  authProfiles = await api('GET', '/auth-profiles');
  authProfileValidity = new Map(authProfiles.map(p => [p.id, { status: 'checking', label: 'checking…' }]));
  await loadAuthProfileValidity();
  renderAuthProfileSelects();
  if ($('auth-profiles-list')) renderAuthProfilesList();
  if (views.site && views.site.classList.contains('active')) renderSiteAuthList();
}

async function loadAuthProfileValidity() {
  const entries = await Promise.all(authProfiles.map(async p => {
    try {
      const validity = await api('GET', `/auth-profiles/${p.id}/validity`);
      return [p.id, validity];
    } catch (_) {
      return [p.id, { status: 'unknown', label: 'check failed' }];
    }
  }));
  authProfileValidity = new Map(entries);
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function authValidityTitle(v) {
  if (!v) return 'Status not loaded yet.';
  const lab = (v.label || '').toLowerCase();
  if (v.status === 'checking' || lab.includes('checking')) return 'Checking cookie dates…';
  switch (v.status) {
    case 'valid':
      return 'Cookie dates look fine. If pages still act logged out, log in again and paste a fresh table.';
    case 'expired':
      return 'These cookies look expired. Log in again in Chrome, copy cookies from DevTools, edit this profile.';
    case 'warning':
      return 'Some cookies are old or expire within a week. Paste fresh cookies if runs start failing.';
    case 'unknown':
      if (lab.includes('check failed')) return 'Could not read this profile. Try editing and saving again.';
      if (lab.includes('add') || lab.includes('paste')) return 'Paste the cookie table after you log in, or add JSON in Advanced.';
      if (lab.includes('session') && lab.includes('json')) return 'Uses session JSON only; we do not show cookie dates here.';
      return 'We cannot read expiry on these cookies—they may still work until the site ends the session.';
    default:
      return '';
  }
}

function formatAuthMode(mode) {
  if (mode === 'session') return 'Cookies';
  if (mode === 'headers_cookies' || mode === 'hybrid') return 'Advanced';
  return mode || '';
}

function renderAuthProfileValidityBadge(profileId) {
  const validity = authProfileValidity.get(profileId);
  const title = authValidityTitle(validity);
  const t = title ? ` title="${escapeAttr(title)}"` : '';
  if (!validity) return `<span class="auth-validity-badge unknown"${t}>…</span>`;
  return `<span class="auth-validity-badge ${escapeHtml(validity.status || 'unknown')}"${t}>${escapeHtml(validity.label || '…')}</span>`;
}

function authProfilesForSite(siteUrl) {
  if (!siteUrl) return [];
  const base = (siteUrl || '').replace(/\/$/, '');
  return authProfiles.filter(p => {
    const pBase = (p.baseUrl || '').replace(/\/$/, '');
    return pBase === base || siteUrl.startsWith(pBase) || pBase.startsWith(base);
  });
}

function renderAuthProfileSelects() {
  const scanUrl = normalizedUrlFromScanField();
  const scanProfiles = scanUrl ? authProfilesForSite(scanUrl) : [];
  const options = scanProfiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  const optNoneScan = '<option value="">None — public pages only</option>';
  const scanSelect = $('scan-auth-profile');
  if (scanSelect) {
    const current = scanSelect.value;
    scanSelect.innerHTML = optNoneScan + options;
    if (current && scanProfiles.some(p => p.id === current)) scanSelect.value = current;
  }
  const hasMatchingScanProfiles = scanProfiles.length > 0;
  const profileRow = $('scan-auth-profile-row');
  if (profileRow) {
    profileRow.classList.toggle('hidden', !hasMatchingScanProfiles);
    profileRow.style.display = hasMatchingScanProfiles ? '' : 'none';
  }
  const emptyState = $('scan-auth-empty');
  if (emptyState) emptyState.classList.toggle('hidden', hasMatchingScanProfiles || !scanUrl);
  const createDetails = $('scan-welcome-auth-details');
  const authDetails = $('scan-auth-details');
  if (createDetails && authDetails && authDetails.open && scanUrl && !hasMatchingScanProfiles) {
    createDetails.open = true;
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ─── Scan / discover ─────────────────────────────────────────────────
$('btn-new-site').onclick = () => {
  activeScenarioId = null;
  renderSidebarList();
  showView('welcome');
  $('scan-url').focus();
};

$('btn-scan').onclick = async () => {
  const url = $('scan-url').value.trim();
  if (!url) return setHint('Please enter a URL.', true);
  setHint('');

  showOverlay('Scanning ' + url + '…');
  const authProfileId = $('scan-auth-profile')?.value || undefined;
  try {
    discoveredScenarios = await api('POST', '/discover', {
      url,
      headless: $('scan-headless').checked,
      ...(authProfileId && { authProfileId }),
    });
    renderDiscovery(discoveredScenarios);
    showView('discovery');
  } catch (err) {
    setHint('Error: ' + err.message, true);
  } finally {
    hideOverlay();
  }
};

$('scan-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-scan').click();
});
$('scan-url').addEventListener('input', () => {
  syncScanWelcomeAuthDefaults();
  renderAuthProfileSelects();
});

const scanWelcomeBaseUrl = $('scan-welcome-auth-base-url');
if (scanWelcomeBaseUrl) {
  scanWelcomeBaseUrl.addEventListener('input', () => {
    syncScanWelcomeAuthNameFromUrl(scanWelcomeBaseUrl.value.trim());
  });
}

const scanWelcomeName = $('scan-welcome-auth-name');
if (scanWelcomeName) {
  scanWelcomeName.addEventListener('input', () => {
    const current = scanWelcomeName.value.trim();
    const autoName = scanWelcomeName.dataset.autoName || '';
    scanWelcomeName.dataset.userEdited = current && current !== autoName ? '1' : '0';
  });
}

const scanAuthDetails = $('scan-auth-details');
if (scanAuthDetails) {
  scanAuthDetails.addEventListener('toggle', () => {
    if (!scanAuthDetails.open) return;
    renderAuthProfileSelects();
  });
}

function setHint(msg, isError = false) {
  const el = $('scan-hint');
  el.textContent = msg;
  el.className = 'hint' + (isError ? ' error' : '');
}

// ─── Discovery view ───────────────────────────────────────────────────
function renderDiscovery(result) {
  $('discovery-title').textContent = `${result.scenarios.length} scenarios discovered`;
  $('discovery-url').textContent = result.siteUrl;

  $('discovery-list').innerHTML = result.scenarios.map((s, i) => `
    <div class="scenario-card" data-index="${i}">
      <div class="scenario-card-header">
        <div>
          <div class="scenario-card-name">${s.name}</div>
          <div class="scenario-card-desc">${s.description}</div>
        </div>
      </div>
      <div class="scenario-card-steps">
        ${s.steps.map((step, j) => `
          <div class="scenario-card-step">
            <span class="step-num">${j + 1}</span>
            <span class="step-type ${step.type}">${step.type}</span>
            <span>${step.instruction}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

$('btn-save-all').onclick = async () => {
  if (!discoveredScenarios) return;
  showOverlay('Saving scenarios…');
  try {
    await api('POST', '/scenarios', { scenarios: discoveredScenarios.scenarios });
    await loadScenarios();
    showView('welcome');
    discoveredScenarios = null;
  } catch (err) {
    alert('Failed to save: ' + err.message);
  } finally {
    hideOverlay();
  }
};

// ─── Scenario detail ─────────────────────────────────────────────────
async function openScenario(id) {
  activeScenarioId = id;
  renderSidebarList();

  const s = scenarios.find(x => x.id === id);
  if (!s) return;

  $('detail-name').textContent = s.name;
  $('detail-url').textContent = s.siteUrl;

  const startingWebpageInput = $('detail-starting-webpage');
  const btnSaveStartingWebpage = $('btn-save-starting-webpage');
  if (startingWebpageInput) {
    startingWebpageInput.value = s.startingWebpage || '';
    startingWebpageInput.placeholder = s.siteUrl || '';
  }
  if (btnSaveStartingWebpage) {
    btnSaveStartingWebpage.onclick = () => {
      const val = (startingWebpageInput && startingWebpageInput.value) ? startingWebpageInput.value.trim() : '';
      const startingWebpage = val || null;
      api('PATCH', `/scenarios/${s.id}`, { startingWebpage }).then(updated => {
        const idx = scenarios.findIndex(x => x.id === s.id);
        if (idx >= 0) scenarios[idx] = updated;
        setScenarioHint('Starting webpage saved.', false);
      }).catch(err => setScenarioHint('Error: ' + err.message, true));
    };
  }

  $('detail-steps').innerHTML = s.steps.map((step, i) => `
    <li class="step-row step-row-editable" data-step-index="${i}">
      <div class="step-row-main">
        <span class="step-num">${i + 1}</span>
        <span class="step-type ${step.type}">${step.type}</span>
        <span class="step-text">${escapeHtml(step.instruction)}</span>
        <button type="button" class="btn-secondary btn-sm step-edit-toggle" data-step-index="${i}">
          Edit step
        </button>
      </div>
      <div class="step-edit-inline hidden" id="step-edit-inline-${i}">
        <label class="edit-scenario-label" for="step-edit-input-${i}">Edit step ${i + 1}</label>
        <p class="edit-scenario-hint">Describe how to change this step only.</p>
        <div class="edit-scenario-row">
          <textarea id="step-edit-input-${i}" class="edit-scenario-input" rows="2" placeholder="e.g. Use &quot;contact&quot; instead of &quot;pricing&quot;"></textarea>
          <button type="button" class="btn-primary edit-scenario-apply step-edit-apply" data-step-index="${i}">
            Apply
          </button>
        </div>
      </div>
    </li>
  `).join('');
  activeStepEditIndex = null;
  $('detail-steps').querySelectorAll('.step-edit-toggle').forEach(btn => {
    btn.onclick = () => toggleStepEditor(Number(btn.dataset.stepIndex));
  });
  $('detail-steps').querySelectorAll('.step-edit-apply').forEach(btn => {
    btn.onclick = () => applyStepEdit(Number(btn.dataset.stepIndex));
  });

  setScenarioHint('', false);
  const editInput = $('edit-scenario-input');
  if (editInput) editInput.value = '';
  const editPanel = $('edit-scenario-panel');
  if (editPanel) editPanel.classList.add('hidden');
  resetRunOutput();
  const forSite = authProfilesForSite(s.siteUrl);
  const activeProfile = s.authProfileId ? forSite.find((p) => p.id === s.authProfileId) : null;
  const statusEl = $('scenario-auth-status');
  const titleEl = $('scenario-auth-title');
  const subtitleEl = $('scenario-auth-subtitle');
  if (statusEl && titleEl && subtitleEl) {
    if (activeProfile) {
      statusEl.className = 'scenario-auth-status activated';
      titleEl.textContent = 'Auth activated';
      subtitleEl.textContent = `${activeProfile.name} is used for runs`;
    } else if (s.authProfileId) {
      statusEl.className = 'scenario-auth-status missing';
      titleEl.textContent = 'Auth profile missing';
      subtitleEl.textContent = 'Saved profile not found for this site';
    } else {
      statusEl.className = 'scenario-auth-status public';
      titleEl.textContent = 'Public run';
      subtitleEl.textContent = 'No auth profile set';
    }
  }

  const panel = $('scenario-auth-panel');
  const changeBtn = $('btn-scenario-auth-change');
  const cancelBtn = $('btn-scenario-auth-cancel');
  const applyBtn = $('btn-scenario-auth-apply');
  const selectEl = $('scenario-auth-select-change');

  if (panel) panel.classList.add('hidden');
  if (selectEl) {
    const scenarioOptions = forSite.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    selectEl.innerHTML = '<option value="">None — public run</option>' + scenarioOptions;
    selectEl.value = activeProfile ? activeProfile.id : '';
  }

  if (changeBtn && panel && selectEl) {
    changeBtn.onclick = () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) selectEl.focus();
    };
  }
  if (cancelBtn && panel) {
    cancelBtn.onclick = () => {
      if (selectEl) selectEl.value = activeProfile ? activeProfile.id : '';
      panel.classList.add('hidden');
    };
  }
  const runBtn = $('btn-run');
  if (runBtn) {
    runBtn.disabled = !isLoggedIn() && trialRunsUsed() >= 2;
    runBtn.title =
      !isLoggedIn() && trialRunsUsed() >= 2 ? 'Sign up to run more scenarios' : '';
  }

  if (applyBtn && panel && selectEl) {
    applyBtn.onclick = async () => {
      const nextAuthProfileId = selectEl.value || null;
      const currentAuthProfileId = s.authProfileId || null;
      if (nextAuthProfileId === currentAuthProfileId) {
        panel.classList.add('hidden');
        setScenarioHint('No auth change to save.', false);
        return;
      }
      try {
        const updated = await api('PATCH', `/scenarios/${s.id}`, { authProfileId: nextAuthProfileId });
        const idx = scenarios.findIndex(x => x.id === s.id);
        if (idx >= 0) scenarios[idx] = updated;
        panel.classList.add('hidden');
        openScenario(updated.id);
        setScenarioHint('Auth profile updated for future runs.', false);
      } catch (err) {
        setScenarioHint('Error: ' + err.message, true);
      }
    };
  }
  showView('scenario');
}

function toggleStepEditor(index) {
  const current = $(`step-edit-inline-${index}`);
  if (!current) return;
  const shouldOpen = current.classList.contains('hidden');
  document.querySelectorAll('.step-edit-inline').forEach(el => el.classList.add('hidden'));
  if (shouldOpen) {
    current.classList.remove('hidden');
    const input = $(`step-edit-input-${index}`);
    if (input) input.focus();
    activeStepEditIndex = index;
  } else {
    activeStepEditIndex = null;
  }
}

async function applyStepEdit(stepIndex) {
  if (!activeScenarioId) return;
  const input = $(`step-edit-input-${stepIndex}`);
  const userMessage = input ? input.value.trim() : '';
  if (!userMessage) {
    setScenarioHint('Describe the change you want for this step.', true);
    return;
  }
  showOverlay('Applying step edit…');
  try {
    const updated = await api('POST', `/scenarios/${activeScenarioId}/modify-step`, { stepIndex, userMessage });
    const idx = scenarios.findIndex(s => s.id === activeScenarioId);
    if (idx >= 0) scenarios[idx] = updated;
    if (input) input.value = '';
    openScenario(activeScenarioId);
    setScenarioHint(`Step ${stepIndex + 1} updated.`, false);
  } catch (err) {
    setScenarioHint('Error: ' + err.message, true);
  } finally {
    hideOverlay();
  }
}

function resetRunOutput() {
  $('run-output').innerHTML = '<p class="run-idle">Hit "Run now" to execute this scenario.</p>';
  $('run-status-badge').innerHTML = '';
  const rb = $('btn-run');
  if (rb) {
    rb.disabled = !isLoggedIn() && trialRunsUsed() >= 2;
    rb.title = !isLoggedIn() && trialRunsUsed() >= 2 ? 'Sign up to run more scenarios' : '';
    rb.textContent = '▶ Run now';
  }
}

async function loadAndRenderTraceDetails(runId) {
  const container = $('run-output');
  let panel = container.querySelector('.trace-details-panel');
  if (panel) panel.remove();
  try {
    const details = await api('GET', '/runs/' + runId + '/details');
    panel = document.createElement('div');
    panel.className = 'trace-details-panel';
    panel.innerHTML = '<p class="trace-details-title">Trace details</p>';
    const timeline = document.createElement('div');
    timeline.className = 'trace-timeline';
    const steps = details.steps || [];
    steps.forEach((s) => {
      const stepEl = document.createElement('div');
      stepEl.className = `trace-step trace-step-${s.status}`;
      const duration = s.durationMs != null ? s.durationMs + 'ms' : '—';
      const errBlock = s.error ? `<div class="trace-step-error">${escapeHtml(s.error)}</div>` : '';
      const raw = JSON.stringify({ instruction: s.instruction, type: s.type, status: s.status, durationMs: s.durationMs, error: s.error }, null, 2);
      const snapshotBlock = s.snapshotUrl
        ? `<div class="trace-step-snapshot-wrap">
            <a href="${s.snapshotUrl}" target="_blank" rel="noopener noreferrer" class="trace-step-snapshot-link">
              <img class="trace-step-snapshot" src="${s.snapshotUrl}" alt="Step ${s.stepIndex + 1} snapshot" loading="lazy" />
            </a>
            <p class="trace-step-snapshot-hint">Click image to open full snapshot</p>
          </div>`
        : '<p class="trace-step-no-snapshot">No snapshot for this step.</p>';
      const isOpen = s.status === 'fail' ? ' open' : '';
      stepEl.innerHTML = `
        <details class="trace-step-details"${isOpen}>
          <summary class="trace-step-header">
            <span class="trace-step-num">Step ${s.stepIndex + 1}</span>
            <span class="trace-step-type ${s.type}">${s.type}</span>
            <span class="trace-step-status ${s.status}">${s.status}</span>
            <span class="trace-step-text">${escapeHtml(s.instruction)}</span>
            <span class="trace-step-dur">${duration}</span>
          </summary>
          <div class="trace-step-body">
            ${snapshotBlock}
            ${errBlock}
            <details class="trace-step-raw-details">
              <summary>Raw</summary>
              <pre class="trace-step-raw">${escapeHtml(raw)}</pre>
            </details>
          </div>
        </details>`;
      timeline.appendChild(stepEl);
    });
    panel.appendChild(timeline);
    container.appendChild(panel);
  } catch (_) {
    // If details fail (e.g. run not found), skip trace panel
  }
}

// ─── Run a scenario (SSE) ─────────────────────────────────────────────
$('btn-run').onclick = () => runActiveScenario();

async function runActiveScenario() {
  if (!activeScenarioId) return;
  const scenario = scenarios.find(s => s.id === activeScenarioId);
  if (!scenario) return;

  if (!isLoggedIn() && trialRunsUsed() >= 2) {
    setScenarioHint('Trial limit reached. Sign up to run more scenarios.', true);
    openAuthModal();
    switchAuthTab('signup');
    return;
  }

  $('btn-run').disabled = true;
  $('btn-run').textContent = 'Running…';
  $('run-status-badge').innerHTML = '<span class="badge running">running</span>';

  // Render pending steps
  const output = $('run-output');
  output.innerHTML = scenario.steps.map((step, i) => `
    <div class="run-step pending" id="run-step-${i}">
      <span class="run-step-icon pending"></span>
      <span class="run-step-text">${step.instruction}</span>
      <span class="run-step-dur"></span>
    </div>
  `).join('');

  const headless = $('run-headless').checked;
  const authProfileId = scenario.authProfileId || undefined;
  const res = await fetch(`/api/scenarios/${activeScenarioId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headless, ...(authProfileId && { authProfileId }) }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let currentRunId = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'start' && event.run) currentRunId = event.run.id;
      handleRunEvent(event, scenario, currentRunId);
    }
  }
}

function handleRunEvent(event, scenario, currentRunId) {
  if (event.type === 'step') {
    const el = $(`run-step-${event.index}`);
    if (!el) return;
    el.className = `run-step ${event.status}`;
    el.querySelector('.run-step-icon').className = `run-step-icon ${event.status}`;
    if (event.durationMs !== undefined) {
      el.querySelector('.run-step-dur').textContent = event.durationMs + 'ms';
    }
    if (event.error) {
      const errDiv = document.createElement('div');
      errDiv.className = 'run-error-box';
      errDiv.textContent = event.error;
      el.after(errDiv);
    }
    // Mark next step as running
    const nextEl = $(`run-step-${event.index + 1}`);
    if (nextEl && event.status === 'pass') {
      nextEl.className = 'run-step running';
      nextEl.querySelector('.run-step-icon').className = 'run-step-icon running';
    }
  }

  if (event.type === 'done') {
    if (!isLoggedIn()) {
      const n = trialRunsUsed() + 1;
      sessionStorage.setItem(TRIAL_RUNS_KEY, String(n));
      updateAuthChrome();
    }
    const badge = $('run-status-badge');
    badge.innerHTML = `<span class="badge ${event.status}">${event.status}</span>`;
    const rb2 = $('btn-run');
    if (rb2) {
      rb2.disabled = !isLoggedIn() && trialRunsUsed() >= 2;
      rb2.title = !isLoggedIn() && trialRunsUsed() >= 2 ? 'Sign up to run more scenarios' : '';
      rb2.textContent = '▶ Run again';
    }

    // Show trace download link when available
    if (event.traceUrl) {
      const traceLink = document.createElement('p');
      traceLink.className = 'run-trace-link';
      traceLink.innerHTML = `Debug: <a href="${event.traceUrl}" download="trace.zip">Download trace</a> (open with <code>npx playwright show-trace trace.zip</code>)`;
      $('run-output').appendChild(traceLink);
    }

    // Load and show in-app trace details timeline
    if (currentRunId) loadAndRenderTraceDetails(currentRunId);

    // Refresh scenario status in sidebar
    loadScenarios().then(() => renderSidebarList());
  }
}

// ─── Edit scenario (AI) ───────────────────────────────────────────────
$('btn-edit-toggle').onclick = () => {
  const panel = $('edit-scenario-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
};

$('btn-edit-apply').onclick = async () => {
  if (!activeScenarioId) return;
  const input = $('edit-scenario-input');
  const userMessage = input ? input.value.trim() : '';
  if (!userMessage) {
    setScenarioHint('Describe the change you want in the edit box above.', true);
    return;
  }
  showOverlay('Applying your edit…');
  try {
    const updated = await api('POST', `/scenarios/${activeScenarioId}/modify-before-run`, { userMessage });
    const idx = scenarios.findIndex(s => s.id === activeScenarioId);
    if (idx >= 0) scenarios[idx] = updated;
    hideOverlay();
    if (input) input.value = '';
    openScenario(activeScenarioId);
    setScenarioHint('Scenario updated.', false);
  } catch (err) {
    hideOverlay();
    setScenarioHint('Error: ' + err.message, true);
  }
};

function setScenarioHint(msg, isError) {
  const el = $('scenario-hint');
  if (!el) return;
  el.textContent = msg;
  el.className = 'hint' + (isError ? ' error' : '');
  el.style.display = msg ? 'block' : 'none';
  if (msg) setTimeout(() => { el.style.display = 'none'; el.textContent = ''; }, 4000);
}

// ─── Delete ───────────────────────────────────────────────────────────
$('btn-delete').onclick = async () => {
  if (!activeScenarioId) return;
  if (!confirm('Delete this scenario?')) return;
  try {
    await api('DELETE', `/scenarios/${activeScenarioId}`);
    activeScenarioId = null;
    await loadScenarios();
    showView('welcome');
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
};

// ─── Auth profiles view ──────────────────────────────────────────────
$('btn-auth-profiles').onclick = () => {
  showView('authProfiles');
  loadAuthProfiles();
};

function renderAuthProfilesList() {
  const list = $('auth-profiles-list');
  if (!list) return;
  if (!authProfiles.length) {
    list.innerHTML = '<p class="empty-state">No auth profiles yet. Fill the form below: name, site URL, then paste cookies from Chrome after you log in.</p>';
    return;
  }
  list.innerHTML = authProfiles.map(p => `
    <div class="auth-profile-card" data-id="${p.id}">
      <div class="auth-profile-info">
        <span class="auth-profile-name">${escapeHtml(p.name)}</span>
        <span class="auth-profile-meta">${escapeHtml(p.baseUrl)} · ${escapeHtml(formatAuthMode(p.mode))}</span>
        ${renderAuthProfileValidityBadge(p.id)}
      </div>
      <div class="auth-profile-actions">
        <button type="button" class="btn-secondary btn-sm auth-profile-edit-toggle" data-id="${p.id}">Edit</button>
        <button type="button" class="btn-secondary btn-sm auth-profile-delete" data-id="${p.id}">Delete</button>
      </div>
      <div class="auth-profile-edit-inline hidden">
        <p class="auth-form-help auth-cookie-intro">To refresh your login: sign in again in Chrome → <kbd>F12</kbd> → <strong>Application</strong> → <strong>Cookies</strong> → your site. Select all in the table, copy, paste below. Leave blank to keep the cookies we already have.</p>
        <div class="auth-form-row">
          <input type="text" class="auth-edit-name" value="${escapeHtml(p.name)}" />
          <input type="url" class="auth-edit-base-url" value="${escapeHtml(p.baseUrl)}" />
        </div>
        <label class="auth-form-json-label">New cookies (optional)</label>
        <textarea class="auth-form-payload auth-edit-cookies-paste" rows="3" placeholder="Full cookie table from Chrome, or leave blank"></textarea>
        <details class="auth-advanced"${p.mode !== 'session' ? ' open' : ''}>
          <summary>Advanced (mode, JSON)</summary>
          <p class="auth-form-help">Change only if you use API keys or custom headers—not needed for normal cookie login.</p>
          <label class="auth-form-json-label">How this profile authenticates</label>
          <select class="auth-edit-mode auth-form-fullwidth">
            <option value="session" ${p.mode === 'session' ? 'selected' : ''}>Cookies (box above)</option>
            <option value="headers_cookies" ${p.mode === 'headers_cookies' ? 'selected' : ''}>Headers / JSON only</option>
            <option value="hybrid" ${p.mode === 'hybrid' ? 'selected' : ''}>Cookies + JSON headers</option>
          </select>
          <label class="auth-form-json-label">New JSON (optional)</label>
          <textarea class="auth-form-payload auth-edit-payload" rows="3" placeholder="Leave blank to keep current. Paste full JSON to replace."></textarea>
        </details>
        <p class="hint auth-edit-hint"></p>
        <div class="auth-profile-actions">
          <button type="button" class="btn-primary btn-sm auth-profile-save" data-id="${p.id}">Save</button>
          <button type="button" class="btn-secondary btn-sm auth-profile-edit-cancel" data-id="${p.id}">Cancel</button>
        </div>
      </div>
    </div>
  `).join('');
  bindAuthProfileCardActions(list);
}

function bindAuthProfileCardActions(container) {
  container.querySelectorAll('.auth-profile-delete').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this auth profile? You can create it again anytime.')) return;
      try {
        await api('DELETE', '/auth-profiles/' + btn.dataset.id);
        await loadAuthProfiles();
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    };
  });

  container.querySelectorAll('.auth-profile-edit-toggle').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.auth-profile-card');
      if (!card) return;
      const panel = card.querySelector('.auth-profile-edit-inline');
      if (!panel) return;
      const shouldOpen = panel.classList.contains('hidden');
      container.querySelectorAll('.auth-profile-edit-inline').forEach(el => el.classList.add('hidden'));
      if (shouldOpen) panel.classList.remove('hidden');
    };
  });

  container.querySelectorAll('.auth-profile-edit-cancel').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.auth-profile-card');
      if (!card) return;
      const panel = card.querySelector('.auth-profile-edit-inline');
      if (panel) panel.classList.add('hidden');
    };
  });

  container.querySelectorAll('.auth-profile-save').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const card = btn.closest('.auth-profile-card');
      if (!id || !card) return;
      const hintEl = card.querySelector('.auth-edit-hint');
      const name = card.querySelector('.auth-edit-name')?.value?.trim() || '';
      const baseInput = card.querySelector('.auth-edit-base-url')?.value?.trim() || '';
      const baseUrl = normalizeUrlInput(baseInput);
      const mode = card.querySelector('.auth-edit-mode')?.value || 'session';
      const cookiesPaste = card.querySelector('.auth-edit-cookies-paste')?.value?.trim() || '';
      const payloadStr = card.querySelector('.auth-edit-payload')?.value?.trim() || '';
      if (!name || !baseUrl) {
        if (hintEl) { hintEl.textContent = 'Name and site URL are required.'; hintEl.className = 'hint error auth-edit-hint'; }
        return;
      }
      const body = { name, baseUrl, mode };
      const baseInputEl = card.querySelector('.auth-edit-base-url');
      if (baseInputEl && baseUrl) baseInputEl.value = baseUrl;
      if (cookiesPaste) body.cookiesPaste = cookiesPaste;
      if (payloadStr) {
        try {
          body.payload = JSON.parse(payloadStr);
        } catch {
          if (hintEl) { hintEl.textContent = 'Advanced JSON is invalid—fix or clear it.'; hintEl.className = 'hint error auth-edit-hint'; }
          return;
        }
      }
      try {
        await api('PATCH', '/auth-profiles/' + id, body);
        if (hintEl) { hintEl.textContent = 'Saved.'; hintEl.className = 'hint auth-edit-hint'; }
        await loadAuthProfiles();
      } catch (err) {
        if (hintEl) { hintEl.textContent = 'Error: ' + err.message; hintEl.className = 'hint error auth-edit-hint'; }
      }
    };
  });
}

$('btn-auth-form-submit').onclick = async () => {
  const name = $('auth-form-name').value.trim();
  const baseUrl = normalizeUrlInput($('auth-form-base-url').value.trim());
  if (baseUrl) $('auth-form-base-url').value = baseUrl;
  const mode = $('auth-form-mode').value;
  const cookiesPaste = $('auth-form-cookies-paste').value.trim();
  const payloadStr = $('auth-form-payload').value.trim();
  const hintEl = $('auth-form-hint');
  if (!name || !baseUrl) {
    hintEl.textContent = 'Enter a profile name and your site URL (e.g. https://app.example.com).';
    hintEl.className = 'hint error';
    return;
  }
  if (!cookiesPaste && !payloadStr) {
    hintEl.textContent = 'Paste the cookie table from Chrome after you log in—or open Advanced if you use JSON only.';
    hintEl.className = 'hint error';
    return;
  }
  let payload;
  if (payloadStr) {
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      hintEl.textContent = 'Advanced JSON is not valid—fix it or clear it.';
      hintEl.className = 'hint error';
      return;
    }
  }
  hintEl.textContent = '';
  try {
    const body = { name, baseUrl, mode };
    if (cookiesPaste) body.cookiesPaste = cookiesPaste;
    if (payload && Object.keys(payload).length) body.payload = payload;
    await api('POST', '/auth-profiles', body);
    $('auth-form-name').value = '';
    $('auth-form-base-url').value = '';
    $('auth-form-cookies-paste').value = '';
    $('auth-form-payload').value = '';
    const modeEl = $('auth-form-mode');
    if (modeEl) modeEl.value = 'session';
    const adv = $('auth-form-advanced');
    if (adv) adv.open = false;
    hintEl.textContent = 'Saved. Pick this profile when you scan or run a scenario.';
    hintEl.className = 'hint';
    await loadAuthProfiles();
  } catch (err) {
    hintEl.textContent = 'Error: ' + err.message;
    hintEl.className = 'hint error';
  }
};

// ─── Init ─────────────────────────────────────────────────────────────
const RUN_HEADLESS_KEY = 'viberegress_run_headless';

(function initRunHeadlessPreference() {
  try {
    const el = $('run-headless');
    if (!el) return;
    const stored = localStorage.getItem(RUN_HEADLESS_KEY);
    if (stored !== null) el.checked = stored === 'true';
    el.addEventListener('change', () => {
      localStorage.setItem(RUN_HEADLESS_KEY, $('run-headless').checked);
    });
  } catch (_) {}
})();

(async () => {
  bindAuthUi();
  await initAuth();
  try {
    await loadScenarios();
    await loadAuthProfiles();
    if (scenarios.length > 0) {
      openScenario(scenarios[0].id);
    } else {
      showView('welcome');
    }
  } catch (err) {
    console.error(err);
    const hint = $('scan-hint');
    if (hint) {
      hint.textContent = err.message || 'Could not load data. Refresh or check you are online.';
      hint.className = 'hint error';
    }
    showView('welcome');
  }
})();
