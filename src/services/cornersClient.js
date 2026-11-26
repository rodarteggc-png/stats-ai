// src/services/cornersClient.js - Cliente del endpoint /api/corners (2026-11-25).
// Sin llave en el navegador: el dato real de API-Sports llega por el endpoint
// serverless, mismo patrón que geminiClient.js (fetch('/api/gemini')).
// Caché en memoria POR EQUIPO (nombre normalizado + temporada), TTL 24 h: el
// servidor ya cachea 24 h por equipo, así que este caché solo evita repetir
// la llamada al endpoint dentro de la misma sesión del simulador (p. ej. si
// el usuario simula el mismo equipo contra otro rival, el equipo ya resuelto
// se reutiliza y solo se pide el faltante).
// Fail-safe: cualquier fallo (red, HTTP no-OK, JSON inválido) → nulls y el
// simulador usa el fallback xG (cornersAvg). Nunca throw.

const CLIENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// `corners_client_{nombreNormalizado}_{season}` -> { data: { avg, n } | null, timestamp }
// Se cachea también el null (equipo sin dato) para no re-preguntar en la sesión.
const clientCache = new Map();

/** Solo para tests: vacía el caché del cliente. */
export function clearCornersClientCache() {
  clientCache.clear();
}

function normalizeClientName(name) {
  return String(name || '').trim().toLowerCase();
}

function readClientCache(name, season) {
  const key = `corners_client_${normalizeClientName(name)}_${season}`;
  const entry = clientCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp >= CLIENT_CACHE_TTL_MS) {
    clientCache.delete(key);
    return undefined;
  }
  return entry.data;
}

function writeClientCache(name, season, data) {
  const key = `corners_client_${normalizeClientName(name)}_${season}`;
  clientCache.set(key, { data, timestamp: Date.now() });
}

function pickReal(value) {
  // OJO: Number(null) === 0, así que un avg null/'' debe tratarse como sin
  // dato, no como 0 córners.
  if (!value || value.avg === null || value.avg === undefined || value.avg === '') return null;
  if (!Number.isFinite(Number(value.avg))) return null;
  return {
    avg: Number(value.avg),
    n: Number.isFinite(Number(value.n)) ? Number(value.n) : 0,
  };
}

/**
 * Pide el promedio real de córners de ambos equipos al endpoint.
 * Devuelve { home: { avg, n } | null, away: { avg, n } | null }.
 * Reutiliza el caché por equipo y solo pide al endpoint los equipos que
 * faltan (el endpoint acepta un solo nombre: el otro responde null).
 * Nunca throw.
 */
export async function fetchRealCorners(homeName, awayName, season = new Date().getFullYear()) {
  const fallback = { home: null, away: null };
  try {
    if (typeof fetch !== 'function') return fallback;
    const homeCached = readClientCache(homeName, season);
    const awayCached = readClientCache(awayName, season);
    if (homeCached !== undefined && awayCached !== undefined) {
      return { home: homeCached, away: awayCached };
    }
    const params = new URLSearchParams({
      home: homeCached === undefined ? (homeName || '') : '',
      away: awayCached === undefined ? (awayName || '') : '',
      season: String(season),
    });
    const res = await fetch(`/api/corners?${params.toString()}`);
    if (!res.ok) return fallback;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return fallback;
    const home = homeCached !== undefined ? homeCached : pickReal(data.home);
    const away = awayCached !== undefined ? awayCached : pickReal(data.away);
    if (homeCached === undefined) writeClientCache(homeName, season, home);
    if (awayCached === undefined) writeClientCache(awayName, season, away);
    return { home, away };
  } catch {
    return fallback;
  }
}

/**
 * Resuelve qué valor de córners usar para UN equipo en el simulador.
 * Si hay promedio real, se usa ese (source 'real'); si no, el fallback xG
 * (cornersAvg, source 'xg'). Nunca sobreescribe el fallback: lo devuelve
 * aparte junto con el promedio real (number | null) para adjuntarlo al
 * partido como cornersAvgReal.
 */
export function resolveCornersValue(real, fallbackAvg) {
  // OJO: Number(null) === 0, así que un avg null/'' es "sin dato", no 0.
  const raw = real?.avg;
  const realAvg = (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)))
    ? Number(raw)
    : null;
  if (realAvg !== null) {
    return { value: realAvg, source: 'real', realAvg };
  }
  return { value: fallbackAvg, source: 'xg', realAvg: null };
}
