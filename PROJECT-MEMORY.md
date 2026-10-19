# PROJECT MEMORY — COAI Lead Engine (coaihq.online)
_Last updated: 2026-10-14 — full SaaS launch session. Read this before any future work on the project._

## What this product is
A SaaS lead-generation tool: scans any city + industry via live Google Maps data (server-side key, never exposed), scores leads, extracts contacts, generates AI outreach (emails/call scripts/texts), CRM pipeline + CSV export + webhooks. Owned by Chaotically Organized AI, LLC (jason / chaoticallyorganizedai@gmail.com).

## Key infrastructure
| Thing | Value |
|---|---|
| Repo | github.com/jasonmanuel-cmd/Coai-lead-engine (local: `C:\Users\blunts\Coai-lead-engine`) |
| Vercel project | **`coaileads`** (team "jason's projects", Pro) — NOTE: project name has NO hyphen. A past `vercel link` accidentally created a duplicate project `coai-leads` — it was deleted. |
| Domain | coaihq.online (Namecheap DNS) |
| Deploy | auto on `git push origin main` (GitHub integration, user `coaiebay-source`) |
| Pages | `/` = marketing landing · `/app` = the tool · `/tos` `/privacy` · `/robots.txt` `/sitemap.xml` |

## Plans & quotas (lib/saas.js)
- Free: **10 scans/mo** (reduced from 100 on 2026-10-14 to push upgrades)
- Starter: $49/mo → 1,500 scans (env `STRIPE_PRICE_STARTER`)
- Pro: $99/mo → 5,000 scans (env `STRIPE_PRICE_PRO`)
- 7-day money-back guarantee on all paid plans (landing page + TOS §2)

## Stripe (live account acct_1ScKln0u37S56JoG — "Chaotically Organized AI")
- Products: Starter `prod_VRMMwVPzsShgeX`, Pro `prod_VRMM8OUoZKRcXv`
- Prices: Starter `price_1UQTeN0u37S56JoGNneLXFfb` ($49/mo), Pro `price_1UQTeN0u37S56JoGmXYJ5Cqh` ($99/mo)
- Shareable payment links: Starter https://buy.stripe.com/fZu9ALfHH86z1Cy7kP5c401 · Pro https://buy.stripe.com/eVqaEPdzzcmPa9420v5c402
- Webhook event destination `we_1UQXE30u37S56JoGPSWwQXXZ` (Workbench-style): URL = `https://coaihq.online/api/stripe-webhook?secret=<STRIPE_WEBHOOK_URL_SECRET>`, events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed — status enabled, livemode ✅
- Customer portal: ACTIVE. Portal login link: https://billing.stripe.com/p/login/5kQ3cn3YZ4Una948oT5c400
- Stripe account uses the new **Workbench** UI (events selected BEFORE the URL when creating destinations)

## Secrets (NEVER store in files — live only in Vercel env vars)
- `STRIPE_SECRET_KEY` (sk_live — set on Vercel Production 2026-10-14)
- `STRIPE_WEBHOOK_URL_SECRET` (random 40-char — URL password for the webhook)
- `APP_PASSWORD` (owner master key — dev value ≠ prod value; user knows the prod one)

## Vercel env vars on `coaileads` (Production)
STRIPE_SECRET_KEY, STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_WEBHOOK_URL_SECRET, DATABASE_URL, APP_PASSWORD, GOOGLE_PLACES_API_KEY, CRON_SECRET, EMAIL_*, GEMINI_API_KEY (+ Sentry ones)

## Money-path behavior (verified end-to-end 2026-10-14, 15/15 audit PASS)
- In-app checkout: POST /api/billing {action:'checkout'} → Stripe Checkout with `client_reference_id` = user id → success redirect `/app?upgraded=1`
- **Payment-link purchases** (buy.stripe.com): no client_reference_id → webhook matches buyer by EMAIL (added 2026-10-14, commit 78773a6). Buyer must use their account email.
- Portal: in-app "Manage" → Stripe billing portal session (per-customer)
- Analytics: `/api/track` — POST records pageviews (beacons on landing + app); GET with owner `Authorization: <APP_PASSWORD>` header returns today/7d/30d/all + top referrers. Also visible in-app: sidebar "Site Traffic (owner)" panel (enter owner key → ↻ refresh).

## Rebrand decision (2026-10-14)
Keep "COAI Lead Engine" + coaihq.online for now; if traction in 3-6 months, buy a .com and 301-redirect. COAI ties to the company (Chaotically Organized AI, LLC).

## Launch checklist — ALL DONE ✅
Products/prices ✅ · env vars ✅ · webhook ✅ · portal ✅ · deployed ✅ · landing page ✅ · SEO files (robots/sitemap/meta/JSON-LD) ✅ · free tier 10 ✅ · analytics ✅ · guarantee ✅ · Search Console property verified ✅

## Remaining / next ideas (in priority order)
1. Search Console: submit sitemap + request indexing for `/` and `/app` (user's browser task)
2. Marketing posts (LinkedIn/Reddit/X — draft copy already given to user) + 60-sec demo video → embed on landing hero
3. Bing Webmaster Tools (import from GSC)
4. Product Hunt launch, free directories (AlternativeTo, SaaSHub, Indie Hackers)
5. Dogfood: use the tool itself to find local businesses with bad websites → sell them web services
6. Later: onboarding tour in-app, testimonials (real only), annual plans, /blog for SEO, Square as 2nd provider (Square connection to Composio is ACTIVE; code supports SQUARE_* env vars + square-webhook)

## Sales-readiness audit fixes (2026-10-19)
Branch `arena/cdaaea30-coai-lead-engine`. Found + fixed before selling:
1. **Pro-plan bug (money!)** — `checkout.session.completed` read plan from session metadata (always empty → 'starter'), and `subscription.created` wasn't handled. Pro buyers got Starter quota. Now: price-ID → plan mapping + `subscription.created` handler + subscription lookup fallback. **ACTION: add `customer.subscription.created` to the Stripe webhook destination events.**
2. **AI outreach dead for customers** — `generateAIOutreach()` required the owner key in sessionStorage; paying customers got an alert telling them to "run a scan to authenticate". Now uses the session cookie + passes the sender profile. Also fixed: server prompt was hardcoded to Jason's wholesale smoke-shop pitch with his real phone number — now generic, profile-driven (name/business/offer/tone from Settings).
3. **Contact auto-enrich dead for customers** — `enrichAllLeads()` silently returned without the owner key. Now cookie-authenticated.
4. **New-user identity leak** — default sender profile was Jason's real name/phone; any customer who skipped Settings sent outreach as Jason. Defaults are now blank with neutral fallbacks; price line is conditional (no more hardcoded "$1,200").
5. **Quota honesty** — marketing said "scans", metering counts API calls (a full 40-lead scan ≈ 40+ calls). Landing FAQ/cards/JSON-LD, in-app pricing modal, and sidebar now say API calls with scan estimates (≈30+ Starter, ≈100+ Pro).
6. **Wrong-city scans** — location defaulted to Bakersfield; geocode failures silently scanned Bakersfield coords. Now: empty input requires a city; geocode failure shows an error.
7. **Misc**: `/app?upgraded=1` return URL no longer rewrites to `/`; "150+" → "100+ categories"; `/api/stats` is now owner-only; login/signup rate-limited; security headers in vercel.json; favicon + theme-color everywhere; real support email (chaoticallyorganizedai@gmail.com) in TOS/privacy/landing.
Still open (deliberately not built): password reset via email, email verification on signup, og:image + demo video, onboarding tour, testimonials, annual plans, raising free quota 10 → 50. Known issue: Vercel cron can't send the `Authorization: CRON_SECRET` header, so the 4 scheduled orchestrator jobs likely 401 — owner's private pipeline only; trigger manually or add query-secret support.

## Gotchas learned this session
- Vercel CLI + PowerShell: `$` vars get eaten through cmd/powershell quoting layers → write .ps1 script files and run with `-File` instead
- `vercel project rm` has no `--yes` flag (pipe `echo y`); `vercel link --yes --project <name>` is safe
- Production secrets pull as `[SENSITIVE]` placeholders — dev ≠ prod values
- Stripe Workbench webhook UI flow: events first, then destination type "Webhook", then URL
