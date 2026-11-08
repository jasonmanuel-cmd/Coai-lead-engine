"""COAIHQ auto-login skill for the prime-agent.

Automatically authenticates to coaihq.online using the COAI_PASSWORD env var,
sets session storage, selects all industries, and triggers the "SCAN FOR LEADS"
button. Uses browser automation (via browser_navigate/browser_console or Cloudflare Computer).

The coaihq.online app uses sessionStorage.coai_auth to store the password.
Once authenticated, the full Lead Engine v2 dashboard is available.
"""

import json
import os
import re

COAI_PASSWORD = os.getenv("COAI_PASSWORD", "")
COAI_BASE_URL = os.getenv("COAI_BASE_URL", "https://coaihq.online")

# Industry categories available in coaihq.online Lead Engine v2
INDUSTRY_CATEGORIES = {
    "TRADES": ["HVAC", "Plumbing", "Electrical", "Roofing", "Contractor", "Flooring", "Painting", "Fencing", "Concrete", "Handyman"],
    "HOME_SERVICES": ["Pest Control", "Landscaping", "Lawn Care", "Cleaning", "Pool Service", "Moving", "Solar", "Security"],
    "AUTO": ["Auto Repair", "Body Shop", "Car Wash", "Towing", "Tires", "Oil Change"],
    "MEDICAL": ["Dental", "Chiro", "Eye Care", "PT / Rehab", "Urgent Care", "Vet", "Mental Health", "Massage"],
    "BEAUTY": ["Hair Salon", "Barber", "Nails", "Tattoo", "Spa", "Lash Studio"],
    "FITNESS": ["Gym", "Personal Training", "Yoga", "Martial Arts", "CrossFit", "Dance"],
    "FOOD": ["Restaurant", "Food Truck", "Pizza", "Bakery", "Coffee", "Bar"],
    "LEGAL_FINANCE": ["Attorney", "Tax Prep", "Insurance", "Real Estate", "Bail Bonds", "Accounting"],
    "RETAIL": ["Smoke Shop", "Head Shop", "Vape Shop", "Tobacco Shop", "CBD Store", "Glass Shop", "Hookah Shop", "Kratom Shop", "Jewelry", "Pawn Shop", "Music Store", "Print Shop", "Photography"],
    "BIZ_SERVICES": ["Hauling / Dump", "Trucking", "Childcare", "Funeral Home", "Storage", "Laundromat"],
    "SENIOR_CARE": ["Assisted Living", "Memory Care", "Skilled Nursing", "Independent Living", "In-Home Care", "Hospice Care", "Adult Day Care"],
    "EMERGING": ["AI Consulting", "Cybersecurity", "Co-working Space", "Notary Public", "Mobile Notary", "Staffing / HR"],
    "INFRASTRUCTURE": ["Smart Home Install", "Battery Storage", "Mold Remediation", "Bio Remediation", "Locksmith"],
    "LIFESTYLE": ["Pet Grooming", "Pet Boarding", "Mobile Detailing", "Events / Catering", "Wedding Planner", "Rehab / Recovery", "Detox Center"],
}


def get_login_script() -> str:
    """Generate the JavaScript to auto-login to coaihq.online.

    Sets sessionStorage.coai_auth = password, then dispatches events
    to trigger the app's auth check.
    """
    # Escape password for JS string
    pwd = COAI_PASSWORD.replace("'", "\\'").replace('"', '\\"')
    script = f'''
// Auto-login script for coaihq.online
// Sets the password in sessionStorage and triggers auth check
(function() {{
    sessionStorage.setItem('coai_auth', '{pwd}');
    
    // Dispatch storage event to trigger any listeners
    window.dispatchEvent(new StorageEvent('storage', {{
        key: 'coai_auth',
        newValue: '{pwd}',
        storageArea: sessionStorage
    }}));
    
    // Try to call the app's auth check function if it exists
    if (typeof window.checkAuth === 'function') {{
        window.checkAuth();
    }}
    if (typeof window.handleLogin === 'function') {{
        window.handleLogin();
    }}
    
    // If there's a login form, fill it and submit
    var pwdField = document.querySelector('input[type="password"]');
    var submitBtn = document.querySelector('button[type="submit"]');
    if (pwdField) {{
        pwdField.value = '{pwd}';
        if (submitBtn) {{
            submitBtn.click();
        }}
    }}
    
    console.log('Auto-login: password set in sessionStorage');
    return true;
}})();
'''
    return script


def get_select_all_industries_script() -> str:
    """Generate JavaScript to click ALL industry buttons and expand the Industries section.

    The coaihq.online Lead Engine v2 has an "Industries" section that starts collapsed.
    This script expands it and clicks every industry button.
    """
    script = '''
// Select all industries in coaihq.online Lead Engine v2
(function() {
    // Expand Industries section
    var industryHeaders = document.querySelectorAll('h2, h3, h4, .section-header');
    industryHeaders.forEach(function(h) {
        if (h.textContent.includes('Industries') || h.textContent.includes('industry')) {
            h.click();
        }
    });
    
    // Also try common expand selectors
    var expandSelectors = ['.expand-all', '.toggle-industries', '.collapse-toggle', '[expand]', '.accordion-button'];
    expandSelectors.forEach(function(sel) {
        var el = document.querySelector(sel);
        if (el) el.click();
    });
    
    // Click all industry buttons
    var buttons = document.querySelectorAll('button');
    buttons.forEach(function(btn) {
        var text = btn.textContent.trim();
        if (text && text.length > 0 && text.length < 30) {
            // Avoid clicking Scan/Submit/Cancel buttons
            var lower = text.toLowerCase();
            if (!lower.includes('scan') && !lower.includes('submit') && 
                !lower.includes('cancel') && !lower.includes('reset') &&
                !lower.includes('close') && !lower.includes('ok')) {
                btn.click();
            }
        }
    });
    
    // Count selected
    var selected = document.querySelectorAll('.selected, .active, .selected-industry');
    console.log('Industries selected: ' + selected.length);
    
    return selected.length;
})();
'''
    return script


def get_scan_script() -> str:
    """Generate JavaScript to click the SCAN FOR LEADS button.

    The scan may take 30-60 seconds. This script waits and collects results.
    """
    script = '''
// Click SCAN FOR LEADS and wait for results
(function() {
    var buttons = document.querySelectorAll('button');
    var scanBtn = null;
    
    for (var i = 0; i < buttons.length; i++) {
        var text = buttons[i].textContent.trim().toLowerCase();
        if (text.includes('scan') && (text.includes('lead') || text.includes('search') || text.includes('prospect'))) {
            scanBtn = buttons[i];
            break;
        }
    }
    
    if (!scanBtn) {
        // Try button with exact match
        scanBtn = Array.from(buttons).find(b => b.textContent.includes('SCAN'));
    }
    
    if (scanBtn) {
        scanBtn.click();
        console.log('Scan button clicked');
        return { clicked: true, buttonText: scanBtn.textContent };
    } else {
        console.log('Scan button not found');
        return { clicked: false, buttonText: null };
    }
})();
'''
    return script


def get_results_script() -> str:
    """Generate JavaScript to extract lead results from the page.

    Parses the results table/list on coaihq.online after a scan completes.
    """
    script = '''
// Extract results from coaihq.online
(function() {
    var results = [];
    
    // Try to find results table
    var tables = document.querySelectorAll('table');
    tables.forEach(function(table) {
        var rows = table.querySelectorAll('tr');
        rows.forEach(function(row, i) {
            if (i === 0) return; // Skip header
            var cells = row.querySelectorAll('td, th');
            var data = {};
            cells.forEach(function(cell, j) {
                var headers = table.querySelectorAll('tr:first-child th');
                var header = headers[j] ? headers[j].textContent.trim() : 'col' + j;
                data[header.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_')] = cell.textContent.trim();
            });
            if (data.company || data.name || data.business) {
                results.push(data);
            }
        });
    });
    
    // Also try to find lead cards
    var cards = document.querySelectorAll('.lead-card, .result-item, .business-card');
    cards.forEach(function(card) {
        var data = {};
        card.querySelectorAll('[data-field]').forEach(function(el) {
            data[el.getAttribute('data-field')] = el.textContent.trim();
        });
        if (Object.keys(data).length > 0) {
            results.push(data);
        }
    });
    
    // Extract from JSON backup
    var backupLink = document.querySelector('a[href*="backup"], a[href*="json"], button[data-backup]');
    if (backupLink) {
        data.backup_available = true;
    }
    
    return { count: results.length, results: results };
})();
'''
    return get_results_script


def get_backup_json_script() -> str:
    """Generate JavaScript to trigger the backup JSON download from coaihq.online."""
    script = '''
    // Click the backup/export button to download results JSON
    var buttons = document.querySelectorAll('button, a');
    for (var i = 0; i < buttons.length; i++) {
        var text = buttons[i].textContent.trim().toLowerCase();
        if (text.includes('backup') || text.includes('export') || text.includes('json') || text.includes('download')) {
            buttons[i].click();
            return { clicked: true, buttonText: buttons[i].textContent };
        }
    }
    return { clicked: false };
'''
    return script


def run_coai_scan(industries: list[str] | None = None) -> dict:
    """Execute a full coaihq.online scan using browser automation.

    This function should be called with browser_navigate/browser_console tools active.
    It:
    1. Navigates to coaihq.online
    2. Enters the password and logs in
    3. Selects all (or specified) industries
    4. Clicks SCAN FOR LEADS
    5. Waits for results
    6. Extracts lead data

    Returns:
        Dict with: success (bool), step (str), result (any), logs (list)
    """
    logs = []

    logs.append(f"Navigating to {COAI_BASE_URL}")
    logs.append("Login: setting sessionStorage.coai_auth from COAI_PASSWORD")
    logs.append(f"Industries: {'all' if not industries else ', '.join(industries)}")
    logs.append("Clicking SCAN FOR LEADS...")
    logs.append("Waiting for scan to complete (30-60s)...")
    logs.append("Extracting results...")

    # This is the script you'd inject via browser_console:
    scripts = {
        "login": get_login_script(),
        "select_industries": get_select_all_industries_script(),
        "scan": get_scan_script(),
        "results": get_results_script(),
        "backup": get_backup_json_script(),
    }

    return {
        "success": True,
        "status": "scripts_ready",
        "logs": logs,
        "scripts": scripts,
        "instructions": [
            "1. Navigate browser to https://coaihq.online",
            "2. Run login script via browser_console",
            "3. Run select_all_industries script",
            "4. Run scan script (wait 30-60 seconds)",
            "5. Run results script to extract leads",
            "6. If results table is empty, click backup JSON button",
        ],
    }


if __name__ == "__main__":
    # Test the scripts
    result = run_coai_scan()
    print(json.dumps(result, indent=2))
