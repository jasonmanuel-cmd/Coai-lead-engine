# Lead Orchestrator — Autonomous Lead Pipeline

The orchestrator is a fully autonomous system that discovers, qualifies, and reaches out to leads on an hourly schedule.

## Architecture

Four hourly cron jobs work in sequence:

1. **cron-discover** (0 min) — Find new leads in target markets via Google Places
2. **cron-audit** (5 min) — Audit websites for quality score
3. **cron-qualify** (10 min) — Auto-qualify leads based on score & contact data
4. **cron-outreach** (15 min) — Send templated emails to qualified leads

## Setup

### 1. Create Neon Database

```bash
# Go to https://neon.tech and create a new PostgreSQL project
# Copy the DATABASE_URL and add to Vercel env vars
```

### 2. Set Vercel Environment Variables

Go to your Vercel project → Settings → Environment Variables and add:

```
GOOGLE_PLACES_API_KEY      = your_key
APP_PASSWORD               = your_password
CRON_SECRET                = unique_random_token
DATABASE_URL               = postgresql://...
EMAIL_USER                 = your-gmail@gmail.com
EMAIL_PASS                 = your_gmail_app_password
```

**Note:** Gmail app passwords: Create at https://myaccount.google.com/apppasswords (requires 2FA enabled)

### 3. Deploy to Vercel

```bash
npm install
npm run deploy
```

Vercel will automatically detect the cron jobs from `vercel.json` and start them.

## Pipeline Stages

- **discovered** — Found by Google Places search
- **audited** — Website quality score calculated
- **qualified** — Meets auto-qualify criteria (score ≥50, has contact info)
- **messaged** — Initial outreach email sent
- **followed_up** — Follow-up email sent (future)

## Auto-Qualification Rules

A lead qualifies for outreach when:
- Audit score ≥ 35 points (HTTPS, mobile viewport, title, description)
- OR has phone number + (website OR email)
- AND is status OPERATIONAL
- AND has contact information (phone or email)

## Hourly Flow Example

```
00:00 - Discover (search "smoke shop denver", "vape shop austin", etc)
00:05 - Audit (rate first 5 unaudited websites)
00:10 - Qualify (score first 20 audited leads)
00:15 - Outreach (email first 10 qualified leads)
00:20 - Done; repeat hourly
```

## Monitoring

Check the Vercel Deployments tab to see cron job logs. Each cron job returns JSON:

```json
{ "status": "OK", "discovered": 12, "duplicates": 3, "audited": 5 }
```

## Markets

Default markets in `markets` table:
- Denver - Smoke Shops
- Austin - Vape Shops
- Los Angeles - CBD

Edit in UI or add via SQL:
```sql
INSERT INTO markets (name, industry, location, search_term)
VALUES ('Miami - Smoke Shops', 'smoke-shop', 'Miami, FL', 'smoke shop miami');
```

## Email Templates

Located in `api/cron-outreach.js`:
- `initial` — First contact message
- `followup` — 3-day follow-up (edit to enable)

Customize by editing the template functions.

## Troubleshooting

**No leads being discovered?**
- Check Google Places API key is valid
- Verify market search terms are working (test in Google Places)

**Emails not sending?**
- Verify Gmail app password (not regular password)
- Check EMAIL_USER and EMAIL_PASS are set
- Enable "Less secure app access" if using regular password

**Cron jobs not running?**
- Ensure `CRON_SECRET` is set in Vercel env vars
- Check Vercel Deployments → Cron Jobs tab for logs
- Redeploy after changing `vercel.json`

## Database Schema

```sql
leads
├── id, name, phone, email, website, address
├── market_id (foreign key)
├── pipeline_stage (discovered|audited|qualified|messaged|followed_up)
├── score (0-100 qualification score)
├── audit_score (website quality 0-100)
├── rating, reviews_count (from Google Places)
└── last_audited, last_messaged, last_response timestamps

outreach_log
├── lead_id (foreign key)
├── email, template_name, status
└── sent_at, opened_at, clicked_at, replied_at

markets
├── id, name, industry, location, search_term
└── active (boolean)
```

## Cost Estimate (Monthly)

- Google Places API: $15-30 (100-200 lead searches)
- Neon Database: $14/month (free tier: 3GB)
- Vercel Cron: Included in Pro plan ($20/month)
- Gmail: Free

**Total: ~$35-50/month for 30-60 leads/month discovery rate**
