(() => {
  if (window.__discoverySnippetMimicMounted) return;
  window.__discoverySnippetMimicMounted = true;

  const state = {
    running: false,
    minimized: false,
    selectedCtas: [],
    journeys: [],
    scenarios: [],
    logs: [],
  };

  const STYLE_ID = 'discovery-snippet-mimic-style';
  const ROOT_ID = 'discovery-snippet-mimic-root';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      #${ROOT_ID} {
        position: fixed; top: 16px; right: 16px; width: 380px; max-height: 82vh;
        z-index: 2147483646; background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
        border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45); font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        display: flex; flex-direction: column; overflow: hidden;
      }
      #${ROOT_ID}.minimized { height: auto; max-height: none; width: 280px; }
      #${ROOT_ID} * { box-sizing: border-box; }
      #${ROOT_ID} .hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #30363d; background: #161b22; }
      #${ROOT_ID} .title { font-size: 13px; font-weight: 700; letter-spacing: .2px; }
      #${ROOT_ID} .sub { font-size: 11px; color: #8b949e; }
      #${ROOT_ID} .actions { display: flex; gap: 6px; }
      #${ROOT_ID} button { border: 1px solid #3d444d; background: #21262d; color: #e6edf3; border-radius: 8px; padding: 6px 9px; cursor: pointer; font-size: 12px; }
      #${ROOT_ID} button:hover { background: #2b3138; }
      #${ROOT_ID} button.primary { background: #1f6feb; border-color: #1f6feb; }
      #${ROOT_ID} button.primary:hover { background: #388bfd; }
      #${ROOT_ID} .body { display: grid; grid-template-rows: auto auto auto 1fr; gap: 10px; padding: 10px; overflow: auto; }
      #${ROOT_ID}.minimized .body { display: none; }
      #${ROOT_ID} .row { display: flex; align-items: center; gap: 8px; }
      #${ROOT_ID} .pill { font-size: 11px; color: #8b949e; border: 1px solid #30363d; border-radius: 999px; padding: 2px 8px; }
      #${ROOT_ID} .section { border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
      #${ROOT_ID} .section h4 { margin: 0; padding: 8px 10px; font-size: 11px; letter-spacing: .2px; text-transform: uppercase; color: #8b949e; border-bottom: 1px solid #30363d; background: #0f141b; }
      #${ROOT_ID} .content { padding: 8px 10px; font-size: 12px; line-height: 1.4; max-height: 170px; overflow: auto; }
      #${ROOT_ID} .item { padding: 6px 0; border-bottom: 1px dashed #2d333b; }
      #${ROOT_ID} .item:last-child { border-bottom: 0; }
      #${ROOT_ID} .ok { color: #3fb950; }
      #${ROOT_ID} .warn { color: #d29922; }
      #${ROOT_ID} .bad { color: #f85149; }
      #${ROOT_ID} .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; }
      #${ROOT_ID} .footer { padding: 8px 10px; border-top: 1px solid #30363d; display: flex; gap: 8px; justify-content: space-between; background: #161b22; }
      #${ROOT_ID} .small { font-size: 11px; color: #8b949e; }
      #${ROOT_ID} .ghost { background: transparent; border-color: #30363d; }
      #${ROOT_ID} .scenario-name { font-weight: 600; }
    `;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function pickLikelyCtas() {
    const all = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .map((el) => ({
        el,
        label: (el.textContent || '').trim().replace(/\s+/g, ' '),
      }))
      .filter((x) => x.label.length >= 3 && x.label.length <= 80);

    const scored = all
      .map((x) => {
        const l = x.label.toLowerCase();
        let score = 0;
        if (/trouver|find|search|session|book|commencer|start/.test(l)) score += 4;
        if (/connexion|login|sign in|compte/.test(l)) score += 3;
        if (/vendre|sell|consultant|expertise/.test(l)) score += 3;
        if (/footer|privacy|legal|terms/.test(l)) score -= 3;
        return { ...x, score };
      })
      .sort((a, b) => b.score - a.score);

    const uniq = [];
    const seen = new Set();
    for (const x of scored) {
      const k = x.label.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(x);
      if (uniq.length >= 3) break;
    }
    return uniq;
  }

  function fakeJourneyFor(label) {
    const l = label.toLowerCase();
    if (/trouver|find|search|session/.test(l)) {
      return {
        label,
        status: 'accepted',
        hops: [
          `Click "${label}"`,
          'Click search input or category tab',
          'Verify list of sessions is visible',
        ],
        description: `User starts from "${label}", refines the intent via search/browse, and reaches session discovery results.`,
      };
    }
    if (/connexion|login|sign in/.test(l)) {
      return {
        label,
        status: 'accepted',
        hops: [`Click "${label}"`, 'Verify login options are visible'],
        description: `User starts from "${label}" and reaches the authentication entry point.`,
      };
    }
    return {
      label,
      status: 'accepted',
      hops: [`Click "${label}"`, 'Verify destination page state aligns with intent'],
      description: `User starts from "${label}" and progresses to an intent-aligned destination.`,
    };
  }

  function now() {
    return new Date().toLocaleTimeString();
  }

  function pushLog(text, level = 'ok') {
    state.logs.unshift({ text, level, at: now() });
    state.logs = state.logs.slice(0, 80);
    render();
  }

  function runFakeDiscovery() {
    if (state.running) return;
    state.running = true;
    state.selectedCtas = [];
    state.journeys = [];
    state.scenarios = [];
    state.logs = [];
    render();

    pushLog('Discovery started (local mock mode).', 'ok');

    setTimeout(() => {
      const ctas = pickLikelyCtas();
      state.selectedCtas = ctas.map((c) => c.label);
      pushLog(`Selected ${state.selectedCtas.length} CTA(s).`, 'ok');
      ctas.forEach((c) => {
        const rect = c.el.getBoundingClientRect();
        const mark = document.createElement('div');
        mark.className = '__discovery-mimic-highlight';
        mark.style.cssText = `
          position: fixed; left: ${Math.max(0, rect.left - 3)}px; top: ${Math.max(0, rect.top - 3)}px;
          width: ${rect.width + 6}px; height: ${rect.height + 6}px; border: 2px solid #1f6feb;
          border-radius: 6px; pointer-events: none; z-index: 2147483645;
          box-shadow: 0 0 0 2px rgba(31,111,235,.25) inset;
        `;
        document.body.appendChild(mark);
        setTimeout(() => mark.remove(), 1800);
      });
      render();
    }, 500);

    setTimeout(() => {
      state.journeys = state.selectedCtas.map((label) => fakeJourneyFor(label));
      pushLog(`Built ${state.journeys.length} intent journey(ies).`, 'ok');
      render();
    }, 1400);

    setTimeout(() => {
      state.scenarios = state.journeys.map((j) => ({
        name: j.label,
        verificationStatus: /search|session|trouver|find/i.test(j.label) ? 'verified' : 'repaired',
        description: j.description,
        steps: j.hops,
      }));
      pushLog(`Final scenarios ready: ${state.scenarios.length}.`, 'ok');
      state.running = false;
      render();
    }, 2400);
  }

  function clearAll() {
    state.selectedCtas = [];
    state.journeys = [];
    state.scenarios = [];
    state.logs = [];
    render();
  }

  function buildUI() {
    const root = document.createElement('aside');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="hdr">
        <div>
          <div class="title">Discovery Assistant (Mimic)</div>
          <div class="sub">UX-only local mode — no API calls</div>
        </div>
        <div class="actions">
          <button id="mimic-min">—</button>
          <button id="mimic-close">✕</button>
        </div>
      </div>
      <div class="body">
        <div class="row">
          <button class="primary" id="mimic-run">Run discovery</button>
          <button class="ghost" id="mimic-clear">Clear</button>
          <span class="pill" id="mimic-status">idle</span>
        </div>
        <div class="section">
          <h4>Selected CTAs</h4>
          <div class="content" id="mimic-ctas"></div>
        </div>
        <div class="section">
          <h4>Intent journeys</h4>
          <div class="content" id="mimic-journeys"></div>
        </div>
        <div class="section">
          <h4>Final scenarios + logs</h4>
          <div class="content" id="mimic-final"></div>
        </div>
      </div>
      <div class="footer">
        <div class="small">Inject once per page</div>
        <button class="ghost" id="mimic-copy">Copy state JSON</button>
      </div>
    `;

    root.querySelector('#mimic-run').addEventListener('click', runFakeDiscovery);
    root.querySelector('#mimic-clear').addEventListener('click', clearAll);
    root.querySelector('#mimic-min').addEventListener('click', () => {
      state.minimized = !state.minimized;
      render();
    });
    root.querySelector('#mimic-close').addEventListener('click', () => {
      window.__discoverySnippetMimicMounted = false;
      document.getElementById(STYLE_ID)?.remove();
      root.remove();
    });
    root.querySelector('#mimic-copy').addEventListener('click', async () => {
      const payload = {
        siteUrl: location.href,
        selectedCtaCount: state.selectedCtas.length,
        scenarioCount: state.scenarios.length,
        selectedCtas: state.selectedCtas,
        scenarios: state.scenarios,
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        pushLog('Copied current state JSON to clipboard.', 'ok');
      } catch {
        pushLog('Clipboard copy unavailable on this page.', 'warn');
      }
    });
    document.body.appendChild(root);
    return root;
  }

  const root = buildUI();

  function render() {
    root.classList.toggle('minimized', state.minimized);
    const status = root.querySelector('#mimic-status');
    status.textContent = state.running ? 'running' : 'idle';
    status.className = `pill ${state.running ? 'warn' : ''}`;

    const ctasEl = root.querySelector('#mimic-ctas');
    ctasEl.innerHTML = state.selectedCtas.length
      ? state.selectedCtas.map((x, i) => `<div class="item">${i + 1}. ${x}</div>`).join('')
      : `<div class="small">No CTAs selected yet.</div>`;

    const journeysEl = root.querySelector('#mimic-journeys');
    journeysEl.innerHTML = state.journeys.length
      ? state.journeys
          .map(
            (j, i) => `
              <div class="item">
                <div><strong>${i + 1}. ${j.label}</strong> <span class="ok">(${j.status})</span></div>
                <div class="small">${j.hops.join(' → ')}</div>
              </div>
            `
          )
          .join('')
      : `<div class="small">No journeys yet.</div>`;

    const finalEl = root.querySelector('#mimic-final');
    const scenariosHtml = state.scenarios.length
      ? state.scenarios
          .map(
            (s, i) => `
            <div class="item">
              <div class="scenario-name">${i + 1}. ${s.name} <span class="${s.verificationStatus === 'verified' ? 'ok' : 'warn'}">(${s.verificationStatus})</span></div>
              <div class="small">${s.description}</div>
              <div class="small">Steps: ${s.steps.join(' → ')}</div>
            </div>
          `
          )
          .join('')
      : `<div class="small">No scenarios yet.</div>`;

    const logsHtml = state.logs.length
      ? `<div class="item mono">${state.logs.map((l) => `[${l.at}] ${l.text}`).join('\n')}</div>`
      : `<div class="small">No logs yet.</div>`;

    finalEl.innerHTML = `${scenariosHtml}${logsHtml}`;
  }

  render();
  pushLog('Widget ready. Click "Run discovery".', 'ok');
})();

