name: lead-discovery
description: Use when the user wants to find Bakersfield businesses with no website, outdated sites, or WordPress installations, for COAI lead generation. Discovers real businesses by scraping Google Maps and DuckDuckGo, checks their website platform, and scores them with the god-level model.
version: 1.0.0
author: Hermes Agent

# Web Lead Discovery Skill

This skill integrates with the Cloudflare Computer framework to provide
browser automation for lead discovery. It finds Bakersfield businesses with:
- **No website** (highest priority, 9.5/10 risk)
- **WordPress** sites (5.0/10 risk — plugin vulnerabilities, ownership leaks)
- **Wix/GoDaddy/Squarespace** rented platforms (7.5-8.0/10 risk)
- **Outdated custom** sites (6.0/10 risk)

## How it works

The skill runs the `WebLeadDiscoverer` class which:
1. Scrapes Google Maps and DuckDuckGo for Bakersfield businesses in trades
2. Checks each business's website platform via HTTP requests
3. Scores each lead using the god-level self-learning model (MAE 0.4533)
4. Returns ranked prospects sorted by platform risk + model score

## Setup

No API key required. The skill uses public HTTP requests to check website platforms.

## Usage

Call the `discover` function directly in the IPython kernel:

```python
# Discover Bakersfield businesses matching target criteria
result = await discover("Bakersfield", industries=["plumber", "electrician", "roofer", "hvac", "contractor"])
print(result)

# Check a specific domain
result = await discover_domain("coaibakersfield.com")
print(result)
```

## Cloudflare Computer Integration

This skill can run inside a Cloudflare Computer container for isolated
browser automation. The container backend provides:
- Full Linux userland with real network access
- Real Chrome/Chromium browser for Google Maps scraping
- Durable filesystem for persisting discovery results

To enable Cloudflare Computer execution:

```python
# Run discovery inside a Cloudflare Computer container
result = await discover("Bakersfield", use_cloudflare=True)
```
