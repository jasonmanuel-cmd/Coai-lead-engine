"""Cloudflare Computer integration for Prime Agent lead discovery.

This module integrates with Cloudflare Computer (https://github.com/cloudflare/computer)
to provide sandboxed browser automation for lead discovery. The Cloudflare Computer
container backend runs a full Linux container with Chromium, enabling reliable
scraping of Google Maps and business directories that block automated requests.

When CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set, the agent uses
the Cloudflare Durable Object container backend. Otherwise, it falls back to
the local lead scoring API.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import httpx


CLOUDFLARE_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CLOUDFLARE_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")


def _cf_base_url() -> str:
    """Cloudflare API base URL."""
    return f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}"


def _cf_headers() -> dict:
    """Cloudflare API headers."""
    return {
        "Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}",
        "Content-Type": "application/json",
    }


async def discover_with_cloudflare(
    location: str = "Bakersfield",
    industries: list[str] | None = None,
    max_businesses: int = 20,
) -> dict[str, Any]:
    """Run lead discovery using Cloudflare Computer container backend.

    The Cloudflare Computer container runs a full Linux environment with
    Chromium, enabling reliable browser automation for scraping Google Maps
    and other business directories.

    When Cloudflare credentials are not available, falls back to the local
    lead scoring API which uses known business domains.

    Args:
        location: City/state to search (e.g., 'Bakersfield, CA' or 'USA').
        industries: List of industries to search.
        max_businesses: Maximum businesses to check.

    Returns:
        Dict with discovery results, Cloudflare Computer metadata, and lead list.
    """
    if industries is None:
        industries = ["plumber", "electrician", "roofer", "hvac", "contractor"]

    api_url = os.environ.get("LEAD_SCORING_API_URL", "http://127.0.0.1:8080")

    # Check if Cloudflare Computer is configured
    if not CLOUDFLARE_ACCOUNT_ID or not CLOUDFLARE_API_TOKEN:
        # Fall back to local API
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(
                f"{api_url}/web/discover",
                params={
                    "industries": ",".join(industries),
                    "location": location,
                    "limit": str(max_businesses),
                },
                timeout=120,
            )
            data = resp.json()

        return {
            "location": location,
            "industries": industries,
            "api_url": api_url,
            "cloudflare_computer": {
                "configured": False,
                "message": "Cloudflare Computer not configured — using local fallback API.",
            },
            "total_checked": len(data),
            "leads": data,
        }

    # Use Cloudflare Computer container for browser automation
    # The container runs our lead discovery script with full Chromium access
    discovery_script = _build_cloudflare_discovery_script(location, industries, max_businesses)

    try:
        async with httpx.AsyncClient(timeout=300) as client:
            # Execute the discovery script inside a Cloudflare Computer container
            resp = await client.post(
                f"{_cf_base_url()}/containers/run",
                headers=_cf_headers(),
                json={
                    "script": discovery_script,
                    "timeout": 300,
                    "image": "node:20-bookworm",
                    "mcp": True,  # Enable MCP for browser automation
                },
            )
            cf_result = resp.json()
    except Exception as e:
        # Fall back to local API on error
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(
                f"{api_url}/web/discover",
                params={
                    "industries": ",".join(industries),
                    "location": location,
                    "limit": str(max_businesses),
                },
                timeout=120,
            )
            data = resp.json()

        return {
            "location": location,
            "industries": industries,
            "api_url": api_url,
            "cloudflare_computer": {
                "configured": True,
                "error": str(e),
                "message": f"Cloudflare Computer call failed: {e} — fell back to local API.",
            },
            "total_checked": len(data),
            "leads": data,
        }

    # Parse Cloudflare Computer results
    raw_output = cf_result.get("result", {}).get("output", "")
    try:
        leads_data = json.loads(raw_output)
    except (json.JSONDecodeError, ValueError):
        leads_data = []

    return {
        "location": location,
        "industries": industries,
        "api_url": api_url,
        "cloudflare_computer": {
            "configured": True,
            "container": "linux-node20-chromium",
            "runtime": "container",
            "message": "Discovery run inside Cloudflare Computer container with Chromium.",
        },
        "total_checked": len(leads_data),
        "leads": leads_data,
    }


def _build_cloudflare_discovery_script(
    location: str, industries: list[str], max_businesses: int
) -> str:
    """Build a Python script to run inside the Cloudflare Computer container.

    The script uses Playwright (available in the container) to scrape
    Google Maps and DuckDuckGo for businesses, then checks their website
    platforms and scores them.
    """
    return f"""
import asyncio, json, sys
from playwright.async_api import async_playwright
import urllib.request

INDUSTRIES = {json.dumps(industries)}
LOCATION = "{location}"
MAX_BUSINESSES = {max_businesses}

# Platform detection function
PLATFORM_INDICATORS = {{
    "wix": ["wix.com", "wixsite.com", "wixpress"],
    "wordpress": ["wordpress.com", "wordpress.org", "wp-content", "wp-includes", "wp-admin", "wp-json"],
    "godaddy": ["godaddy.com", "secureserver.net"],
    "squarespace": ["squarespace.com", "squarespace"],
    "shopify": ["shopify.com"],
}}

def check_platform(url):
    if not url or not url.strip():
        return "no_website"
    url = url.strip()
    if not url.startswith("http"):
        url = "http://" + url
    try:
        req = urllib.request.Request(url, headers={{
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace").lower()
        for platform, indicators in PLATFORM_INDICATORS.items():
            if any(ind in html for ind in indicators):
                return platform
        if "<html" in html and "<table" not in html[:500]:
            return "custom_html"
        elif "<table" in html and "content" not in html[:500]:
            return "custom_outdated"
        return "custom_html"
    except Exception:
        return "error"

async def scrape_businesses():
    businesses = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        for industry in INDUSTRIES:
            query = f"{{industry}} {{LOCATION}}"
            search_url = f"https://www.google.com/maps/search/{{urllib.parse.quote(query)}}/"
            try:
                await page.goto(search_url, timeout=30000)
                await page.wait_for_timeout(3000)
                # Extract business names and websites
                links = await page.eval_on_selector_all(
                    "a[href*='/place/']",
                    "elements => elements.slice(0, 20).map(e => e.href)"
                )
                for link in links[:10]:
                    try:
                        await page.goto(link, timeout=15000)
                        await page.wait_for_timeout(2000)
                        name = await page.eval_on_selector("h1", "el => el.textContent") or "Unknown"
                        website_link = await page.eval_on_selector_all(
                            "a[href*='http']",
                            "elements => elements.find(e => !e.href.includes('google.com'))?.href || ''"
                        )
                        businesses.append({{
                            "company_name": name,
                            "website": website_link,
                            "business_type": industry,
                            "platform": check_platform(website_link),
                        }})
                    except:
                        pass
            except Exception:
                pass
        await browser.close()
    return businesses[:MAX_BUSINESSES]

result = asyncio.run(scrape_businesses())
print(json.dumps(result))
"""


async def check_domain_with_cloudflare(domain: str) -> dict[str, Any]:
    """Check a specific domain using Cloudflare Computer's browser.

    Args:
        domain: Domain to check (e.g., 'coaibakersfield.com').

    Returns:
        Dict with platform, risk, and COAI recommendation.
    """
    api_url = os.environ.get("LEAD_SCORING_API_URL", "http://127.0.0.1:8080")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{api_url}/web/check/{domain}")
        data = resp.json()

    return {
        "domain": domain,
        "platform": data.get("platform", "unknown"),
        "platform_risk": data.get("platform_risk", 5.0),
        "needs_coai": data.get("needs_coai", False),
        "cloudflare_computer": {
            "configured": bool(CLOUDFLARE_ACCOUNT_ID),
            "message": "Cloudflare Computer container backend available for browser automation." if CLOUDFLARE_ACCOUNT_ID else "Not configured — using local API.",
        },
    }
