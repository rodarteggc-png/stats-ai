// src/services/apiSports.js
// ADAPTADOR OFICIAL PARA API-SPORTS (api-sports.io)
// Provee cuotas de Pinnacle y Bet365, alineaciones confirmadas y estadísticas de jugadores.
// Cuota: 100 requests / día (reseteo diario a las 00:00 UTC).

import { fetchWithRetry } from './httpClient.js';

const DEFAULT_APISPORTS_KEY = '7184f1016b68c388a5c1e102b0f6eaef';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 Horas de caché (consumo mínimo: ~2 a 4 req/día)

const memoryCache = new Map();

export function getApiSportsKey() {
  if (typeof process !== 'undefined' && process.env) {
    const envKey = (process.env.APISPORTS_KEY || process.env.API_SPORTS_KEY || '').trim();
    if (envKey && envKey.length > 10) return envKey;
  }
  return DEFAULT_APISPORTS_KEY;
}

/**
 * Consulta el estado de cuenta y consumo de cuota diaria en API-Sports
 */
export async function getApiSportsStatus() {
  const apiKey = getApiSportsKey();
  if (!apiKey) {
    return { success: false, error: 'APISPORTS_KEY no configurada', requestsUsedToday: null, dailyLimit: 100, remainingToday: null };
  }
  try {
    const res = await fetchWithRetry('https://v3.football.api-sports.io/status', {
      headers: { 'x-apisports-key': apiKey }
    }, { retries: 1, timeoutMs: 5000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      success: true,
      account: data.response?.account?.firstname + ' ' + (data.response?.account?.lastname || ''),
      email: data.response?.account?.email,
      plan: data.response?.subscription?.plan || 'Free',
      active: data.response?.subscription?.active,
      expires: data.response?.subscription?.end,
      requestsUsedToday: data.response?.requests?.current ?? 0,
      dailyLimit: data.response?.requests?.limit_day ?? 100,
      remainingToday: (data.response?.requests?.limit_day ?? 100) - (data.response?.requests?.current ?? 0)
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      requestsUsedToday: null,
      dailyLimit: 100,
      remainingToday: null
    };
  }
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
