// Decision tree orchestrator
// Tries each transport level in order, escalates on failure

const { withBackoff } = require('../utils/retry');
const { throttle } = require('../utils/rateLimit');
const { isAllowed } = require('../utils/robots');
const httpDirect = require('../transport/httpDirect');
const proxyLayer = require('../transport/proxyLayer');
const browser = require('../transport/browser');
const { validateResult, detectAnomalies } = require('./validate');

const IS_FREE_TIER = !process.env.PROXY_USERNAME && !process.env.CAPSOLVER_API_KEY;

const TRANSPORT_LEVELS = [
  { name: 'httpDirect', fn: httpDirect.scrape, level: 1 },
  ...(process.env.PROXY_USERNAME ? [{ name: 'proxyLayer', fn: proxyLayer.scrape, level: 2 }] : []),
  { name: 'browser', fn: browser.scrape, level: 3 },
];

async function escalate(url, options = {}) {
  const {
    respectRobots = true,
    skipLevels = [],
  } = options;

  if (respectRobots) {
    const robotCheck = await isAllowed(url);
    if (robotCheck && !robotCheck.allowed) {
      return {
        ok: false,
        data: { email: null, phone: null, emails: [], phones: [], phone_records: [], pages_scanned: [], extraction_notes: ['blocked by robots.txt'] },
        level: 0,
        error: `blocked by robots.txt`,
      };
    }
  }

  await throttle(url);

  for (const transport of TRANSPORT_LEVELS) {
    if (skipLevels.includes(transport.level)) continue;

    try {
      const maxRetries = IS_FREE_TIER ? 0 : 2;
      const result = await withBackoff(
        async () => {
          const r = await transport.fn(url);
          if (!r.ok) throw new Error(r.error || `${transport.name} failed`);
          return r;
        },
        {
          maxRetries,
          baseDelay: 2000,
          onRetry: (attempt, max, err) => {
            console.error(`[${transport.name}] retry ${attempt}/${max}: ${err.message}`);
          },
        }
      );

      const validated = validateResult(result);
      const anomalies = validated.data?.data ? detectAnomalies(validated.data.data) : [];

      return {
        ...result,
        transport: transport.name,
        warnings: [...(validated.warnings || []), ...anomalies],
      };
    } catch (err) {
      console.error(`[escalation] ${transport.name} failed, escalating: ${err.message}`);
      continue;
    }
  }

  return {
    ok: false,
    data: { email: null, phone: null, emails: [], phones: [], phone_records: [], pages_scanned: [], extraction_notes: ['all transport levels exhausted'] },
    level: 4,
    error: 'all transport levels exhausted',
  };
}

module.exports = { escalate };
