# VibeRegress

Non-regression testing for people who vibe code.

Paste a URL → AI discovers your key user scenarios → run them anytime to catch breakage.

## Stack

- **Stagehand** (Browserbase) — AI-powered browser automation
- **Express** + TypeScript — backend API
- **Vanilla JS** — frontend (no framework)
- **Supabase Postgres** — persistent app data (with SQLite fallback if Postgres env is not set)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install Playwright browsers

```bash
npx playwright install chromium
```

### 3. Set env vars

Create a `.env` file (or export in your shell):

```bash
# Use Anthropic (recommended)
export ANTHROPIC_API_KEY=sk-ant-...

# Or OpenAI
export OPENAI_API_KEY=sk-...
```

Also configure Supabase auth + Postgres persistence:

```bash
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_ANON_KEY=<anon-key>
export SUPABASE_DB_URL=postgresql://...
```

Run `supabase/schema.sql` in Supabase SQL editor first.

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000**

---

## How it works

### Discovery
1. Click **"Scan new site"** and paste a URL
2. Stagehand opens a headless browser, crawls the page, and uses an LLM to identify 3–6 key user scenarios
3. Review the discovered scenarios and click **"Save all"**

### Running tests
1. Click any scenario in the sidebar
2. Hit **"Run now"**
3. Watch each step execute live — green ✓ pass, red ✗ fail
4. If a step fails you'll see the exact error

### Caching
On second and subsequent runs, Stagehand caches resolved selectors — so replays don't re-invoke the LLM unless the site has changed. Faster and cheaper.

---

## Project structure

```
src/
  index.ts              Express server
  routes/api.ts         REST + SSE endpoints
  services/
    stagehand.ts        Discovery + replay logic
    store.ts            In-memory data store
  types/index.ts        Shared TypeScript types
public/
  index.html            Single-page app shell
  css/app.css           Styles
  js/app.js             Frontend logic
```

---

## Next steps (post-MVP)

- [ ] Persist scenarios to SQLite with `better-sqlite3`
- [ ] Schedule runs (cron) with `node-cron`
- [ ] Screenshot capture on failure
- [ ] Email/Slack alerts
- [ ] Multi-site support / project grouping
- [ ] Upgrade to Browserbase cloud for parallel runs
