# Grid Rank (gbp.exoreach.dev)

An internal Google Maps grid-rank and listing-improvement tool. It runs on a Cloudflare Worker with a D1 database. Data comes from DataForSEO (Maps SERP, standard queue, $0.0006 a point).

## What it does
- **Grid scans:** 3×3 to 9×9, live or demo. Results come back by DataForSEO postback. "Check now" pulls waiting points directly.
- **Action plan:** compares your listing with the leaders in each scan (category, extra categories, reviews, review pace, rating, claimed, hours, website, photos, keyword names, weak direction, possible spam, brand keywords). Turns the gaps into ranked steps with evidence labels.
- **Progress:** a top-3 share chart per keyword, a change log (shown as markers on the chart), scan history and before/after comparison.
- **Checklist:** 24 listing basics per location, from the research brief.
- **Repeating scans:** a daily cron (06:17 UTC) runs any due schedules (every 7, 14 or 30 days).
- **Spend cap:** live scans stop once the month's data cost would pass `MONTHLY_CAP_USD` (default $10).
- **Share links:** `/r/<token>` shows the map and competitors with no login. The action plan stays private.

Stored per scan: rank per point, the top 20 listing keys per point, and a slim snapshot of each listing. Raw SERP JSON is never stored.

## Access
- Cloudflare Access protects the site. Only `dan@exoreach.co` can sign in (one-time PIN).
- Public (bypass): `/r/*`, `/api/share/*`, `/api/postback`, `/assets/*`.
- The Worker also checks the Access JWT itself.

## Secrets
Set in Cloudflare (Workers → gbp-grid → Settings → Variables and Secrets) as **Secret**:
`DFS_LOGIN`, `DFS_PASSWORD` (the DataForSEO **API** password), `POSTBACK_KEY` (already set). Turn off DataForSEO's IP whitelist, because Workers have no fixed outgoing IP.

## Develop
```bash
npm install
```

```bash
npx wrangler d1 execute gbp-grid --local --file=schema.sql
```

```bash
npm run dev
```

`.dev.vars` needs `DEV_EMAIL=you@example.com`. The login bypass only works on localhost.

## Deploy
Cloudflare Workers Builds deploys every push to `main` (it runs `npx wrangler deploy`, which runs `node build.mjs` first).

Database changes are not automatic. Migrations `0002`–`0004` were applied to production by hand, so run new ones by hand too:
```bash
npx wrangler d1 execute gbp-grid --remote --file=migrations/<new-file>.sql
```

## Layout
- `src/worker.js`: API, postbacks, schedules, security headers.
- `src/analysis.js`: competitor stats, reach and action-plan rules.
- `src/client/`: the single-page app (HTML, CSS, JS), bundled as text by `build.mjs`.
- `schema.sql`: full schema. `migrations/`: changes to it.
