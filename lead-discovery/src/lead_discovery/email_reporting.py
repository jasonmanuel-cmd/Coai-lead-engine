"""Email reporting skill for the prime-agent.

Sends revenue reports, lead summaries, and money-making opportunities to the user's email.
Works with any SMTP provider (Gmail, Outlook, Yahoo, custom SMTP) or SendGrid/Mailgun API.

Configuration: Set these environment variables:
  EMAIL_SMTP_HOST    (e.g., smtp.gmail.com)
  EMAIL_SMTP_PORT    (e.g., 587 for TLS, 465 for SSL)
  EMAIL_USERNAME      (e.g., your@email.com)
  EMAIL_PASSWORD      (app password or SMTP password)
  EMAIL_TO            (recipient email, defaults to EMAIL_USERNAME)
  EMAIL_PROVIDER      (gmail/outlook/yahoo/custom/sendgrid/mailgun)

If EMAIL_PROVIDER is set to 'sendgrid', uses SendGrid API instead.
If EMAIL_PROVIDER is set to 'mailgun', uses Mailgun API instead.
"""

import os
import json
from datetime import datetime

# SMTP configuration
SMTP_HOST = os.getenv("EMAIL_SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("EMAIL_SMTP_PORT", "587"))
SMTP_USER = os.getenv("EMAIL_USERNAME", "")
SMTP_PASS = os.getenv("EMAIL_PASSWORD", "")
EMAIL_TO = os.getenv("EMAIL_TO", "") or SMTP_USER
EMAIL_PROVIDER = os.getenv("EMAIL_PROVIDER", "custom")
SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY", "")
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY", "")
MAILGUN_DOMAIN = os.getenv("MAILGUN_DOMAIN", "")


def send_report(subject: str, body_html: str, body_text: str | None = None, to_email: str | None = None) -> dict:
    """Send an email report to the user.

    Args:
        subject: Email subject line.
        body_html: HTML-formatted email body.
        body_text: Plain-text version (auto-generated from HTML if not provided).
        to_email: Override recipient email address (for lead outreach to specific emails).

    Returns:
        Dict with: success (bool), method (str), message_id (str), error (str|None)
    """
    if not SMTP_USER:
        return {"success": False, "error": "No EMAIL_USERNAME configured. Set EMAIL_USERNAME + EMAIL_PASSWORD env vars."}

    recipient = to_email or EMAIL_TO or SMTP_USER
    if body_text is None:
        body_text = _strip_html(body_html)

    if EMAIL_PROVIDER == "sendgrid" and SENDGRID_API_KEY:
        return _send_via_sendgrid(subject, body_html, body_text, recipient)
    elif EMAIL_PROVIDER == "mailgun" and MAILGUN_API_KEY:
        return _send_via_mailgun(subject, body_html, body_text, recipient)
    else:
        return _send_via_smtp(subject, body_html, body_text, recipient)


def _send_via_smtp(subject: str, body_html: str, body_text: str, to_email: str) -> dict:
    """Send via SMTP (Gmail, Outlook, Yahoo, custom)."""
    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = SMTP_USER
        msg["To"] = to_email

        part1 = MIMEText(body_text, "plain")
        part2 = MIMEText(body_html, "html")
        msg.attach(part1)
        msg.attach(part2)

        if SMTP_PORT == 465:
            import ssl
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
                server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(SMTP_USER, to_email, msg.as_string())
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(SMTP_USER, to_email, msg.as_string())

        return {
            "success": True,
            "method": f"smtp_{EMAIL_PROVIDER}",
            "message_id": f"sent-{datetime.now().isoformat()}",
            "error": None,
            "to": to_email,
        }
    except Exception as e:
        return {"success": False, "method": "smtp", "error": str(e)}


def _send_via_sendgrid(subject: str, body_html: str, body_text: str, to_email: str) -> dict:
    """Send via SendGrid API."""
    try:
        import httpx
        resp = httpx.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={
                "Authorization": f"Bearer {SENDGRID_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "personalizations": [{"to": [{"email": to_email}]}],
                "from": {"email": SMTP_USER},
                "subject": subject,
                "content": [
                    {"type": "text/plain", "value": body_text},
                    {"type": "text/html", "value": body_html},
                ],
            },
            timeout=30,
        )
        if resp.status_code == 202:
            return {"success": True, "method": "sendgrid", "message_id": resp.headers.get("X-Message-ID", ""), "error": None, "to": to_email}
        return {"success": False, "method": "sendgrid", "error": f"HTTP {resp.status_code}: {resp.text}"}
    except Exception as e:
        return {"success": False, "method": "sendgrid", "error": str(e)}


def _send_via_mailgun(subject: str, body_html: str, body_text: str, to_email: str) -> dict:
    """Send via Mailgun API."""
    try:
        import httpx
        resp = httpx.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
            auth=("api", MAILGUN_API_KEY),
            data={
                "from": SMTP_USER,
                "to": to_email,
                "subject": subject,
                "text": body_text,
                "html": body_html,
            },
            timeout=30,
        )
        if resp.status_code == 200:
            return {"success": True, "method": "mailgun", "message_id": resp.json().get("id", ""), "error": None, "to": to_email}
        return {"success": False, "method": "mailgun", "error": f"HTTP {resp.status_code}: {resp.text}"}
    except Exception as e:
        return {"success": False, "method": "mailgun", "error": str(e)}


def send_daily_report(cycle_summary: dict):
    """Generate and send the daily revenue report email.

    Args:
        cycle_summary: Dict with cycle results from the revenue agent.

    Returns:
        Email send result dict.
    """
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    stats = cycle_summary.get("stats", {})

    html = f"""
    <html>
    <body>
      <h2>⏰ COAI Prime-Agent — Daily Revenue Report ({timestamp})</h2>
      <hr>
      <h3>Summary</h3>
      <table border="1" cellpadding="5" cellspacing="0">
        <tr><td>Leads Discovered</td><td>{stats.get('leads_found', 0)}</td></tr>
        <tr><td>Emails Found</td><td>{stats.get('emails_found', 0)}</td></tr>
        <tr><td>Phones Found</td><td>{stats.get('phones_found', 0)}</td></tr>
        <tr><td>SMS Sent</td><td>{stats.get('sms_sent', 0)}</td></tr>
        <tr><td>WhatsApp Sent</td><td>{stats.get('wa_sent', 0)}</td></tr>
        <tr><td>PayPal Invoices Generated</td><td>{stats.get('invoices_generated', 0)}</td></tr>
        <tr><td><b>Total Revenue</b></td><td><b>${stats.get('total_revenue', 0)}</b></td></tr>
        <tr><td>Conversions</td><td>{stats.get('conversions', 0)}</td></tr>
      </table>

      <h3>Top Hot Leads (score >= 25)</h3>
      <table border="1" cellpadding="5" cellspacing="0">
        <tr><th>Company</th><th>Platform</th><th>Hot Score</th><th>Payment Link</th></tr>
      """

    hot_leads = cycle_summary.get("hot_leads", [])
    for lead in hot_leads[:10]:
        amount = 499 if lead.get("hot_lead_score", 0) >= 40 else 299
        paypal_link = f"https://paypal.me/COAIJason/{amount}"
        venmo_link = "https://venmo.com/@COAIJason"
        gumroad_link = "https://coaijason1989.gumroad.com/l/wincarepro"
        html += f"""
        <tr>
          <td>{lead.get('company_name', 'Unknown')}</td>
          <td>{lead.get('platform', '?')}</td>
          <td>{lead.get('hot_lead_score', 0)}</td>
          <td>
            <a href="{paypal_link}">PayPal ${amount}</a> |
            <a href="{venmo_link}">Venmo</a> |
            <a href="{gumroad_link}">Gumroad</a>
          </td>
        </tr>
        """

    html += """
      </table>

      <h3>Quick Money Opportunities</h3>
      <ul>
        <li>No-website businesses: WhatsApp + PayPal.Me/COAIJason/{amount} outreach</li>
        <li>WordPress businesses: Security audit offer $99 (PayPal.Me/COAIJason/99)</li>
        <li>Low-rated businesses: Review management $99/month</li>
        <li>WinCare Pro cross-sell: <a href="https://coaijason1989.gumroad.com/l/wincarepro">Gumroad affiliate link</a></li>
      </ul>

      <h3>Payment Methods</h3>
      <ul>
        <li><strong>PayPal:</strong> <a href="https://paypal.me/COAIJason">paypal.me/COAIJason</a></li>
        <li><strong>Venmo:</strong> <a href="https://venmo.com/@COAIJason">@COAIJason</a></li>
        <li><strong>Chime:</strong> $JasonCOAI</li>
        <li><strong>Gumroad:</strong> <a href="https://coaijason1989.gumroad.com">coaijason1989.gumroad.com</a></li>
      </ul>

      <p><a href="https://prime-agent-ui.vercel.app">View Full Dashboard</a></p>
      <p>— COAI Prime-Agent (coaiagent1)<br>
      Running 24/7 every 30 minutes</p>
    </body>
    </html>
    """

    subject = f"COAI Daily Report — ${stats.get('total_revenue', 0)} Revenue, {stats.get('leads_found', 0)} Leads"
    return send_report(subject, html, body_text=f"Daily revenue: ${stats.get('total_revenue', 0)}. Leads: {stats.get('leads_found', 0)}. See full dashboard: https://prime-agent-ui.vercel.app")


def send_alert(subject: str, body: str, priority: str = "normal") -> dict:
    """Send an urgent alert email (e.g., pricing change, big conversion)."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    html = f"""
    <html><body>
      <h2 style="color: {'red' if priority == 'high' else 'orange'}">🚨 COAI Alert — {priority.title()} Priority</h2>
      <p><b>Time:</b> {timestamp}</p>
      <p>{body}</p>
      <p><a href="https://prime-agent-ui.vercel.app">View Dashboard</a></p>
    </body></html>
    """
    subject = f"[COAI ALERT] {subject}"
    return send_report(subject, html)


def send_test_email() -> dict:
    """Send a test email to verify configuration."""
    html = """
    <html><body>
      <h2>COAI Prime-Agent — Email Test</h2>
      <p>If you're receiving this, the email configuration is working! 🎉</p>
      <p>The prime-agent will now send you daily revenue reports at the end of each cycle.</p>
      <p>To configure: set EMAIL_SMTP_HOST, EMAIL_USERNAME, EMAIL_PASSWORD env vars.</p>
    </body></html>
    """
    return send_report("COAI Prime-Agent — Email Test ✓", html)


def _strip_html(html: str) -> str:
    """Strip HTML tags to create plain text version."""
    import re
    text = re.sub(r"<[^>]+>", "", html)
    text = re.sub(r"\s+", " ", text)
    return text.strip()
