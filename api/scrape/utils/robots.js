const robotsParser = require('robots-parser');
const { URL } = require('url');

const cache = new Map();

async function fetchRobotsTxt(domain) {
  try {
    const resp = await fetch(`https://${domain}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

async function isAllowed(url, userAgent = 'COAIScraper/2.0') {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname;

    if (!cache.has(domain)) {
      const body = await fetchRobotsTxt(domain);
      if (body) {
        cache.set(domain, robotsParser(`https://${domain}/robots.txt`, body));
      } else {
        cache.set(domain, null);
      }
    }

    const robots = cache.get(domain);
    if (!robots) return true;

    const allowed = robots.isAllowed(url, userAgent);
    const delay = robots.getCrawlDelay(userAgent) || 0;

    return { allowed, crawlDelay: delay };
  } catch {
    return { allowed: true, crawlDelay: 0 };
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { isAllowed, clearCache };
