"""Revenue Attribution Tracker for the prime-agent.

Tracks which leads came from which source, measures conversion rates,
and identifies the most effective discovery channels for COAI lead generation.

Data schema:
- Source: 'local_discovery', 'nationwide_scan', 'domain_check', 'google_maps', 'known_domains'
- Industry: plumber, electrician, roofer, hvac, etc.
- Outcome: 'contacted' → 'proposal_sent' → 'converted' → 'paid'
- Revenue: dollar value of closed deals
"""

import json
import os
from datetime import datetime
from pathlib import Path

TRACKING_DIR = Path(os.getenv("LEAD_TRACKING_DIR", str(Path.home() / ".lead-tracking")))
TRACKING_DIR.mkdir(parents=True, exist_ok=True)

CONVERSION_STAGES = [
    "discovered",      # Lead found by discovery agent
    "contacted",       # First contact attempted (email/WhatsApp/SMS)
    "proposal_sent",   # COAI proposal sent
    "negotiating",     # In negotiation
    "closed_won",      # Deal won
    "closed_lost",     # Deal lost
    "paid",            # Payment received
]

REVENUE_PER_CONVERSION = 500  # Average COAI lead value (adjustable)


def log_lead(lead: dict, source: str = "unknown") -> str:
    """Log a discovered lead with its source for attribution tracking.

    Args:
        lead: Lead dict with company_name, website, platform, hot_lead_score, etc.
        source: Where the lead came from (local_discovery, nationwide_scan, domain_check).

    Returns:
        Lead ID (for future lookup and conversion tracking).
    """
    lead_id = lead.get("company_name", "unknown")[:20].replace(" ", "_").replace("/", "_")
    timestamp = datetime.now().isoformat()

    record = {
        "id": lead_id,
        "source": source,
        "company_name": lead.get("company_name", ""),
        "website": lead.get("website", ""),
        "platform": lead.get("platform", ""),
        "hot_lead_score": lead.get("hot_lead_score", 0),
        "score": lead.get("score", 0),
        "industry": lead.get("industry", ""),
        "address": lead.get("address", ""),
        "phone": lead.get("phone", ""),
        "emails": lead.get("emails", []),
        "rating": lead.get("rating"),
        "review_count": lead.get("review_count", 0),
        "discovered_at": timestamp,
        "stage": "discovered",
        "stage_history": [{"stage": "discovered", "at": timestamp}],
        "value_estimate": _estimate_lead_value(lead),
    }

    filepath = TRACKING_DIR / f"{lead_id}.json"
    with open(filepath, "w") as f:
        json.dump(record, f, indent=2)

    # Also append to the source aggregate log
    aggregate = _load_aggregate(source)
    aggregate["total_leads"] = aggregate.get("total_leads", 0) + 1
    aggregate["hot_leads"] = aggregate.get("hot_leads", 0) + (1 if lead.get("hot_lead_score", 0) >= 20 else 0)
    aggregate["platforms"][lead.get("platform", "unknown")] = aggregate.get("platforms", {}).get(lead.get("platform", "unknown"), 0) + 1
    _save_aggregate(source, aggregate)

    return lead_id


def update_stage(lead_id: str, stage: str, notes: str = "") -> bool:
    """Update a lead's conversion stage.

    Args:
        lead_id: The ID returned by log_lead().
        stage: One of CONVERSION_STAGES.
        notes: Optional notes about this stage transition.

    Returns:
        True if updated successfully.
    """
    if stage not in CONVERSION_STAGES:
        raise ValueError(f"Invalid stage '{stage}'. Must be one of: {CONVERSION_STAGES}")

    filepath = TRACKING_DIR / f"{lead_id}.json"
    if not filepath.exists():
        return False

    with open(filepath) as f:
        record = json.load(f)

    timestamp = datetime.now().isoformat()
    record["stage"] = stage
    record["stage_history"].append({"stage": stage, "at": timestamp, "notes": notes})

    # Track conversion funnel
    if stage in ("closed_won", "paid"):
        record["closed_at"] = timestamp
        record["value_realized"] = record.get("value_estimate", REVENUE_PER_CONVERSION)

    with open(filepath, "w") as f:
        json.dump(record, f, indent=2)

    # Update aggregate
    source = record.get("source", "unknown")
    aggregate = _load_aggregate(source)

    if stage == "contacted":
        aggregate["contacted"] = aggregate.get("contacted", 0) + 1
    elif stage == "proposal_sent":
        aggregate["proposals_sent"] = aggregate.get("proposals_sent", 0) + 1
    elif stage in ("closed_won", "paid"):
        aggregate["conversions"] = aggregate.get("conversions", 0) + 1
        aggregate["revenue"] = aggregate.get("revenue", 0) + record.get("value_realized", REVENUE_PER_CONVERSION)

    _save_aggregate(source, aggregate)
    return True


def get_attribution_report() -> dict:
    """Generate a comprehensive attribution report across all sources.

    Returns:
        Dict with per-source metrics, conversion rates, and top-performing channels.
    """
    report = {
        "sources": {},
        "total_leads": 0,
        "total_conversions": 0,
        "total_revenue": 0,
        "best_source": None,
        "generated_at": datetime.now().isoformat(),
    }

    for record_file in TRACKING_DIR.glob("*.json"):
        try:
            with open(record_file) as f:
                record = json.load(f)

            source = record.get("source", "unknown")
            if source not in report["sources"]:
                report["sources"][source] = {
                    "total_leads": 0, "hot_leads": 0, "contacted": 0,
                    "proposals_sent": 0, "conversions": 0, "revenue": 0,
                    "platforms": {},
                }

            s = report["sources"][source]
            s["total_leads"] += 1
            s["hot_leads"] += 1 if record.get("hot_lead_score", 0) >= 20 else 0
            s["revenue"] += record.get("value_realized", 0)
            if record.get("stage") == "contacted":
                s["contacted"] += 1
            if record.get("stage") == "proposal_sent":
                s["proposals_sent"] += 1
            if record.get("stage") in ("closed_won", "paid"):
                s["conversions"] += 1
                report["total_conversions"] += 1
                report["total_revenue"] += record.get("value_realized", REVENUE_PER_CONVERSION)

        except (json.JSONDecodeError, KeyError):
            continue

    report["total_leads"] = sum(s["total_leads"] for s in report["sources"].values())

    # Find best source by revenue/conversions
    if report["sources"]:
        best = max(
            report["sources"].items(),
            key=lambda x: x[1]["revenue"] + x[1]["conversions"] * 10
        )
        report["best_source"] = best[0]

    return report


def _estimate_lead_value(lead: dict) -> int:
    """Estimate the dollar value of a lead based on hot-lead score."""
    hot_score = lead.get("hot_lead_score", 0)
    if hot_score >= 40:
        return 800  # High priority (no website, Wix)
    elif hot_score >= 25:
        return 600  # Medium-high (WordPress with low rating)
    elif hot_score >= 15:
        return 400  # Medium (WordPress standard)
    else:
        return 200  # Low (healthy site, unlikely to convert)


def _load_aggregate(source: str) -> dict:
    """Load or create the aggregate metrics for a source."""
    filepath = TRACKING_DIR / f"{source}_aggregate.json"
    if filepath.exists():
        with open(filepath) as f:
            return json.load(f)
    return {
        "source": source,
        "total_leads": 0, "hot_leads": 0, "contacted": 0,
        "proposals_sent": 0, "conversions": 0, "revenue": 0,
        "platforms": {},
    }


def _save_aggregate(source: str, data: dict):
    """Save aggregate metrics for a source."""
    filepath = TRACKING_DIR / f"{source}_aggregate.json"
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
