// src/services/nbaService.js
// SERVICIO DE DATOS Y CALENDARIO PARA NBA (BALONCESTO) - STATS-AI PRO
// Combina ESPN Scoreboard oficial (gratuito) con cuotas institucionales de Pinnacle vía API-Sports

import { calculateNbaProbabilities } from '../utils/hoops.js';
import { ensureLiveNbaRatings } from './nbaRatings.js';

const NBA_CACHE = new Map();
// E4 (2026-11-16): 15 min, no 1 hora. El caché solo sirve para no re-descargar
// el scoreboard en llamadas repetidas dentro del mismo escaneo; las cuotas
// nunca se reutilizan más de 15 min (el gate 'odds_stale' en
// classifyOpportunity lo exige al despachar).
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

// Caché de standings NBA (1 hora: los standings cambian lento; el scoreboard
// usa 15 min porque las cuotas sí se mueven). Solo guarda racha/récord/L10.
const NBA_STANDINGS_CACHE = new Map();
const NBA_STANDINGS_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * Extrae { streak, record, lastTen } por id de equipo desde el JSON de
 * standings de ESPN (https://site.api.espn.com/apis/v2/sports/basketball/nba/standings).
 * Solo stats reales: `streak` (ej. "W3"), `overall` (ej. "10-6") y
 * `Last Ten Games` (ej. "7-3"). Un equipo sin dato real no entra al mapa
 * (fail-closed). Función pura para poder probarla sin red.
 */
export function parseNbaStandingsEntries(json) {
  const map = {};
  const entries = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.standings?.entries)) entries.push(...node.standings.entries);
    if (Array.isArray(node.children)) node.children.forEach(collect);
  };
  collect(json);
  for (const e of entries) {
    const id = String(e.team?.id || '');
    if (!id) continue;
    const stat = (name) => e.stats?.find((s) => s.name === name)?.displayValue;
    const streak = stat('streak');
    const record = stat('overall');
    const lastTen = stat('Last Ten Games');
    const entry = {};
    if (typeof streak === 'string' && streak.trim()) entry.streak = streak.trim();
    if (typeof record === 'string' && record.trim()) entry.record = record.trim();
    if (typeof lastTen === 'string' && lastTen.trim()) entry.lastTen = lastTen.trim();
    if (Object.keys(entry).length > 0) map[id] = entry;
  }
  return map;
}

export function clearNbaStandingsCache() { NBA_STANDINGS_CACHE.clear(); }

/**
 * Mapa equipo → { streak, record, lastTen } desde los standings de ESPN.
 * Fail-safe: si ESPN falla, devuelve {} y los partidos no llevan racha
 * (fail-closed en la tarjeta). Nunca inventa streak.
 */
export async function fetchNbaStandingsMap({ fetchImpl = fetch } = {}) {
  const cached = NBA_STANDINGS_CACHE.get('map');
  if (cached && (Date.now() - cached.timestamp < NBA_STANDINGS_TTL_MS)) return cached.data;
  try {
    const res = await fetchImpl('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings', { headers: { 'User-Agent': 'StatsAIPro/1.0' } });
    if (!res.ok) throw new Error(`ESPN NBA standings HTTP ${res.status}`);
    const map = parseNbaStandingsEntries(await res.json());
    NBA_STANDINGS_CACHE.set('map', { timestamp: Date.now(), data: map });
    return map;
  } catch (err) {
    console.warn('[nbaService] Standings NBA no disponibles (sin racha en tarjetas):', err.message);
    return {};
  }
}

/**
 * E1 (2026-11-16): lee los precios REALES de ESPN/DraftKings del objeto odds
 * del scoreboard. Verificado en vivo 2026-11-16 (curl): los partidos pre-juego
 * traen moneyline/pointSpread/total con {open, close} y odds americanas por
 * lado (ej. spread close -113/-107, total close -110/-110); NO existe el
 * subcampo "current" (solo open/close) y el "close" pre-juego es la línea
 * vigente. Tras el partido, ESPN retira las odds (0 entradas). El campo plano
 * homeTeamOdds.moneyLine NO viene poblado en vivo (0/63 eventos 16 nov):
 * el ML real solo existe en moneyline.{home,away}.close.odds.
 * Devuelve decimales o null por lado, más el proveedor. Nunca inventa precio.
 */
export function parseEspnNbaOdds(oddsObj = {}) {
  const provider = oddsObj.provider?.displayName || oddsObj.provider?.name || 'DraftKings';
  const toDec = (am) => {
    const n = parseFloat(am);
    if (isNaN(n) || n === 0) return null;
    if (n > 0) return Number((1 + (n / 100)).toFixed(2));
    return Number((1 + (100 / Math.abs(n))).toFixed(2));
  };
  // "current" no existe en vivo; el orden current→close sigue la convención de
  // extractEspnSharpMarket por si ESPN lo publica en algún momento.
  const pick = (node) => node?.current?.odds ?? node?.close?.odds ?? null;
  const homeMl = toDec(pick(oddsObj.moneyline?.home) ?? oddsObj.homeTeamOdds?.moneyLine ?? null);
  const awayMl = toDec(pick(oddsObj.moneyline?.away) ?? oddsObj.awayTeamOdds?.moneyLine ?? null);
  const spreadHomeOdds = toDec(pick(oddsObj.pointSpread?.home));
  const spreadAwayOdds = toDec(pick(oddsObj.pointSpread?.away));
  const overOdds = toDec(pick(oddsObj.total?.over));
  const underOdds = toDec(pick(oddsObj.total?.under));
  return { provider, homeMl, awayMl, spreadHomeOdds, spreadAwayOdds, overOdds, underOdds };
}

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
    // Racha real del equipo (ESPN standings): streak/récord/L10 por equipo.
    // Fail-safe: sin standings, los partidos no llevan racha (fail-closed).
    const standingsMap = await fetchNbaStandingsMap();
    // E4 (2026-11-16): hora de descarga del scoreboard. Cada partido lleva
    // su fetchedAt; el gate 'odds_stale' exige cuotas del escaneo actual.
    const oddsFetchedAt = new Date().toISOString();

    const matches = events.map(evt => {
      const comp = evt.competitions?.[0] || {};
      const homeComp = comp.competitors?.find(c => c.homeAway === 'home') || {};
      const awayComp = comp.competitors?.find(c => c.homeAway === 'away') || {};
      const oddsObj = comp.odds?.[0] || {};

      const homeName = homeComp.team?.displayName || 'Local';
      const awayName = awayComp.team?.displayName || 'Visitante';
      // Racha/récord/L10 reales del equipo (solo si ESPN los trae).
      const homeStreak = standingsMap[String(homeComp.team?.id || '')] || {};
      const awayStreak = standingsMap[String(awayComp.team?.id || '')] || {};
      const marketSpread = oddsObj.spread !== undefined ? parseFloat(oddsObj.spread) : null;
      const marketTotal = oddsObj.overUnder !== undefined ? parseFloat(oddsObj.overUnder) : null;

      // E1 (2026-11-16): precios reales de ESPN (decimales o null por lado).
      // Antes el ML se leía del campo plano homeTeamOdds.moneyLine (vacío en
      // vivo) y spread/total se fijaban a null a mano; ahora vienen del
      // objeto estructurado y el 1.91 fijo se sobrescribe en applyTwoWay.
      const espnOdds = parseEspnNbaOdds(oddsObj);
      const homeMlDec = espnOdds.homeMl;
      const awayMlDec = espnOdds.awayMl;
      const statusName = evt.status?.type?.name || '';
      const homeScore = homeComp.score !== undefined && homeComp.score !== '' ? parseInt(homeComp.score, 10) : null;
      const awayScore = awayComp.score !== undefined && awayComp.score !== '' ? parseInt(awayComp.score, 10) : null;

      const matchObj = {
        id: `nba-${evt.id}`,
        sport: 'Baloncesto',
        league: 'NBA',
        game: `${homeName} vs ${awayName}`,
        home: { name: homeName, score: homeScore, ...homeStreak },
        away: { name: awayName, score: awayScore, ...awayStreak },
        homeScore,
        awayScore,
        date: evt.date,
        gameDate: evt.date,
        isCompleted: evt.status?.type?.completed || false,
        statusName,
        isPostponed: /POSTPONED|CANCELED|CANCELLED|SUSPENDED/i.test(statusName),
        spread: marketSpread,
        total: marketTotal,
        oddsFetchedAt,
        vegas: {
          spread: marketSpread,
          overUnder: marketTotal,
          spreadHomeOdds: espnOdds.spreadHomeOdds,
          spreadAwayOdds: espnOdds.spreadAwayOdds,
          overOdds: espnOdds.overOdds,
          underOdds: espnOdds.underOdds,
          provider: espnOdds.provider,
          oddsOrigin: 'espn'
        },
        market: {
          homeOdds: homeMlDec ? homeMlDec.toString() : null,
          awayOdds: awayMlDec ? awayMlDec.toString() : null,
          spread: marketSpread,
          overUnder: marketTotal,
          homeSpreadOdds: espnOdds.spreadHomeOdds ? espnOdds.spreadHomeOdds.toString() : null,
          awaySpreadOdds: espnOdds.spreadAwayOdds ? espnOdds.spreadAwayOdds.toString() : null,
          overOdds: espnOdds.overOdds ? espnOdds.overOdds.toString() : null,
          underOdds: espnOdds.underOdds ? espnOdds.underOdds.toString() : null,
          hasRealOdds: Boolean(homeMlDec && awayMlDec),
          provider: espnOdds.provider,
          oddsOrigin: 'espn',
          details: `NBA Spread ${marketSpread !== null ? (marketSpread > 0 ? `+${marketSpread}` : marketSpread) : '0'} | Total ${marketTotal || 224.5}`
        },
        odds: {
          spread: marketSpread,
          overUnder: marketTotal,
          homeMl: homeMlDec,
          awayMl: awayMlDec,
          spreadOdds: espnOdds.spreadHomeOdds,
          totalOdds: espnOdds.overOdds
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
