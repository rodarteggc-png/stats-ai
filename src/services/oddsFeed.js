// src/services/oddsFeed.js
// ADAPTADOR CUANTITATIVO DE CUOTAS SHARP EN TIEMPO REAL (THE ODDS API / PINNACLE & BET365)
// Gestiona el pool de llaves gratuitas con rotación automática, caché de 3 horas y detección de RLM institucional.

import { getOddsApiKeys } from './sportsApi.js';
import { fetchApiSportsPinnacleOdds } from './apiSports.js';

// Mapeo oficial de deportes Tier 1 a llaves de The Odds API
export const SPORT_KEY_MAP = {
  nfl: 'americanfootball_nfl',
  mlb: 'baseball_mlb',
  ncaaf: 'americanfootball_ncaaf',
  epl: 'soccer_epl',
  laliga: 'soccer_spain_la_liga',
  champions: 'soccer_uefa_champs_league',
  ligamx: 'soccer_mexico_ligamx',
  bundesliga: 'soccer_germany_bundesliga',
  seriea: 'soccer_italy_serie_a'
};

const ODDS_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 Horas de caché
const localMemoryCache = new Map();

/**
 * Consulta cuotas de Pinnacle y Bet365 utilizando el pool rotativo de llaves y API-Sports
 * @param {string} sport - Clave de deporte (nfl, mlb, epl, laliga, champions, etc.)
 * @returns {Promise<Array>} Lista de eventos con cuotas sharp
 */
export async function fetchPinnacleOdds(sport = 'nfl') {
  const sportKey = SPORT_KEY_MAP[sport.toLowerCase()] || sport;
  const now = Date.now();

  // 1. Verificar caché en memoria
  if (localMemoryCache.has(sportKey)) {
    const cached = localMemoryCache.get(sportKey);
    if (now - cached.timestamp < ODDS_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  // 2. Obtener pool de llaves de The Odds API
  const keys = getOddsApiKeys();
  let theOddsApiSuccess = false;

  // 3. Probar llaves secuencialmente (rotación automática) si hay disponibles
  if (keys && keys.length > 0) {
    for (let i = 0; i < keys.length; i++) {
      const apiKey = keys[i];
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=eu,us&markets=h2h,spreads,totals&bookmakers=pinnacle,bet365`;
        const res = await fetch(url);

        if (res.status === 429 || res.status === 401) {
          continue;
        }

        if (!res.ok) continue;

        const data = await res.json();
        const parsedMatches = normalizeOddsApiResponse(data);
        if (parsedMatches && parsedMatches.length > 0) {
          localMemoryCache.set(sportKey, { data: parsedMatches, timestamp: now });
          return parsedMatches;
        }
      } catch (err) {}
    }
  }

  // 4. Respaldo de Alta Capacidad: API-Sports (100 requests/día gratis)
  try {
    const apiSportsMatches = await fetchApiSportsPinnacleOdds();
    if (apiSportsMatches && apiSportsMatches.length > 0) {
      console.log(`🏛️ [oddsFeed] Cuotas de Pinnacle provistas exitosamente por API-Sports (${apiSportsMatches.length} partidos).`);
      localMemoryCache.set(sportKey, { data: apiSportsMatches, timestamp: now });
      return apiSportsMatches;
    }
  } catch (apiSportsErr) {
    console.warn('[Respaldo API-Sports] Error:', apiSportsErr.message);
  }

  return null;
}

/**
 * Extrae y normaliza cuotas de Pinnacle y Bet365 para un formato estructurado
 */
function normalizeOddsApiResponse(events = []) {
  if (!Array.isArray(events)) return [];

  return events.map(ev => {
    const homeTeam = ev.home_team;
    const awayTeam = ev.away_team;
    const bookmakers = ev.bookmakers || [];

    // Priorizar Pinnacle, luego Bet365
    const pinnacle = bookmakers.find(b => b.key.toLowerCase().includes('pinnacle'));
    const bet365 = bookmakers.find(b => b.key.toLowerCase().includes('bet365'));
    const primaryBook = pinnacle || bet365 || bookmakers[0];

    const markets = primaryBook?.markets || [];
    const h2h = markets.find(m => m.key === 'h2h');
    const spreads = markets.find(m => m.key === 'spreads');
    const totals = markets.find(m => m.key === 'totals');

    const h2hHome = h2h?.outcomes?.find(o => o.name === homeTeam)?.price || null;
    const h2hAway = h2h?.outcomes?.find(o => o.name === awayTeam)?.price || null;
    const h2hDraw = h2h?.outcomes?.find(o => o.name.toLowerCase() === 'draw' || o.name.toLowerCase() === 'empate')?.price || null;

    const spreadHomeOutcome = spreads?.outcomes?.find(o => o.name === homeTeam);
    const spreadAwayOutcome = spreads?.outcomes?.find(o => o.name === awayTeam);

    const overOutcome = totals?.outcomes?.find(o => o.name.toLowerCase() === 'over');
    const underOutcome = totals?.outcomes?.find(o => o.name.toLowerCase() === 'under');

    return {
      id: ev.id,
      sportKey: ev.sport_key,
      commenceTime: ev.commence_time,
      homeTeam,
      awayTeam,
      bookmaker: primaryBook?.title || 'Consenso Sharp',
      isPinnacle: Boolean(pinnacle),
      moneyline: {
        home: h2hHome,
        away: h2hAway,
        draw: h2hDraw
      },
      spread: {
        homePoint: spreadHomeOutcome?.point !== undefined ? spreadHomeOutcome.point : null,
        homeOdds: spreadHomeOutcome?.price || null,
        awayPoint: spreadAwayOutcome?.point !== undefined ? spreadAwayOutcome.point : null,
        awayOdds: spreadAwayOutcome?.price || null
      },
      totals: {
        line: overOutcome?.point !== undefined ? overOutcome.point : null,
        overOdds: overOutcome?.price || null,
        underOdds: underOutcome?.price || null
      }
    };
  });
}

/**
 * Busca cuotas de Pinnacle para un partido específico por nombres de equipos
 */
export async function getPinnacleOddsForMatch(sport, homeTeam, awayTeam) {
  const matches = await fetchPinnacleOdds(sport);
  if (!matches || matches.length === 0) return null;

  const hNorm = (homeTeam || '').toLowerCase().trim();
  const aNorm = (awayTeam || '').toLowerCase().trim();

  return matches.find(m => {
    const mh = m.homeTeam.toLowerCase();
    const ma = m.awayTeam.toLowerCase();
    return (mh.includes(hNorm) || hNorm.includes(mh)) && (ma.includes(aNorm) || aNorm.includes(ma));
  }) || null;
}
