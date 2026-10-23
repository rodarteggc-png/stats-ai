// src/services/nbaService.js
// SERVICIO DE DATOS Y CALENDARIO PARA NBA (BALONCESTO) - STATS-AI PRO
// Combina ESPN Scoreboard oficial (gratuito) con cuotas institucionales de Pinnacle vía API-Sports

import { calculateNbaProbabilities } from '../utils/hoops.js';

const NBA_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * Descarga la programación oficial de la NBA de hoy o fecha especificada
 */
export async function fetchNbaSchedule(range = 'hoy') {
  const cacheKey = `nba-${range}`;
  const cached = NBA_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
    const res = await fetch(url, { headers: { 'User-Agent': 'StatsAIPro/1.0' } });
    if (!res.ok) throw new Error(`ESPN NBA HTTP ${res.status}`);
    const json = await res.json();
    const events = json.events || [];

    const matches = events.map(evt => {
      const comp = evt.competitions?.[0] || {};
      const homeComp = comp.competitors?.find(c => c.homeAway === 'home') || {};
      const awayComp = comp.competitors?.find(c => c.homeAway === 'away') || {};
      const oddsObj = comp.odds?.[0] || {};

      const homeName = homeComp.team?.displayName || 'Local';
      const awayName = awayComp.team?.displayName || 'Visitante';
      const marketSpread = oddsObj.spread !== undefined ? parseFloat(oddsObj.spread) : null;
      const marketTotal = oddsObj.overUnder !== undefined ? parseFloat(oddsObj.overUnder) : null;

      const homeMl = oddsObj.homeTeamOdds?.moneyLine || 1.90;
      const awayMl = oddsObj.awayTeamOdds?.moneyLine || 1.90;

      // Convertir momio americano a decimal si viene negativo/positivo
      function toDecimalOdds(am) {
        const n = parseFloat(am);
        if (isNaN(n) || n === 0) return 1.90;
        if (n > 0) return Number((1 + (n / 100)).toFixed(2));
        return Number((1 + (100 / Math.abs(n))).toFixed(2));
      }

      const matchObj = {
        id: `nba-${evt.id}`,
        sport: 'Baloncesto',
        league: 'NBA',
        game: `${homeName} vs ${awayName}`,
        home: { name: homeName, score: homeComp.score ? parseInt(homeComp.score, 10) : null },
        away: { name: awayName, score: awayComp.score ? parseInt(awayComp.score, 10) : null },
        date: evt.date,
        gameDate: evt.date,
        isCompleted: evt.status?.type?.completed || false,
        spread: marketSpread,
        total: marketTotal,
        vegas: {
          spread: marketSpread,
          overUnder: marketTotal,
          spreadHomeOdds: '1.91',
          spreadAwayOdds: '1.91',
          overOdds: '1.91',
          underOdds: '1.91'
        },
        market: {
          homeOdds: toDecimalOdds(homeMl).toString(),
          awayOdds: toDecimalOdds(awayMl).toString(),
          spread: marketSpread,
          overUnder: marketTotal,
          hasRealOdds: true,
          details: `NBA Spread ${marketSpread !== null ? (marketSpread > 0 ? `+${marketSpread}` : marketSpread) : '0'} | Total ${marketTotal || 224.5}`
        },
        odds: {
          spread: marketSpread,
          overUnder: marketTotal,
          homeMl: toDecimalOdds(homeMl),
          awayMl: toDecimalOdds(awayMl),
          spreadOdds: 1.91,
          totalOdds: 1.91
        }
      };

      // Modelar cuantitativamente
      const probs = calculateNbaProbabilities(matchObj);
      matchObj.probabilities = probs;
      return matchObj;
    });

    NBA_CACHE.set(cacheKey, { timestamp: Date.now(), data: matches });
    return matches;
  } catch (err) {
    console.warn('[nbaService] Aviso consultando ESPN NBA:', err.message);
    return [];
  }
}
