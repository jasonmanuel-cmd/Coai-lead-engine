"""Review scraper skill for the prime-agent.

Scrapes review data from business websites, Google Maps, Facebook, and Yelp
to enhance the hot-lead scoring model. Review-based signals:
- Rating < 3.5 stars: +25 points
- No rating at all: +20 points
- Zero reviews: +10 points
- Fewer than 10 reviews: +15 points

This matches the coaihq.online Lead Engine v2 scoring system.
"""

import httpx
import re
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse


def get_review_data(lead: dict) -> dict:
    """Scrape review data for a lead.

    Args:
        lead: Lead dict with 'website', 'company_name', 'platform'.

    Returns:
        Dict with: rating (float|None), review_count (int), has_rating (bool),
                   sources (list), raw_snippets (list)
    """
    website = lead.get("website", "")
    company_name = lead.get("company_name", "")
    platform = lead.get("platform", "")

    result = {
        "rating": None,
        "review_count": 0,
        "has_rating": False,
        "sources": [],
        "snippets": [],
    }

    # If no website, try Google Maps / Facebook lookalike
    if not website:
        maps_data = _scrape_google_maps(company_name, lead.get("address", ""))
        if maps_data:
            result["rating"] = maps_data.get("rating")
            result["review_count"] = maps_data.get("review_count", 0)
            result["has_rating"] = maps_data.get("rating") is not None
            result["sources"].append("google_maps")
            if maps_data.get("snippet"):
                result["snippets"].append(maps_data["snippet"])
        return result

    # Try to scrape reviews from the business's own website (reduced paths for speed)
    site_data = _scrape_website_reviews(website)
    if site_data:
        result["rating"] = site_data.get("rating")
        result["review_count"] = site_data.get("review_count", 0)
        result["has_rating"] = site_data.get("rating") is not None
        result["sources"].append("website")
        if site_data.get("snippet"):
            result["snippets"].append(site_data["snippet"])
        return result

    # Try Google search for reviews (Facebook, Yelp, Google Maps)
    google_data = _scrape_google_search(company_name)
    if google_data:
        result["rating"] = google_data.get("rating")
        result["review_count"] = google_data.get("review_count", 0)
        result["has_rating"] = google_data.get("rating") is not None
        result["sources"].append("google_search")
        if google_data.get("snippet"):
            result["snippets"].append(google_data["snippet"])

    return result


def _scrape_website_reviews(website: str) -> dict | None:
    """Scrape review widgets/embedded ratings from a business website."""
    if not website:
        return None

    # Try common review widget paths (reduced for speed)
    review_paths = ["/", "/reviews", "/testimonials"]

    for path in review_paths:
        url = f"https://{website.replace('www.', '')}{path}"
        try:
            resp = httpx.get(url, timeout=8, follow_redirects=True)
            if resp.status_code != 200:
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            result = _extract_review_data_from_html(soup, url)
            if result.get("rating") is not None or result.get("review_count", 0) > 0:
                return result
        except Exception:
            continue

    return None


def _extract_review_data_from_html(soup: BeautifulSoup, url: str) -> dict:
    """Extract rating and review count from HTML soup."""
    result = {"rating": None, "review_count": 0, "snippet": ""}

    # Look for Google Reviews widgets (common patterns)
    # Pattern 1: star-rating with structured data
    rating_elem = soup.find(attrs={"itemprop": "ratingValue"}) or soup.find(attrs={"data-rating": True})
    if rating_elem:
        rating_val = rating_elem.get("content") or rating_elem.get("data-rating") or rating_elem.text
        try:
            result["rating"] = float(re.search(r'[\d.]+', rating_val).group())
        except (ValueError, AttributeError):
            pass

    # Pattern 2: review count from structured data or text
    count_elem = soup.find(attrs={"itemprop": "ratingCount"}) or soup.find(string=re.compile(r'(?:\d+)\s*(?:reviews?|ratings?)', re.I))
    if count_elem:
        text = count_elem.get_text() if hasattr(count_elem, 'get_text') else str(count_elem)
        count_match = re.search(r'(\d+)\s*(?:reviews?|ratings?)', text, re.I)
        if count_match:
            result["review_count"] = int(count_match.group(1))

    # Pattern 3: Facebook reviews iframe
    fb_frame = soup.find("iframe", src=re.compile(r'facebook\.com/(?:plugins/page\.php|rating'))
    if fb_frame:
        result["snippet"] = f"Facebook reviews widget found at {url}"

    # Pattern 4: JSON-LD structured data
    json_ld = soup.find("script", type="application/ld+json")
    if json_ld:
        try:
            import json as _json
            data = _json.loads(json_ld.string)
            if isinstance(data, dict):
                # AggregateRating
                if "aggregateRating" in data:
                    agg = data["aggregateRating"]
                    if "ratingValue" in agg:
                        result["rating"] = float(agg["ratingValue"])
                    if "ratingCount" in agg:
                        result["review_count"] = int(agg["ratingCount"])
                    result["snippet"] = f"JSON-LD aggregate rating: {result['rating']}/5 from {result['review_count']} reviews"
        except (ValueError, TypeError):
            pass

    return result


def _scrape_google_maps(company_name: str, address: str = "") -> dict | None:
    """Scrape Google Maps for review data (simulated — real impl uses browser_automation).

    For now, returns None if no API key — browser automation path handles this.
    """
    # Google Maps scraping typically requires browser automation to handle JavaScript
    # The CloudflareComputerAgent can do this, but for the API-only path we skip it
    return None


def _scrape_google_search(company_name: str) -> dict | None:
    """Search Google for review snippets.

    Looks for review snippets in search results for "{company_name} reviews".
    """
    try:
        # Use DuckDuckGo to avoid Google's JS requirements
        url = f"https://html.duckduckgo.com/html/?q={company_name.replace(' ', '+')}+reviews"
        resp = httpx.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code != 200:
            return None

        soup = BeautifulSoup(resp.text, "html.parser")

        result = {"rating": None, "review_count": 0, "snippet": ""}

        # Look for star rating patterns in search results
        rating_match = re.search(r'(\d\.\d)\s*(?:stars?|out of 5)', resp.text, re.I)
        if rating_match:
            result["rating"] = float(rating_match.group(1))

        # Look for review count
        count_match = re.search(r'(\d{2,4})\s*(?:reviews?|ratings?)', resp.text, re.I)
        if count_match:
            result["review_count"] = int(count_match.group(1))

        result["snippet"] = f"Found rating {result['rating']} from {result['review_count']} reviews (via search)"
        return result
    except Exception:
        return None


def calculate_review_score(review_data: dict) -> int:
    """Calculate hot-lead score bonus from review data.

    Scoring matches coaihq.online Lead Engine v2:
    - Rating < 3.5 stars: +25 points
    - No rating at all: +20 points
    - Fewer than 10 reviews: +15 points
    - Zero reviews: +10 points

    Args:
        review_data: Dict from get_review_data().

    Returns:
        Bonus points (0, 15, 20, or 25).
    """
    score = 0

    if not review_data.get("has_rating", False):
        # No rating found at all
        score += 20
    elif review_data.get("rating") is not None and review_data["rating"] < 3.5:
        # Low rating
        score += 25
    elif review_data.get("rating") is None:
        score += 20

    # Review count signals
    count = review_data.get("review_count", 0)
    if count == 0:
        # If we found the business but no reviews
        if review_data.get("sources"):
            score += 10
    elif count < 10:
        score += 15

    return min(score, 40)


def enrich_leads_with_reviews(leads: list[dict]) -> list[dict]:
    """Add review data and scoring to a list of leads.

    Args:
        leads: List of lead dicts from discovery.

    Returns:
        Same list with 'rating', 'review_count', 'review_bonus', 'review_sources' added.
    """
    for lead in leads:
        review_data = get_review_data(lead)
        lead["rating"] = review_data.get("rating")
        lead["review_count"] = review_data.get("review_count", 0)
        lead["review_sources"] = review_data.get("sources", [])
        lead["review_bonus"] = calculate_review_score(review_data)

        # Add review bonus to hot_lead_score
        lead["hot_lead_score"] = lead.get("hot_lead_score", 0) + lead["review_bonus"]

    return leads
