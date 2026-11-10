// src/services/apiSports.js
// ADAPTADOR OFICIAL PARA API-SPORTS (api-sports.io)
// Provee cuotas de Pinnacle y Bet365, alineaciones confirmadas y estadísticas de jugadores.
// Cuota: 100 requests / día (reseteo diario a las 00:00 UTC).

import { fetchWithRetry } from './httpClient.js';

// Sin llave en el codigo: solo APISPORTS_KEY en variables de entorno (servidor).
const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 Horas de caché (consumo mínimo: ~2 a 4 req/día)

const memoryCache = new Map();

// Pool de llaves API-Sports (rotación 2026-11-10).
// El plan gratuito da 100 req/día POR LLAVE, y /futuro consume hasta 30 por toque,
// así que una sola llave se satura. Con 2 llaves el tope diario es 200.
// Configuración en Vercel: APISPORTS_KEYS con las llaves separadas por coma
// (ej. "llaveNueva,llaveVieja"); APISPORTS_KEY singular sigue funcionando como respaldo.
// La llave vieja suspendida NO debe entrar al pool hasta confirmar su desbloqueo:
// cada petición con ella fallaría y la mitad del tráfico se perdería.
// Cada invocación usa la siguiente llave sana (round-robin); una llave que responde
// 429 o suspensión se marca no saludable en ESTA instancia y las siguientes
// invocaciones usan la otra. Si todas están marcadas, se usa la primera y el
// llamador degrada y usa el respaldo, igual que con una sola llave.
// Los valores de las llaves nunca se registran en logs ni se devuelven: solo
// se exponen los últimos 4 caracteres enmascarados (ver getApiSportsStatusAll).
export const inMemoryUnhealthyApiSportsKeys = new Set();
let lastApiSportsKeyIndex = -1;

export function getApiSportsKeys() {
  if (typeof process !== 'undefined' && process.env) {
    // APISPORTS_KEYS (plural) tiene precedencia EXCLUSIVA: si existe, la singular
    // se ignora, para que una llave vieja suspendida no contamine el pool.
    const plural = (process.env.APISPORTS_KEYS || '').trim();
    if (plural) {
      return [...new Set(plural.split(/[\n,;]+/).map((k) => k.trim()).filter((k) => k.length > 10))];
    }
    const singular = (process.env.APISPORTS_KEY || process.env.API_SPORTS_KEY || '').trim();
    if (singular) {
      return [...new Set(singular.split(/[\n,;]+/).map((k) => k.trim()).filter((k) => k.length > 10))];
    }
  }
  return [];
}

export function getApiSportsKeyEntry() {
  const keys = getApiSportsKeys();
  if (!keys.length) return { key: '', index: -1 };
  const healthy = keys.map((key, index) => ({ key, index }))
    .filter(({ key }) => !inMemoryUnhealthyApiSportsKeys.has(key));
  const pool = healthy.length ? healthy : keys.map((key, index) => ({ key, index }));
  lastApiSportsKeyIndex = (lastApiSportsKeyIndex + 1) % pool.length;
  return pool[lastApiSportsKeyIndex];
}

export function getApiSportsKey() {
  return getApiSportsKeyEntry().key;
}

export function markApiSportsKeyUnhealthy(key, _reason = '') {
  if (key) inMemoryUnhealthyApiSportsKeys.add(key);
}

export function resetApiSportsKeyHealth() {
  inMemoryUnhealthyApiSportsKeys.clear();
  lastApiSportsKeyIndex = -1;
}

export function getApiSportsPoolState() {
  const keys = getApiSportsKeys();
  const unhealthy = keys.filter((k) => inMemoryUnhealthyApiSportsKeys.has(k)).length;
  return { total: keys.length, healthy: keys.length - unhealthy, unhealthy };
}

/**
 * Consulta el estado de cuenta y consumo de cuota diaria en API-Sports
 * para UNA llave (por defecto, la siguiente del pool). Detecta la suspensión
 * tanto por HTTP como por el cuerpo de errores de la API.
 */
export async function getApiSportsStatus(apiKeyOverride = '') {
  const apiKey = apiKeyOverride || getApiSportsKey();
  if (!apiKey) {
    return { success: false, error: 'APISPORTS_KEY no configurada', requestsUsedToday: null, dailyLimit: 100, remainingToday: null, suspended: false, status: '🔴 ERROR' };
  }
  try {
    const res = await fetchWithRetry('https://v3.football.api-sports.io/status', {
      headers: { 'x-apisports-key': apiKey }
    }, { retries: 1, timeoutMs: 5000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const errorText = Object.values(data.errors || {}).join(' ');
    if (/suspended/i.test(errorText)) {
      return { success: false, error: errorText.slice(0, 180), requestsUsedToday: null, dailyLimit: 100, remainingToday: null, suspended: true, status: '🔴 SUSPENDIDA' };
    }
    return {
      success: true,
      account: data.response?.account?.firstname + ' ' + (data.response?.account?.lastname || ''),
      email: data.response?.account?.email,
      plan: data.response?.subscription?.plan || 'Free',
      active: data.response?.subscription?.active,
      expires: data.response?.subscription?.end,
      requestsUsedToday: data.response?.requests?.current ?? 0,
      dailyLimit: data.response?.requests?.limit_day ?? 100,
      remainingToday: (data.response?.requests?.limit_day ?? 100) - (data.response?.requests?.current ?? 0),
      suspended: false,
      status: '🟢 CONECTADA Y OPERATIVA'
    };
  } catch (err) {
    const suspended = /suspended/i.test(err.message || '');
    return {
      success: false,
      error: err.message,
      requestsUsedToday: null,
      dailyLimit: 100,
      remainingToday: null,
      suspended,
      status: suspended ? '🔴 SUSPENDIDA' : '🔴 ERROR'
    };
  }
}

/**
 * Estado de TODAS las llaves del pool (1 petición /status por llave).
 * Nunca expone valores: solo los últimos 4 caracteres enmascarados.
 */
export async function getApiSportsStatusAll() {
  const keys = getApiSportsKeys();
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    const status = await getApiSportsStatus(keys[i]);
    results.push({
      id: `Llave ${i + 1}`,
      key: `****${keys[i].slice(-4)}`,
      ...status
    });
  }
  const totalCapacity = results.reduce((acc, r) => acc + (r.dailyLimit || 0), 0);
  const totalUsed = results.reduce((acc, r) => acc + (r.requestsUsedToday || 0), 0);
  const totalRemaining = results.reduce((acc, r) => acc + (r.remainingToday || 0), 0);
  return {
    poolSummary: {
      totalKeys: keys.length,
      healthyKeys: results.filter((r) => r.success && !r.suspended).length,
      suspendedKeys: results.filter((r) => r.suspended).length,
      totalCapacity,
      totalRemaining,
      totalUsed,
      usagePercentage: totalCapacity > 0 ? ((totalUsed / totalCapacity) * 100).toFixed(1) + '%' : '0%'
    },
    keys: results
  };
}

/**
 * Descarga y normaliza cuotas de Pinnacle (y Bet365 de respaldo) para todos los partidos del día
 * @param {string} dateStr - Fecha en formato YYYY-MM-DD
 * @returns {Promise<Array>} Lista de partidos con cuotas de Pinnacle / Bet365
 */
export async function fetchApiSportsPinnacleOdds(dateStr = null) {
  const targetDate = dateStr || new Date().toISOString().split('T')[0];
  const cacheKey = `pinnacle_odds_${targetDate}`;
  const now = Date.now();

  // 1. Revisar caché en memoria
  if (memoryCache.has(cacheKey)) {
    const cached = memoryCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const apiKey = getApiSportsKey();
  if (!apiKey) return [];
  const headers = { 'x-apisports-key': apiKey };

  try {
    console.log(`[API-Sports] Consultando fixtures y cuotas Pinnacle para ${targetDate}...`);

    // Descarga paralela: fixtures del día + cuotas de Pinnacle (bookmaker 4)
    const [fixturesRes, oddsPinnacleRes] = await Promise.all([
      fetchWithRetry(`https://v3.football.api-sports.io/fixtures?date=${targetDate}`, { headers }, { retries: 1, timeoutMs: 8000 }).then(r => (r.ok ? r.json() : { response: [] })),
      fetchWithRetry(`https://v3.football.api-sports.io/odds?date=${targetDate}&bookmaker=4`, { headers }, { retries: 1, timeoutMs: 8000 }).then(r => (r.ok ? r.json() : { response: [] }))
    ]);

    const fixtureMap = new Map();
    (fixturesRes.response || []).forEach(f => {
      if (f.fixture?.id && f.teams?.home?.name && f.teams?.away?.name) {
        fixtureMap.set(f.fixture.id, {
          homeTeam: f.teams.home.name,
          awayTeam: f.teams.away.name,
          league: f.league?.name || 'Fútbol',
          country: f.league?.country || ''
        });
      }
    });

    const parsedEvents = [];
    (oddsPinnacleRes.response || []).forEach(item => {
      const fixInfo = fixtureMap.get(item.fixture?.id);
      if (!fixInfo) return;

      const bookmaker = item.bookmakers?.[0];
      if (!bookmaker) return;

      const mlBet = bookmaker.bets?.find(b => b.name === 'Match Winner');
      const ouBet = bookmaker.bets?.find(b => b.name === 'Goals Over/Under');
      const ahBet = bookmaker.bets?.find(b => b.name === 'Asian Handicap');

      const homeMl = mlBet?.values?.find(v => v.value === 'Home')?.odd;
      const drawMl = mlBet?.values?.find(v => v.value === 'Draw')?.odd;
      const awayMl = mlBet?.values?.find(v => v.value === 'Away')?.odd;

      const over25 = ouBet?.values?.find(v => v.value === 'Over 2.5')?.odd;
      const under25 = ouBet?.values?.find(v => v.value === 'Under 2.5')?.odd;

      const ahHomeMinus15 = ahBet?.values?.find(v => v.value === 'Home -1.5')?.odd;
      const ahAwayPlus15 = ahBet?.values?.find(v => v.value === 'Away +1.5')?.odd;

      parsedEvents.push({
        homeTeam: fixInfo.homeTeam,
        awayTeam: fixInfo.awayTeam,
        league: fixInfo.league,
        bookmaker: 'Pinnacle',
        isPinnacle: true,
        source: 'api-sports',
        moneyline: {
          home: homeMl ? parseFloat(homeMl) : null,
          away: awayMl ? parseFloat(awayMl) : null,
          draw: drawMl ? parseFloat(drawMl) : null
        },
        spread: {
          homePoint: -1.5,
          homeOdds: ahHomeMinus15 ? parseFloat(ahHomeMinus15) : null,
          awayOdds: ahAwayPlus15 ? parseFloat(ahAwayPlus15) : null
        },
        totals: {
          line: 2.5,
          overOdds: over25 ? parseFloat(over25) : null,
          underOdds: under25 ? parseFloat(under25) : null
        }
      });
    });

    if (parsedEvents.length > 0) {
      console.log(`🏛️ [API-Sports] ${parsedEvents.length} partidos sincronizados con cuotas Pinnacle en tiempo real.`);
      memoryCache.set(cacheKey, { data: parsedEvents, timestamp: now });
      return parsedEvents;
    }

    return [];
  } catch (err) {
    console.warn('[API-Sports] Error consultando cuotas Pinnacle:', err.message);
    return [];
  }
}
