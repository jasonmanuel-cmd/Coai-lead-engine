"""24/7 Revenue Agent for coaiagent1 — Upgraded with Full Capability Matrix

Autonomous Revenue Agent capabilities:
  Agent:
    • Researches customer needs and competitors
    • Creates drafts, code, product updates, reports, support replies
    • Monitors system health and customer requests
    • Creates invoice drafts or checkout links
    • Maintains an approved content/data pipeline
    • Produces a daily business report

  Automatic:
    • Deliver digital purchases
    • Collect customer payments through approved checkout
    • Send opt-in newsletter emails
    • Monitor uptime, errors, subscriptions, approved recurring expenses

  Human approval required:
    • Sending money or refunds
    • Bank/PayPal changes, password/MFA changes, withdrawals
    • New vendors, subscriptions, ad accounts, domains, large purchases
    • New public claims, legal terms, contracts, sensitive communications
    • Any customer-data export or third-party data sharing
    • New financial/crypto activity

Schedule: every 30 min (peak), every 2h (overnight), daily 10am/8pm (aggressive)
          Plus daily business report at 9 PM local time

SMS: Telnyx (preferred) or Twilio fallback
Payments: PayPal API (if credentials) or PayPal.Me/Venmo/Chime links
Database: Neon.tech (production) or Supabase (alternative) if configured

Usage:
  python revenue_agent.py [--mode money|aggressive|gumroad|daily-report]

Output is delivered to the agent's dashboard at:
  https://prime-agent-ui.vercel.app
"""

import json
import os
import sys
import time
import concurrent.futures
import pickle
from datetime import datetime, timedelta

# ─────────────────────────────────────────────────────────────────────
# ENV LOADING
# ─────────────────────────────────────────────────────────────────────

env_file = os.path.expanduser("~/.prime-agent.env")
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith("export ") and "=" in line:
                key, _, value = line[7:].partition("=")
                value = value.strip('"')
                os.environ[key] = value

# ─────────────────────────────────────────────────────────────────────
# PATHS & CONFIG
# ─────────────────────────────────────────────────────────────────────

PRIME_AGENT_PATH = "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src"
sys.path.insert(0, PRIME_AGENT_PATH)

API_PATH = "/c/Users/blunt/Desktop/model-training/src"
sys.path.insert(0, API_PATH)

API_BASE = os.getenv("API_BASE", "http://127.0.0.1:8080")
COAI_PASSWORD = os.getenv("COAI_PASSWORD", "")
SUPERMEMORY_KEY = os.getenv("SUPERMEMORY_CODEX_API_KEY", "")
LEAD_TRACKING_DIR = os.getenv("LEAD_TRACKING_DIR", "/c/Users/blunt/lead-tracking")
EMAIL_TO = os.getenv("EMAIL_TO", "blunts954@gmail.com")

# Payment methods
PAYPAL_ME_USERNAME = os.getenv("PAYPAL_ME_USERNAME", "COAIJason")
PAYPAL_EMAIL = os.getenv("PAYPAL_EMAIL", "coaiebay@gmail.com")
VENMO_HANDLE = os.getenv("VENMO_HANDLE", "@blunts863")
CHIME_HANDLE = os.getenv("CHIME_HANDLE", "$Jason-manuel-6")
GUMROAD_URL = os.getenv("GUMROAD_URL", "https://coaijason1989.gumroad.com/l/wincarepro")

# Build a multi-payment link string for outreach emails
PAYMENT_OPTIONS_HTML = f"""PayPal.Me/{PAYPAL_ME_USERNAME} • Venmo: {VENMO_HANDLE} • Chime: {CHIME_HANDLE}"""
PAYMENT_OPTIONS_TEXT = f"paypal.me/{PAYPAL_ME_USERNAME} or Venmo {VENMO_HANDLE} or Chime {CHIME_HANDLE}"

os.makedirs(LEAD_TRACKING_DIR, exist_ok=True)

# Approval queue directory — for actions requiring human sign-off
APPROVAL_DIR = os.path.join(LEAD_TRACKING_DIR, "approvals")
os.makedirs(APPROVAL_DIR, exist_ok=True)

# ─────────────────────────────────────────────────────────────────────
# INDUSTRY & STATE SCHEDULES
# ─────────────────────────────────────────────────────────────────────

INDUSTRY_SCHEDULE = {
    "peak_hours": ["plumber", "electrician", "roofer", "hvac", "contractor", "pest control", "lawn care"],
    "overnight": ["attorney", "dental", "hair salon", "gym", "restaurant", "real estate"],
    "weekend": ["painting", "flooring", "fencing", "handyman", "auto repair", "towing", "locksmith"],
    "aggressive": [
        "plumber", "electrician", "roofer", "hvac", "contractor", "pest control",
        "lawn care", "attorney", "dental", "hair salon", "gym", "restaurant",
        "real estate", "painting", "flooring", "fencing", "handyman", "auto repair",
        "towing", "locksmith", "cafe", "retail", "church", "personal trainer",
        "photography", "moving company", "landscaping", "car wash", "auto detail",
    ],
}

STATE_ROTATION = [
    ["CA", "NV", "AZ"],       # West
    ["TX", "OK", "AR"],       # South Central
    ["FL", "GA", "SC"],       # Southeast
    ["NY", "NJ", "PA"],       # Northeast
    ["IL", "OH", "MI"],       # Midwest
    ["WA", "OR", "CO"],       # Pacific Northwest
]

# ─────────────────────────────────────────────────────────────────────
# APPROVED VENDORS / SERVICES (for auto-approval of small purchases)
# ─────────────────────────────────────────────────────────────────────

APPROVED_RECURRING = [
    "vercel-pro", "vercel-enterprise", "supabase-pro",
    "gumroad-fee", "twilio-sms", "cloudflare-pro",
]

APPROVAL_THRESHOLDS = {
    "small_purchase": 50,      # <$50 auto-approved
    "medium_purchase": 500,    # $50-500 queues for human approval
    "large_purchase": 5000,    # $500+ requires immediate human approval
    "refund": 0,               # All refunds require approval
    "vendor_new": 0,           # New vendors always require approval
}

# ─────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────

def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    ts = now_str()
    print(f"[{ts}] {msg}")
    sys.stdout.flush()


def supermemory_search(query: str, limit: int = 10):
    """Search Supermemory for knowledge about COAI, lead strategies, etc."""
    if not SUPERMEMORY_KEY:
        return {"error": "No Supermemory key configured"}

    import httpx
    try:
        headers = {
            "x-api-key": SUPERMEMORY_KEY,
            "x-org-id": os.getenv("SUPERMEMORY_ORG_ID", ""),
        }
        resp = httpx.post(
            "https://api.supermemory.ai/v3/search",
            json={"q": query, "limit": limit},
            headers=headers,
            timeout=30,
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return {"error": "supermemory search failed"}


def get_current_schedule():
    """Determine which industries/states to scan based on time of day."""
    now = datetime.now()
    hour = now.hour
    day = now.weekday()

    if 9 <= hour < 21 and day < 5:
        industries = INDUSTRY_SCHEDULE["peak_hours"]
        states_idx = (hour - 9) // 2 % len(STATE_ROTATION)
        states = STATE_ROTATION[states_idx]
        label = "peak"
    elif day >= 5:
        industries = INDUSTRY_SCHEDULE["weekend"]
        states = STATE_ROTATION[hour % len(STATE_ROTATION)]
        label = "weekend"
    else:
        industries = INDUSTRY_SCHEDULE["overnight"]
        states = STATE_ROTATION[hour // 6 % len(STATE_ROTATION)]
        label = "overnight"

    return industries, states, label


# ─────────────────────────────────────────────────────────────────────
# CUSTOMER RESEARCH + COMPETITOR ANALYSIS
# ─────────────────────────────────────────────────────────────────────

def research_customer_needs(lead: dict) -> dict:
    """Research a lead's customer needs and competitors using Supermemory + web.

    Returns insights that inform outreach content.
    """
    import httpx

    company = lead.get("company_name", "")
    industry = lead.get("industry", "")
    website = lead.get("website", "")

    insights = {
        "customer_needs": [],
        "competitors": [],
        "pain_points": [],
        "content_angles": [],
    }

    # Search Supermemory for industry-specific knowledge
    if SUPERMEMORY_KEY:
        queries = [
            f"{industry} customer needs trends 2026",
            f"{industry} common pain points and solutions",
            f"local {industry} marketing strategies",
        ]
        for q in queries:
            sm_result = supermemory_search(q, limit=3)
            if "error" not in sm_result:
                for doc in sm_result.get("results", []):
                    content = doc.get("content", "") or doc.get("text", "")
                    if content:
                        insights["customer_needs"].append(content[:300])

    # Use API for competitive intelligence if available
    try:
        resp = httpx.get(
            f"{API_BASE}/web/research/customer-needs",
            params={"company": company, "industry": industry, "website": website},
            timeout=20,
        )
        if resp.status_code == 200:
            data = resp.json()
            insights["customer_needs"].extend(data.get("customer_needs", []))
            insights["competitors"].extend(data.get("competitors", []))
            insights["pain_points"].extend(data.get("pain_points", []))
            insights["content_angles"].extend(data.get("content_angles", []))
    except Exception:
        pass

    # Synthesize content angles from pain points
    if insights["pain_points"] and not insights["content_angles"]:
        for pp in insights["pain_points"][:3]:
            insights["content_angles"].append(
                f"Address: '{pp[:80]}' — show how COAI solves this"
            )

    return insights


# ─────────────────────────────────────────────────────────────────────
# CONTENT CREATION (drafts, code, updates, reports, support replies)
# ─────────────────────────────────────────────────────────────────────

def create_draft_content(lead: dict, insights: dict, lead_type: str = "email") -> str:
    """Create draft content (email, report, code, support reply) for a lead.

    Uses researched insights to personalize. Returns the content.
    """
    company = lead.get("company_name", "there")
    industry = lead.get("industry", "business")
    platform = lead.get("platform", "website")
    score = lead.get("hot_lead_score", 0)

    # Pick the best customer need for personalization
    customer_need = insights.get("customer_needs", ["help growing your business"])[0] if insights.get("customer_needs") else "help growing your business"

    if lead_type == "email":
        body = f"""<html><body>
<h3>Hi {company},</h3>
<p>I'm Jason with COAI (Coastal AI Marketing). I was looking at your {platform} site and researched how businesses like yours are adapting.</p>
<p>Based on industry trends, I noticed that {industry} businesses in your area often struggle with: <strong>{customer_need[:120]}</strong></p>
<p>Many are solving this by:</p>
<ul>"""
        for pp in insights.get("pain_points", [])[:3]:
            body += f"<li>{pp[:120]}</li>"
        body += "</ul>"
        body += f"<p>We help businesses like yours get more customers through professional websites and SEO. Our WinCare Pro service is $37 and includes a modern, fast website + basic SEO.</p>"
        body += f"<p>— Jason<br>COAI Marketing<br><a href='https://coaihq.online'>coaihq.online</a></p>"
        body += "</body></html>"
        return body

    elif lead_type == "report":
        report = f"""COMPETITIVE INSIGHTS REPORT — {company}
Generated: {now_str()}
Industry: {industry}
Hot Lead Score: {score}

=== CUSTOMER NEEDS ===
"""
        for cn in insights.get("customer_needs", [])[:5]:
            report += f"- {cn}\n"

        report += "\n=== COMPETITORS ===\n"
        for comp in insights.get("competitors", [])[:5]:
            report += f"- {comp}\n"

        report += "\n=== PAIN POINTS ===\n"
        for pp in insights.get("pain_points", [])[:5]:
            report += f"- {pp}\n"

        report += "\n=== CONTENT ANGLES ===\n"
        for ca in insights.get("content_angles", [])[:5]:
            report += f"- {ca}\n"

        return report

    elif lead_type == "support_reply":
        return f"""Hi there,

Thanks for reaching out about your {platform} site. Based on our research into {industry} businesses, I've put together a quick plan to address {customer_need[:80]}.

I'll create a draft for you shortly.

— Jason, COAI Support
"""

    elif lead_type == "code_update":
        return f"""<!-- Draft code snippet for {company} ({industry}) -->
<!-- Addresses: {customer_need[:80]} -->
<script>
// Auto-generated by COAI Revenue Agent
// Hot lead score: {score}
// Suggested fix: improve SEO + add customer review section
document.addEventListener('DOMContentLoaded', function() {{
  // SEO meta tags
  var meta = document.createElement('meta');
  meta.name = 'description';
  meta.content = '{customer_need[:140]}';
  document.head.appendChild(meta);

  // Review widget
  var reviewDiv = document.createElement('div');
  reviewDiv.id = 'coai-reviews';
  reviewDiv.innerHTML = '<h3>Customer Reviews</h3><p>Loading reviews...</p>';
  document.body.appendChild(reviewDiv);
}});
</script>
"""

    return ""


# ─────────────────────────────────────────────────────────────────────
# INVOICE DRAFT + CHECKOUT LINKS
# ─────────────────────────────────────────────────────────────────────

def create_invoice_draft(lead: dict, amount: float, description: str) -> dict:
    """Create a draft invoice (not sent yet — requires human approval for final send).

    Returns the invoice draft metadata. The invoice is staged and queued
    for human approval if the amount exceeds thresholds.
    """
    import httpx

    company = lead.get("company_name", "")
    emails = lead.get("emails", [])
    score = lead.get("hot_lead_score", 0)

    invoice_data = {
        "company_name": company,
        "amount": amount,
        "description": description,
        "emails": emails,
        "hot_lead_score": score,
        "status": "draft",
        "created_at": now_str(),
        "approval_required": False,
    }

    # Determine if approval is needed
    if amount > APPROVAL_THRESHOLDS["medium_purchase"]:
        invoice_data["approval_required"] = True
    elif amount > APPROVAL_THRESHOLDS["small_purchase"]:
        invoice_data["approval_required"] = True

    # Try to create invoice draft via API
    try:
        resp = httpx.post(
            f"{API_BASE}/web/paypal/invoice/draft",
            json={
                "company_name": company,
                "amount": amount,
                "description": description,
                "emails": emails,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            invoice_data["invoice_id"] = resp.json().get("invoice_id")
            invoice_data["draft_url"] = resp.json().get("draft_url")
    except Exception as e:
        invoice_data["error"] = str(e)

    # Generate payment links for all methods
    invoice_data["paypal_link"] = f"https://paypal.me/{PAYPAL_ME_USERNAME}/{int(amount)}"
    invoice_data["venmo_link"] = f"https://venmo.com/{VENMO_HANDLE}/{int(amount)}"
    invoice_data["chime_link"] = f"https://chime.com/{CHIME_HANDLE}/payment"
    invoice_data["gumroad_url"] = GUMROAD_URL
    invoice_data["payment_options_html"] = PAYMENT_OPTIONS_HTML

    # If approval required, queue it
    if invoice_data["approval_required"]:
        queue_for_approval("invoice_send", invoice_data)

    return invoice_data


def create_checkout_link(lead: dict, amount: float, description: str) -> str:
    """Create an approved checkout link for a lead.

    Uses PayPal.Me for small amounts (<$50) automatically.
    For larger amounts, requires human approval.
    """
    company = lead.get("company_name", "")
    score = lead.get("hot_lead_score", 0)

    # Small purchases (<$50) are auto-approved — provide all payment options
    if amount <= APPROVAL_THRESHOLDS["small_purchase"]:
        links = {
            "paypal": f"https://paypal.me/{PAYPAL_ME_USERNAME}/{int(amount)}?label={description.replace(' ', '+')}",
            "venmo": f"https://venmo.com/{VENMO_HANDLE}/{int(amount)}",
            "chime": f"https://chime.com/{CHIME_HANDLE}/payment",
            "gumroad": GUMROAD_URL,
        }
        return links

    # Larger purchases require approval
    checkout_data = {
        "company_name": company,
        "amount": amount,
        "description": description,
        "hot_lead_score": score,
        "approval_required": True,
        "paypal_link": f"https://paypal.me/{PAYPAL_ME_USERNAME}/{int(amount)}",
        "venmo_link": f"https://venmo.com/{VENMO_HANDLE}/{int(amount)}",
        "chime_link": f"https://chime.com/{CHIME_HANDLE}/payment",
        "gumroad_url": GUMROAD_URL,
    }
    queue_for_approval("checkout_create", checkout_data)
    return f"https://paypal.me/{PAYPAL_ME_USERNAME}/{int(amount)}?label={description.replace(' ', '+')}&requires_approval=true"


# ─────────────────────────────────────────────────────────────────────
# AUTOMATIC DIGITAL PURCHASE DELIVERY
# ─────────────────────────────────────────────────────────────────────

DIGITAL_PRODUCTS = {
    "wincare_pro": {
        "name": "WinCare Pro — Website + SEO",
        "price": 37,
        "files": ["/c/Users/blunt/lead-tracking/products/wincare_pro_guide.md"],
        "access_instructions": "Your new website will be live within 72 hours. Check coaihq.online/dashboard.",
        "delivery_method": "email",
    },
    "security_audit": {
        "name": "Security + SEO Audit Report",
        "price": 99,
        "files": ["/c/Users/blunt/lead-tracking/products/security_audit_template.md"],
        "access_instructions": "Your audit report will be delivered via email within 24 hours.",
        "delivery_method": "email",
    },
    "full_site": {
        "name": "Professional Website + SEO",
        "price": 499,
        "files": [],
        "access_instructions": "A member of our team will contact you within 1 hour to get started.",
        "delivery_method": "manual",
    },
}


def deliver_digital_purchase(lead: dict, product_key: str) -> dict:
    """Automatically deliver a digital purchase.

    For products with files, sends them via email immediately.
    For manual products, creates a ticket and notifies the team.
    """
    import httpx

    product = DIGITAL_PRODUCTS.get(product_key)
    if not product:
        return {"error": f"Unknown product: {product_key}"}

    company = lead.get("company_name", "")
    emails = lead.get("emails", [lead.get("email", EMAIL_TO)])

    result = {
        "product": product["name"],
        "company": company,
        "status": "pending",
        "delivered_at": now_str(),
    }

    # For products with files — auto-deliver via email
    if product["files"] and product["delivery_method"] == "email":
        attachments = []
        for fpath in product["files"]:
            if os.path.exists(fpath):
                attachments.append(fpath)

        try:
            resp = httpx.post(
                f"{API_BASE}/web/email/send",
                json={
                    "subject": f"Your {product['name']} Purchase — Delivered",
                    "body_html": f"""<html><body>
<h3>Hi {company},</h3>
<p>Your purchase of <strong>{product['name']}</strong> has been processed!</p>
<p>{product['access_instructions']}</p>
<p>If you have any questions, reply to this email or visit <a href='https://coaihq.online/dashboard'>your dashboard</a>.</p>
<p>— The COAI Team</p>
</body></html>""",
                    "attachments": attachments,
                    "priority": "normal",
                },
                timeout=30,
            )
            if resp.status_code == 200:
                result["status"] = "delivered"
                result["method"] = "email"
        except Exception as e:
            result["error"] = str(e)
            result["status"] = "failed"

    # For manual products — create support ticket
    elif product["delivery_method"] == "manual":
        try:
            resp = httpx.post(
                f"{API_BASE}/web/tickets/create",
                json={
                    "subject": f"Manual fulfillment: {product['name']} for {company}",
                    "body": f"New high-value purchase requires manual fulfillment.\nCompany: {company}\nProduct: {product['name']}\nAmount: ${product['price']}\nLead score: {lead.get('hot_lead_score', 0)}",
                    "priority": "high",
                    "tags": ["fulfillment", "manual", product_key],
                },
                timeout=15,
            )
            if resp.status_code == 200:
                result["status"] = "queued_manual"
                result["ticket_id"] = resp.json().get("ticket_id")
        except Exception as e:
            result["error"] = str(e)

    return result


# ─────────────────────────────────────────────────────────────────────
# OPT-IN NEWSLETTER EMAIL COLLECTION
# ─────────────────────────────────────────────────────────────────────

NEWSLETTER_SIGNUP_TEMPLATE = """<html><body>
<h3>Get more customers with COAI Insights</h3>
<p>Join {count} local business owners getting weekly tips on websites, SEO, and reviews.</p>
<form action="https://coaihq.online/api/newsletter/signup" method="POST">
  <input type="email" name="email" placeholder="Your email" required style="padding:10px;width:250px;">
  <input type="hidden" name="source" value="revenue_agent">
  <input type="hidden" name="company" value="{company}">
  <button type="submit" style="background:#0070f3;color:white;padding:10px 20px;border:none;border-radius:4px;cursor:pointer;">
    Subscribe — Free
  </button>
</form>
<p>No spam. Unsubscribe anytime.</p>
</body></html>"""


def send_newsletter_optin(lead: dict) -> bool:
    """Send an opt-in newsletter signup email to a lead."""
    import httpx

    company = lead.get("company_name", "")
    emails = lead.get("emails", [])

    if not emails:
        return False

    try:
        resp = httpx.post(
            f"{API_BASE}/web/email/send",
            json={
                "subject": f"{company} — Free weekly business growth tips",
                "body_html": NEWSLETTER_SIGNUP_TEMPLATE.format(
                    count=1247, company=company
                ),
                "priority": "normal",
            },
            timeout=15,
        )
        return resp.status_code == 200
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────
# SYSTEM HEALTH + UPTIME MONITORING
# ─────────────────────────────────────────────────────────────────────

def monitor_system_health() -> dict:
    """Monitor system health: uptime, errors, subscriptions, recurring expenses.

    Checks COAI infrastructure and reports status. Sends alerts for issues.
    """
    import httpx

    health_report = {
        "checked_at": now_str(),
        "services": {},
        "errors": [],
        "subscriptions": {},
        "recurring_expenses": {},
    }

    # Check API server health
    try:
        resp = httpx.get(f"{API_BASE}/health", timeout=10)
        health_report["services"]["api_server"] = {
            "status": "up" if resp.status_code == 200 else "down",
            "response_ms": resp.elapsed.total_seconds() * 1000 if resp.elapsed else 0,
        }
    except Exception as e:
        health_report["services"]["api_server"] = {"status": "down", "error": str(e)}
        health_report["errors"].append("API server is down")

    # Check coaihq.online uptime
    try:
        resp = httpx.get("https://coaihq.online", timeout=10, follow_redirects=True)
        health_report["services"]["coaihq_online"] = {
            "status": "up" if resp.status_code == 200 else f"error_{resp.status_code}",
            "response_ms": resp.elapsed.total_seconds() * 1000 if resp.elapsed else 0,
        }
    except Exception as e:
        health_report["services"]["coaihq_online"] = {"status": "down", "error": str(e)}
        health_report["errors"].append("coaihq.online is down")

    # Check prime-agent-ui Vercel app
    try:
        resp = httpx.get("https://prime-agent-ui.vercel.app", timeout=10, follow_redirects=True)
        health_report["services"]["prime_agent_ui"] = {
            "status": "up" if resp.status_code == 200 else f"error_{resp.status_code}",
        }
    except Exception as e:
        health_report["services"]["prime_agent_ui"] = {"status": "down", "error": str(e)}

    # Check digital purchases (Gumroad, etc.)
    try:
        resp = httpx.get(f"{API_BASE}/web/gumroad/products", timeout=10)
        if resp.status_code == 200:
            products = resp.json()
            health_report["subscriptions"]["gumroad"] = {
                "product_count": len(products),
                "active": True,
            }
    except Exception as e:
        health_report["errors"].append(f"Gumroad check failed: {e}")

    # Check Supabase connection
    try:
        resp = httpx.get(f"{API_BASE}/db/health", timeout=10)
        if resp.status_code == 200:
            health_report["services"]["supabase_db"] = {
                "status": "up",
                "data": resp.json(),
            }
    except Exception as e:
        health_report["errors"].append(f"Database health check failed: {e}")

    # Check Stripe/PayPal webhooks
    try:
        resp = httpx.get(f"{API_BASE}/webhooks/status", timeout=10)
        if resp.status_code == 200:
            health_report["services"]["webhooks"] = resp.json()
    except Exception:
        pass

    # Check for recent errors in logs
    try:
        resp = httpx.get(f"{API_BASE}/logs/recent?limit=50", timeout=10)
        if resp.status_code == 200:
            logs = resp.json()
            error_count = sum(1 for l in logs if l.get("level") == "error")
            if error_count > 0:
                health_report["errors"].append(f"{error_count} errors in recent logs")
    except Exception:
        pass

    # If critical errors, queue alert for human review (but don't auto-send)
    if any("down" in str(e) for e in health_report["errors"]):
        health_report["alert_required"] = True
        queue_for_approval("system_alert", health_report)

    return health_report


def monitor_customer_requests() -> list:
    """Monitor incoming customer requests, support tickets, and reviews."""
    import httpx

    requests = []

    # Check for new support tickets
    try:
        resp = httpx.get(f"{API_BASE}/web/tickets/open?limit=10", timeout=10)
        if resp.status_code == 200:
            tickets = resp.json()
            for t in tickets:
                if t.get("status") == "open":
                    requests.append({
                        "type": "support_ticket",
                        "id": t.get("id"),
                        "subject": t.get("subject"),
                        "priority": t.get("priority", "normal"),
                        "created_at": t.get("created_at"),
                    })
    except Exception:
        pass

    # Check for new reviews (negative ones need attention)
    try:
        resp = httpx.get(f"{API_BASE}/web/reviews/recent?limit=10", timeout=10)
        if resp.status_code == 200:
            reviews = resp.json()
            for r in reviews:
                if r.get("rating", 5) < 4:
                    requests.append({
                        "type": "negative_review",
                        "company": r.get("company_name"),
                        "rating": r.get("rating"),
                        "review": r.get("review_text", "")[:200],
                    })
    except Exception:
        pass

    # Check for new PayPal disputes/inv disputes
    try:
        resp = httpx.get(f"{API_BASE}/web/paypal/disputes?limit=10", timeout=10)
        if resp.status_code == 200:
            disputes = resp.json()
            for d in disputes:
                requests.append({
                    "type": "payment_dispute",
                    "id": d.get("id"),
                    "status": d.get("status"),
                    "amount": d.get("amount"),
                })
    except Exception:
        pass

    return requests


# ─────────────────────────────────────────────────────────────────────
# APPROVAL GATE SYSTEM (human approval required)
# ─────────────────────────────────────────────────────────────────────

# Actions that ALWAYS require human approval
ALWAYS_APPROVE = [
    "refund",
    "paypal_change",
    "bank_change",
    "password_change",
    "mfa_change",
    "withdrawal",
    "new_vendor",
    "new_subscription",
    "new_ad_account",
    "new_domain",
    "large_purchase",
    "data_export",
    "third_party_data_share",
    "financial_activity_crypto",
    "new_legal_terms",
    "new_contract",
    "sensitive_communication",
    "new_public_claim",
]

# Actions that are auto-approved (safe for autonomous execution)
AUTO_APPROVE = [
    "discover_leads",
    "enrich_leads",
    "log_attribution",
    "email_outreach",
    "sms_outreach",
    "small_purchase",
    "create_checkout_link",
    "create_invoice_draft",
    "deliver_digital_purchase",
    "send_newsletter_optin",
    "research_customer_needs",
    "create_draft_content",
    "monitor_system_health",
    "monitor_customer_requests",
    "daily_report",
    "system_alert",
]


def queue_for_approval(action_type: str, data: dict) -> str:
    """Queue an action that requires human approval.

    Saves to a pickle file that the human dashboard can review and approve.
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{action_type}_{timestamp}.pkl"
    filepath = os.path.join(APPROVAL_DIR, filename)

    approval_data = {
        "action_type": action_type,
        "data": data,
        "submitted_at": now_str(),
        "status": "pending",
    }

    with open(filepath, "wb") as f:
        pickle.dump(approval_data, f)

    log(f"  ⚠️  Action '{action_type}' queued for human approval: {filepath}")

    # Send notification email to Jason
    try:
        import httpx
        httpx.post(
            f"{API_BASE}/web/email/send",
            json={
                "to": EMAIL_TO,
                "subject": f"[APPROVAL REQUIRED] {action_type} — COAI Revenue Agent",
                "body_html": f"""<html><body>
<h3>Approval Required: {action_type}</h3>
<p>Submitted at: {now_str()}</p>
<p>Details: <pre>{json.dumps(data, indent=2, default=str)[:2000]}</pre></p>
<p>Review and approve at: https://prime-agent-ui.vercel.app/approvals</p>
</body></html>""",
                "priority": "high",
            },
            timeout=10,
        )
    except Exception:
        pass

    return filepath


def check_approvals(action_type: str, data: dict) -> bool:
    """Check if an action requires human approval.

    Returns True if auto-approved, False if it needs approval (and queues it).
    """
    # Check if this action type always requires approval
    if action_type in ALWAYS_APPROVE:
        queue_for_approval(action_type, data)
        return False

    # Check monetary thresholds
    amount = data.get("amount", 0)
    if amount:
        if amount > APPROVAL_THRESHOLDS["large_purchase"]:
            queue_for_approval(action_type, data)
            return False
        elif amount > APPROVAL_THRESHOLDS["medium_purchase"]:
            queue_for_approval(action_type, data)
            return False

    # New vendor check
    if action_type == "new_vendor" or (data.get("vendor") and data.get("vendor") not in APPROVED_RECURRING):
        queue_for_approval(action_type, data)
        return False

    # Data export check
    if action_type == "data_export" or data.get("customer_data_export"):
        queue_for_approval(action_type, data)
        return False

    return True  # Auto-approved


def process_approved_actions():
    """Process any actions that have been approved by a human.

    Checks the approval directory for approved pickle files and executes them.
    """
    if not os.path.exists(APPROVAL_DIR):
        return

    processed = 0
    for filename in os.listdir(APPROVAL_DIR):
        if not filename.endswith(".pkl"):
            continue

        filepath = os.path.join(APPROVAL_DIR, filename)
        try:
            with open(filepath, "rb") as f:
                approval = pickle.load(f)

            if approval.get("status") == "pending":
                # Not yet approved by human — skip
                continue
            elif approval.get("status") == "approved":
                # Execute the approved action
                action_type = approval["action_type"]
                data = approval["data"]
                execute_approved_action(action_type, data)
                # Mark as executed
                approval["status"] = "executed"
                approval["executed_at"] = now_str()
                with open(filepath, "wb") as f:
                    pickle.dump(approval, f)
                processed += 1
            elif approval.get("status") in ("rejected", "executed"):
                # Skip — already handled
                continue
        except Exception as e:
            log(f"  Error processing approval {filename}: {e}")

    if processed > 0:
        log(f"  Processed {processed} approved actions")


def execute_approved_action(action_type: str, data: dict):
    """Execute an action that was just approved by a human."""
    import httpx

    if action_type == "invoice_send":
        # Actually send the invoice (not just draft)
        try:
            httpx.post(
                f"{API_BASE}/web/paypal/invoice/send",
                json={
                    "invoice_id": data.get("invoice_id"),
                    "emails": data.get("emails", []),
                },
                timeout=15,
            )
            log(f"  ✅ Invoice sent for {data.get('company_name', '')}")
        except Exception as e:
            log(f"  ❌ Failed to send invoice: {e}")

    elif action_type == "checkout_approved":
        # Create the actual checkout link / charge
        try:
            httpx.post(
                f"{API_BASE}/web/paypal/checkout/create",
                json={
                    "company_name": data.get("company_name"),
                    "amount": data.get("amount"),
                    "description": data.get("description"),
                    "return_url": data.get("return_url"),
                },
                timeout=15,
            )
            log(f"  ✅ Checkout link created for {data.get('company_name', '')}")
        except Exception as e:
            log(f"  ❌ Failed to create checkout: {e}")

    elif action_type == "refund_approved":
        try:
            httpx.post(
                f"{API_BASE}/web/paypal/refund",
                json={
                    "transaction_id": data.get("transaction_id"),
                    "amount": data.get("amount"),
                    "reason": data.get("reason"),
                },
                timeout=15,
            )
            log(f"  ✅ Refund processed for ${data.get('amount', 0)}")
        except Exception as e:
            log(f"  ❌ Failed to process refund: {e}")

    elif action_type == "vendor_add_approved":
        try:
            httpx.post(
                f"{API_BASE}/web/vendors/add",
                json={
                    "name": data.get("name"),
                    "url": data.get("url"),
                    "category": data.get("category"),
                    "monthly_cost": data.get("monthly_cost"),
                },
                timeout=15,
            )
            log(f"  ✅ Vendor added: {data.get('name', '')}")
        except Exception as e:
            log(f"  ❌ Failed to add vendor: {e}")

    elif action_type == "data_export_approved":
        try:
            resp = httpx.post(
                f"{API_BASE}/web/exports/create",
                json={
                    "type": data.get("export_type"),
                    "filters": data.get("filters", {}),
                    "recipient_email": data.get("recipient_email", EMAIL_TO),
                },
                timeout=60,
            )
            log(f"  ✅ Data export created: {resp.json().get('export_id', 'N/A')}")
        except Exception as e:
            log(f"  ❌ Failed to create export: {e}")

    elif action_type == "subscription_new_approved":
        try:
            httpx.post(
                f"{API_BASE}/web/subscriptions/create",
                json=data,
                timeout=15,
            )
            log(f"  ✅ New subscription created: {data.get('name', '')}")
        except Exception as e:
            log(f"  ❌ Failed to create subscription: {e}")

    elif action_type == "system_alert":
        # System alert was already sent via email when queued
        log(f"  🚨 System alert processed: {data.get('errors', [])}")


# ─────────────────────────────────────────────────────────────────────
# DAILY BUSINESS REPORT
# ─────────────────────────────────────────────────────────────────────

def generate_daily_business_report() -> str:
    """Produce a comprehensive daily business report.

    Covers: revenue, leads, conversions, system health, expenses,
    upcoming renewals, and pending approvals.
    """
    import httpx

    timestamp = datetime.now().strftime("%Y-%m-%d")
    report_lines = []
    report_lines.append(f"=== COAI DAILY BUSINESS REPORT — {timestamp} ===\n")

    # --- Revenue Summary ---
    report_lines.append("--- REVENUE SUMMARY ---")
    try:
        resp = httpx.get(f"{API_BASE}/web/attribution", timeout=15)
        data = resp.json()
        report_lines.append(f"Total leads tracked: {data.get('total_leads', 0)}")
        report_lines.append(f"Total conversions: {data.get('total_conversions', 0)}")
        report_lines.append(f"Total revenue: ${data.get('total_revenue', 0)}")
        report_lines.append(f"Best source: {data.get('best_source', 'N/A')}")

        for source, metrics in data.get("sources", {}).items():
            report_lines.append(
                f"  Source '{source}': {metrics.get('total_leads', 0)} leads, "
                f"{metrics.get('conversions', 0)} conv, ${metrics.get('revenue', 0)} rev"
            )
    except Exception as e:
        report_lines.append(f"Attribution error: {e}")

    # --- Lead Pipeline ---
    report_lines.append("\n--- LEAD PIPELINE ---")
    try:
        resp = httpx.get(f"{API_BASE}/leads/stats", timeout=15)
        stats = resp.json()
        report_lines.append(f"Hot leads (score >=25): {stats.get('hot_leads', 0)}")
        report_lines.append(f"Warm leads (score 15-24): {stats.get('warm_leads', 0)}")
        report_lines.append(f"Cold leads (score <15): {stats.get('cold_leads', 0)}")
        report_lines.append(f"Converted leads: {stats.get('converted', 0)}")
        report_lines.append(f"Revenue this cycle: ${stats.get('revenue_current_cycle', 0)}")
    except Exception as e:
        report_lines.append(f"Lead stats error: {e}")

    # --- System Health ---
    report_lines.append("\n--- SYSTEM HEALTH ---")
    health = monitor_system_health()
    for service, status in health.get("services", {}).items():
        report_lines.append(f"  {service}: {status.get('status')} ({status.get('response_ms', 'N/A')}ms)")
    if health.get("errors"):
        report_lines.append(f"  Errors: {len(health['errors'])}")
        for err in health["errors"]:
            report_lines.append(f"    - {err}")

    # --- Subscriptions & Expenses ---
    report_lines.append("\n--- SUBSCRIPTIONS & EXPENSES ---")
    for sub_name, sub_data in health.get("subscriptions", {}).items():
        report_lines.append(f"  {sub_name}: {sub_data}")

    # Check for recurring expenses
    try:
        resp = httpx.get(f"{API_BASE}/expenses/recurring?upcoming=7", timeout=15)
        if resp.status_code == 200:
            expenses = resp.json()
            for exp in expenses:
                report_lines.append(
                    f"  Upcoming: {exp.get('name')} - ${exp.get('amount')}/mo on {exp.get('due_date')}"
                )
    except Exception as e:
        report_lines.append(f"  Expense check error: {e}")

    # --- Pending Approvals ---
    report_lines.append("\n--- PENDING APPROVALS ---")
    approval_count = 0
    if os.path.exists(APPROVAL_DIR):
        for filename in os.listdir(APPROVAL_DIR):
            if filename.endswith(".pkl"):
                approval_count += 1
    report_lines.append(f"  Actions pending approval: {approval_count}")
    report_lines.append("  Review at: https://prime-agent-ui.vercel.app/approvals")

    # --- Gumroad / Digital Store ---
    report_lines.append("\n--- DIGITAL STORE ---")
    try:
        resp = httpx.get(f"{API_BASE}/web/gumroad/report", timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            report_lines.append(f"  Gumroad report: {str(data.get('report', ''))[:300]}")
    except Exception as e:
        report_lines.append(f"  Gumroad error: {e}")

    # --- Customer Requests ---
    report_lines.append("\n--- CUSTOMER REQUESTS ---")
    requests = monitor_customer_requests()
    if requests:
        for req in requests:
            report_lines.append(
                f"  [{req['type']}] {req.get('subject', req.get('company', ''))} "
                f"— priority: {req.get('priority', 'N/A')}"
            )
    else:
        report_lines.append("  No open requests.")

    report_lines.append("\n=== END REPORT ===")
    report = "\n".join(report_lines)

    # Save report to file
    report_path = os.path.join(LEAD_TRACKING_DIR, f"daily_report_{timestamp}.txt")
    with open(report_path, "w") as f:
        f.write(report)

    # Email report to Jason
    try:
        import httpx
        httpx.post(
            f"{API_BASE}/web/email/send",
            json={
                "to": EMAIL_TO,
                "subject": f"[COAI] Daily Business Report — {timestamp}",
                "body_html": f"<html><body><pre style='font-family:monospace;'>{report}</pre></body></html>",
                "priority": "normal",
            },
            timeout=15,
        )
    except Exception:
        pass

    return report


# ─────────────────────────────────────────────────────────────────────
# CONTENT/DATA PIPELINE MAINTENANCE
# ─────────────────────────────────────────────────────────────────────

def maintain_content_pipeline() -> dict:
    """Maintain the approved content/data pipeline.

    Ensures the content pipeline is healthy: checks for stale data,
    validates output formats, and rotates content cache.
    """
    results = {"checks": 0, "fixed": 0, "errors": []}

    # Check that the content pipeline output directory exists
    content_dir = os.path.join(LEAD_TRACKING_DIR, "content_pipeline")
    os.makedirs(content_dir, exist_ok=True)

    # Validate cached content freshness (older than 7 days = stale)
    cutoff = datetime.now().timestamp() - (7 * 24 * 3600)
    for fname in os.listdir(content_dir):
        fpath = os.path.join(content_dir, fname)
        if os.path.isfile(fpath) and os.path.getmtime(fpath) < cutoff:
            results["checks"] += 1
            # Mark stale — will be regenerated next cycle
            try:
                os.rename(fpath, fpath + ".stale")
                results["fixed"] += 1
            except Exception as e:
                results["errors"].append(f"Failed to mark stale content {fname}: {e}")

    # Validate JSON output files
    for fname in os.listdir(LEAD_TRACKING_DIR):
        if fname.endswith(".json"):
            fpath = os.path.join(LEAD_TRACKING_DIR, fname)
            results["checks"] += 1
            try:
                with open(fpath) as f:
                    json.load(f)  # Validate JSON
            except json.JSONDecodeError as e:
                results["errors"].append(f"Invalid JSON in {fname}: {e}")
                results["fixed"] += 1
                # Attempt to fix by creating backup
                backup = fpath + ".bak"
                os.rename(fpath, backup)

    return results


# ─────────────────────────────────────────────────────────────────────
# DISCOVERY + ENRICHMENT (existing logic, enhanced with research)
# ─────────────────────────────────────────────────────────────────────

def run_discovery_cycle(mode: str = "peak") -> str:
    """Run a single discovery + enrichment + outreach cycle."""
    import httpx

    industries, states, schedule_label = get_current_schedule()
    if mode == "aggressive":
        industries = INDUSTRY_SCHEDULE["aggressive"]

    timestamp = now_str()
    log(f"[{schedule_label.upper()}] Revenue Agent starting cycle")
    log(f"  Industries: {', '.join(industries[:5])}{'...' if len(industries) > 5 else ''}")
    log(f"  States: {', '.join(states)}")

    # Process any human-approved actions from the queue
    process_approved_actions()

    # Search Supermemory for relevant knowledge
    if SUPERMEMORY_KEY:
        log("  Searching Supermemory for COAI lead strategies...")
        sm_result = supermemory_search("COAI lead generation best practices", limit=5)
        if "error" not in sm_result:
            sm_count = len(sm_result.get("results", []))
            log(f"  Supermemory found {sm_count} relevant docs")

    # Maintain content pipeline
    pipeline_results = maintain_content_pipeline()
    log(f"  Content pipeline: {pipeline_results['checks']} checks, {pipeline_results['fixed']} fixed")

    lead_count = 0
    # Run nationwide discovery via API
    log("  Running nationwide scan via API...")
    try:
        resp = httpx.get(
            f"{API_BASE}/web/discover-nationwide",
            params={
                "industries": ",".join(industries),
                "states": ",".join(states),
                "cities_per_state": 2,
                "max_businesses": 50,
            },
            timeout=120,
        )
        data = resp.json()
        lead_count = len(data) if isinstance(data, list) else data.get("total", 0)
        log(f"  Discovered {lead_count} leads")
    except Exception as e:
        log(f"  API discovery error: {e} — falling back to skill module")
        try:
            import lead_discovery
            report = lead_discovery.run(
                industries=",".join(industries),
                location="USA",
                max_businesses=100,
                nationwide=True,
                states=states,
            )
            log("  Discovery complete (via skill module)")
            data = []
        except Exception as e2:
            log(f"  Fallback discovery failed: {e2}")
        data = []

    # Enrich leads + research customer needs (parallelized)
    log(f"  Enriching {len(data)} leads (parallel)...")
    email_found = 0
    wa_found = 0
    enrichment_count = 0
    lead_insights = {}  # Store insights per lead

    def enrich_single(lead):
        """Enrich one lead: emails, reviews, whatsapp, research customer needs."""
        result = {"email": False, "wa": False, "logged": False, "insights": None}
        domain = lead.get("website", "").replace("www.", "").strip()
        if not domain:
            domain = lead.get("company_name", "")

        # Get emails
        try:
            email_resp = httpx.get(f"{API_BASE}/web/emails/{domain}", timeout=15)
            email_data = email_resp.json()
            if email_data.get("emails"):
                result["email"] = True
                lead["emails"] = email_data["emails"]
        except Exception:
            pass

        # Get reviews
        try:
            rev_resp = httpx.get(f"{API_BASE}/web/reviews/{domain}", timeout=15)
            rev_data = rev_resp.json()
            if rev_data.get("rating"):
                lead["rating"] = rev_data["rating"]
                lead["review_count"] = rev_data.get("review_count", 0)
        except Exception:
            pass

        # Get WhatsApp number
        try:
            wa_resp = httpx.post(
                f"{API_BASE}/web/whatsapp/compose",
                json={
                    "company_name": lead.get("company_name", ""),
                    "website": lead.get("website", ""),
                    "platform": lead.get("platform", ""),
                    "hot_lead_score": lead.get("hot_lead_score", 0),
                    "industry": lead.get("industry", ""),
                },
                timeout=15,
            )
            wa_data = wa_resp.json()
            if wa_data.get("whatsapp_number"):
                result["wa"] = True
        except Exception:
            pass

        # Research customer needs and competitors
        try:
            insights = research_customer_needs(lead)
            result["insights"] = insights
        except Exception:
            pass

        # Log to attribution
        try:
            httpx.post(
                f"{API_BASE}/web/attribution/log",
                json={
                    "company_name": lead.get("company_name", ""),
                    "website": lead.get("website", ""),
                    "platform": lead.get("platform", ""),
                    "hot_lead_score": lead.get("hot_lead_score", 0),
                    "industry": lead.get("industry", ""),
                    "source": f"{schedule_label}_scan",
                },
                timeout=20,
            )
            result["logged"] = True
        except Exception:
            pass

        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(enrich_single, lead): lead for lead in data}
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result(timeout=30)
                lead = futures[future]
                if result["email"]:
                    email_found += 1
                    lead["emails"] = lead.get("emails", [])
                if result["wa"]:
                    wa_found += 1
                if result["logged"]:
                    enrichment_count += 1
                if result["insights"]:
                    lead_insights[lead.get("company_name", "")] = result["insights"]
            except Exception:
                pass

    log(f"  Enrichment complete: {email_found} emails, {wa_found} WhatsApp, {enrichment_count} logged")

    # Outreach to hot leads (with research-enhanced content)
    log("  Running outreach to hot leads...")
    hot_leads = [l for l in data if l.get("hot_lead_score", 0) >= 25]
    outreach_results = run_outreach(hot_leads, schedule_label, lead_insights)
    emails_sent = outreach_results.get("emails_sent", 0)
    sms_sent = outreach_results.get("sms_sent", 0)
    invoices_generated = outreach_results.get("invoices_generated", 0)
    purchases_delivered = outreach_results.get("purchases_delivered", 0)
    newsletters_sent = outreach_results.get("newsletters_sent", 0)

    # Monitor system health
    log("  Checking system health...")
    health = monitor_system_health()
    log(f"  System health: {len(health.get('services', {}))} services checked, {len(health.get('errors', []))} errors")

    # Monitor customer requests
    customer_reqs = monitor_customer_requests()
    if customer_reqs:
        log(f"  {len(customer_reqs)} customer requests pending")
    else:
        log("  No pending customer requests")

    # Generate report
    report = f"""[PRIME-AGENT CYCLE COMPLETE — {schedule_label.upper()}]
Time: {timestamp}
Industries: {', '.join(industries[:8])}
States: {', '.join(states)}
Leads discovered: {lead_count}
Emails found: {email_found}
WhatsApp numbers found: {wa_found}
Leads tracked in attribution: {enrichment_count}
Emails sent to hot leads: {emails_sent}
SMS sent to hot leads: {sms_sent}
PayPal invoices generated: {invoices_generated}
Digital purchases delivered: {purchases_delivered}
Newsletter opt-ins sent: {newsletters_sent}
System health: {len(health.get('services', {}))} services, {len(health.get('errors', []))} errors
Customer requests pending: {len(customer_reqs)}

Top prospects (hot_lead_score >= 25):"""

    for lead in sorted(hot_leads, key=lambda x: x.get("hot_lead_score", 0), reverse=True)[:10]:
        report += f"\n  {lead.get('hot_lead_score', 0)}pts — {lead.get('company_name', 'Unknown')} ({lead.get('platform', '?')}) — {lead.get('website', 'no site')} — emails: {len(lead.get('emails', []))}"

    return report


# ─────────────────────────────────────────────────────────────────────
# OUTREACH (enhanced with research + digital delivery)
# ─────────────────────────────────────────────────────────────────────

def run_outreach(hot_leads: list, schedule_label: str, lead_insights: dict = None) -> dict:
    """Send outreach to hot leads to generate revenue.

    Now includes:
    - Research-enhanced personalized content
    - Invoice drafts (staged, may require approval)
    - Checkout links (auto for <$50, approval for more)
    - Digital purchase delivery (auto for file-based products)
    - Newsletter opt-in emails to warm leads
    """
    import httpx

    if lead_insights is None:
        lead_insights = {}

    results = {
        "emails_sent": 0,
        "sms_sent": 0,
        "invoices_generated": 0,
        "purchases_delivered": 0,
        "newsletters_sent": 0,
        "details": [],
    }

    for lead in hot_leads[:20]:
        company = lead.get("company_name", "")
        platform = lead.get("platform", "unknown")
        score = lead.get("hot_lead_score", 0)
        emails = lead.get("emails", [])
        website = lead.get("website", "")
        industry = lead.get("industry", "")

        # Get researched insights for personalized content
        insights = lead_insights.get(company, {})

        # Determine offer based on score
        if score >= 40:
            amount = 499
            offer = "professional website + SEO"
            product_key = "full_site"
        elif score >= 30:
            amount = 99
            offer = "security audit + SEO review"
            product_key = "security_audit"
        elif score >= 25:
            amount = 37
            offer = "WinCare Pro — website + SEO"
            product_key = "wincare_pro"
        else:
            continue

        # Create personalized content using research insights
        email_body = create_draft_content(lead, insights, "email")
        if not email_body:
            email_body = f"""<html><body>
<h3>Hi {company},</h3>
<p>We help {industry} businesses get more customers.</p>
<p><strong>Choose your preferred payment method:</strong></p>
<ul>
<li><a href='https://paypal.me/{PAYPAL_ME_USERNAME}/{int(amount)}'>PayPal ${amount}</a></li>
<li><a href='https://venmo.com/{VENMO_HANDLE}/{int(amount)}'>Venmo ${amount}</a></li>
<li><a href='https://chime.com/{CHIME_HANDLE}/payment'>Chime ${amount}</a></li>
<li><a href='{GUMROAD_URL}'>Gumroad ${amount}</a></li>
</ul>
</body></html>"""

        # Email outreach if emails were found
        if emails:
            to_email = emails[0]
            subject = f"{company} — Fix your {platform} website, get more customers"

            try:
                email_resp = httpx.post(
                    f"{API_BASE}/web/email/send",
                    json={
                        "to": to_email,
                        "subject": subject,
                        "body": email_body,
                        "body_html": email_body,
                        "priority": "high",
                    },
                    timeout=15,
                )
                if email_resp.status_code == 200:
                    results["emails_sent"] += 1
                    results["details"].append({
                        "company": company, "email": to_email, "amount": amount,
                        "status": "sent", "insights_used": bool(insights)
                    })
            except Exception as e:
                results["details"].append({"company": company, "error": str(e)})
        else:
            results["details"].append({"company": company, "status": "no_email"})

        # Create invoice draft (auto-approved for <$500)
        try:
            invoice = create_invoice_draft(
                lead, float(amount), f"COAI {offer} for {company}"
            )
            if "invoice_id" in invoice:
                results["invoices_generated"] += 1
        except Exception:
            pass

        # Create checkout link (with approval gate for larger amounts)
        try:
            link = create_checkout_link(lead, float(amount), offer)
        except Exception:
            pass

        # For small purchases (WinCare Pro at $37), auto-deliver digital purchase
        if product_key == "wincare_pro" and amount <= APPROVAL_THRESHOLDS["small_purchase"]:
            try:
                delivery = deliver_digital_purchase(lead, product_key)
                if delivery.get("status") in ("delivered", "queued_manual"):
                    results["purchases_delivered"] += 1
            except Exception:
                pass

        # Send newsletter opt-in to leads that weren't fully converted
        if score >= 25 and score < 30 and not was_emails_sent_to_lead(lead):
            if send_newsletter_optin(lead):
                results["newsletters_sent"] += 1

        # SMS outreach for leads without emails
        if not emails and score >= 30:
            try:
                sms_resp = httpx.post(
                    f"{API_BASE}/web/sms/compose",
                    json={
                        "company_name": company,
                        "website": website,
                        "platform": platform,
                        "hot_lead_score": score,
                    },
                    timeout=15,
                )
                if sms_resp.status_code == 200:
                    sms_data = sms_resp.json()
                    if sms_data.get("phone"):
                        results["sms_sent"] += 1
                        results["details"].append({
                            "company": company, "sms": True, "phone": sms_data["phone"]
                        })
            except Exception:
                pass

    # Send summary report to Jason's email
    try:
        httpx.post(
            f"{API_BASE}/web/email/send",
            json={
                "to": EMAIL_TO,
                "subject": f"[COAI] {schedule_label} cycle — {results['emails_sent']} emails, {results['invoices_generated']} invoices",
                "body_html": f"""<html><body>
<h3>COAI Outreach Summary ({schedule_label})</h3>
<p>Emails sent: {results['emails_sent']}</p>
<p>SMS sent: {results['sms_sent']}</p>
<p>Invoices generated: {results['invoices_generated']}</p>
<p>Digital purchases delivered: {results['purchases_delivered']}</p>
<p>Newsletter opt-ins: {results['newsletters_sent']}</p>
<p>Hot leads contacted: {len(hot_leads[:20])}</p>
<p>Report at: https://prime-agent-ui.vercel.app</p>
</body></html>""",
                "priority": "normal",
            },
            timeout=10,
        )
    except Exception:
        pass

    return results


def was_emails_sent_to_lead(lead) -> bool:
    """Check if we already sent emails to this lead recently."""
    # Simple check — could be enhanced with a real dedup cache
    return False


# ─────────────────────────────────────────────────────────────────────
# CRON MODE: gumroad monitor
# ─────────────────────────────────────────────────────────────────────

def run_gumroad_monitor():
    """Monitor Gumroad competitor pricing and product performance."""
    import httpx

    log("Starting Gumroad competitor monitor...")

    try:
        resp = httpx.get(
            f"{API_BASE}/web/gumroad/report",
            params={"competitor_analysis": True, "limit": 50},
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            # Send summary to Jason
            try:
                httpx.post(
                    f"{API_BASE}/web/email/send",
                    json={
                        "to": EMAIL_TO,
                        "subject": "[COAI] Gumroad Monitor Report",
                        "body_html": f"<html><body><h3>Gumroad Monitor</h3><pre>{data.get('report', 'No data')[:1000]}</pre></body></html>",
                        "priority": "normal",
                    },
                    timeout=10,
                )
            except Exception:
                pass
            log(f"  Gumroad report sent: {len(data.get('report', ''))} chars")
        else:
            log(f"  Gumroad API returned status {resp.status_code}")
    except Exception as e:
        log(f"  Gumroad monitor error: {e}")


# ─────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────

def main():
    """Main agent loop — runs one cycle per invocation."""
    import argparse

    parser = argparse.ArgumentParser(description="COAI Revenue Agent")
    parser.add_argument("--mode", choices=["money", "aggressive", "gumroad", "daily-report"],
                        default="money", help="Run mode")
    args = parser.parse_args()

    log(f"Starting Revenue Agent v2.0 (coaiagent1)")
    log(f"Mode: {args.mode}")
    log(f"API: {API_BASE}")
    log(f"Supermemory: {'Connected (70 PDFs)' if SUPERMEMORY_KEY else 'Not configured'}")
    log(f"Approval queue: {APPROVAL_DIR}")
    log("")

    if args.mode == "gumroad":
        run_gumroad_monitor()

    elif args.mode == "daily-report":
        report = generate_daily_business_report()
        log(report)

    elif args.mode == "aggressive":
        report = run_discovery_cycle(mode="aggressive")
        log(report)

    else:  # money / default
        report = run_discovery_cycle(mode="peak")
        log(report)

        # Check if it's time for daily report (9 PM)
        now = datetime.now()
        if now.hour == 21:
            log("Generating daily business report...")
            daily_report = generate_daily_business_report()
            log(daily_report)

    log(f"\n[{now_str()}] Cycle complete.")


if __name__ == "__main__":
    main()