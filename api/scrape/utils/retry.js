function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(baseMs) {
  return baseMs + Math.floor(Math.random() * 1000);
}

async function withBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 2000,
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = jitter(Math.pow(2, attempt) * baseDelay);
        if (onRetry) onRetry(attempt, maxRetries, err, delay);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

module.exports = { withBackoff, sleep, jitter };
