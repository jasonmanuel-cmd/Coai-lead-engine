# COAI Lead Engine v2

A lead generation tool that scans Google Maps for local businesses, scores them by digital presence weakness, and generates AI-personalized outreach scripts.

**Author:** Jason Manuel — Chaotically Organized AI (Bakersfield, CA)

## Architecture

```
index.html          → Single-page app (vanilla JS, dark-mode UI)
api/search.js       → Google Places API proxy (NearbySearch, Geocode, Place Details)
api/scrape.js       → Scraper with 4-level escalation pipeline
  ├── transport/    → TLS-spoofed HTTP → residential proxy → Browser stealth → CAPTCHA solver
  ├── pipeline/     → Decision tree orchestrator + Zod validation
  └── utils/        → robots.txt, rate limiting, retry with backoff
api/outreach.js     → AI outreach generator (Claude Haiku)
```

## Cost — Can Run at $0

The scraper auto-detects free tier and adjusts: retries disabled, proxy/captcha layers skipped if unconfigured.

| Service | Free Tier | Why It Works |
|---|---|---|
| **Vercel Hobby** | Free | Most leads caught by Level 1 (HTTP) within 10s |
| **Google Places API** | $200/mo credit | Lead gen uses pennies per scan |
| **Google Gemini** | Free tier (1500 req/day) | Default provider — no cost for lead gen volumes |
| **Smartproxy** | Skipped if unset | Local biz sites (Wix/WordPress) don't need proxies |
| **Capsolver** | Skipped if unset | Almost never triggered on basic sites |

**Free path**: Level 1 (impit TLS HTTP) catches ~90% of local business websites. Level 3 (browser) kicks in for JS-heavy sites and fits within 10s for simple pages.

## Deploy

1. Deploy to Vercel (any plan — auto-adjusts for Hobby's 10s limit)
2. Set environment variables in Vercel dashboard (see `.env.example`)
3. Point `GOOGLE_PLACES_API_KEY` to a key with Places API enabled
4. Optional: Set `GEMINI_API_KEY` for AI outreach (free, default). Or `PERPLEXITY_API_KEY` / `ANTHROPIC_API_KEY`
5. Optional: Set `PROXY_USERNAME`/`PROXY_PASSWORD` for residential proxy layer
6. Optional: Set `CAPSOLVER_API_KEY` for CAPTCHA solving tier

## Environment Variables

See `.env.example` for all required and optional vars.

## Operator Training

The `JAX-TRAINING-GUIDE.html` file is a standalone training manual for operators.
