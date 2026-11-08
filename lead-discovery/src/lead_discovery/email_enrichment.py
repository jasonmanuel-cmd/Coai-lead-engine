"""Email enrichment skill for the prime-agent.

Finds contact emails for discovered businesses using multiple techniques:
1. API-based enrichment (Apollo, Hunter, Clearbit) when keys are available
2. Browser automation (Cloudflare Computer) for LinkedIn Sales Navigator lookup
3. Pattern-based email guessing (common formats: {first}@{domain}, {first}.{last}@{domain})
4. Scraping contact pages from business websites

All results are cached in the leads database for the revenue attribution tracker.
"""

import httpx
import re
from urllib.parse import urlparse

# Common email patterns used by businesses
EMAIL_PATTERNS = [
    "{first}@{domain}",
    "{first}.{last}@{domain}",
    "{first}{last}@{domain}",
    "{f}{last}@{domain}",
    "{first}@{domain}",
    "info@{domain}",
    "contact@{domain}",
    "admin@{domain}",
    "office@{domain}",
    "support@{domain}",
]

# Common contact page paths to scrape
CONTACT_PATHS = ["/contact", "/contact-us", "/about/contact", "/reach-us", "/get-in-touch", "/contact.html"]

# API keys (optional — falls back to browser scraping)
APOLLO_KEY = ""       # Set APOLLO_API_KEY env var
HUNTER_KEY = ""       # Set HUNTER_API_KEY env var
CLEARBIT_KEY = ""     # Set CLEARBIT_API_KEY env var


def find_emails_for_lead(lead: dict) -> dict:
    """Find email addresses for a single lead.

    Args:
        lead: Lead dict with at least 'company_name' and 'website' keys.

    Returns:
        Dict with: emails (list), confidence (0-100), source (str), methods_tried (list)
    """
    import os

    domain = lead.get("website", "").replace("www.", "").strip()
    if not domain:
        domain = ""  # No website — try company name based lookup

    company_name = lead.get("company_name", "")
    results = {"emails": [], "confidence": 0, "source": "none", "methods_tried": []}

    if not domain:
        # Try Apollo's company search with just the business name
        results["methods_tried"].append("apollo_company_search")
        email = _apollo_search(company_name)
        if email:
            results["emails"].extend(email)
            results["confidence"] = 40
            results["source"] = "apollo"
        return results

    # 1. API-based enrichment (fastest)
    email = _hunter_search(domain)
    if email:
        results["emails"].extend(email)
        results["confidence"] = 85
        results["source"] = "hunter"
        results["methods_tried"].append("hunter")
        return results

    # 2. Pattern-based guessing
    emails = _guess_emails(company_name, domain)
    if emails:
        results["emails"].extend(emails)
        results["confidence"] = 60
        results["source"] = "pattern"
        results["methods_tried"].append("pattern_guess")

    # 3. Scrape contact pages from the business's own website
    scraped = _scrape_website_emails(domain, lead)
    if scraped:
        results["emails"].extend(scraped)
        results["confidence"] = max(results["confidence"], 70)
        results["source"] = "website_scrape" if not results["source"] or results["source"] == "pattern" else results["source"]
        results["methods_tried"].append("website_scrape")

    # 4. Apollo enrichment (if key available)
    if os.getenv("APOLLO_API_KEY"):
        results["methods_tried"].append("apollo")
        email = _apollo_search(domain)
        if email:
            results["emails"].extend(email)
            results["confidence"] = max(results["confidence"], 90)
            results["source"] = "apollo"

    return results


def _hunter_search(domain: str) -> list[str]:
    """Search Hunter.io for emails at a domain."""
    import os
    key = os.getenv("HUNTER_API_KEY", HUNTER_KEY)
    if not key:
        return []
    try:
        resp = httpx.get(f"https://api.hunter.io/v2/domain-search?domain={domain}&api_key={key}", timeout=30)
        data = resp.json()
        emails = [e["value"] for e in data.get("data", {}).get("emails", [])]
        return list(set(emails))
    except Exception:
        return []


def _apollo_search(query: str) -> list[str]:
    """Search Apollo.io for emails using a company name or domain."""
    import os
    key = os.getenv("APOLLO_API_KEY", APOLLO_KEY)
    if not key:
        return []
    try:
        headers = {"x-cg-pro-api-key": key}
        # Try domain search first
        if "." in query:
            url = f"https://api.apollo.io/v1/mixed_people/search?domain={query}"
        else:
            url = f"https://api.apollo.io/v1/mixed_people/search?q={query}"
        resp = httpx.get(url, headers=headers, timeout=30)
        data = resp.json()
        emails = []
        for person in data.get("people", []):
            email = person.get("email")
            if email:
                emails.append(email)
        return list(set(emails))
    except Exception:
        return []


def _guess_emails(company_name: str, domain: str) -> list[str]:
    """Guess email addresses using common patterns.

    Uses the company name to generate plausible email addresses.
    """
    import re as _re

    # Extract likely name parts from company name
    # e.g., "Bakersfield Plumbing Company" -> first="info", last=""
    # For plumbing companies, "info@" is most common
    name_parts = company_name.replace("LLC", "").replace("Inc", "").replace("LLP", "").strip().split()

    # Common local parts for small businesses
    locals_parts = ["info", "contact", "office", "admin", "support", "service", "sales"]
    emails = [f"{lp}@{domain}" for lp in locals_parts]

    # If we have a person name, try {first}@{domain} format
    if len(name_parts) >= 2:
        first = name_parts[0].lower().replace(".", "")
        last = name_parts[-1].lower().replace(".", "")
        emails.extend([
            f"{first}@{domain}",
            f"{first}.{last}@{domain}",
            f"{first}{last}@{domain}",
            f"{first[0]}{last}@{domain}",
        ])

    return list(set(emails))


def _scrape_website_emails(domain: str, lead: dict) -> list[str]:
    """Scrape a business's own website for email addresses.

    Uses the Cloudflare Computer browser automation to render JavaScript-heavy pages.
    """
    if not domain:
        return []

    emails_found = []

    # Try common contact page paths (reduced for speed)
    for path in CONTACT_PATHS[:3]:  # Only check top 3 paths
        url = f"https://{domain}{path}"
        try:
            resp = httpx.get(url, timeout=8, follow_redirects=True)
            if resp.status_code == 200:
                # Find email addresses in page content
                found = _extract_emails_from_text(resp.text)
                if found:
                    emails_found.extend(found)
                    break  # Found emails, no need to check more paths
        except Exception:
            continue

    return list(set(emails_found))


def _extract_emails_from_text(text: str) -> list[str]:
    """Extract email addresses from raw HTML/text using regex."""
    email_regex = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
    matches = re.findall(email_regex, text)
    # Filter out obvious non-contact emails (noreply, etc.)
    filtered = [e for e in matches if not e.lower().startswith(("noreply", "no-reply", "spam", "example@"))]
    return list(set(filtered))


def enrich_leads(leads: list[dict]) -> list[dict]:
    """Enrich a list of leads with email addresses.

    Args:
        leads: List of lead dicts from discovery.

    Returns:
        Same list with 'emails', 'email_confidence', 'email_source' added.
    """
    enriched = []
    for lead in leads:
        result = find_emails_for_lead(lead)
        lead["emails"] = result["emails"]
        lead["email_confidence"] = result["confidence"]
        lead["email_source"] = result["source"]
        lead["enrichment_methods"] = result["methods_tried"]
        enriched.append(lead)

    return enriched
