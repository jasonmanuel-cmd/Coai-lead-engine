"""Lead discovery skill for Prime Agent — finds Bakersfield businesses with no website, WordPress, or outdated sites.

This skill uses the god-level self-learning lead scoring model to identify
high-priority business prospects for COAI's call-first website services.
"""

from __future__ import annotations

import asyncio
import json
import httpx
import os
from pathlib import Path
from typing import Any

# Re-export Cloudflare Computer integration
from .cloudflare_computer import (
    discover_with_cloudflare,
    check_domain_with_cloudflare,
)

# Re-export email enrichment
from .email_enrichment import find_emails_for_lead, enrich_leads

# Re-export review scraper
from .review_scraper import get_review_data, enrich_leads_with_reviews, calculate_review_score

# Re-export revenue attribution tracker
from .revenue_tracker import log_lead, update_stage, get_attribution_report

# Re-export WhatsApp outreach
from .whatsapp_outreach import find_whatsapp_number, compose_message, send_whatsapp_message, bulk_send

# Re-export coaihq.online auto-login
from .coai_autologin import run_coai_scan, get_login_script, get_select_all_industries_script, get_scan_script, get_results_script, get_backup_json_script

# Re-export gumroad competitor analysis
from .gumroad_analysis import analyze_competitor, analyze_all_competitors, generate_pricing_report

# Re-export SMS outreach
from .sms_outreach import find_phone_number, compose_sms_message, send_sms, create_paypal_invoice, bulk_sms

# Re-export email reporting
from .email_reporting import send_report, send_daily_report, send_alert, send_test_email


def _resolve_api_url() -> str:
    """Resolve the lead scoring API URL."""
    return os.environ.get("LEAD_SCORING_API_URL", "http://127.0.0.1:8080")


def _risk_map(platform: str) -> float:
    return {
        "no_website": 9.5,
        "error": 3.0,
        "wix": 8.0,
        "godaddy": 8.0,
        "squarespace": 7.5,
        "shopify": 7.0,
        "wordpress": 5.0,
        "webflow": 4.5,
        "drupal": 4.0,
        "custom_outdated": 6.0,
        "custom_html": 1.0,
    }.get(platform, 5.0)


async def discover_domain(domain: str) -> str:
    """Check a specific domain's website platform and score it.

    Args:
        domain: Domain to check (e.g., 'coaibakersfield.com').

    Returns:
        Formatted report with platform type, risk score, model score, and COAI recommendation.
    """
    api_url = _resolve_api_url()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{api_url}/web/check/{domain}")
            data = resp.json()
    except Exception as e:
        return f"Error checking domain '{domain}': {e}"

    platform = data.get("platform", "unknown")
    risk = data.get("platform_risk", 5.0)
    needs_coai = data.get("needs_coai", False)

    # Score via the model API
    context = f"Company: {domain} digital agency | Location: kern county ca. | Profile: {platform} site. Small business website."
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{api_url}/score",
                json={"context": context},
                timeout=10,
            )
            score_data = resp.json()
            model_score = score_data.get("score", 0)
            confidence = score_data.get("confidence", 0)
    except Exception:
        model_score = 0
        confidence = 0

    return (
        f"Domain: {domain}\n"
        f"  Platform: {platform}\n"
        f"  Platform Risk: {risk}/10\n"
        f"  Model Score: {model_score}/10 (confidence: {confidence:.1f}%)\n"
        f"  Needs COAI Services: {needs_coai}\n"
        f"  Recommendation: {'HIGH PRIORITY' if needs_coai else 'Healthy presence'}"
    )


async def discover(location: str = "Bakersfield", industries: list[str] | None = None,
                   max_businesses: int = 20, use_cloudflare: bool = False,
                   nationwide: bool = False, states: list[str] | None = None) -> str:
    """Discover businesses for COAI lead generation.

    Args:
        location: City to search (default: Bakersfield).
        industries: List of industries to search.
        max_businesses: Maximum number of businesses to check.
        use_cloudflare: If True, run inside a Cloudflare Computer container for browser automation.
        nationwide: If True, search across all 50 US states (default: False).
        states: Specific state codes to search (e.g. ['CA', 'TX']). Default: top 17 states.

    Returns:
        Formatted report of discovered prospects, sorted by priority.
    """
    if industries is None:
        industries = ["plumber", "electrician", "roofer", "hvac", "contractor"]

    api_url = _resolve_api_url()

    # Call the discovery endpoint
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            if nationwide:
                endpoint = "/web/discover-nationwide"
                params = {
                    "industries": ",".join(industries),
                    "states": ",".join(states) if states else "",
                    "limit": max_businesses,
                }
            else:
                endpoint = "/web/discover"
                params = {
                    "industries": ",".join(industries),
                    "location": location,
                    "limit": max_businesses,
                }
            resp = await client.get(f"{api_url}{endpoint}", params=params, timeout=300)
            data = resp.json()
    except Exception as e:
        return f"Error running discovery: {e}\n\nMake sure the API server is running at {api_url}."

    total = len(data)
    needs_coai = len([l for l in data if l.get("platform") in ("no_website", "wordpress", "wix", "godaddy", "squarespace", "custom_outdated", "error")])
    no_website = len([l for l in data if l.get("platform") == "no_website"])
    wordpress = len([l for l in data if l.get("platform") == "wordpress"])
    wix = len([l for l in data if l.get("platform") in ("wix", "godaddy", "squarespace", "shopify")])
    outdated = len([l for l in data if l.get("platform") == "custom_outdated"])

    report = [
        f"PRIME-AGENT LEAD DISCOVERY REPORT",
        f"Location: {location}",
        f"Industries: {', '.join(industries)}",
        f"Total businesses checked: {total}",
        f"Needs COAI Services: {needs_coai}",
        f"  - No website: {no_website}",
        f"  - WordPress: {wordpress}",
        f"  - Wix/Rented: {wix}",
        f"  - Outdated custom: {outdated}",
        "",
        "TOP PROSPECTS (sorted by risk + score):",
        "-" * 80,
    ]

    leads = data  # data is already a list of LeadScoredWeb objects

    # Enrich with email + review data (these modules are imported at top)
    try:
        leads = enrich_leads_with_reviews(leads)
    except Exception:
        pass
    try:
        leads = enrich_leads(leads)
    except Exception:
        pass

    # Sort by hot_lead_score + model score
    leads.sort(key=lambda x: (x.get("hot_lead_score", 0), x.get("score", 0)), reverse=True)

    for lead in leads[:20]:
        name = lead.get("company_name", "Unknown")
        platform = lead.get("platform", "unknown")
        score = lead.get("score", 0)
        hot = lead.get("hot_lead_score", lead.get("platform_risk", 0))
        coai = "🔥 NEEDS COAI" if lead.get("needs_coai") else "✓ healthy"
        website = lead.get("website", "")
        emails = lead.get("emails", [])
        rating = lead.get("rating")
        report.append(f"  {name:<40} | {platform:<15} | hot={hot} | score={score} | {coai} | {website}")
        if emails:
            report.append(f"    📧 {', '.join(emails[:3])}")
        if rating:
            report.append(f"    ⭐ Rating: {rating}/5 from {lead.get('review_count', 0)} reviews")

    return "\n".join(report)


def run(
    domain: str | None = None,
    location: str = "Bakersfield",
    industries: str = "plumber,electrician,roofer,hvac,contractor",
    max_businesses: int = 20,
    use_cloudflare: bool = False,
    nationwide: bool = False,
    states: list[str] | None = None,
) -> str:
    """CLI entry point for the lead discovery skill.

    Either check a specific domain or discover businesses in a location.

    Args:
        domain: Check a specific domain (e.g., 'coaibakersfield.com').
        location: City/location to search (default: Bakersfield).
        industries: Comma-separated industries to search.
        max_businesses: Max businesses to discover.
        use_cloudflare: Run inside Cloudflare Computer container.
    """
    if domain:
        if use_cloudflare:
            result = asyncio.run(check_domain_with_cloudflare(domain))
            return json.dumps(result, indent=2, default=str)
        return asyncio.run(discover_domain(domain))
    else:
        ind_list = [i.strip() for i in industries.split(",")]
        if use_cloudflare:
            result = asyncio.run(discover_with_cloudflare(location, ind_list, max_businesses, states=states))
            return json.dumps(result, indent=2, default=str)
        return asyncio.run(discover(location, ind_list, max_businesses, use_cloudflare,
                                    nationwide=nationwide, states=states))
