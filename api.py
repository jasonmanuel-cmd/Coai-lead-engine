"""FastAPI Inference Server for God-Level Lead Scorer

Endpoints:
  POST /score          — Score a single lead (context text)
  POST /score/batch    — Score multiple leads
  POST /feedback       — Submit feedback for self-correction
  GET  /stats          — Model stats & feedback queue size
  GET  /health         — Health check
  GET  /leads/find     — Find & score leads from CSV sources
  GET  /leads/stats    — Lead statistics
  GET  /web/discover   — Discover businesses from Google Maps & score them
  GET  /web/check/{domain} — Check a specific website's platform

Usage:
  .venv/Scripts/python -m uvicorn api:app --reload --port 8080
"""

import sys
import os
_src_dir = os.path.dirname(os.path.abspath(__file__))
_root_dir = os.path.dirname(_src_dir)
sys.path.insert(0, _src_dir)    # for src/*.py imports
sys.path.insert(0, _root_dir)   # for paths.py

import json
import urllib.request
import urllib.error
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
from pathlib import Path
import joblib
import numpy as np
import time
import sqlite3
from datetime import datetime, timezone
from fastapi.responses import JSONResponse

from paths import MODEL_DIR, SYNTHETIC_DIR
from god_level_scorer import SelfLearningLeadScorer, load_jsonl
from lead_finder import find_all_leads, Lead, WebLeadDiscoverer

# ===== DATABASE (SQLite for messages, activity, chat history) =====
DB_PATH = os.environ.get("DB_PATH", "C:\\\\Users\\\\blunt\\\\lead-tracking\\\\coai.db")

def init_db():
    """Initialize the SQLite database with all required tables."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # Messages table: agent notes, user questions, system alerts
    c.execute("""CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,           -- 'agent', 'user', 'system'
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general', -- 'note', 'question', 'idea', 'alert', 'update'
        priority INTEGER DEFAULT 0,      -- 0=normal, 1=high, 2=urgent
        created_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
        read_by_user INTEGER DEFAULT 0,  -- 0=unread, 1=read
        metadata TEXT                    -- JSON for extra data
    )""")
    
    # Chat conversations table
    c.execute("""CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,             -- 'user', 'assistant', 'system'
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
        metadata TEXT
    )""")
    
    # Activity log table: real-time agent activity
    c.execute("""CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT (datetime('now', 'localtime'))
    )""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)")
    
    # System health table: heartbeat checks
    c.execute("""CREATE TABLE IF NOT EXISTS system_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        component TEXT NOT NULL,          -- 'api', 'ngrok', 'cron', 'helper'
        status TEXT NOT NULL,             -- 'online', 'offline', 'degraded'
        details TEXT,                     -- JSON
        checked_at TIMESTAMP DEFAULT (datetime('now', 'localtime'))
    )""")
    
    # Agent ideas table: ideas the agent generates
    c.execute("""CREATE TABLE IF NOT EXISTS agent_ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT,                    -- 'lead-gen', 'monetization', 'feature', 'optimization'
        priority TEXT DEFAULT 'medium',   -- 'low', 'medium', 'high'
        status TEXT DEFAULT 'new',        -- 'new', 'in-progress', 'implemented', 'rejected'
        created_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
        updated_at TIMESTAMP DEFAULT (datetime('now', 'localtime'))
    )""")
    
    conn.commit()
    conn.close()

def log_activity(action: str, status: str, details: str = None):
    """Log an agent activity event."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO activity_log (action, status, details) VALUES (?, ?, ?)",
              (action, status, details or ''))
    conn.commit()
    conn.close()

def add_message(sender: str, content: str, category: str = "general", priority: int = 0):
    """Add a message to the message board."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO messages (sender, content, category, priority) VALUES (?, ?, ?, ?)",
              (sender, content, category, priority))
    conn.commit()
    msg_id = c.lastrowid
    conn.close()
    return msg_id

def add_idea(title: str, description: str, category: str = "general", priority: str = "medium"):
    """Add an idea from the agent."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO agent_ideas (title, description, category, priority) VALUES (?, ?, ?, ?)",
              (title, description, category, priority))
    conn.commit()
    conn.close()

# Initialize database on startup
init_db()

# ===== PYDANTIC MODELS =====

class LeadRequest(BaseModel):
    """Request to score a lead."""
    context: str = Field(..., description="Full lead context text describing company, platform, location, etc.")
    company_name: Optional[str] = Field(None, description="Optional company name for reference")

class ScoreResponse(BaseModel):
    """Score prediction response."""
    score: int
    confidence: float
    rule_based: float
    feature_model: float
    tfidf_model: float

class BatchScoreRequest(BaseModel):
    """Batch scoring request."""
    leads: List[LeadRequest]

class FeedbackRequest(BaseModel):
    """Feedback for self-correction."""
    context: str
    true_score: int = Field(..., ge=1, le=10)

class StatsResponse(BaseModel):
    """Model stats."""
    model_version: str
    is_fitted: bool
    feedback_queue_size: int
    model_path: str

class LeadStatsResponse(BaseModel):
    """Lead discovery stats."""
    total_leads: int
    industry_breakdown: dict
    source_breakdown: dict

class SiteCheckResponse(BaseModel):
    """Website platform check result."""
    domain: str
    platform: str
    platform_risk: float
    needs_coai: bool

class LeadScoredWeb(BaseModel):
    """A scored lead discovered from the web."""
    id: str
    company_name: str
    industry: str
    score: int
    confidence: float
    platform: str
    website: str
    phone: str
    source: str
    hot_lead_score: int = 0
    needs_coai: bool = True

# ===== FASTAPI APP =====

app = FastAPI(
    title="WinCare Pro Lead Scoring API",
    description="God-level self-learning lead scoring model",
    version="2.0.0",
)

# Global model instance
_model: Optional[SelfLearningLeadScorer] = None
_train_contexts = []
_train_scores = []

def get_model():
    """Lazy-load the model."""
    global _model
    if _model is None:
        _model = SelfLearningLeadScorer()
        model_path = MODEL_DIR / "god_model.pkl"
        if model_path.exists() or (MODEL_DIR / "ensemble_model.pkl").exists():
            _model.load(MODEL_DIR)
        else:
            raise RuntimeError("Model not trained. Run src/god_level_scorer.py first.")
    return _model

@app.on_event("startup")
def load_training_data():
    """Preload training data for retraining."""
    global _train_contexts, _train_scores
    # Resolve path relative to this file's location
    src_dir = Path(__file__).parent
    project_root = src_dir.parent
    train_path = project_root / "data" / "synthetic" / "train.jsonl"
    train_data = load_jsonl(train_path)
    _train_contexts = [d["context"] for d in train_data]
    _train_scores = [d["score"] for d in train_data]

@app.get("/health")
def health():
    """Health check."""
    return {"status": "ok", "timestamp": time.time()}

@app.get("/stats", response_model=StatsResponse)
def stats():
    """Get model stats."""
    model = get_model()
    return StatsResponse(
        model_version="god-level-v2",
        is_fitted=model.is_fitted,
        feedback_queue_size=len(model.feedback_log),
        model_path=str(MODEL_DIR / "ensemble_model.pkl"),
    )

@app.post("/score", response_model=ScoreResponse)
def score_lead(request: LeadRequest):
    """Score a single lead."""
    model = get_model()
    result = model.predict(request.context, return_details=True)
    return ScoreResponse(
        score=result["score"],
        confidence=result["confidence"],
        rule_based=result["rule_based"],
        feature_model=result["feature_model"],
        tfidf_model=result["tfidf_model"],
    )

@app.post("/score/batch", response_model=List[ScoreResponse])
def score_batch(request: BatchScoreRequest):
    """Score multiple leads in batch."""
    model = get_model()
    results = []
    for item in request.leads:
        result = model.predict(item.context, return_details=True)
        results.append(ScoreResponse(
            score=result["score"],
            confidence=result["confidence"],
            rule_based=result["rule_based"],
            feature_model=result["feature_model"],
            tfidf_model=result["tfidf_model"],
        ))
    return results

@app.post("/feedback")
def submit_feedback(request: FeedbackRequest):
    """Submit feedback for self-correction (active learning)."""
    model = get_model()
    model.add_feedback(request.context, request.true_score)

    # If we have enough feedback, trigger retraining
    if model.has_feedback():
        print(f"  Auto-retraining with {len(model.feedback_log)} feedback samples...")
        model.retrain_with_feedback(_train_contexts, _train_scores)
        model.save(MODEL_DIR)
        return {
            "status": "feedback_accepted_and_model_retrained",
            "feedback_queue_size": 0,
            "message": f"Model self-corrected with {len(model.feedback_log)} feedback samples. Queue reset."
        }

    return {
        "status": "feedback_accepted",
        "feedback_queue_size": len(model.feedback_log),
        "message": "Feedback collected. Model will auto-retrain when 5+ samples are accumulated.",
    }

class LeadScored(BaseModel):
    """A scored lead."""
    id: str
    company_name: str
    industry: str
    score: int
    confidence: float
    context: str
    source: str

@app.get("/leads/find", response_model=List[LeadScored])
def find_leads():
    """Find leads from all sources and score them."""
    model = get_model()
    leads = find_all_leads()
    results = []
    seen = set()
    for lead in leads:
        if lead.company_name in seen:
            continue
        seen.add(lead.company_name)
        context = lead.to_context()
        pred = model.predict(context, return_details=True)
        results.append(LeadScored(
            id=lead.company_name,
            company_name=lead.company_name,
            industry=lead.industry_category,
            score=pred["score"],
            confidence=pred["confidence"],
            context=context[:300],
            source=lead.source,
        ))
    # Sort by score descending
    results.sort(key=lambda x: x.score, reverse=True)
    return results


@app.get("/leads/stats", response_model=LeadStatsResponse)
def lead_stats():
    """Get statistics about discovered leads."""
    leads = find_all_leads()
    from collections import Counter
    industries = Counter(l.industry_category.lower() if l.industry_category else "unknown" for l in leads)
    sources = Counter(l.source for l in leads)
    return LeadStatsResponse(
        total_leads=len(leads),
        industry_breakdown=dict(industries.most_common(10)),
        source_breakdown=dict(sources.most_common(10)),
    )


@app.get("/web/discover", response_model=List[LeadScoredWeb])
def web_discover(industries: str = "plumber,electrician,hvac", limit: int = 20, location: str = "Bakersfield"):
    """Discover businesses from Google Maps and score them.

    Searches for businesses in target industries, checks their website
    platform, scores with the god-level model, and returns sorted by score.

    Args:
        industries: Comma-separated industries to search.
        limit: Maximum businesses to return.
        location: City/state to search (default: Bakersfield). Use "USA" for nationwide.
    """
    model = get_model()
    discoverer = WebLeadDiscoverer()

    industry_list = [i.strip() for i in industries.split(",") if i.strip()]
    all_leads = []
    for industry in industry_list:
        businesses = discoverer.search_google_maps(industry, location=location)
        for biz in businesses[:limit // len(industry_list) + 5]:
            platform = discoverer.check_website_platform(biz.get("website", ""))
            biz["platform"] = platform
            all_leads.append(biz)

    # Fallback: if Google Maps scraping returns nothing, use known business domains
    if not all_leads:
        print("  Google Maps scraping blocked — using known business domains...")
        for company_name, domain, industry in discoverer.KNOWN_BUSINESS_DOMAINS:
            platform = discoverer.check_website_platform(domain or "")
            all_leads.append({
                "company_name": company_name,
                "website": domain or "",
                "address": "Bakersfield, CA" if location == "Bakersfield" else location,
                "phone": "",
                "business_type": industry,
                "platform": platform,
                "source": "known_domains",
            })

    # Score each discovered lead
    results = []
    seen = set()
    # Hot-lead point values (COAI Lead Engine v2 style)
    PLATFORM_POINTS = {"no_website": 40, "wordpress": 15, "wix": 40, "godaddy": 30,
                       "squarespace": 25, "shopify": 30, "custom_outdated": 35,
                       "custom_html": 0, "error": 10}
    for biz in all_leads:
        if biz["company_name"].lower() in seen:
            continue
        seen.add(biz["company_name"].lower())

        context = biz.get("website", "") or biz.get("business_type", "") or biz.get("company_name", "")
        if biz.get("address"):
            context += f" | {biz['address']}"
        if biz.get("platform") and biz["platform"] != "no_website":
            context += f" | Platform: {biz['platform']}"

        pred = model.predict(context, return_details=True)

        # Calculate hot-lead score
        platform = biz.get("platform", "unknown")
        hot_score = PLATFORM_POINTS.get(platform, 0)

        results.append(LeadScoredWeb(
            id=biz["company_name"][:8],
            company_name=biz["company_name"],
            industry=biz.get("business_type", "general_business"),
            score=pred["score"],
            confidence=pred["confidence"],
            platform=platform,
            website=biz.get("website", ""),
            phone=biz.get("phone", ""),
            source=biz.get("source", "google_maps"),
            hot_lead_score=hot_score,
            needs_coai=hot_score >= 15,
        ))

    results.sort(key=lambda x: (x.score, x.confidence), reverse=True)
    return results


@app.get("/web/check/{domain:path}", response_model=SiteCheckResponse)
def check_site(domain: str):
    """Check a specific website's platform and quality.

    Usage: GET /web/check/coaibakersfield.com
    Returns platform type, risk score, and whether they need COAI services.
    """
    discoverer = WebLeadDiscoverer()
    result = discoverer.check_specific_site(domain)
    return SiteCheckResponse(
        domain=result["domain"],
        platform=result["platform"],
        platform_risk=result["platform_risk"],
        needs_coai=result["needs_coai"],
    )


@app.get("/web/discover-nationwide")
def web_discover_nationwide(
    states: str = "CA,TX,FL,NY,PA,IL,OH,MI,GA,NC,WA,AZ,MA,TN,IN,MO",
    industries: str = "plumber,electrician,roofer,hvac",
    cities_per_state: int = 3,
    max_businesses: int = 25,
):
    """Discover businesses across multiple US states.

    Searches Google Maps in major cities across the specified states,
    checks website platforms, and returns businesses sorted by hot-lead score.

    Args:
        states: Comma-separated 2-letter state codes (default: top 17 states).
        industries: Comma-separated industries to search.
        cities_per_state: How many major cities per state to search.
        max_businesses: Maximum number of businesses to return.
    """
    discoverer = WebLeadDiscoverer()

    state_list = [s.strip() for s in states.split(",") if s.strip()]
    industry_list = [i.strip() for i in industries.split(",") if i.strip()]

    leads = discoverer.discover_nationwide(
        states=state_list,
        industries=industry_list,
        cities_per_state=cities_per_state,
    )

    # Score with god-level model
    model = get_model()
    for lead in leads:
        ctx = json.dumps({
            "company_name": lead.get("company_name", ""),
            "business_type": lead.get("business_type", ""),
            "industry_category": lead.get("business_type", ""),
            "platform": lead.get("platform", ""),
            "address": lead.get("address", ""),
        })
        prediction = model.predict(ctx)
        lead["score"] = prediction.get("score", prediction.get("final_score", 5))
        lead["confidence"] = prediction.get("confidence", 0.5)

    # Sort by hot-lead score + needs_coai
    leads.sort(key=lambda x: (x.get("hot_lead_score", 0), x.get("score", 0)), reverse=True)
    leads = leads[:max_businesses]
    return leads


# ===== PRIME-AGENT DISCOVERY ENDPOINT =====

from pydantic import BaseModel as _BaseModel

class DiscoveryReportResponse(_BaseModel):
    total_businesses: int
    needs_coai_count: int
    no_website_count: int
    wordpress_count: int
    wix_count: int
    results: list = []

class EmailEnrichRequest(_BaseModel):
    company_name: str
    website: str | None = None
    platform: str | None = None

class WhatsAppMessageRequest(_BaseModel):
    company_name: str
    website: str | None = None
    platform: str | None = None
    hot_lead_score: int | None = 0
    industry: str | None = None
    recipient_phone: str | None = None

class AttributionUpdateRequest(_BaseModel):
    lead_id: str
    stage: str
    notes: str | None = None

class AttributionLogRequest(_BaseModel):
    company_name: str
    website: str | None = None
    platform: str | None = None
    hot_lead_score: int | None = 0
    industry: str | None = None
    source: str | None = "discovery"

# ===== Revenue / Outreach API endpoints =====

@app.get("/web/emails/{domain}")
async def get_emails_for_domain(domain: str):
    """Find email addresses for a business domain."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.email_enrichment import find_emails_for_lead
        result = find_emails_for_lead({"company_name": domain, "website": domain})
        return result
    except ImportError:
        return {"error": "Email enrichment module not available"}

@app.get("/web/reviews/{domain}")
async def get_reviews_for_domain(domain: str):
    """Scrape review data for a business."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.review_scraper import get_review_data
        result = get_review_data({"company_name": domain, "website": domain})
        return result
    except ImportError:
        return {"error": "Review scraper module not available"}

@app.get("/web/gumroad/report")
async def get_gumroad_report():
    """Generate competitive pricing report for competitor Gumroad products."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.gumroad_analysis import generate_pricing_report
        report = generate_pricing_report()
        return {"report": report}
    except ImportError:
        return {"error": "Gumroad analysis module not available"}

@app.get("/web/coai/scan-script")
async def get_coai_scan_script():
    """Get the automated browser scripts to login and scan on coaihq.online."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.coai_autologin import run_coai_scan
        return run_coai_scan()
    except ImportError:
        return {"error": "coaihq auto-login module not available"}

@app.get("/web/attribution")
async def get_attribution():
    """Get the revenue attribution report."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.revenue_tracker import get_attribution_report
        return get_attribution_report()
    except ImportError:
        return {"error": "Revenue tracker module not available"}

@app.post("/web/attribution/log")
async def log_attribution(lead: AttributionLogRequest):
    """Log a lead to the attribution tracker."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.revenue_tracker import log_lead
        lead_id = log_lead(
            {"company_name": lead.company_name, "website": lead.website or "",
             "platform": lead.platform or "", "hot_lead_score": lead.hot_lead_score or 0,
             "industry": lead.industry or ""},
            source=lead.source or "discovery"
        )
        return {"success": True, "lead_id": lead_id}
    except ImportError:
        return {"error": "Revenue tracker module not available"}

@app.post("/web/attribution/update")
async def update_attribution(req: AttributionUpdateRequest):
    """Update a lead's conversion stage."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.revenue_tracker import update_stage
        result = update_stage(req.lead_id, req.stage, req.notes or "")
        return {"success": result}
    except ImportError:
        return {"error": "Revenue tracker module not available"}

@app.post("/web/whatsapp/compose")
async def compose_whatsapp(lead: WhatsAppMessageRequest):
    """Compose a WhatsApp outreach message for a lead."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.whatsapp_outreach import compose_message, find_whatsapp_number, send_whatsapp_message
        message = compose_message({
            "company_name": lead.company_name,
            "platform": lead.platform or "unknown",
            "hot_lead_score": lead.hot_lead_score or 0,
            "industry": lead.industry or "business",
        })
        wa_number = find_whatsapp_number({"website": lead.website or "", "company_name": lead.company_name})
        result = send_whatsapp_message({
            "company_name": lead.company_name,
            "platform": lead.platform or "unknown",
            "hot_lead_score": lead.hot_lead_score or 0,
            "industry": lead.industry or "business",
        }, lead.recipient_phone)
        return {
            "message": message,
            "whatsapp_number": wa_number,
            "send_result": result,
        }
    except ImportError:
        return {"error": "WhatsApp outreach module not available"}


@app.get("/web/")
def web_root():
    """Web API info."""
    return {
        "endpoints": {
            "discover": "GET /web/discover?industries=plumber&location=Bakersfield&limit=20",
            "check": "GET /web/check/{domain}",
            "emails": "GET /web/emails/{domain}",
            "reviews": "GET /web/reviews/{domain}",
            "whatsapp": "POST /web/whatsapp/compose {body}",
            "sms": "POST /web/sms/compose {body}",
            "paypal_invoice": "POST /web/paypal/invoice {body}",
            "attribution": "GET /web/attribution",
            "log_lead": "POST /web/attribution/log {body}",
            "update_stage": "POST /web/attribution/update {body}",
            "gumroad_report": "GET /web/gumroad/report",
            "coai_scan": "GET /web/coai/scan-script",
        }
    }


class SMSComposeRequest(_BaseModel):
    company_name: str
    website: str | None = None
    platform: str | None = None
    hot_lead_score: int | None = 0


class PayPalInvoiceRequest(_BaseModel):
    company_name: str
    amount: float
    description: str | None = "COAI Website Design Service"
    emails: list[str] | None = None


@app.post("/web/sms/compose")
async def compose_sms(lead: SMSComposeRequest):
    """Compose and optionally send an SMS to a lead."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.sms_outreach import compose_sms_message, find_phone_number, send_sms
        message = compose_sms_message({
            "company_name": lead.company_name,
            "platform": lead.platform or "unknown",
            "hot_lead_score": lead.hot_lead_score or 0,
        })
        phone = find_phone_number({
            "website": lead.website or "",
            "company_name": lead.company_name,
        })
        result = send_sms({
            "company_name": lead.company_name,
            "platform": lead.platform or "unknown",
            "hot_lead_score": lead.hot_lead_score or 0,
        }, phone)
        return {"message": message, "phone": phone, "send_result": result}
    except ImportError:
        return {"error": "SMS outreach module not available"}


@app.post("/web/paypal/invoice")
async def create_invoice(lead: PayPalInvoiceRequest):
    """Create a PayPal invoice for a lead."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.sms_outreach import create_paypal_invoice
        result = create_paypal_invoice({
            "company_name": lead.company_name,
            "emails": lead.emails or [],
        }, lead.amount, lead.description or "COAI Website Design Service")
        return result
    except ImportError:
        return {"error": "PayPal invoice module not available"}

class EmailRequest(_BaseModel):
    subject: str
    body: str
    body_html: str | None = None
    priority: str | None = "normal"
    to: str | None = None  # Override the default recipient (for lead outreach to specific emails)

class DailyReportRequest(_BaseModel):
    cycle_summary: dict | None = None

@app.post("/web/email/send")
async def send_email(req: EmailRequest):
    """Send an email report."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.email_reporting import send_report, send_alert
        if req.priority == "high":
            return send_alert(req.subject, req.body, priority="high")
        return send_report(req.subject, req.body_html or req.body, to_email=req.to)
    except ImportError:
        return {"error": "Email reporting module not available"}

@app.get("/web/email/test")
async def test_email():
    """Send a test email to verify configuration."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.email_reporting import send_test_email
        return send_test_email()
    except ImportError:
        return {"error": "Email reporting module not available"}

@app.post("/web/email/daily-report")
async def send_daily_report(req: DailyReportRequest):
    """Send the daily revenue report email."""
    try:
        import sys
        sys.path.insert(0, "/c/Users/blunt/Desktop/prime-agent/packages/coding-agent/skills/lead-discovery/src")
        from lead_discovery.email_reporting import send_daily_report
        return send_daily_report(req.cycle_summary or {})
    except ImportError:
        return {"error": "Email reporting module not available"}


class MonetizeRequest(_BaseModel):
    company_name: str
    website: str | None = None
    platform: str | None = None
    hot_lead_score: int | None = 0
    industry: str | None = None
    emails: list[str] | None = None
    phone: str | None = None


@app.post("/web/monetize")
async def monetize_lead_endpoint(lead: MonetizeRequest):
    """Monetize a single lead — send outreach + create invoice."""
    import sys
    sys.path.insert(0, "/c/Users/blunt/Desktop/model-training/src")
    try:
        from money_machine import monetize_lead, get_price_for_score, create_paypal_invoice
        lead_dict = {
            "company_name": lead.company_name,
            "website": lead.website or "",
            "platform": lead.platform or "unknown",
            "hot_lead_score": lead.hot_lead_score or 0,
            "industry": lead.industry or "business",
            "emails": lead.emails or [],
            "phone": lead.phone or "",
        }
        result = monetize_lead(lead_dict)
        return result
    except ImportError as e:
        return {"error": f"Money machine module not available: {e}"}


# ===== NEW UNIFIED ENDPOINTS =====

class MessageRequest(BaseModel):
    sender: str = "user"
    content: str
    category: str = "general"
    priority: int = 0

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

class ActivityRequest(BaseModel):
    action: str
    status: str
    details: Optional[str] = None

class IdeaRequest(BaseModel):
    title: str
    description: Optional[str] = None
    category: str = "general"
    priority: str = "medium"

@app.get("/messages")
async def get_messages(unread_only: bool = False):
    """Get all messages from the message board."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    if unread_only:
        c.execute("SELECT id, sender, content, category, priority, created_at, read_by_user FROM messages WHERE read_by_user = 0 ORDER BY created_at DESC")
    else:
        c.execute("SELECT id, sender, content, category, priority, created_at, read_by_user FROM messages ORDER BY created_at DESC")
    rows = c.fetchall()
    conn.close()
    return [{"id": r[0], "sender": r[1], "content": r[2], "category": r[3], "priority": r[4], "created_at": r[5], "read_by_user": r[6]} for r in rows]

@app.post("/messages")
async def post_message(msg: MessageRequest):
    """Post a new message to the board."""
    msg_id = add_message(msg.sender, msg.content, msg.category, msg.priority)
    return {"id": msg_id, "status": "posted"}

@app.post("/messages/read/{msg_id}")
async def mark_message_read(msg_id: int):
    """Mark a message as read."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE messages SET read_by_user = 1 WHERE id = ?", (msg_id,))
    conn.commit()
    conn.close()
    return {"status": "marked as read"}

@app.get("/activity")
async def get_activity(limit: int = 100):
    """Get recent activity log entries."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(f"SELECT id, action, status, details, created_at FROM activity_log ORDER BY id DESC LIMIT {limit}")
    rows = c.fetchall()
    conn.close()
    return [{"id": r[0], "action": r[1], "status": r[2], "details": r[3], "created_at": r[4]} for r in rows]

@app.post("/activity")
async def log_activity_endpoint(activity: ActivityRequest):
    """Log a new activity entry."""
    log_activity(activity.action, activity.status, activity.details)
    return {"status": "logged"}

@app.get("/chat/history/{session_id}")
async def get_chat_history(session_id: str):
    """Get chat history for a session."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT role, content, created_at FROM conversations WHERE session_id = ? ORDER BY id ASC", (session_id,))
    rows = c.fetchall()
    conn.close()
    return [{"role": r[0], "content": r[1], "created_at": r[2]} for r in rows]

@app.post("/chat")
async def chat_endpoint(chat: ChatRequest):
    """Chat with the AI assistant using Supermemory search."""
    import urllib.request
    
    # Store user message
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?, 'user', ?)",
              (chat.session_id, chat.message))
    conn.commit()
    
    # Search Supermemory for context
    supermemory_key = os.environ.get("SUPERMEMORY_KEY", "")
    supermemory_org = os.environ.get("SUPERMEMORY_ORG_ID", "9BDei71qniQUDpPd6kks2")
    
    response_text = "I'm online but Supermemory search is not configured."
    
    if supermemory_key:
        try:
            url = "https://api.supermemory.ai/v3/search"
            data = json.dumps({"q": chat.message, "limit": 5}).encode()
            req = urllib.request.Request(url, data=data, headers={
                "Content-Type": "application/json",
                "x-api-key": supermemory_key,
                "x-org-id": supermemory_org,
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                sm_result = json.loads(resp.read())
                context = sm_result.get("data", {}).get("results", [])[:3]
                context_summary = " ".join([r.get("content", r.get("title", ""))[:200] for r in context])
                
                # Build a simple response using OpenRouter
                openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
                if openrouter_key:
                    prompt = f"Answer the user's question based on this context:\n\nContext:\n{context_summary}\n\nQuestion: {chat.message}\n\nAnswer:"
                    
                    or_data = json.dumps({
                        "model": "nvidia/nemotron-3-super-120b-a12b:free",
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": 500,
                    }).encode()
                    or_req = urllib.request.Request("https://api.openrouter.ai/v1/chat/completions", data=or_data, headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {openrouter_key}",
                    })
                    with urllib.request.urlopen(or_req, timeout=20) as or_resp:
                        or_result = json.loads(or_resp.read())
                        response_text = or_result.get("choices", [{}])[0].get("message", {}).get("content", "No response generated.")
        except Exception as e:
            response_text = f"I encountered an error while searching my knowledge base: {str(e)[:200]}"
    
    # Store assistant response
    c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?, 'assistant', ?)",
              (chat.session_id, response_text))
    conn.commit()
    conn.close()
    
    return {"response": response_text, "session_id": chat.session_id}

@app.get("/ideas")
async def get_ideas(status: str = None):
    """Get agent ideas, optionally filtered by status."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    if status:
        c.execute("SELECT * FROM agent_ideas WHERE status = ? ORDER BY created_at DESC", (status,))
    else:
        c.execute("SELECT * FROM agent_ideas ORDER BY created_at DESC")
    rows = c.fetchall()
    conn.close()
    return [{"id": r[0], "title": r[1], "description": r[2], "category": r[3], "priority": r[4], "status": r[5], "created_at": r[6], "updated_at": r[7]} for r in rows]

@app.post("/ideas")
async def add_idea_endpoint(idea: IdeaRequest):
    """Add a new idea from the agent."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO agent_ideas (title, description, category, priority) VALUES (?, ?, ?, ?)",
              (idea.title, idea.description, idea.category, idea.priority))
    conn.commit()
    idea_id = c.lastrowid
    conn.close()
    return {"id": idea_id, "status": "added"}

@app.get("/system/status")
async def system_status():
    """Get comprehensive system status."""
    import urllib.request
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # Check API health
    api_status = "online"
    
    # Check ngrok tunnel — check both the ngrok local API and the public URL
    ngrok_status = "unknown"
    ngrok_url = os.environ.get("NGROK_URL", "")
    if ngrok_url:
        try:
            # Check the public URL
            import urllib.request as _ur
            req = _ur.Request(f"{ngrok_url}/health", method="GET")
            with _ur.urlopen(req, timeout=5) as resp:
                ngrok_status = "online" if resp.status == 200 else "degraded"
        except:
            try:
                # Fallback: check ngrok local API
                req2 = _ur.Request("http://127.0.0.1:4040/api/tunnels", method="GET")
                with _ur.urlopen(req2, timeout=5) as resp2:
                    data = json.loads(resp2.read())
                    if data.get("tunnels"):
                        ngrok_status = "online"
            except:
                ngrok_status = "offline"
    else:
        # Try checking ngrok local API directly
        try:
            import urllib.request as _ur
            req = _ur.Request("http://127.0.0.1:4040/api/tunnels", method="GET")
            with _ur.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                if data.get("tunnels"):
                    tunnel = data["tunnels"][0]
                    ngrok_status = "online"
                    ngrok_url = tunnel.get("public_url", "")
        except:
            ngrok_status = "offline"
    
    # Check cron jobs (count recent activity)
    try:
        c.execute("SELECT COUNT(*) FROM activity_log WHERE action = 'cron' AND status = 'completed' AND created_at > datetime('now', '-24 hours')")
        cron_today = c.fetchone()[0]
    except:
        cron_today = 0
    
    # Check recent messages
    try:
        c.execute("SELECT COUNT(*) FROM messages WHERE read_by_user = 0")
        unread_messages = c.fetchone()[0]
    except:
        unread_messages = 0
    
    # Check recent ideas
    try:
        c.execute("SELECT COUNT(*) FROM agent_ideas WHERE status = 'new'")
        new_ideas = c.fetchone()[0]
    except:
        new_ideas = 0
    
    conn.close()
    
    return {
        "api": {"status": api_status, "timestamp": time.time()},
        "ngrok": {"status": ngrok_status, "url": ngrok_url},
        "cron": {"last_24h": cron_today},
        "messages": {"unread": unread_messages},
        "ideas": {"new": new_ideas},
        "database": DB_PATH,
    }

@app.get("/dashboard")
async def dashboard_data():
    """Get all data needed by the dashboard in one call."""
    import urllib.request
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # Recent messages (5 most recent)
    c.execute("SELECT id, sender, content, category, priority, created_at, read_by_user FROM messages ORDER BY created_at DESC LIMIT 5")
    messages = [{"id": r[0], "sender": r[1], "content": r[2], "category": r[3], "priority": r[4], "created_at": r[5], "read_by_user": r[6]} for r in c.fetchall()]
    
    # Recent activity (10 most recent)
    c.execute("SELECT id, action, status, details, created_at FROM activity_log ORDER BY id DESC LIMIT 10")
    activity = [{"id": r[0], "action": r[1], "status": r[2], "details": r[3], "created_at": r[4]} for r in c.fetchall()]
    
    # Recent ideas (5 most recent)
    c.execute("SELECT id, title, description, category, priority, status, created_at FROM agent_ideas ORDER BY created_at DESC LIMIT 5")
    ideas = [{"id": r[0], "title": r[1], "description": r[2], "category": r[3], "priority": r[4], "status": r[5], "created_at": r[6]} for r in c.fetchall()]
    
    # Unread count
    c.execute("SELECT COUNT(*) FROM messages WHERE read_by_user = 0")
    unread = c.fetchone()[0]
    
    # New ideas count
    c.execute("SELECT COUNT(*) FROM agent_ideas WHERE status = 'new'")
    new_ideas = c.fetchone()[0]
    
    conn.close()
    
    # Check ngrok
    ngrok_url = os.environ.get("NGROK_URL", "")
    ngrok_status = "offline"
    if ngrok_url:
        try:
            req = urllib.request.Request(f"{ngrok_url}/health", method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                ngrok_status = "online" if resp.status == 200 else "degraded"
        except:
            ngrok_status = "offline"
    
    return {
        "messages": {"recent": messages, "unread_count": unread},
        "activity": {"recent": activity},
        "ideas": {"recent": ideas, "new_count": new_ideas},
        "system": {
            "api": "online",
            "ngrok": {"status": ngrok_status, "url": ngrok_url},
            "timestamp": time.time()
        }
    }

# ===== AGENCY AGENTS INTEGRATION =====

AGENCY_AGENTS_DIR = os.environ.get("AGENCY_AGENTS_DIR", "C:\\\\Users\\\\blunt\\\\.agency-agents")

AGENT_REGISTRY = {
    "outbound-strategist": {
        "category": "sales",
        "description": "Signal-based outreach specialist — designs multi-channel prospecting sequences triggered by buying signals",
        "file": f"{AGENCY_AGENTS_DIR}/sales/sales-outbound-strategist.md",
        "persona": "outbound",
    },
    "pipeline-analyst": {
        "category": "sales",
        "description": "Revenue operations analyst — pipeline health diagnostics, deal velocity analysis, forecast accuracy",
        "file": f"{AGENCY_AGENTS_DIR}/sales/sales-pipeline-analyst.md",
        "persona": "analyst",
    },
    "backend-architect": {
        "category": "engineering",
        "description": "Scalable system design and API architecture expert",
        "file": f"{AGENCY_AGENTS_DIR}/engineering/engineering-backend-architect.md",
        "persona": "architect",
    },
    "ai-engineer": {
        "category": "engineering",
        "description": "ML model development, AI integration, data pipelines expert",
        "file": f"{AGENCY_AGENTS_DIR}/engineering/engineering-ai-engineer.md",
        "persona": "ml",
    },
    "automation-governor": {
        "category": "specialized",
        "description": "Automation governance — cron job management, workflow orchestration, process improvement",
        "file": f"{AGENCY_AGENTS_DIR}/specialized/automation-governance-architect.md",
        "persona": "governor",
    },
    "codebase-archaeologist": {
        "category": "specialized",
        "description": "Codebase archaeologist — understands existing code, finds technical debt, suggests improvements",
        "file": f"{AGENCY_AGENTS_DIR}/specialized/specialized-codebase-archaeologist.md",
        "persona": "archaeologist",
    },
    "sales-outreach": {
        "category": "sales",
        "description": "Consultative B2B sales outreach specialist for cold prospecting, lead follow-up, objection handling, proposal writing, and pipeline management",
        "file": f"{AGENCY_AGENTS_DIR}/specialized/sales-outreach.md",
        "persona": "sales",
    },
    "workflow-architect": {
        "category": "specialized",
        "description": "Workflow architect — designs optimal agent workflows and handoff patterns",
        "file": f"{AGENCY_AGENTS_DIR}/specialized/specialized-workflow-architect.md",
        "persona": "workflow",
    },
}

def load_agent_persona(name: str):
    """Load an agent persona's profile from the agency-agents directory."""
    if name not in AGENT_REGISTRY:
        return None
    info = AGENT_REGISTRY[name]
    file_path = info["file"]
    if not os.path.exists(file_path):
        return None
    with open(file_path, 'r') as f:
        content = f.read()
    # Parse YAML frontmatter for name/description
    lines = content.split('\n---')
    if len(lines) >= 3:
        frontmatter = lines[1].strip()
    else:
        frontmatter = ""
    
    return {
        "name": name,
        "category": info["category"],
        "description": info["description"],
        "persona": info["persona"],
        "available": True,
        "frontmatter": frontmatter,
    }

class AgentChatRequest(BaseModel):
    message: str
    session_id: str = "default"

@app.get("/agents")
async def list_agents():
    """List all available agent personas."""
    agents = []
    for name, info in AGENT_REGISTRY.items():
        agents.append({
            "name": name,
            "category": info["category"],
            "description": info["description"],
            "persona": info["persona"],
            "available": os.path.exists(info["file"]),
        })
    return agents

@app.get("/agents/registry")
async def get_registry():
    """Get the full agent registry."""
    return {name: {"category": info["category"], "description": info["description"], "file": info["file"], "available": os.path.exists(info["file"])} for name, info in AGENT_REGISTRY.items()}

@app.get("/agents/{name}")
async def get_agent(name: str):
    """Get a specific agent persona's profile."""
    agent = load_agent_persona(name)
    if not agent:
        return {"error": "Agent not found or persona file not available"}
    return agent

@app.post("/agents/{name}/chat")
async def chat_with_agent(name: str, req: AgentChatRequest):
    """Chat with a specific agent persona."""
    agent = load_agent_persona(name)
    if not agent:
        return {"error": "Agent not found or persona file not available"}
    
    session_key = f"agent:{name}:{req.session_id}"
    
    # Save user message
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?, 'user', ?)",
              (session_key, req.message))
    conn.commit()
    
    # Search Supermemory for context
    supermemory_key = os.environ.get("SUPERMEMORY_KEY", os.environ.get("SUPERMEMORY_CODEX_API_KEY", ""))
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
    supermemory_org = os.environ.get("SUPERMEMORY_ORG_ID", "9BDei71qniQUDpPd6kks2")
    
    response_text = f"[{name}] Persona: {agent['description']}. I'd help you with this, but my knowledge base integration isn't fully configured yet. Ask me something about {agent['category']}."
    
    if supermemory_key:
        try:
            sm_url = "https://api.supermemory.ai/v3/search"
            sm_data = json.dumps({"q": req.message, "limit": 5}).encode()
            sm_req = urllib.request.Request(sm_url, data=sm_data, headers={
                "Content-Type": "application/json",
                "x-api-key": supermemory_key,
                "x-org-id": supermemory_org,
            })
            with urllib.request.urlopen(sm_req, timeout=10) as sm_resp:
                sm_result = json.loads(sm_resp.read())
                context = sm_result.get("data", {}).get("results", [])[:3]
                context_summary = " ".join([r.get("content", r.get("title", ""))[:300] for r in context])
        except Exception as e:
            context_summary = f"(Supermemory search error: {str(e)[:100]})"
    else:
        context_summary = "(Supermemory: not configured)"
    
    if openrouter_key:
        try:
            # Build a persona-specific system prompt
            system_prompt = f"You are {agent['name']}, a {agent['description']} Your personality: {agent['persona']}. Use the following context from your knowledge base to answer: {context_summary}"
            
            or_data = json.dumps({
                "model": "nvidia/nemotron-3-super-120b-a12b:free",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": req.message}
                ],
                "max_tokens": 500,
            }).encode()
            or_req = urllib.request.Request("https://api.openrouter.ai/v1/chat/completions", data=or_data, headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {openrouter_key}",
            })
            with urllib.request.urlopen(or_req, timeout=30) as or_resp:
                or_result = json.loads(or_resp.read())
                response_text = or_result.get("choices", [{}])[0].get("message", {}).get("content", response_text)
        except Exception as e:
            response_text += f"\n\n(OpenRouter error: {str(e)[:100]})"
    else:
        response_text += "\n\n(OpenRouter API key not configured — set OPENROUTER_API_KEY to enable AI responses)"
    
    # Save assistant response
    c.execute("INSERT INTO conversations (session_id, role, content) VALUES (?, 'assistant', ?)",
              (session_key, response_text))
    conn.commit()
    conn.close()
    
    return {"response": response_text, "agent": name, "session_id": session_key}

@app.get("/agents/{name}/chat/history")
async def get_agent_chat_history(name: str, session_id: str = "default"):
    """Get chat history with a specific agent."""
    session_key = f"agent:{name}:{session_id}"
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT role, content, created_at FROM conversations WHERE session_id = ? ORDER BY id ASC", (session_key,))
    rows = c.fetchall()
    conn.close()
    return [{"role": r[0], "content": r[1], "created_at": r[2]} for r in rows]

@app.get("/")
def root():
    return {"message": "WinCare Pro Lead Scoring API — God Level", "docs": "/docs"}