// src/services/nbaService.js
// SERVICIO DE DATOS Y CALENDARIO PARA NBA (BALONCESTO) - STATS-AI PRO
// Combina ESPN Scoreboard oficial (gratuito) con cuotas institucionales de Pinnacle vía API-Sports

import { calculateNbaProbabilities } from '../utils/hoops.js';
import { ensureLiveNbaRatings } from './nbaRatings.js';

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
    // Ratings en vivo (ESPN, temporada en curso) antes de calcular probabilidades.
    // Si ESPN falla, ensureLiveNbaRatings devuelve null y el modelo sigue con la tabla
    // estática de hoops.js: el escaneo nunca se rompe por esto.
    try {
      const live = await ensureLiveNbaRatings();
      if (live) {
        console.log(`[NBA] Ratings en vivo cargados: ${live.teams} equipos (${live.season || 'temporada en curso'}), promedio liga ORtg ${live.leagueAvg.ortg}.`);
        if (live.notices?.length) live.notices.forEach((n) => console.warn(`[NBA] ${n}`));
      } else {
        console.warn('[NBA] Ratings en vivo no disponibles; se usa la tabla estática de hoops.js.');
      }
    } catch (err) {
      console.warn('[NBA] No se pudieron cargar ratings en vivo, se usa tabla estática:', err.message);
    }

    const url = new URL('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
    if (/^\d{8}(?:-\d{8})?$/.test(range)) url.searchParams.set('dates', range);
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

      const homeMl = oddsObj.homeTeamOdds?.moneyLine ?? null;
      const awayMl = oddsObj.awayTeamOdds?.moneyLine ?? null;

      // Convertir momio americano a decimal; null si el libro no publicó precio
      function toDecimalOdds(am) {
        const n = parseFloat(am);
        if (isNaN(n) || n === 0) return null;
        if (n > 0) return Number((1 + (n / 100)).toFixed(2));
        return Number((1 + (100 / Math.abs(n))).toFixed(2));
      }
      const homeMlDec = toDecimalOdds(homeMl);
      const awayMlDec = toDecimalOdds(awayMl);
      const statusName = evt.status?.type?.name || '';
      const homeScore = homeComp.score !== undefined && homeComp.score !== '' ? parseInt(homeComp.score, 10) : null;
      const awayScore = awayComp.score !== undefined && awayComp.score !== '' ? parseInt(awayComp.score, 10) : null;

      const matchObj = {
        id: `nba-${evt.id}`,
        sport: 'Baloncesto',
        league: 'NBA',
        game: `${homeName} vs ${awayName}`,
        home: { name: homeName, score: homeScore },
        away: { name: awayName, score: awayScore },
        homeScore,
        awayScore,
        date: evt.date,
        gameDate: evt.date,
        isCompleted: evt.status?.type?.completed || false,
        statusName,
        isPostponed: /POSTPONED|CANCELED|CANCELLED|SUSPENDED/i.test(statusName),
        spread: marketSpread,
        total: marketTotal,
        vegas: {
          spread: marketSpread,
          overUnder: marketTotal,
          spreadHomeOdds: null,
          spreadAwayOdds: null,
          overOdds: null,
          underOdds: null
        },
        market: {
          homeOdds: homeMlDec ? homeMlDec.toString() : null,
          awayOdds: awayMlDec ? awayMlDec.toString() : null,
          spread: marketSpread,
          overUnder: marketTotal,
          hasRealOdds: Boolean(homeMlDec && awayMlDec),
          details: `NBA Spread ${marketSpread !== null ? (marketSpread > 0 ? `+${marketSpread}` : marketSpread) : '0'} | Total ${marketTotal || 224.5}`
        },
        odds: {
          spread: marketSpread,
          overUnder: marketTotal,
          homeMl: homeMlDec,
          awayMl: awayMlDec,
          spreadOdds: null,
          totalOdds: null
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
