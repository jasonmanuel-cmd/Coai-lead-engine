# Lead Discovery Skill for Prime Agent

A Prime Agent skill that finds Bakersfield (and beyond) businesses with:
- **No website** (highest priority, 9.5/10 risk)
- **WordPress** sites (5.0/10 risk — plugin vulnerabilities, ownership leaks)
- **Wix/GoDaddy/Squarespace** rented platforms (7.5-8.0/10 risk)
- **Outdated custom** sites (6.0/10 risk)

Built on the [PrimeIntellect AI prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) framework with optional [Cloudflare Computer](https://github.com/cloudflare/computer) integration for browser automation.

## Architecture

```
prime-agent (TypeScript)
  ├── lead-discovery skill (Python)
  │   ├── __init__.py — async discover() + check_domain() functions
  │   └── cloudflare_computer.py — Cloudflare Computer container integration
  ├── Cloudflare Computer (npm: @cloudflare/computer)
  │   └── Container backend (Linux + Chromium for scraping)
  └── Lead Scoring API (FastAPI, port 8080)
      ├── /web/check/{domain} — platform detection
      ├── /web/discover — business discovery
      └── /score, /feedback, /leads/find — model scoring

RLM Pattern: Parent orchestrator (prime-agent kernel) →
  Child workers (ThreadPoolExecutor/RLM subagents) →
  Return scored prospects
```

## Usage

### In Prime Agent IPython Kernel

```python
# Check a specific domain
result = await discover_domain("coaibakersfield.com")

# Discover businesses in Bakersfield
result = await discover("Bakersfield", industries=["plumber", "electrician"])

# With Cloudflare Computer (requires CLOUDFLARE_ACCOUNT_ID + API token)
result = await discover_with_cloudflare("Bakersfield", industries=["plumber"])
```

### CLI

```bash
# Check a specific domain
run domain=coaibakersfield.com

# Discover businesses
run location=Bakersfield industries=plumber,electrician,roofer

# With Cloudflare Computer
run location=Bakersfield use_cloudflare=true
```

### API (standalone)

```bash
# The lead scoring API must be running
cd model-training/src && python -m uvicorn api:app --port 8080

# Check a domain
curl http://127.0.0.1:8080/web/check/coaibakersfield.com

# Discover businesses
curl "http://127.0.0.1:8080/web/discover?industries=plumber,electrician&location=Bakersfield"
```

## Cloudflare Computer Integration

Set these environment variables to enable browser automation via Cloudflare Durable Objects:

```bash
export CLOUDFLARE_ACCOUNT_ID=your_account_id
export CLOUDFLARE_API_TOKEN=your_api_token
```

When enabled, the skill uses Cloudflare Computer's container backend to run
Chromium inside an isolated Linux container with real network access, enabling
reliable scraping of Google Maps and business directories.

## Model

Uses the god-level self-learning lead scoring ensemble:
- **MAE**: 0.4533 (test), 0.5067 (validation)
- **±1 accuracy**: 97.3% (test), 96.7% (validation)
- **368 real leads** from sales-outreach CSV data
