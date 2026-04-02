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
let activeAddStepIndex = null;
/** Cached run UI per scenario id so we can preserve results across tab switches. */
let runUiCacheByScenarioId = new Map();
/** Scenario id whose run is currently in progress (best-effort; see run UI updates). */
let runInProgressScenarioId = null;

let sessionId = null;
let supabaseClient = null;
let accessToken = null;
let authConfigured = false;
let cachedUserEmail = '';
/** @type {null | { monthlyRunsUsed?: number; monthlyRunsLimit?: number; monthlyRunsRemaining?: number; atLimit?: boolean }} */
let monthlyUsageCache = null;

function isLoggedIn() {
  return !!accessToken;
}

function isLocalhostRuntime() {
  const host = (window.location && window.location.hostname ? window.location.hostname : '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isAnonymousTrialLimited() {
  return !isLocalhostRuntime();
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
  welcome:        $('view-welcome'),
  discovery:      $('view-discovery'),
  scenario:       $('view-scenario'),
  authProfiles:   $('view-auth-profiles'),
  site:           $('view-site'),
  account:        $('view-account'),
  sharedSite:     $('view-shared-site'),
  sharedScenario: $('view-shared-scenario'),
};

let shareTokenActive = null;
let sharedSiteScenarios = [];
let activeSharedScenario = null;

function parseSharePath() {
  const m = /^\/share\/([^/]+)\/?$/.exec(window.location.pathname || '');
  return m ? m[1] : null;
}

// ─── View switching ──────────────────────────────────────────────────
function showView(name) {
  Object.values(views).forEach(v => {
    if (v) v.classList.remove('active');
  });
  const v = views[name];
  if (v) v.classList.add('active');
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
    const e = new Error(err.error || res.statusText);
    e.details = err;
    throw e;
  }
  return res.json();
}

/** Headers for run SSE fetches (auth matches api()). */
function runFetchHeaders(jsonBody) {
  const h = {};
  if (jsonBody) h['Content-Type'] = 'application/json';
  if (accessToken) h['Authorization'] = 'Bearer ' + accessToken;
  else if (sessionId) h['X-Session-Id'] = sessionId;
  return h;
}

let siteBatchRunning = false;
/** Clears run dashboard when switching to a different site. */
let lastSiteDashboardUrl = null;

function updateSiteRunAllButton() {
  const btn = $('btn-site-run-all');
  if (!btn) return;
  const siteScenarios = selectedSiteUrl
    ? scenarios.filter(s => (s.siteUrl || '') === selectedSiteUrl)
    : [];
  const n = siteScenarios.length;
  if (!n) {
    btn.disabled = true;
    btn.title = 'No scenarios to run';
    return;
  }
  if (siteBatchRunning) {
    btn.disabled = true;
    btn.title = 'Batch run in progress';
    return;
  }
  if (!isLoggedIn() && isAnonymousTrialLimited() && trialRunsUsed() >= 2) {
    btn.disabled = true;
    btn.title = 'Sign up to run more scenarios';
    return;
  }
  if (!isLoggedIn() && isAnonymousTrialLimited() && trialRunsRemaining() < n) {
    btn.disabled = true;
    btn.title =
      'Trial: ' +
      trialRunsRemaining() +
      ' run(s) left for ' +
      n +
      ' scenarios — sign in to run all';
    return;
  }
  if (isLoggedIn() && monthlyUsageCache && monthlyUsageCache.atLimit) {
    btn.disabled = true;
    btn.title = 'Monthly run limit reached — upgrade to continue';
    return;
  }
  btn.disabled = false;
  btn.title = 'Run all ' + n + ' scenario(s) one after another';
}

function runButtonStateForRunBtn() {
  if (!isLoggedIn() && isAnonymousTrialLimited() && trialRunsUsed() >= 2) {
    return { disabled: true, title: 'Sign up to run more scenarios' };
  }
  if (isLoggedIn() && monthlyUsageCache && monthlyUsageCache.atLimit) {
    return { disabled: true, title: 'Monthly run limit reached' };
  }
  return { disabled: false, title: '' };
}

async function refreshMonthlyUsage() {
  if (!isLoggedIn()) {
    monthlyUsageCache = null;
    updateSiteRunAllButton();
    return;
  }
  try {
    monthlyUsageCache = await api('GET', '/usage');
  } catch {
    monthlyUsageCache = null;
  }
  updateSiteRunAllButton();
}

function formatPeriodResetUtc(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }) + ' (UTC)'
  );
}

function openPaywallModal(payload) {
  const used = payload.used ?? payload.monthlyRunsUsed ?? 0;
  const limit = payload.limit ?? payload.monthlyRunsLimit ?? 20;
  const body = $('paywall-body');
  const reset = $('paywall-reset');
  if (body) {
    body.textContent = `You've used ${used} of ${limit} scenario runs this calendar month (UTC). Upgrade to run more.`;
  }
  const end = payload.periodEndExclusiveUtc || payload.periodResetsAtUtc;
  if (reset) {
    reset.textContent = end ? 'Your limit resets on ' + formatPeriodResetUtc(end) + '.' : '';
  }
  const ov = $('paywall-overlay');
  if (ov) {
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
  }
}

function closePaywallModal() {
  const ov = $('paywall-overlay');
  if (ov) {
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
  }
}

async function downloadTraceWithAuth(traceUrl) {
  const res = await fetch(traceUrl, { headers: runFetchHeaders(false) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Trace download failed');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = 'trace.zip';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function traceDownloadLinkHtml(traceUrl, text = 'Download trace') {
  const safeUrl = escapeAttr(traceUrl || '');
  return `<a href="${safeUrl}" data-trace-url="${safeUrl}">${escapeHtml(text)}</a>`;
}

document.addEventListener('click', (e) => {
  const target = e.target;
  const linkEl = target && target.closest ? target.closest('a[data-trace-url]') : null;
  if (!linkEl) return;
  e.preventDefault();
  const traceUrl = linkEl.getAttribute('data-trace-url') || linkEl.getAttribute('href');
  if (!traceUrl) return;
  const prevText = linkEl.textContent || 'Download trace';
  linkEl.textContent = 'Downloading...';
  linkEl.setAttribute('aria-disabled', 'true');
  void downloadTraceWithAuth(traceUrl)
    .then(() => {
      linkEl.textContent = 'Downloaded';
      setTimeout(() => {
        linkEl.textContent = prevText;
      }, 1500);
    })
    .catch((err) => {
      alert(err && err.message ? err.message : 'Trace download failed');
      linkEl.textContent = prevText;
    })
    .finally(() => {
      linkEl.removeAttribute('aria-disabled');
    });
});

async function loadAccountView() {
  const emailEl = $('account-email');
  const lineEl = $('account-usage-line');
  const resetEl = $('account-usage-reset');
  if (emailEl) emailEl.textContent = cachedUserEmail || '';
  if (!isLoggedIn()) {
    if (lineEl) lineEl.textContent = 'Sign in to see usage.';
    if (resetEl) resetEl.textContent = '';
    const sl = $('account-share-links-list');
    const se = $('account-share-empty');
    if (sl) sl.innerHTML = '';
    if (se) {
      se.hidden = false;
      se.textContent = 'Sign in to see your share links.';
    }
    return;
  }
  if (lineEl) lineEl.textContent = 'Loading…';
  try {
    const u = await api('GET', '/usage');
    monthlyUsageCache = u;
    if (lineEl) {
      lineEl.textContent = `${u.monthlyRunsUsed} of ${u.monthlyRunsLimit} used · ${u.monthlyRunsRemaining} left`;
    }
    if (resetEl) {
      resetEl.textContent = u.periodResetsAtUtc
        ? 'Resets on ' + formatPeriodResetUtc(u.periodResetsAtUtc) + '.'
        : '';
    }
  } catch {
    if (lineEl) lineEl.textContent = 'Could not load usage.';
    if (resetEl) resetEl.textContent = '';
  }
  const shareList = $('account-share-links-list');
  const shareEmpty = $('account-share-empty');
  if (shareList) shareList.innerHTML = 'Loading…';
  try {
    const recent = await api('GET', '/share-links/recent');
    if (shareEmpty) {
      shareEmpty.hidden = recent.length > 0;
      if (!recent.length) {
        shareEmpty.textContent =
          'No active share links yet. Open a site and use Share to create one.';
      }
    }
    if (shareList) {
      if (!recent.length) {
        shareList.innerHTML = '';
      } else {
        shareList.innerHTML = recent
          .map(
            l => `
          <li class="account-share-row">
            <span class="account-share-site">${escapeHtml(l.siteUrl)}</span>
            <button type="button" class="btn-secondary btn-sm account-share-copy" data-url="${escapeHtml(
              window.location.origin + l.sharePath
            )}">Copy link</button>
          </li>`
          )
          .join('');
        shareList.querySelectorAll('.account-share-copy').forEach(btn => {
          btn.addEventListener('click', () => {
            const u = btn.getAttribute('data-url');
            if (u) {
              navigator.clipboard.writeText(u).catch(() => {});
              btn.textContent = 'Copied';
              setTimeout(() => {
                btn.textContent = 'Copy link';
              }, 1500);
            }
          });
        });
      }
    }
  } catch {
    if (shareList) shareList.innerHTML = '';
    if (shareEmpty) shareEmpty.hidden = false;
  }
}

function closeShareModal() {
  const ov = $('share-overlay');
  if (ov) {
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
  }
}

async function loadShareLinksModal() {
  const listEl = $('share-links-list');
  const hint = $('share-modal-hint');
  if (!selectedSiteUrl || !listEl) return;
  listEl.innerHTML = '<li class="hint">Loading…</li>';
  try {
    const links = await api('GET', '/sites/' + encodeURIComponent(selectedSiteUrl) + '/share-links');
    const base = window.location.origin;
    if (!links.length) {
      listEl.innerHTML = '<li class="hint">No links yet. Create one below.</li>';
    } else {
      listEl.innerHTML = links
        .map(l => {
          const full = l.sharePath ? base + l.sharePath : '';
          const active = l.active;
          return `<li class="share-link-row" data-id="${escapeHtml(l.id)}">
            <code class="share-link-token">${active ? escapeHtml(full) : '(revoked)'}</code>
            <div class="share-link-actions">
              ${
                active
                  ? `<button type="button" class="btn-secondary btn-sm share-copy-btn" data-url="${escapeHtml(
                      full
                    )}">Copy</button>
                 <button type="button" class="btn-secondary btn-sm share-revoke-btn">Revoke</button>`
                  : '<span class="muted">Revoked</span>'
              }
            </div>
          </li>`;
        })
        .join('');
      listEl.querySelectorAll('.share-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const u = btn.getAttribute('data-url');
          if (u) navigator.clipboard.writeText(u).catch(() => {});
        });
      });
      listEl.querySelectorAll('.share-revoke-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.share-link-row');
          const id = row && row.getAttribute('data-id');
          if (!id) return;
          try {
            await api('DELETE', '/sites/' + encodeURIComponent(selectedSiteUrl) + '/share-links/' + id);
            await loadShareLinksModal();
            if (hint) hint.textContent = 'Link revoked.';
          } catch (e) {
            if (hint) hint.textContent = e.message || 'Revoke failed';
          }
        });
      });
    }
  } catch (e) {
    listEl.innerHTML = '';
    if (hint) hint.textContent = e.message || 'Could not load links';
  }
}

function openShareModal() {
  if (!selectedSiteUrl) return;
  if (!isLoggedIn()) {
    switchAuthTab('signin');
    openAuthModal();
    return;
  }
  const ov = $('share-overlay');
  if (ov) {
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
  }
  const hint = $('share-modal-hint');
  if (hint) hint.textContent = '';
  void loadShareLinksModal();
}

function bindShareUi() {
  $('btn-site-share')?.addEventListener('click', () => openShareModal());
  $('share-modal-close')?.addEventListener('click', closeShareModal);
  $('share-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'share-overlay') closeShareModal();
  });
  $('btn-share-create')?.addEventListener('click', async () => {
    const hint = $('share-modal-hint');
    if (!selectedSiteUrl) return;
    try {
      const created = await api('POST', '/sites/' + encodeURIComponent(selectedSiteUrl) + '/share-links', {});
      const url = window.location.origin + created.sharePath;
      await navigator.clipboard.writeText(url).catch(() => {});
      if (hint) hint.textContent = 'New link created and copied: ' + url;
      await loadShareLinksModal();
    } catch (e) {
      if (hint) hint.textContent = e.message || 'Could not create link';
    }
  });
}

function bindSharedVisitorUi() {
  $('btn-shared-signin')?.addEventListener('click', () => {
    switchAuthTab('signin');
    openAuthModal();
  });
  $('btn-shared-back')?.addEventListener('click', () => {
    renderSharedSiteList();
    showView('sharedSite');
  });
  $('shared-btn-run')?.addEventListener('click', () => void runSharedScenario());
}

function renderSharedSiteList() {
  const listEl = $('shared-site-scenario-list');
  if (!listEl) return;
  if (!sharedSiteScenarios.length) {
    listEl.innerHTML = '<li class="empty-state">No scenarios on this shared site.</li>';
    return;
  }
  listEl.innerHTML = sharedSiteScenarios
    .map(
      s => `
    <li class="site-scenario-row">
      <span class="scenario-item ${s.lastStatus || 'never'}" data-shared-scenario-id="${escapeHtml(s.id)}">
        <span class="s-dot"></span>
        <span class="s-name">${escapeHtml(s.name)}</span>
      </span>
    </li>`
    )
    .join('');
  listEl.querySelectorAll('[data-shared-scenario-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-shared-scenario-id');
      if (id) openSharedScenarioDetail(id);
    });
  });
}

function openSharedScenarioDetail(id) {
  const s = sharedSiteScenarios.find(x => x.id === id);
  if (!s) return;
  activeSharedScenario = s;
  const nameEl = $('shared-detail-name');
  const urlEl = $('shared-detail-url');
  if (nameEl) nameEl.textContent = s.name;
  if (urlEl) urlEl.textContent = s.siteUrl;
  const stepsEl = $('shared-detail-steps');
  if (stepsEl) {
    stepsEl.innerHTML = (s.steps || [])
      .map(
        (step, i) => `
      <li class="step-row">
        <span class="step-num">${i + 1}</span>
        <span class="step-type ${step.type}">${step.type}</span>
        <span>${escapeHtml(step.instruction)}</span>
      </li>`
      )
      .join('');
  }
  const out = $('shared-run-output');
  if (out) out.innerHTML = '<p class="run-idle">Sign in to run, then click Run now.</p>';
  const badge = $('shared-run-status-badge');
  if (badge) badge.innerHTML = '';
  showView('sharedScenario');
}

function handleSharedRunEvent(event, scenario, currentRunId) {
  if (event.type === 'step') {
    const el = $(`shared-run-step-${event.index}`);
    if (!el) return;
    el.className = `run-step ${event.status}`;
    const icon = el.querySelector('.run-step-icon');
    if (icon) icon.className = `run-step-icon ${event.status}`;
    if (event.durationMs !== undefined) {
      const dur = el.querySelector('.run-step-dur');
      if (dur) dur.textContent = event.durationMs + 'ms';
    }
    if (event.error) {
      const errDiv = document.createElement('div');
      errDiv.className = 'run-error-box';
      errDiv.textContent = event.error;
      el.after(errDiv);
    }
    const nextEl = $(`shared-run-step-${event.index + 1}`);
    if (nextEl && event.status === 'pass') {
      nextEl.className = 'run-step running';
      const ni = nextEl.querySelector('.run-step-icon');
      if (ni) ni.className = 'run-step-icon running';
    }
  }
  if (event.type === 'done') {
    if (isLoggedIn()) {
      void refreshMonthlyUsage();
    }
    const badge = $('shared-run-status-badge');
    if (badge) badge.innerHTML = `<span class="badge ${event.status}">${event.status}</span>`;
    const rb = $('shared-btn-run');
    if (rb) {
      rb.disabled = false;
      rb.textContent = '▶ Run again';
    }
    if (event.traceUrl && $('shared-run-output')) {
      const traceLink = document.createElement('p');
      traceLink.className = 'run-trace-link';
      traceLink.innerHTML = `Debug: ${traceDownloadLinkHtml(event.traceUrl)}`;
      $('shared-run-output').appendChild(traceLink);
    }
  }
}

async function runSharedScenario() {
  if (!activeSharedScenario || !shareTokenActive) return;
  if (!isLoggedIn()) {
    openAuthModal();
    switchAuthTab('signin');
    return;
  }
  const scenario = activeSharedScenario;
  const btn = $('shared-btn-run');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
  }
  const badge = $('shared-run-status-badge');
  if (badge) badge.innerHTML = '<span class="badge running">running</span>';
  const output = $('shared-run-output');
  if (output) {
    output.innerHTML = scenario.steps
      .map(
        (step, i) => `
      <div class="run-step pending" id="shared-run-step-${i}">
        <span class="run-step-icon pending"></span>
        <span class="run-step-text">${escapeHtml(step.instruction)}</span>
        <span class="run-step-dur"></span>
      </div>`
      )
      .join('');
  }
  const headlessEl = $('shared-run-headless');
  const headless = headlessEl ? headlessEl.checked : true;
  const res = await fetch(
    '/api/share/' + encodeURIComponent(shareTokenActive) + '/scenarios/' + encodeURIComponent(scenario.id) + '/run',
    {
      method: 'POST',
      headers: runFetchHeaders(true),
      body: JSON.stringify({ headless }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 402 && err.error === 'monthly_limit_exceeded') {
      monthlyUsageCache = {
        monthlyRunsUsed: err.used,
        monthlyRunsLimit: err.limit,
        monthlyRunsRemaining: err.remaining ?? 0,
        atLimit: true,
      };
      openPaywallModal(err);
    } else {
      alert(err.error || res.statusText || 'Run failed');
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = '▶ Run now';
    }
    if (badge) badge.innerHTML = '';
    if (output) output.innerHTML = '<p class="run-idle">Try again after signing in or fixing the error.</p>';
    return;
  }
  if (!res.body) {
    alert('No response body');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '▶ Run now';
    }
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentRunId = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (event.type === 'start' && event.run) currentRunId = event.run.id;
      handleSharedRunEvent(event, scenario, currentRunId);
    }
  }
}

async function bootstrapSharedVisitor(token) {
  shareTokenActive = token;
  const titleEl = $('shared-site-title');
  const urlEl = $('shared-site-url');
  const listEl = $('shared-site-scenario-list');
  try {
    const r = await fetch('/api/share/' + encodeURIComponent(token) + '/site');
    if (!r.ok) {
      if (titleEl) titleEl.textContent = 'Link unavailable';
      if (urlEl) urlEl.textContent = 'This share link is invalid or has been revoked.';
      if (listEl) listEl.innerHTML = '';
      showView('sharedSite');
      return;
    }
    const data = await r.json();
    sharedSiteScenarios = data.scenarios || [];
    if (urlEl) urlEl.textContent = data.siteUrl || '';
    if (titleEl) titleEl.textContent = 'Shared scenarios';
    renderSharedSiteList();
    showView('sharedSite');
  } catch {
    if (titleEl) titleEl.textContent = 'Error';
    if (urlEl) urlEl.textContent = 'Could not load shared site.';
    showView('sharedSite');
  }
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
        if (!accessToken) monthlyUsageCache = null;
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
          if (accessToken) await refreshMonthlyUsage();
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
  const btnAcct = $('btn-my-account');
  if (isLoggedIn()) {
    banner.hidden = true;
    emailEl.textContent = cachedUserEmail || 'Signed in';
    const anonActions = $('auth-user-actions-anon');
    if (anonActions) anonActions.classList.add('hidden');
    if (btnOut) btnOut.hidden = false;
    if (btnAcct) btnAcct.classList.remove('hidden');
  } else {
    banner.hidden = false;
    if (isAnonymousTrialLimited()) {
      const left = trialRunsRemaining();
      runsText.textContent =
        left > 0 ? left + ' free run' + (left === 1 ? '' : 's') + ' left' : 'No runs left — sign up to continue';
    } else {
      runsText.textContent = 'Unlimited runs on localhost';
    }
    emailEl.textContent = 'Trial mode';
    const anonActions = $('auth-user-actions-anon');
    if (anonActions) anonActions.classList.remove('hidden');
    if (btnOut) btnOut.hidden = true;
    if (btnAcct) btnAcct.classList.add('hidden');
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

function bindAccountUi() {
  $('btn-my-account')?.addEventListener('click', () => {
    showView('account');
    void loadAccountView();
  });
  $('paywall-close')?.addEventListener('click', closePaywallModal);
  $('paywall-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'paywall-overlay') closePaywallModal();
  });
  const paywallCta = () => {
    closePaywallModal();
    alert('Payments are not wired up yet — this is a placeholder.');
  };
  $('paywall-upgrade')?.addEventListener('click', paywallCta);
  $('btn-account-upgrade')?.addEventListener('click', paywallCta);
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
  updateSiteRunAllButton();
  const sumEl = $('site-run-summary');
  const dashList = $('site-run-dashboard-list');
  if (sumEl && dashList && !siteBatchRunning) {
    if (lastSiteDashboardUrl !== selectedSiteUrl) {
      lastSiteDashboardUrl = selectedSiteUrl;
      dashList.innerHTML = '';
      if (!siteScenarios.length) sumEl.textContent = '';
      else
        sumEl.textContent =
          'Click “Run all scenarios” to execute every scenario and see pass/fail here.';
    } else if (!siteScenarios.length) {
      dashList.innerHTML = '';
      sumEl.textContent = '';
    }
  }
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

const btnSiteRunAll = $('btn-site-run-all');
if (btnSiteRunAll) {
  btnSiteRunAll.onclick = () => runAllScenariosForSite();
}

async function runAllScenariosForSite() {
  if (!selectedSiteUrl || siteBatchRunning) return;
  const siteScenarios = scenarios.filter(s => (s.siteUrl || '') === selectedSiteUrl);
  if (!siteScenarios.length) return;

  if (!isLoggedIn() && isAnonymousTrialLimited() && trialRunsUsed() >= 2) {
    openAuthModal();
    switchAuthTab('signup');
    return;
  }
  if (!isLoggedIn() && isAnonymousTrialLimited() && trialRunsRemaining() < siteScenarios.length) {
    alert(
      'Trial allows ' +
        trialRunsRemaining() +
        ' more run(s), but this site has ' +
        siteScenarios.length +
        ' scenarios. Sign in to run all.'
    );
    openAuthModal();
    switchAuthTab('signup');
    return;
  }

  siteBatchRunning = true;
  const btn = $('btn-site-run-all');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
  }

  const listEl = $('site-run-dashboard-list');
  const summaryEl = $('site-run-summary');
  const total = siteScenarios.length;
  if (summaryEl) summaryEl.textContent = 'Starting… (0/' + total + ' complete)';
  if (listEl) {
    listEl.innerHTML = siteScenarios
      .map(
        s => `
      <li class="site-dash-row pending" id="site-dash-${s.id}" data-scenario-id="${s.id}">
        <div class="site-dash-row-top">
          <span class="site-dash-status pending">pending</span>
          <span class="site-dash-name">${escapeHtml(s.name)}</span>
        </div>
        <div class="site-dash-progress"></div>
        <div class="site-dash-error"></div>
        <div class="site-dash-trace"></div>
      </li>`
      )
      .join('');
  }

  const headlessEl = $('run-headless');
  const headless = headlessEl ? headlessEl.checked : false;
  const path = '/sites/' + encodeURIComponent(selectedSiteUrl) + '/run-all';

  let completed = 0;
  let hitMonthlyPaywall = false;
  try {
    const res = await fetch('/api' + path, {
      method: 'POST',
      headers: runFetchHeaders(true),
      body: JSON.stringify({ headless }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    if (!res.body) throw new Error('No response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === 'monthlyLimitExceeded') {
          hitMonthlyPaywall = true;
          monthlyUsageCache = {
            monthlyRunsUsed: ev.used,
            monthlyRunsLimit: ev.limit,
            monthlyRunsRemaining: 0,
            atLimit: true,
          };
          openPaywallModal(ev);
          break outer;
        }
        if (ev.type === 'batchStart' && summaryEl) {
          summaryEl.textContent = 'Running… (0/' + (ev.total || total) + ' complete)';
        }
        if (ev.type === 'scenarioStart') {
          const row = $('site-dash-' + ev.scenarioId);
          if (row) {
            row.className = 'site-dash-row running';
            row.dataset.stepCount = String(ev.stepCount || 0);
            const st = row.querySelector('.site-dash-status');
            const pr = row.querySelector('.site-dash-progress');
            if (st) {
              st.className = 'site-dash-status running';
              st.textContent = 'running';
            }
            if (pr) pr.textContent = 'Step 1 / ' + (ev.stepCount || '?') + '…';
          }
        }
        if (ev.type === 'step' && ev.scenarioId != null) {
          const row = $('site-dash-' + ev.scenarioId);
          const nSteps = Number(row && row.dataset.stepCount) || 0;
          const pr = row && row.querySelector('.site-dash-progress');
          if (pr && ev.status === 'pass' && nSteps) {
            const doneSteps = ev.index + 1;
            if (doneSteps >= nSteps) pr.textContent = 'All ' + nSteps + ' steps completed';
            else pr.textContent = 'Step ' + (doneSteps + 1) + ' / ' + nSteps + '…';
          }
          if (pr && ev.status === 'fail') {
            pr.textContent = 'Stopped at step ' + (ev.index + 1) + ' / ' + (nSteps || '?');
            const errEl = row.querySelector('.site-dash-error');
            if (errEl && ev.error) errEl.textContent = ev.error;
          }
        }
        if (ev.type === 'scenarioDone') {
          completed += 1;
          if (summaryEl) {
            summaryEl.textContent =
              'Progress: ' + completed + '/' + total + ' scenario(s) finished';
          }
          if (!isLoggedIn()) {
            sessionStorage.setItem(TRIAL_RUNS_KEY, String(trialRunsUsed() + 1));
            updateAuthChrome();
          }
          const row = $('site-dash-' + ev.scenarioId);
          if (row) {
            row.className = 'site-dash-row ' + ev.status;
            const st = row.querySelector('.site-dash-status');
            if (st) {
              st.className = 'site-dash-status ' + ev.status;
              st.textContent = ev.status;
            }
            const errEl = row.querySelector('.site-dash-error');
            if (errEl && ev.error && ev.status === 'fail') errEl.textContent = ev.error;
            const tr = row.querySelector('.site-dash-trace');
            if (tr && ev.traceUrl) {
              tr.innerHTML =
                traceDownloadLinkHtml(ev.traceUrl);
            }
          }
        }
        if (ev.type === 'batchDone' && summaryEl) {
          summaryEl.textContent =
            'Done: ' + ev.passed + ' passed, ' + ev.failed + ' failed (of ' + ev.total + ')';
        }
      }
    }
  } catch (e) {
    if (summaryEl) summaryEl.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
    alert('Run all failed: ' + (e && e.message ? e.message : String(e)));
  } finally {
    if (hitMonthlyPaywall && summaryEl) {
      summaryEl.textContent =
        (summaryEl.textContent || '') + ' — monthly run limit reached; remaining scenarios were not run.';
    }
    siteBatchRunning = false;
    if (btn) btn.textContent = 'Run all scenarios';
    updateSiteRunAllButton();
    try {
      await loadScenarios();
      renderSidebarList();
      if (views.site && views.site.classList.contains('active')) renderSiteView();
    } catch (_) {}
  }
}

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

function buildDiscoveryLogFallback(result, scenarios) {
  const visitedPages = Array.isArray(result && result.visitedPages) ? result.visitedPages : [];
  const intentTraces = Array.isArray(result && result.intentTraces) ? result.intentTraces : [];
  const selectedCtas = result && result.crawlMeta && Array.isArray(result.crawlMeta.selectedCtas) ? result.crawlMeta.selectedCtas : [];
  const crawlErrors = result && result.crawlMeta && Array.isArray(result.crawlMeta.crawlErrors) ? result.crawlMeta.crawlErrors : [];
  const lines = [];
  lines.push('DISCOVERY LOG');
  lines.push(`siteUrl: ${result && result.siteUrl ? result.siteUrl : ''}`);
  lines.push(`createdAt: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`SUMMARY`);
  lines.push(`selectedCtaCount: ${selectedCtas.length}`);
  lines.push(`visitedPageCount: ${visitedPages.length}`);
  lines.push(`intentTraceCount: ${intentTraces.length}`);
  lines.push(`scenarioCount: ${scenarios.length}`);
  lines.push('');
  lines.push(`SELECTED CTAS`);
  lines.push(selectedCtas.length ? selectedCtas.map((c, i) => `${i + 1}. ${c}`).join('\n') : '- none');
  lines.push('');
  lines.push(`VISITED PAGES`);
  lines.push(
    visitedPages.length
      ? visitedPages.map((p, i) => `${i + 1}. ${p.url || ''} | title=${p.title || ''} | requireAuth=${p.requireAuth ? 'yes' : 'no'}`).join('\n')
      : '- none'
  );
  lines.push('');
  lines.push(`INTENT TRACES`);
  lines.push(
    intentTraces.length
      ? intentTraces
          .map((t, i) => `${i + 1}. intent=${t.intent && t.intent.label ? t.intent.label : ''}\n   action=${t.intent && t.intent.actionInstruction ? t.intent.actionInstruction : ''}\n   outcomeUrl=${t.observedOutcome && t.observedOutcome.url ? t.observedOutcome.url : ''}\n   outcomeTitle=${t.observedOutcome && t.observedOutcome.title ? t.observedOutcome.title : ''}\n   requireAuth=${t.observedOutcome && t.observedOutcome.requireAuth ? 'yes' : 'no'}`)
          .join('\n')
      : '- none'
  );
  lines.push('');
  lines.push(`FINAL SCENARIOS`);
  lines.push(
    scenarios.length
      ? scenarios
          .map((s, i) => `${i + 1}. ${s.name}\n   verificationStatus=${s.verificationStatus || 'unknown'}\n   verificationError=${s.verificationError || ''}\n   steps:\n${(s.steps || []).map((step, idx) => `     ${idx + 1}. [${step.type}] ${step.instruction}`).join('\n')}`)
          .join('\n')
      : '- none'
  );
  lines.push('');
  lines.push(`CRAWL ERRORS`);
  lines.push(crawlErrors.length ? crawlErrors.map((e, i) => `${i + 1}. ${e}`).join('\n') : '- none');
  return lines.join('\n');
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
  const allScenarios = Array.isArray(result.scenarios) ? result.scenarios : [];
  const filtered = allScenarios;
  $('discovery-title').textContent = `${filtered.length} scenarios discovered`;
  $('discovery-url').textContent = result.siteUrl;

  const visitedPages = Array.isArray(result.visitedPages) ? result.visitedPages : [];
  const intentTraces = Array.isArray(result.intentTraces) ? result.intentTraces : [];
  const visitedHtml = visitedPages.length
    ? `
      <div class="discovery-visited panel">
        <p class="panel-label">Visited pages (${visitedPages.length})</p>
        <ul class="discovery-visited-list">
          ${visitedPages.map((p) => `
            <li class="discovery-visited-item">
              <div class="discovery-visited-url">${escapeHtml(p.url || '')}</div>
              <div class="discovery-visited-meta">
                ${p.requireAuth ? '<span class="discovery-auth-badge">Auth</span>' : ''}
                <span>${escapeHtml(p.title || '')}</span>
              </div>
              <div class="discovery-visited-summary">${escapeHtml(p.summary || '')}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    `
    : '';

  const traceHtml = intentTraces.length
    ? `
      <div class="discovery-traces panel">
        <p class="panel-label">How discovered (${intentTraces.length})</p>
        <ul class="discovery-trace-list">
          ${intentTraces.map((t) => `
            <li class="discovery-trace-item">
              <div class="discovery-trace-head">
                <span class="discovery-trace-intent">${escapeHtml(t.intent.label || '')}</span>
                <span class="discovery-trace-class">${escapeHtml(t.observedOutcome.pageClass || '')}</span>
                ${t.observedOutcome.requireAuth ? '<span class="discovery-auth-badge">Auth required</span>' : ''}
              </div>
              <div class="discovery-trace-url">${escapeHtml(t.observedOutcome.url || '')}</div>
              <div class="discovery-trace-summary">${escapeHtml(t.observedOutcome.summary || '')}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    `
    : '';

  const discoveryLogText = (result && typeof result.discoveryLog === 'string' && result.discoveryLog.trim())
    ? result.discoveryLog
    : buildDiscoveryLogFallback(result, filtered);
  const discoveryLogHtml = `
    <div class="discovery-log panel">
      <div class="discovery-log-head">
        <p class="panel-label">Discovery full log</p>
        <button type="button" class="btn-secondary btn-sm" id="discovery-log-copy">Copy log</button>
      </div>
      <textarea id="discovery-log-text" class="input mono" rows="14" readonly>${escapeHtml(discoveryLogText)}</textarea>
    </div>
  `;

  $('discovery-list').innerHTML = discoveryLogHtml + visitedHtml + traceHtml + filtered.map((s, i) => `
    <div class="scenario-card" data-index="${i}">
      <div class="scenario-card-header">
        <div>
          <div class="scenario-card-name">${s.name}</div>
          <div class="scenario-card-desc">${s.description}</div>
          <div class="discovery-scenario-meta">
            ${s.requireAuth ? '<span class="discovery-auth-badge">Auth required</span>' : ''}
            ${s.verificationStatus ? `<span class="discovery-verif-badge ${escapeHtml(s.verificationStatus)}" title="${escapeHtml(s.verificationError || '')}">${escapeHtml(s.verificationStatus)}</span>` : ''}
            ${s.intentDrift && s.intentDrift.detected ? `<span class="discovery-auth-badge" title="${escapeHtml(s.intentDrift.reason || '')}">Intent drift</span>` : ''}
          </div>
        </div>
        <button type="button" class="btn-${s.verificationStatus === 'unverified' ? 'secondary' : 'primary'} btn-sm discovery-save-one" data-index="${i}">
          ${s.verificationStatus === 'unverified' ? 'Save & auto-repair' : 'Save'}
        </button>
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
      <p class="hint discovery-card-hint" id="discovery-card-hint-${i}" style="display:none;"></p>
      <div class="discovery-card-trace hidden" id="discovery-card-trace-${i}"></div>
    </div>
  `).join('');
  $('discovery-list').querySelectorAll('.discovery-save-one').forEach((btn) => {
    btn.onclick = () => saveOneDiscoveredScenario(Number(btn.dataset.index));
  });
  const copyBtn = $('discovery-log-copy');
  const logBox = $('discovery-log-text');
  if (copyBtn && logBox) {
    copyBtn.onclick = async () => {
      const text = logBox.value || '';
      try {
        await navigator.clipboard.writeText(text);
        const prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = prev;
        }, 1200);
      } catch (_) {
        logBox.focus();
        logBox.select();
      }
    };
  }
}

async function saveOneDiscoveredScenario(index) {
  if (!discoveredScenarios || !discoveredScenarios.scenarios || !discoveredScenarios.scenarios[index]) return;
  const scenario = discoveredScenarios.scenarios[index];
  const card = document.querySelector(`.scenario-card[data-index="${index}"]`);
  const hint = $(`discovery-card-hint-${index}`);
  const traceBox = $(`discovery-card-trace-${index}`);
  const button = card ? card.querySelector('.discovery-save-one') : null;
  if (button) {
    button.disabled = true;
    button.textContent = 'Saving…';
  }
  if (hint) {
    hint.style.display = 'none';
    hint.textContent = '';
  }
  if (traceBox) {
    traceBox.classList.add('hidden');
    traceBox.innerHTML = '';
  }
  try {
    await api('POST', '/scenarios/save-one-from-discovery', { scenario });
    discoveredScenarios.scenarios.splice(index, 1);
    await loadScenarios();
    if (!discoveredScenarios.scenarios.length) {
      discoveredScenarios = null;
      showView('welcome');
      return;
    }
    renderDiscovery(discoveredScenarios);
  } catch (err) {
    const details = err && err.details ? err.details : null;
    if (hint) {
      hint.style.display = 'block';
      hint.className = 'hint discovery-card-hint error';
      hint.textContent = 'Failed to save: ' + (err.message || String(err));
    }
    if (traceBox && details && Array.isArray(details.buildLogs) && details.buildLogs.length) {
      traceBox.classList.remove('hidden');
      traceBox.innerHTML = details.buildLogs.map((event) => {
        const cls = event.level === 'warn' || event.level === 'error' ? 'scenario-log-row warn' : 'scenario-log-row';
        return `
          <div class="${cls}">
            <span class="scenario-log-time">${escapeHtml(new Date(event.occurredAt).toLocaleString())}</span>
            <span class="scenario-log-text">${escapeHtml(formatScenarioBuildEventText(event))}</span>
            ${renderScenarioTraceDetails(event && event.payload ? event.payload.trace : null)}
          </div>
        `;
      }).join('');
    }
    if (button) {
      button.disabled = false;
      button.textContent = scenario.verificationStatus === 'unverified' ? 'Save & auto-repair' : 'Save';
    }
  }
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

function formatScenarioBuildEventText(event) {
  const p = event && event.payload ? event.payload : {};
  const modeLabel =
    p.mode === 'modify_before_run' ? 'modify'
      : p.mode === 'discovery' ? 'discovery'
      : 'create';
  switch (event.eventType) {
    case 'scenario_generation_started':
      return `Generation started (${modeLabel}).`;
    case 'scenario_verification_attempted':
      return `Verification attempt ${p.attempt} (${p.stepCount} steps).`;
    case 'scenario_verification_succeeded':
      return `Verification passed (attempt ${p.attempt}, ${p.stepCount} steps).`;
    case 'scenario_verification_failed':
      return `Verification failed (attempt ${p.attempt}): ${p.error || 'Unknown error'}`;
    case 'scenario_repair_attempted':
      return `Auto-repair attempt ${p.attempt} started after verification failure.`;
    case 'scenario_repair_succeeded':
      return `Auto-repair produced ${p.stepCount} steps (attempt ${p.attempt}).`;
    case 'scenario_generation_failed':
      return `Generation failed (${modeLabel}): ${p.error || 'Unknown error'}`;
    case 'scenario_saved':
      return `Scenario saved (${p.stepCount} steps).`;
    default:
      return `${event.eventType}`;
  }
}

function renderScenarioTraceDetails(trace) {
  if (!trace) return '';
  const sections = [];
  if (trace.intent) {
    sections.push(`<details class="scenario-log-details"><summary>Intent</summary><pre>${escapeHtml(trace.intent)}</pre></details>`);
  }
  if (trace.verificationError) {
    sections.push(`<details class="scenario-log-details"><summary>Verification error</summary><pre>${escapeHtml(trace.verificationError)}</pre></details>`);
  }
  if (trace.repairPrompt) {
    sections.push(`<details class="scenario-log-details"><summary>Repair prompt</summary><pre>${escapeHtml(trace.repairPrompt)}</pre></details>`);
  }
  if (trace.candidateBeforeRepair) {
    const c = trace.candidateBeforeRepair;
    sections.push(
      `<details class="scenario-log-details"><summary>Candidate before repair</summary><pre>${escapeHtml(
        `${c.name}\n${c.description}\n\n${(c.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      )}</pre></details>`
    );
  }
  if (trace.aiRewrite) {
    const c = trace.aiRewrite;
    sections.push(
      `<details class="scenario-log-details"><summary>AI rewrite</summary><pre>${escapeHtml(
        `${c.name}\n${c.description}\n\n${(c.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      )}</pre></details>`
    );
  }
  if (trace.rerunResult) {
    const r = trace.rerunResult;
    sections.push(
      `<details class="scenario-log-details"><summary>Re-run result</summary><pre>${escapeHtml(
        `passed: ${r.passed ? 'true' : 'false'}${r.error ? `\nerror: ${r.error}` : ''}`
      )}</pre></details>`
    );
  }
  return sections.join('');
}

async function loadScenarioBuildLogs(scenarioId) {
  const container = $('scenario-build-logs');
  if (!container) return;
  container.innerHTML = '<p class="run-idle">Loading generation logs…</p>';
  try {
    const events = await api('GET', `/scenarios/${scenarioId}/build-logs`);
    if (!events || !events.length) {
      container.innerHTML = '<p class="run-idle">No generation logs yet.</p>';
      return;
    }
    container.innerHTML = events.slice(-25).map((event) => {
      const cls = event.level === 'warn' || event.level === 'error' ? 'scenario-log-row warn' : 'scenario-log-row';
      return `
        <div class="${cls}">
          <span class="scenario-log-time">${escapeHtml(new Date(event.occurredAt).toLocaleString())}</span>
          <span class="scenario-log-text">${escapeHtml(formatScenarioBuildEventText(event))}</span>
          ${renderScenarioTraceDetails(event && event.payload ? event.payload.trace : null)}
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="run-idle">Could not load generation logs: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

// ─── Scenario detail ─────────────────────────────────────────────────
async function openScenario(id) {
  activeScenarioId = id;
  renderSidebarList();

  const s = scenarios.find(x => x.id === id);
  if (!s) return;

  if (isLoggedIn()) await refreshMonthlyUsage();
  await loadScenarioBuildLogs(id);

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
        <button type="button" class="btn-secondary btn-sm step-add-toggle" data-add-after-index="${i}">
          Add after (AI)
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
      <div class="step-add-inline hidden" id="step-add-inline-${i}">
        <label class="edit-scenario-label" for="step-add-input-${i}">Add one step after step ${i + 1}</label>
        <p class="edit-scenario-hint">Describe exactly what the new step should do.</p>
        <div class="edit-scenario-row">
          <textarea id="step-add-input-${i}" class="edit-scenario-input" rows="2" placeholder="e.g. Click “La RSE en PME : une démarche créatrice de valeur”"></textarea>
          <button type="button" class="btn-primary edit-scenario-apply step-add-apply" data-add-after-index="${i}">
            Add step
          </button>
        </div>
      </div>
    </li>
  `).join('') + `
    <li class="step-row step-row-add-end">
      <div class="step-row-main">
        <span class="step-num">+</span>
        <span class="step-text">Add a new step at the end</span>
        <button type="button" class="btn-secondary btn-sm step-add-toggle" data-add-after-index="end">
          Add at end (AI)
        </button>
      </div>
      <div class="step-add-inline hidden" id="step-add-inline-end">
        <label class="edit-scenario-label" for="step-add-input-end">Add one step at the end</label>
        <p class="edit-scenario-hint">Describe exactly what the new step should do.</p>
        <div class="edit-scenario-row">
          <textarea id="step-add-input-end" class="edit-scenario-input" rows="2" placeholder="e.g. Verify at least one session card is visible"></textarea>
          <button type="button" class="btn-primary edit-scenario-apply step-add-apply" data-add-after-index="end">
            Add step
          </button>
        </div>
      </div>
    </li>
  `;
  activeStepEditIndex = null;
  activeAddStepIndex = null;
  $('detail-steps').querySelectorAll('.step-edit-toggle').forEach(btn => {
    btn.onclick = () => toggleStepEditor(Number(btn.dataset.stepIndex));
  });
  $('detail-steps').querySelectorAll('.step-edit-apply').forEach(btn => {
    btn.onclick = () => applyStepEdit(Number(btn.dataset.stepIndex));
  });
  $('detail-steps').querySelectorAll('.step-add-toggle').forEach(btn => {
    btn.onclick = () => toggleAddStepEditor(btn.dataset.addAfterIndex);
  });
  $('detail-steps').querySelectorAll('.step-add-apply').forEach(btn => {
    btn.onclick = () => applyAddStep(btn.dataset.addAfterIndex);
  });

  setScenarioHint('', false);
  const editInput = $('edit-scenario-input');
  if (editInput) editInput.value = '';
  const editPanel = $('edit-scenario-panel');
  if (editPanel) editPanel.classList.add('hidden');
  let restoredRunUi = false;
  if (runInProgressScenarioId === s.id) {
    // Keep current output while the run is streaming.
    restoredRunUi = true;
  } else if (restoreRunUiForScenario(s.id)) {
    restoredRunUi = true;
  } else {
    resetRunOutput();
  }
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
  if (runBtn && !restoredRunUi) {
    const st = runButtonStateForRunBtn();
    runBtn.disabled = st.disabled;
    runBtn.title = st.title;
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

function stepAddInlineId(addAfterIndexRaw) {
  return addAfterIndexRaw === 'end' ? 'step-add-inline-end' : `step-add-inline-${addAfterIndexRaw}`;
}

function stepAddInputId(addAfterIndexRaw) {
  return addAfterIndexRaw === 'end' ? 'step-add-input-end' : `step-add-input-${addAfterIndexRaw}`;
}

function normalizeAddAfterIndex(addAfterIndexRaw) {
  if (addAfterIndexRaw === 'end') return 'end';
  const idx = Number(addAfterIndexRaw);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

function toggleAddStepEditor(addAfterIndexRaw) {
  const id = stepAddInlineId(addAfterIndexRaw);
  const current = $(id);
  if (!current) return;
  const shouldOpen = current.classList.contains('hidden');
  document.querySelectorAll('.step-add-inline').forEach(el => el.classList.add('hidden'));
  if (shouldOpen) {
    current.classList.remove('hidden');
    const input = $(stepAddInputId(addAfterIndexRaw));
    if (input) input.focus();
    activeAddStepIndex = normalizeAddAfterIndex(addAfterIndexRaw);
  } else {
    activeAddStepIndex = null;
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

async function addStepWithAI(addAfterIndex, userMessage) {
  if (!activeScenarioId) return null;
  const scenario = scenarios.find(s => s.id === activeScenarioId);
  if (!scenario) return null;
  const locationText = addAfterIndex === 'end'
    ? 'at the end'
    : `after step ${Number(addAfterIndex) + 1}`;
  const constrainedPrompt = [
    `Insert one or more new steps ${locationText}, with a maximum of 3 new steps.`,
    'Keep all existing steps in the same order and unchanged.',
    'Do not rename the scenario and do not change the description.',
    'Each new step must be atomic and contain one primary intent.',
    'If the request combines an action and a verification (for example "click ... and check ..."), split them into separate ordered steps (act first, then assert).',
    'Make the new step verifiable using stable, visible UI outcomes; avoid transient/intermediate state checks unless explicitly requested.',
    `New step request: ${userMessage}`,
  ].join(' ');
  return await api('POST', `/scenarios/${activeScenarioId}/modify-before-run`, { userMessage: constrainedPrompt });
}

async function applyAddStep(addAfterIndexRaw) {
  if (!activeScenarioId) return;
  const addAfterIndex = normalizeAddAfterIndex(addAfterIndexRaw);
  if (addAfterIndex === null) {
    setScenarioHint('Invalid insert location.', true);
    return;
  }
  const input = $(stepAddInputId(addAfterIndexRaw));
  const userMessage = input ? input.value.trim() : '';
  if (!userMessage) {
    setScenarioHint('Describe the step you want to add.', true);
    return;
  }
  showOverlay('Adding step with AI…');
  try {
    const updated = await addStepWithAI(addAfterIndex, userMessage);
    const idx = scenarios.findIndex(s => s.id === activeScenarioId);
    if (idx >= 0) scenarios[idx] = updated;
    if (input) input.value = '';
    openScenario(activeScenarioId);
    const loc = addAfterIndex === 'end' ? 'at the end' : `after step ${addAfterIndex + 1}`;
    setScenarioHint(`Step added ${loc}.`, false);
  } catch (err) {
    setScenarioHint('Error: ' + err.message, true);
  } finally {
    hideOverlay();
  }
}

function resetRunOutput() {
  // Revoke snapshot object URLs when clearing the trace details panel.
  // (Otherwise blob: URLs can leak when switching scenarios.)
  const container = $('run-output');
  const panel = container && container.querySelector('.trace-details-panel');
  if (panel) {
    panel.querySelectorAll('[data-snapshot-object-url]').forEach((el) => {
      const objectUrl = el.getAttribute('data-snapshot-object-url');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  }
  container.innerHTML = '<p class="run-idle">Hit "Run now" to execute this scenario.</p>';
  const badge = $('run-status-badge');
  if (badge) badge.innerHTML = '';
  const rb = $('btn-run');
  if (rb) {
    const st = runButtonStateForRunBtn();
    rb.disabled = st.disabled;
    rb.title = st.title;
    rb.textContent = '▶ Run now';
  }
}

function cacheRunUiForScenario(scenarioId) {
  if (!scenarioId) return;
  const out = $('run-output');
  const badge = $('run-status-badge');
  const rb = $('btn-run');
  if (!out) return;
  runUiCacheByScenarioId.set(scenarioId, {
    runOutputHtml: out.innerHTML,
    runStatusBadgeHtml: badge ? badge.innerHTML : '',
    runButtonState: rb
      ? { disabled: rb.disabled, title: rb.title || '', textContent: rb.textContent || '' }
      : null,
  });
}

function restoreRunUiForScenario(scenarioId) {
  if (!scenarioId) return false;
  const cached = runUiCacheByScenarioId.get(scenarioId);
  if (!cached) return false;

  const out = $('run-output');
  const badge = $('run-status-badge');
  const rb = $('btn-run');

  if (out) out.innerHTML = cached.runOutputHtml || '';
  if (badge) badge.innerHTML = cached.runStatusBadgeHtml || '';
  if (rb && cached.runButtonState) {
    rb.disabled = !!cached.runButtonState.disabled;
    rb.title = cached.runButtonState.title || '';
    rb.textContent = cached.runButtonState.textContent || '';
  }
  return true;
}

function renderDecisionLogSummary(log) {
  const mode = log && log.executionMode ? String(log.executionMode) : 'unknown';
  const finalStatus = log && log.finalStatus ? String(log.finalStatus) : 'unknown';
  const finalError = log && log.finalError ? String(log.finalError) : '';
  const assertReason = log && log.assertReason ? String(log.assertReason) : '';
  const actions = Array.isArray(log && log.actions) ? log.actions : [];

  const attemptsHtml = actions.length
    ? actions
        .map(a => {
          const kind = a && a.kind ? String(a.kind) : 'act';
          const attempt = a && a.attempt != null ? String(a.attempt) : '1';
          const status = a && a.status ? String(a.status) : 'unknown';
          const detail = a && (a.action || a.verifyInstruction)
            ? String(a.action || a.verifyInstruction)
            : '';
          const extra = a && a.error ? ` — ${escapeHtml(String(a.error))}` : '';
          return `<li><strong>${escapeHtml(kind)}</strong> attempt ${escapeHtml(attempt)}: <span class="trace-step-status ${escapeHtml(
            status
          )}">${escapeHtml(status)}</span>${detail ? ` — ${escapeHtml(detail)}` : ''}${extra}</li>`;
        })
        .join('')
    : '<li>No detailed attempts recorded.</li>';

  return `
    <p><strong>Mode:</strong> ${escapeHtml(mode)}</p>
    <p><strong>Final:</strong> <span class="trace-step-status ${escapeHtml(finalStatus)}">${escapeHtml(finalStatus)}</span>${
      finalError ? ` — ${escapeHtml(finalError)}` : ''
    }</p>
    ${assertReason ? `<p><strong>Verify reason:</strong> ${escapeHtml(assertReason)}</p>` : ''}
    <ul class="trace-step-decision-list">${attemptsHtml}</ul>
  `;
}

async function loadAndRenderTraceDetails(runId) {
  const container = $('run-output');
  let panel = container.querySelector('.trace-details-panel');
  if (panel) {
    panel.querySelectorAll('[data-snapshot-object-url]').forEach((el) => {
      const objectUrl = el.getAttribute('data-snapshot-object-url');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
    panel.remove();
  }
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
            <a class="trace-step-snapshot-link" data-snapshot-link>
              <img
                class="trace-step-snapshot"
                data-snapshot-image
                data-snapshot-url="${escapeAttr(s.snapshotUrl)}"
                alt="Step ${s.stepIndex + 1} snapshot"
                loading="lazy"
              />
            </a>
            <p class="trace-step-snapshot-hint" data-snapshot-hint>Loading snapshot…</p>
          </div>`
        : '<p class="trace-step-no-snapshot">No snapshot for this step.</p>';
      const actionLogBlock = s.actionLogUrl
        ? `<details class="trace-step-decision-details" data-action-log-wrap>
            <summary>Decision log</summary>
            <div class="trace-step-decision-content" data-action-log-url="${escapeAttr(s.actionLogUrl)}">Loading decision log…</div>
          </details>`
        : '<p class="trace-step-no-snapshot">No decision log for this step.</p>';
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
            ${actionLogBlock}
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
    const snapshotImages = panel.querySelectorAll('[data-snapshot-image]');
    await Promise.all(
      Array.from(snapshotImages).map(async (imgEl) => {
        const snapshotUrl = imgEl.getAttribute('data-snapshot-url');
        if (!snapshotUrl) return;
        const wrap = imgEl.closest('.trace-step-snapshot-wrap');
        const linkEl = wrap && wrap.querySelector('[data-snapshot-link]');
        const hintEl = wrap && wrap.querySelector('[data-snapshot-hint]');
        try {
          const res = await fetch(snapshotUrl, { headers: runFetchHeaders(false) });
          if (!res.ok) throw new Error('snapshot_fetch_failed');
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          imgEl.src = objectUrl;
          if (wrap) wrap.setAttribute('data-snapshot-object-url', objectUrl);
          if (linkEl) {
            linkEl.href = objectUrl;
            linkEl.target = '_blank';
            linkEl.rel = 'noopener noreferrer';
          }
          if (hintEl) hintEl.textContent = 'Click image to open full snapshot';
        } catch (_) {
          if (hintEl) hintEl.textContent = 'Snapshot unavailable.';
          if (linkEl) {
            linkEl.removeAttribute('href');
            linkEl.removeAttribute('target');
            linkEl.removeAttribute('rel');
          }
        }
      })
    );
    const actionLogs = panel.querySelectorAll('[data-action-log-url]');
    await Promise.all(
      Array.from(actionLogs).map(async (logEl) => {
        const actionLogUrl = logEl.getAttribute('data-action-log-url');
        if (!actionLogUrl) return;
        try {
          const res = await fetch(actionLogUrl, { headers: runFetchHeaders(false) });
          if (!res.ok) throw new Error('action_log_fetch_failed');
          const log = await res.json();
          const raw = JSON.stringify(log, null, 2);
          logEl.innerHTML = `
            ${renderDecisionLogSummary(log)}
            <details class="trace-step-raw-details">
              <summary>Raw JSON</summary>
              <pre class="trace-step-raw">${escapeHtml(raw)}</pre>
            </details>
          `;
        } catch (_) {
          logEl.textContent = 'Decision log unavailable.';
        }
      })
    );
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

  if (!isLoggedIn() && isAnonymousTrialLimited() && trialRunsUsed() >= 2) {
    setScenarioHint('Trial limit reached. Sign up to run more scenarios.', true);
    openAuthModal();
    switchAuthTab('signup');
    return;
  }

  runInProgressScenarioId = scenario.id;
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
  cacheRunUiForScenario(scenario.id);

  const headless = $('run-headless').checked;
  const authProfileId = scenario.authProfileId || undefined;
  const res = await fetch(`/api/scenarios/${activeScenarioId}/run`, {
    method: 'POST',
    headers: runFetchHeaders(true),
    body: JSON.stringify({ headless, ...(authProfileId && { authProfileId }) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 402 && err.error === 'monthly_limit_exceeded') {
      monthlyUsageCache = {
        monthlyRunsUsed: err.used,
        monthlyRunsLimit: err.limit,
        monthlyRunsRemaining: err.remaining ?? 0,
        atLimit: true,
      };
      openPaywallModal(err);
    } else {
      alert(err.error || res.statusText || 'Run failed');
    }
    runInProgressScenarioId = null;
    resetRunOutput();
    return;
  }
  if (!res.body) {
    alert('No response body');
    runInProgressScenarioId = null;
    resetRunOutput();
    return;
  }
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
      const actions = document.createElement('div');
      actions.className = 'run-step-ai-actions';
      actions.innerHTML = `
        <button type="button" class="btn-secondary btn-sm" data-run-action="fix" data-step-index="${event.index}">
          Fix this step (AI)
        </button>
        <button type="button" class="btn-secondary btn-sm" data-run-action="remove" data-step-index="${event.index}">
          Remove this step (AI)
        </button>
      `;
      errDiv.after(actions);
      const fixBtn = actions.querySelector('[data-run-action="fix"]');
      const removeBtn = actions.querySelector('[data-run-action="remove"]');
      if (fixBtn) {
        fixBtn.onclick = () => {
          void fixFailedStepWithAI(event.index, event.error);
        };
      }
      if (removeBtn) {
        removeBtn.onclick = () => {
          void removeStepWithAI(event.index);
        };
      }
    }
    // Mark next step as running
    const nextEl = $(`run-step-${event.index + 1}`);
    if (nextEl && event.status === 'pass') {
      nextEl.className = 'run-step running';
      nextEl.querySelector('.run-step-icon').className = 'run-step-icon running';
    }
  }

  if (event.type === 'done') {
    const scenarioId = scenario.id;
    runInProgressScenarioId = null;
    if (!isLoggedIn()) {
      const n = trialRunsUsed() + 1;
      sessionStorage.setItem(TRIAL_RUNS_KEY, String(n));
      updateAuthChrome();
    } else {
      void refreshMonthlyUsage().then(() => {
        const rb2 = $('btn-run');
        if (rb2) {
          const st = runButtonStateForRunBtn();
          rb2.disabled = st.disabled;
          rb2.title = st.title;
          rb2.textContent = '▶ Run again';
        }
        cacheRunUiForScenario(scenarioId);
        if (views.account && views.account.classList.contains('active')) void loadAccountView();
      });
    }
    const badge = $('run-status-badge');
    badge.innerHTML = `<span class="badge ${event.status}">${event.status}</span>`;
    const rb2 = $('btn-run');
    if (rb2 && !isLoggedIn()) {
      rb2.disabled = !isLoggedIn() && isAnonymousTrialLimited() && trialRunsUsed() >= 2;
      rb2.title =
        !isLoggedIn() && isAnonymousTrialLimited() && trialRunsUsed() >= 2
          ? 'Sign up to run more scenarios'
          : '';
      rb2.textContent = '▶ Run again';
    } else if (rb2 && isLoggedIn()) {
      rb2.textContent = '▶ Run again';
    }

    // Show trace download link when available
    if (event.traceUrl) {
      const traceLink = document.createElement('p');
      traceLink.className = 'run-trace-link';
      traceLink.innerHTML = `Debug: ${traceDownloadLinkHtml(event.traceUrl)} (open with <code>npx playwright show-trace trace.zip</code>)`;
      $('run-output').appendChild(traceLink);
    }

    cacheRunUiForScenario(scenarioId);

    // Load and show in-app trace details timeline
    if (currentRunId) {
      void loadAndRenderTraceDetails(currentRunId).then(() => cacheRunUiForScenario(scenarioId));
    }

    // Refresh scenario status in sidebar
    loadScenarios().then(() => renderSidebarList());
  }
}

async function fixFailedStepWithAI(stepIndex, errorText) {
  if (!activeScenarioId) return;
  showOverlay('Fixing failed step with AI…');
  try {
    const userMessage = `Fix this failed step based on the error: "${errorText}". Keep the same intent but make it robust and executable.`;
    const updated = await api('POST', `/scenarios/${activeScenarioId}/modify-step`, { stepIndex, userMessage });
    const idx = scenarios.findIndex(s => s.id === activeScenarioId);
    if (idx >= 0) scenarios[idx] = updated;
    openScenario(activeScenarioId);
    setScenarioHint(`Step ${stepIndex + 1} updated from failure context.`, false);
  } catch (err) {
    setScenarioHint('Error: ' + err.message, true);
  } finally {
    hideOverlay();
  }
}

async function removeStepWithAI(stepIndex) {
  if (!activeScenarioId) return;
  showOverlay('Removing step with AI…');
  try {
    const userMessage = `Remove step ${stepIndex + 1} only. Keep all other steps unchanged, in the same order. Do not rename the scenario or change the description.`;
    const updated = await api('POST', `/scenarios/${activeScenarioId}/modify-before-run`, { userMessage });
    const idx = scenarios.findIndex(s => s.id === activeScenarioId);
    if (idx >= 0) scenarios[idx] = updated;
    openScenario(activeScenarioId);
    setScenarioHint(`Step ${stepIndex + 1} removed.`, false);
  } catch (err) {
    setScenarioHint('Error: ' + err.message, true);
  } finally {
    hideOverlay();
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
    const stored = localStorage.getItem(RUN_HEADLESS_KEY);
    const el = $('run-headless');
    if (el) {
      if (stored !== null) el.checked = stored === 'true';
      el.addEventListener('change', () => {
        localStorage.setItem(RUN_HEADLESS_KEY, $('run-headless').checked);
        const sh = $('shared-run-headless');
        if (sh) sh.checked = $('run-headless').checked;
      });
    }
    const sh = $('shared-run-headless');
    if (sh) {
      if (stored !== null) sh.checked = stored === 'true';
      sh.addEventListener('change', () => {
        localStorage.setItem(RUN_HEADLESS_KEY, sh.checked);
        const rh = $('run-headless');
        if (rh) rh.checked = sh.checked;
      });
    }
  } catch (_) {}
})();

(async () => {
  bindAuthUi();
  bindAccountUi();
  bindShareUi();
  const pathToken = parseSharePath();
  if (pathToken) {
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.add('shared-visitor');
    await initAuth();
    bindSharedVisitorUi();
    await bootstrapSharedVisitor(pathToken);
    return;
  }
  await initAuth();
  if (isLoggedIn()) await refreshMonthlyUsage();
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
