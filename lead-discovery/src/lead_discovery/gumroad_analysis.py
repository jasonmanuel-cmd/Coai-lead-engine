"""Gumroad competitor analysis skill for the prime-agent.

Scrapes competitor Gumroad product listings to extract:
- Pricing tiers (tiers, discounts, bundles)
- Product descriptions and features
- Review counts and ratings
- Sales page structure (titles, testimonials, CTAs)

Products monitored: KasiStock, FeeScout, LeadShield
"""

import httpx
import re
import json
from bs4 import BeautifulSoup

# Competitor Gumroad products to monitor (based on memory: KasiStock $79/$149, FeeScout $49, LeadShield $19/$69)
COMPETITOR_PRODUCTS = {
    "KasiStock": {
        "url": "https://kasistock.gumroad.com",
        "pricing_known": "$79/$149",
        "category": "stock",
    },
    "FeeScout": {
        "url": "https://feescout.gumroad.com",
        "pricing_known": "$49",
        "category": "web3",
    },
    "LeadShield": {
        "url": "https://leadshield.gumroad.com",
        "pricing_known": "$19/$69",
        "category": "saas",
    },
}


def analyze_competitor(url: str) -> dict:
    """Analyze a single Gumroad competitor product page.

    Args:
        url: Gumroad product URL (e.g., https://feescout.gumroad.com)

    Returns:
        Dict with: product_name, pricing, description, features, testimonials,
                   review_count, review_score, cta_text, upsells, page_structure
    """
    result = {
        "url": url,
        "product_name": "",
        "pricing": [],
        "description": "",
        "features": [],
        "testimonials": [],
        "review_count": 0,
        "review_score": None,
        "cta_text": "",
        "upsells": [],
        "page_structure": [],
        "error": None,
    }

    try:
        resp = httpx.get(url, timeout=30, follow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        if resp.status_code != 200:
            result["error"] = f"HTTP {resp.status_code}"
            return result

        soup = BeautifulSoup(resp.text, "html.parser")

        # Extract product name
        title_elem = soup.find("h1") or soup.find(attrs={"data-testid": "product-title"})
        if title_elem:
            result["product_name"] = title_elem.get_text(strip=True)
        else:
            # Fallback: use domain name
            result["product_name"] = url.split("//")[-1].split(".")[0]

        # Extract pricing tiers
        price_elements = soup.find_all(string=re.compile(r'\$[\d,]+(\.?\d*)', re.I))
        prices = set()
        for elem in price_elements:
            matches = re.findall(r'\$([\d,]+(?:\.\d+)?)', elem)
            for m in matches:
                prices.add(m)
        result["pricing"] = sorted([f"${p}" for p in prices])

        # Extract description
        desc_elem = soup.find(attrs={"data-testid": "product-description"}) or soup.find(class_=re.compile(r'description|product-desc', re.I))
        if desc_elem:
            result["description"] = desc_elem.get_text(strip=True)[:500]

        # Extract testimonials
        testimonial_elems = soup.find_all(class_=re.compile(r'testimonial|review|quote', re.I))
        result["testimonials"] = [t.get_text(strip=True)[:200] for t in testimonial_elems[:5]]

        # Extract review count and score
        review_elem = soup.find(string=re.compile(r'\d+\s*(?:ratings?|reviews?)', re.I))
        if review_elem:
            count_match = re.search(r'(\d+)\s*(?:ratings?|reviews?)', review_elem, re.I)
            if count_match:
                result["review_count"] = int(count_match.group(1))

        # Extract star rating
        stars = re.findall(r'(\d\.\d)/5', resp.text)
        if stars:
            result["review_score"] = float(stars[0])

        # Extract CTA buttons
        ctas = soup.find_all("button", string=re.compile(r'Get|Buy|Purchase|Checkout', re.I))
        if ctas:
            result["cta_text"] = ctas[0].get_text(strip=True)

        # Extract page structure (for comparison)
        for elem in soup.find_all(["h1", "h2", "h3", "p", "button"]):
            text = elem.get_text(strip=True)
            if text and len(text) < 100:
                result["page_structure"].append({
                    "tag": elem.name,
                    "text": text[:50],
                })

    except Exception as e:
        result["error"] = str(e)

    return result


def analyze_all_competitors() -> list[dict]:
    """Analyze all monitored competitor products."""
    results = []
    for name, info in COMPETITOR_PRODUCTS.items():
        result = analyze_competitor(info["url"])
        result["competitor_name"] = name
        result["known_pricing"] = info["pricing_known"]
        result["category"] = info["category"]
        results.append(result)

        # Also check if pricing matches known values
        if result["pricing"] and result["known_pricing"]:
            result["pricing_match"] = result["pricing"] == sorted(result["known_pricing"].replace("/", " ").split())
    return results


def generate_pricing_report() -> str:
    """Generate a competitive pricing analysis report."""
    results = analyze_all_competitors()

    report = [
        "GUMROAD COMPETITOR PRICING REPORT",
        "=" * 60,
        "",
    ]

    for r in results:
        report.append(f"  {r['competitor_name']} ({r['category']})")
        report.append(f"    URL: {r['url']}")
        report.append(f"    Known pricing: {r['known_pricing']}")
        report.append(f"    Scraped pricing: {r['pricing'] or 'N/A'}")
        report.append(f"    Reviews: {r['review_count']} ({r['review_score']}/5 stars)")
        report.append(f"    CTA: {r['cta_text'] or 'N/A'}")
        if r['testimonials']:
            report.append(f"    Testimonials: {len(r['testimonials'])} found")
        if r.get('pricing') and r.get('known_pricing'):
            match = "✓ MATCH" if r.get('pricing_match') else "✗ DIFFERENT"
            report.append(f"    Pricing match: {match}")
        report.append("")

    return "\n".join(report)
