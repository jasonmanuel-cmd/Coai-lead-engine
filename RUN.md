# Run COAI LEADS (coaihq.online)

Live site: **https://coaihq.online** (Vercel project `coai-leads`, auto-deploys on `git push`).

## 💳 SaaS mode (v2.2) — accounts + subscriptions

Customers now sign up with email/password (100 free scans/mo) and upgrade via Stripe:
- **Starter — $49/mo** → 1,500 API calls/month (`STRIPE_PRICE_STARTER`)
- **Pro — $99/mo** → 5,000 API calls/month (`STRIPE_PRICE_PRO`)
- Free tier: 100 API calls/month (no card needed — great for demos)
- The owner's `APP_PASSWORD` (sidebar "Owner key") still works with unlimited access.

### New API endpoints
| Endpoint | Purpose |
|---|---|
| `GET/POST /api/auth` | signup / login / logout / session check (httpOnly cookie) |
| `POST /api/billing` | Stripe Checkout + billing portal URLs |
| `POST /api/stripe-webhook` | subscription lifecycle sync |

### Launch checklist (do these before pushing to production)
1. **Vercel Pro** — the Hobby (free) plan prohibits commercial use. Upgrade the project.
2. **Stripe** — create 2 recurring Products/Prices: Starter $49/mo, Pro $99/mo. Copy the `price_...` IDs.
3. **Vercel env vars** (Dashboard → Settings → Environment Variables):
   - `DATABASE_URL` — already used by cron/stats; required for accounts. If not set, create a free Postgres (Neon/Vercel Postgres) and set it.
   - `STRIPE_SECRET_KEY` — `sk_live_...` (or `sk_test_...` while testing)
   - `STRIPE_PRICE_STARTER` — `price_...`
   - `STRIPE_PRICE_PRO` — `price_...`
   - `STRIPE_WEBHOOK_URL_SECRET` — any long random string (also enables webhook auth)
4. **Stripe webhook** — Dashboard → Developers → Webhooks → add endpoint:
   `https://coaihq.online/api/stripe-webhook?secret=<your STRIPE_WEBHOOK_URL_SECRET>`
   Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
5. **Enable Stripe customer portal** — Dashboard → Settings → Billing → Customer portal → activate.
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
