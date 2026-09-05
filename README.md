# Box Cricket

Weekend box cricket: a custom scoring engine, an admin area, a one-thumb
scoring pad, public scorecards and rankings, and printable reports.

The rules are the league's own — zones marked by cones, declared runs, impact
overs, dot-outs and last man. They live in `src/engine/`, which is a pure
function with no I/O, and are explained in plain language on the in-app rules
page. Every rule carries an ID in the code comments and test names, matching
the league's written specification.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | 121 tests: engine, database, and the admin → pad flow |
| `npm run typecheck` | TypeScript, strict, no `any` |
| `npm run build` | Production build (what Vercel runs) |
| `npm run build:check` | Same build into `.next-build`, so it can run while `dev` is live |
| `npm run verify` | Typecheck, tests, and build — what CI runs |

## Layout

```
src/engine/     the scoring engine — pure, no I/O, no dates, no randomness
src/db/         database types and the row <-> engine mappers
supabase/       schema and row level security, verified against real Postgres
lib/            the local store, stats, rankings, shared UI
app/            the screens
```

The scoreboard is **always derived** by replaying the delivery log. No screen
reads a stored total, and undo works by voiding a ball and replaying — which is
why a rule change can be applied to a match already in progress.

## Deploying

Hosting, CI and CD are all free.

**1. Push to GitHub**

```bash
git remote add origin https://github.com/<you>/box-cricket.git
git branch -M main
git push -u origin main
```

**2. Connect Vercel** — vercel.com → Add New → Project → Import the repo.
Framework is detected automatically; no environment variables are needed yet.

From then on: every push to `main` deploys to production, every branch and pull
request gets its own preview URL, and `.github/workflows/ci.yml` runs the
typecheck, the tests and a production build on each push.

**3. Optional** — set a repository variable `SITE_URL` to your deployed URL so
the daily keep-alive workflow pings the right host.

## Reports

Any scorecard or series page can be saved as a PDF from the browser's print
dialog. The print stylesheet swaps the floodlit dark theme for black on white
and drops every button, so what prints is a report rather than a screenshot.
No library, no server, no cost.

## Where the data lives

Today: `localStorage` on the device that scored the match. `lib/store.ts` is
shaped exactly like the Postgres tables in `supabase/migrations/0001_init.sql`,
so swapping it for the Supabase client is a one-file change. Until then two
phones will not see the same match, and admin sign-in records who you are
without checking a password.
