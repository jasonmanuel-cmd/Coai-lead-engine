# Run COAI LEADS (coaihq.online)

Live site: **https://coaihq.online** (Vercel project `coai-leads`, auto-deploys on `git push`).

## 💳 SaaS mode (v2.2) — accounts + subscriptions

Customers now sign up with email/password (10 free scans/mo) and upgrade via **Stripe or Square**:
- **Starter — $49/mo** → 1,500 API calls/month
- **Pro — $99/mo** → 5,000 API calls/month
- Free tier: 10 API calls/month (no card needed — enough to demo the product)
- The owner's `APP_PASSWORD` (sidebar "Owner key") still works with unlimited access.
- The provider is chosen automatically per plan: if a Stripe price ID is set → Stripe Checkout; else if a Square plan variation is set → Square payment link. Both can coexist.

### New API endpoints
| Endpoint | Purpose |
|---|---|
| `GET/POST /api/auth` | signup / login / logout / forgot-password / reset-password / session check (httpOnly cookie) |
| `POST /api/billing` | Stripe/Square checkout URLs, portal link, Square cancel |
| `POST /api/stripe-webhook` | Stripe subscription lifecycle sync |
| `POST /api/square-webhook` | Square subscription lifecycle sync |

### Launch checklist (do these before pushing to production)
1. **Vercel Pro** — ✅ already on Pro.
2. **Stripe** — ✅ DONE (2026-10-14, created via Composio in account `Chaotically Organized AI` / `acct_1ScKln0u37S56JoG`):
   - Starter: product `prod_VRMMwVPzsShgeX`, price **`price_1UQTeN0u37S56JoGNneLXFfb`** ($49/mo recurring)
   - Pro: product `prod_VRMM8OUoZKRcXv`, price **`price_1UQTeN0u37S56JoGmXYJ5Cqh`** ($99/mo recurring)
   - Shareable payment links (for posting/sending directly):
     - Starter: https://buy.stripe.com/fZu9ALfHH86z1Cy7kP5c401
     - Pro: https://buy.stripe.com/eVqaEPdzzcmPa9420v5c402
   **OR/AND Square** — create subscription plans in Square (Dashboard → Items → Subscriptions): Starter $49/mo, Pro $99/mo, copy the plan variation IDs (`SQUARE_PLAN_VARIATION_*`).
3. **Vercel env vars** (Dashboard → Settings → Environment Variables):
   - `DATABASE_URL` — already used by cron/stats; required for accounts. If not set, create a free Postgres (Neon/Vercel Postgres) and set it.
   - Stripe: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`
   - Square: `SQUARE_ACCESS_TOKEN` (from Developer Console, with ORDERS + SUBSCRIPTIONS permissions), `SQUARE_LOCATION_ID`, `SQUARE_PLAN_VARIATION_STARTER`, `SQUARE_PLAN_VARIATION_PRO`
   - `STRIPE_WEBHOOK_URL_SECRET` + `SQUARE_WEBHOOK_URL_SECRET` — long random strings (webhook auth)
   - `SQUARE_SIGNATURE_KEY` — Square webhook signature key (enables full webhook signature verification)
   - `SQUARE_WEBHOOK_NOTIFICATION_URL` — defaults to `https://coaihq.online/api/square-webhook` (must match the Square dashboard URL for signatures)
   - `EMAIL_USER` + `EMAIL_PASS` — required for **password-reset emails** (Gmail address + App Password from https://myaccount.google.com/apppasswords). Optional: `EMAIL_FROM` (defaults to EMAIL_USER), `EMAIL_SERVICE` (defaults to `gmail`).
4. **Webhooks**:
   - ✅ Stripe webhook live (2026-10-14, destination `we_1UQXE30u37S56JoGPSWwQXXZ`) → `https://coaihq.online/api/stripe-webhook?secret=<STRIPE_WEBHOOK_URL_SECRET>` — events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` (⚠️ if you created the destination before 2026-10-19, add the `customer.subscription.created` event in the Stripe Dashboard — without it, Pro buyers are recorded as Starter)
   - Square → `https://coaihq.online/api/square-webhook?secret=<SQUARE_WEBHOOK_URL_SECRET>` — events: `subscription.created`, `subscription.updated`
5. ✅ **Stripe customer portal enabled** (2026-10-14). Portal login link (sendable to customers): https://billing.stripe.com/p/login/5kQ3cn3YZ4Una948oT5c400 — in-app "Manage" button also auto-creates per-customer portal sessions. (Square has no portal — customers cancel in-app via "Manage" → confirm.)
6. Deploy: `git push` (auto-deploys).

### Database tables (auto-created on first auth call)
`users`, `sessions`, `subscriptions`, `usage_events` (+ existing `markets`, `leads`, `outreach_log`).

## Run it locally
```bash
cd this-repo
npm install
vercel dev          # opens http://localhost:3000
```
`.env.local` holds local keys — don't commit it (gitignored).

## Required env vars (already set on Vercel ✓)
| Var | Purpose | Status |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | Maps search + place details | ✅ set |
| `APP_PASSWORD` | Owner master key (unlimited) + cron auth | ✅ set |
| `DATABASE_URL` | Accounts, subscriptions, usage metering | ⚠️ verify it's set |

## To enable the AI outreach button (currently the only missing piece)
The code defaults to free Google Gemini but no key is set, so outreach generation falls back to static templates.

1. Get a free key: https://aistudio.google.com/apikey
2. Add it to Vercel:
   ```bash
   vercel env add GEMINI_API_KEY production
   ```
   (paste key when prompted), then redeploy: `vercel --prod`

Alternatives (set `AI_PROVIDER` accordingly): `PERPLEXITY_API_KEY` or `ANTHROPIC_API_KEY`.

## Optional (free tier works without these)
`PROXY_*` (residential proxy, Level-2 scrape escalation) and `CAPSOLVER_API_KEY` (CAPTCHA, Level-4).

## Deploy a change
```bash
git add -A && git commit -m "your message" && git push   # auto-deploys to coaihq.online
```

## Legal pages
- `/tos` — Terms of Service
- `/privacy` — Privacy Policy
(Both linked from the signup modal — required by Stripe onboarding.)
