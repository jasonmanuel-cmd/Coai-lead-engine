"""SMS outreach skill for the prime-agent.

Sends SMS messages to discovered leads using Twilio API or Telnyx API.
Fallback to email if SMS fails.

Also includes PayPal invoice generation for leads that respond positively.
"""

import httpx
import json
import os
import re
from datetime import datetime

# Twilio API (optional)
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "+184****8301")

# Telnyx API (optional — preferred over Twilio if both configured)
TELNYX_API_KEY = os.getenv("TELNYX_API_KEY", "")
TELNYX_MQ_ID = os.getenv("TELNYX_MQ_ID", "")  # Messaging Profile ID
TELNYX_PHONE_NUMBER = os.getenv("TELNYX_PHONE_NUMBER", "")  # Your Telnyx phone number

# PayPal (optional)
PAYPAL_CLIENT_ID = os.getenv("PAYPAL_CLIENT_ID", "")
PAYPAL_CLIENT_SECRET = os.getenv("PAYPAL_CLIENT_SECRET", "")
PAYPAL_EMAIL = os.getenv("PAYPAL_EMAIL", "")
PAYPAL_ENV = os.getenv("PAYPAL_ENV", "production")  # "sandbox" or "production"

PAYPAL_BASE_URL = "https://api.sandbox.paypal.com" if PAYPAL_ENV == "sandbox" else "https://api.paypal.com"


def find_phone_number(lead: dict) -> str | None:
    """Find a phone number for a business from website or search."""
    website = lead.get("website", "")
    company_name = lead.get("company_name", "")
    address = lead.get("address", "")

    # Try scraping the website for phone numbers
    if website:
        try:
            url = f"https://{website.replace('www.', '')}"
            resp = httpx.get(url, timeout=8, follow_redirects=True)
            # US phone number format: (555) 123-4567 or 555-123-4567 or 5551234567
            phone_match = re.search(r'\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})', resp.text)
            if phone_match:
                return phone_match.group(0).replace("(", "").replace(")", "").replace("-", "").replace(".", "").replace(" ", "")
        except Exception:
            pass

    # Try Google search
    if company_name:
        try:
            search_url = f"https://html.duckduckgo.com/html/?q={company_name.replace(' ', '+')}+phone+number"
            resp = httpx.get(search_url, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
            phone_match = re.search(r'\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})', resp.text)
            if phone_match:
                return phone_match.group(0).replace("(", "").replace(")", "").replace("-", "").replace(".", "").replace(" ", "")
        except Exception:
            pass

    return None


def compose_sms_message(lead: dict) -> str:
    """Compose an SMS message for a lead."""
    company_name = lead.get("company_name", "there")
    platform = lead.get("platform", "unknown")
    hot_score = lead.get("hot_lead_score", 0)

    if hot_score >= 40:
        msg = f"Hi! I'm with COAI. {company_name} doesn't have a website — you're missing online customers. Quick call? Reply YES."
    elif hot_score >= 15:
        msg = f"Hi! {company_name} should upgrade your website to get more customers. Quick chat? Reply YES — COAI."
    else:
        msg = f"Hi! COAI helps {company_name}-type businesses get more online customers. 5 min chat? Reply YES."

    return msg[:160]  # SMS limit


def send_sms(lead: dict, phone: str | None = None) -> dict:
    """Send an SMS to a lead via Twilio.

    Args:
        lead: Lead dict.
        phone: Phone number in E.164 format. If None, tries to find one.

    Returns:
        Dict with success, message_sid, error.
    """
    if not phone:
        phone = find_phone_number(lead)

    if not phone:
        return {
            "success": False,
            "error": "No phone number found for this business.",
            "method": "none",
        }

    # Ensure phone is in E.164 format with country code
    phone = phone.lstrip("+")
    # If 10 digits (US without country code), prepend 1
    if len(phone) == 10 and phone.isdigit():
        phone = "1" + phone

    msg = compose_sms_message(lead)

    # Try Telnyx first (preferred), then Twilio fallback
    if TELNYX_API_KEY and TELNYX_MQ_ID:
        try:
            resp = httpx.post(
                "https://api.telnyx.com/v2/messages",
                headers={
                    "Authorization": f"Bearer {TELNYX_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": f"+{str(TELNYX_PHONE_NUMBER or TWILIO_PHONE_NUMBER).lstrip('+').replace('-', '').replace(' ', '')}",
                    "to": f"+{phone.lstrip('+')}",
                    "text": msg,
                    "messaging_profile_id": TELNYX_MQ_ID,
                },
                timeout=30,
            )
            if resp.status_code == 200 or resp.status_code == 202:
                data = resp.json()
                return {
                    "success": True,
                    "method": "telnyx",
                    "message_id": data.get("data", {}).get("id", ""),
                    "error": None,
                    "recipient": phone,
                    "body": msg,
                }
            else:
                return {
                    "success": False,
                    "method": "telnyx",
                    "error": f"Telnyx error: {resp.text}",
                    "recipient": phone,
                }
        except Exception as e:
            return {
                "success": False,
                "method": "telnyx",
                "error": str(e),
                "recipient": phone,
            }

    # Fallback: Try Twilio
    if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
        try:
            resp = httpx.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
                auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
                data={
                    "From": TWILIO_PHONE_NUMBER,
                    "To": f"+{phone.lstrip('+')}",
                    "Body": msg,
                },
                timeout=30,
            )
            if resp.status_code == 201:
                data = resp.json()
                return {
                    "success": True,
                    "method": "twilio",
                    "message_sid": data.get("sid", ""),
                    "error": None,
                    "recipient": phone,
                    "body": msg,
                }
            else:
                return {
                    "success": False,
                    "method": "telnyx_fallback_twilio",
                    "error": f"Twilio error: {resp.text}",
                    "recipient": phone,
                }
        except Exception as e:
            return {
                "success": False,
                "method": "telnyx_fallback_twilio",
                "error": str(e),
                "recipient": phone,
                "fallback_message": msg,
            }

    # Fallback: return the message for manual sending
    return {
        "success": False,
        "method": "manual",
        "error": "SMS not configured (neither Telnyx nor Twilio). Manual SMS needed.",
        "recipient": phone,
        "fallback_message": msg,
    }


def create_paypal_invoice(lead: dict, amount: float, description: str = "COAI Website Design Service") -> dict:
    """Create and send a PayPal invoice to a lead.

    Args:
        lead: Lead dict with company_name, emails.
        amount: Dollar amount for the invoice.
        description: Description of the service.

    Returns:
        Dict with success, invoice_url, invoice_id, error.
    """
    if not PAYPAL_CLIENT_ID or not PAYPAL_CLIENT_SECRET:
        return {
            "success": False,
            "error": "PayPal credentials not configured. Use PayPal.Me/COAIJason instead.",
            "paypal_me_url": f"https://paypal.me/COAIJason/{amount:.2f}?description={description.replace(' ', '+')}",
        }

    try:
        # Get access token
        auth_resp = httpx.post(
            f"{PAYPAL_BASE_URL}/v1/oauth2/token",
            auth=(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET),
            data={"grant_type": "client_credentials"},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )

        if auth_resp.status_code != 200:
            return {"success": False, "error": "PayPal auth failed"}

        access_token = auth_resp.json()["access_token"]

        # Get payer email from lead
        emails = lead.get("emails", ["lead@example.com"])
        payer_email = emails[0] if emails else "lead@example.com"

        # Create invoice — PayPal v2 Invoicing API structure
        invoice_data = {
            "detail": {
                "currency_code": "USD",
                "reference": "COAI-WincarePro",
                "description": f"For {lead.get('company_name', 'your business')}",
            },
            "invoicer": {"email": PAYPAL_EMAIL or "coaiebay@gmail.com"},
            "billing_info": [{"email": payer_email}],
            "items": [
                {
                    "name": description,
                    "description": f"For {lead.get('company_name', 'your business')}",
                    "quantity": 1,
                    "unit_amount": {"currency_code": "USD", "value": f"{amount:.2f}"},
                }
            ],
        }

        inv_resp = httpx.post(
            f"{PAYPAL_BASE_URL}/v2/invoicing/invoices",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json=invoice_data,
            timeout=30,
        )

        if inv_resp.status_code == 201:
            data = inv_resp.json()
            # PayPal returns the invoice ID in the Location header
            # Format: https://api.paypal.com/v2/invoicing/invoices/INV2-XXXX-XXXX-XXXX
            location = inv_resp.headers.get("location", "")
            invoice_id = location.rstrip("/").split("/")[-1] if location else ""
            # Fallback: try to extract from response body links
            if not invoice_id:
                links = data.get("links", [])
                if isinstance(data, list):
                    links = data
                for link in links:
                    if isinstance(link, dict) and link.get("rel") == "self":
                        href = link.get("href", "")
                        invoice_id = href.rstrip("/").split("/")[-1]
                        break
            # Last resort: check top-level response
            if not invoice_id:
                if isinstance(data, dict):
                    invoice_id = data.get("id", "")
                elif isinstance(data, list):
                    for link in data:
                        if isinstance(link, dict) and link.get("href"):
                            invoice_id = link["href"].rstrip("/").split("/")[-1]
                            break
            return {
                "success": True,
                "invoice_id": invoice_id,
                "invoice_url": f"https://www.paypal.com/invoice/details/{invoice_id}",
                "error": None,
            }
        else:
            return {
                "success": False,
                "error": f"Invoice creation failed: {inv_resp.text}",
                "paypal_me_url": f"https://paypal.me/COAIJason/{amount:.2f}",
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "paypal_me_url": f"https://paypal.me/COAIJason/{amount:.2f}",
        }


def bulk_sms(leads: list[dict]) -> dict:
    """Send SMS to multiple leads."""
    results = []
    success = 0
    fail = 0

    for lead in leads:
        result = send_sms(lead)
        if result["success"]:
            success += 1
        else:
            fail += 1
        results.append({
            "company": lead.get("company_name"),
            "result": result,
        })

    return {
        "success_count": success,
        "fail_count": fail,
        "total": len(leads),
        "results": results,
    }
