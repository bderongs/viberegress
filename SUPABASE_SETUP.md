# Supabase Auth setup (email + Google)

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. In **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
3. In **Project Settings → Database** (or **Connect**), copy a Postgres connection string and set `SUPABASE_DB_URL`.
4. Add all values to your `.env` (see `.env.example`).
5. Run [`supabase/schema.sql`](/Users/baptiste/Sites/viberegress_fixed 2/supabase/schema.sql) in the Supabase SQL editor.
6. **Authentication → URL configuration**
   - Add **Site URL**: `http://localhost:3000` (and your production URL when you deploy).
   - Add **Redirect URLs**: `http://localhost:3000` and `http://localhost:3000/**`.
7. **Authentication → Providers → Google**
   - Enable Google.
   - Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (OAuth 2.0 Client ID, Web application).
   - Authorized redirect URI: use the value Supabase shows (e.g. `https://<project-ref>.supabase.co/auth/v1/callback`).
   - Paste Client ID and Client Secret into Supabase.

Restart the VibeRegress server after changing `.env`.

**Usage:** Signed-in users get **20 scenario runs per calendar month (UTC)**. Usage is derived from `runs` joined to owned `scenarios`. `GET /api/usage` returns the current counts for the **My account** page.
