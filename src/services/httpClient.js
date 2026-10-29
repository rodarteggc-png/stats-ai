// src/services/httpClient.js
// Cliente HTTP resiliente: timeout, reintentos con backoff exponencial + jitter y circuit breaker por host.

const breakers = new Map();
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 2 * 60 * 1000;

function getHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function isCircuitOpen(host) {
  const b = breakers.get(host);
  if (!b || b.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - b.openedAt > BREAKER_COOLDOWN_MS) {
    // Half-open: permite una petición de prueba
    b.failures = BREAKER_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordFailure(host) {
  const b = breakers.get(host) || { failures: 0, openedAt: 0 };
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD) b.openedAt = Date.now();
  breakers.set(host, b);
}

function recordSuccess(host) {
  breakers.delete(host);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * fetch con timeout, reintentos (5xx, 429, errores de red) y circuit breaker.
 * Los 4xx distintos de 429 se devuelven sin reintentar (errores del cliente/llave inválida).
 */
export async function fetchWithRetry(url, options = {}, { retries = 2, timeoutMs = 6000, baseDelayMs = 400, maxDelayMs = 4000 } = {}) {
  const host = getHost(url);
  if (isCircuitOpen(host)) {
    throw new Error(`Circuit breaker abierto para ${host}`);
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} en ${host}`);
        if (attempt < retries) {
          const retryAfter = parseFloat(res.headers.get('retry-after'));
          const backoff = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, maxDelayMs)
            : Math.min(baseDelayMs * 2 ** attempt, maxDelayMs) * (0.5 + Math.random());
          await sleep(backoff);
          continue;
        }
        recordFailure(host);
        return res;
      }

      recordSuccess(host);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? new Error(`Timeout ${timeoutMs}ms en ${host}`) : err;
      if (attempt < retries) {
        await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs) * (0.5 + Math.random()));
      }
    }
  }

  recordFailure(host);
  throw lastError;
}

export function getCircuitBreakerState() {
  return Object.fromEntries([...breakers.entries()].map(([h, b]) => [h, { ...b, open: b.failures >= BREAKER_THRESHOLD }]));
}
