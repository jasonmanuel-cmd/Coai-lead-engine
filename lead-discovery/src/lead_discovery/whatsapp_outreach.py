"""WhatsApp outreach skill for the prime-agent.

Handles automated WhatsApp messaging to discovered leads using browser automation
or the Twilio WhatsApp API. Messages are personalized based on the lead's
business type, platform, and hot-lead score.
"""

import httpx
import os
import re
from urllib.parse import urlparse

# Twilio WhatsApp API (optional — requires TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN)
# Falls back to browser automation via Cloudflare Computer if Twilio is not configured
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_NUMBER = os.getenv("TWILIO_WHATSAPP_NUMBER", "+14155238886")  # Twilio sandbox number


def find_whatsapp_number(lead: dict) -> str | None:
    """Find a WhatsApp number for a business.

    Looks for WhatsApp links on the business's website, or searches
    Facebook/Google Maps for the business's WhatsApp contact.
    """
    website = lead.get("website", "")
    company_name = lead.get("company_name", "")
    platform = lead.get("platform", "")

    # If lead has a website, search it for WhatsApp links
    if website:
        try:
            url = f"https://{website.replace('www.', '')}"
            resp = httpx.get(url, timeout=8, follow_redirects=True)
            # Look for WhatsApp links: wa.me/ + phone_number
            wa_matches = re.findall(r'wa\.me/(\d{10,15})', resp.text)
            if wa_matches:
                return wa_matches[0]
            # Also look for WhatsApp embed links
            wa_matches = re.findall(r'api\.whatsapp\.com/send\?phone=(\d{10,15})', resp.text)
            if wa_matches:
                return wa_matches[0]
        except Exception:
            pass

    # Fallback: Try DuckDuckGo search for WhatsApp number
    if company_name:
        try:
            search_url = f"https://html.duckduckgo.com/html/?q={company_name.replace(' ', '+')}+whatsapp"
            resp = httpx.get(search_url, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
            wa_matches = re.findall(r'wa\.me/(\d{10,15})', resp.text)
            if wa_matches:
                return wa_matches[0]
            wa_matches = re.findall(r'api\.whatsapp\.com/send\?phone=(\d{10,15})', resp.text)
            if wa_matches:
                return wa_matches[0]
        except Exception:
            pass

    return None


def compose_message(lead: dict) -> str:
    """Compose a personalized WhatsApp message based on lead data.

    Uses the lead's business type, platform, and hot-lead score to craft
    a relevant outreach message.
    """
    company_name = lead.get("company_name", "there")
    platform = lead.get("platform", "unknown")
    hot_score = lead.get("hot_lead_score", 0)
    industry = lead.get("industry", "business")

    # Customize greeting based on lead quality
    if hot_score >= 40:
        opener = f"Hi {{name}}, I noticed {company_name} may not have a professional website."
    elif hot_score >= 15:
        opener = f"Hi {{name}}, I was looking at {company_name}'s website."
    else:
        opener = f"Hi {{name}}, I came across {company_name} online."

    # Customize value proposition based on platform
    if platform == "no_website":
        value = "Many customers search online before calling — without a website, you're missing out on those leads."
    elif platform == "wordpress":
        value = "WordPress sites often have security issues and slow loading. I can help fix that."
    elif platform == "wix":
        value = "Wix sites can be expensive and limited in SEO. There's a better solution for your industry."
    elif platform == "custom_outdated":
        value = "I noticed your site may be outdated. Modern websites convert 3x better."
    else:
        value = "I help local businesses like yours get more online visibility."

    message = f"""{opener}

{value}

I'm with COAI — we help {industry.replace('_', ' ')} businesses get more customers through professional websites and online marketing.

Would you be interested in a quick 5-minute call to see how we can help {company_name} get more customers?

Just say "yes" and I'll send you our portfolio and pricing.

Payment: PayPal.me/COAIJason or Venmo @blunts863 — whatever's easier. Chime $Jason-manuel-6 also available.

Our Gumroad: coaijason1989.gumroad.com/l/wincarepro"""

    return message


def send_whatsapp_message(lead: dict, recipient_phone: str | None = None) -> dict:
    """Send a WhatsApp message to a lead.

    Args:
        lead: Lead dict with company_name, platform, hot_lead_score, industry.
        recipient_phone: Phone number in E.164 format. If None, tries to find one.

    Returns:
        Dict with: success (bool), method (str), message_id (str), error (str|None)
    """
    message = compose_message(lead)

    # Try Twilio WhatsApp API first
    if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
        if not recipient_phone:
            recipient_phone = find_whatsapp_number(lead)

        if recipient_phone:
            try:
                client = httpx.Client(
                    auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
                    timeout=30,
                )
                resp = client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
                    data={
                        "From": f"whatsapp:{TWILIO_WHATSAPP_NUMBER}",
                        "To": f"whatsapp:+{recipient_phone.lstrip('+')}",
                        "Body": message,
                    },
                )
                data = resp.json()
                return {
                    "success": resp.status_code == 201,
                    "method": "twilio_whatsapp",
                    "message_id": data.get("sid", ""),
                    "error": None if resp.status_code == 201 else data.get("message", ""),
                    "recipient": recipient_phone,
                }
            except Exception as e:
                return {"success": False, "method": "twilio_whatsapp", "message_id": "", "error": str(e)}

    # Fallback: return message for browser-based sending via Cloudflare Computer
    if not recipient_phone:
        recipient_phone = find_whatsapp_number(lead)

    if not recipient_phone:
        return {
            "success": False,
            "method": "browser_automation",
            "message_id": "",
            "error": "No WhatsApp number found for this business. Manual outreach needed.",
            "message_template": message,
        }

    return {
        "success": False,
        "method": "browser_automation",
        "message_id": "",
        "error": None,
        "recipient": recipient_phone,
        "message_template": message,
        "instruction": "Open web.whatsapp.com in browser, enter number, paste message",
    }


def bulk_send(lead_ids: list[str], leads: list[dict]) -> dict:
    """Send WhatsApp messages to multiple leads.

    Args:
        lead_ids: List of lead IDs (from revenue_tracker).
        leads: List of lead dicts.

    Returns:
        Dict with success_count, fail_count, results list.
    """
    results = []
    success_count = 0
    fail_count = 0

    for lead in leads:
        result = send_whatsapp_message(lead)
        if result["success"]:
            success_count += 1
        else:
            fail_count += 1
        results.append({
            "lead": lead.get("company_name", "unknown"),
            "result": result,
        })

    return {
        "success_count": success_count,
        "fail_count": fail_count,
        "total": len(leads),
        "results": results,
    }
