const { URL } = require('url');

const domainTimestamps = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function throttle(url, minIntervalMs = 3000) {
  const domain = getDomain(url);
  if (!domain) return;

  const now = Date.now();
  const last = domainTimestamps.get(domain) || 0;
  const elapsed = now - last;

  if (elapsed < minIntervalMs) {
    const wait = minIntervalMs - elapsed;
    await new Promise(resolve => setTimeout(resolve, wait));
  }

  domainTimestamps.set(domain, Date.now());
}

function reset() {
  domainTimestamps.clear();
}

module.exports = { throttle, reset };
