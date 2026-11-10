// src/services/nbaRatings.js
// RATINGS EN VIVO PARA NBA — reemplaza la tabla estática fósil de src/utils/hoops.js
// (Boston ORtg 122.2 era su número de 2023-24; el modelo proyectaba con 25.4 pts de error
// promedio en los 6 spreads auditados de oct 2026, ver auditoría de spreads 2026-11-10).
//
// Fuentes (ESPN, gratis, sin llave):
//   1) Standings: https://site.api.espn.com/apis/v2/sports/basketball/nba/standings
//      -> id, displayName, avgPointsFor, avgPointsAgainst
//   2) Team stats: https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{id}/statistics
//      -> avgFieldGoalsAttempted, avgFreeThrowsAttempted, avgOffensiveRebounds,
//         avgTurnovers, avgPoints, gamesPlayed (temporada en curso)
//
// Fórmulas (Dean Oliver, las mismas que ya usa el modelo en hoops.js):
//   Pace = FGA + 0.44*FTA - ORB + TOV   (posesiones por partido ≈ por 48 min)
//   ORtg = 100 * PPG / Pace ; DRtg = 100 * OppPPG / Pace
//
// Encogimiento (shrinkage): al inicio de temporada hay pocos partidos y el ruido es alto,
// así que cada rating se acerca al promedio de liga:
//   ajustado = (partidos * crudo + K * promedioLiga) / (partidos + K),  K = 6 partidos.
// Con 10 partidos, el peso del dato real es 10/16 = 62.5%.
//
// Limitación conocida (v1): SIN ajuste por fortaleza del calendario. Un equipo que jugó
// contra defensas débiles se ve mejor de lo que es. Es ruido de segundo orden frente al
// error de 25 pts de la tabla fósil; el ajuste por rival es el siguiente paso, no este.
// Si ESPN falla, el llamador sigue con la tabla estática: nunca se rompe el escaneo.

import { setLiveNbaRatings } from '../utils/hoops.js';

export const NBA_RATINGS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
export const NBA_RATINGS_SHRINK_K = 6; // partidos equivalentes de encogimiento hacia la liga
const STANDINGS_URL = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings';
const TEAM_STATS_URL = (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/statistics`;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_CONCURRENCY = 6;

let cachedPayload = null;
let cachedAt = 0;

export function normalizeNbaTeamKey(name = '') {
  return String(name || '').toLowerCase().trim();
}

/**
 * Calcula pace / ORtg / DRtg crudos (sin encoger) desde las medias por partido de un equipo.
 * Devuelve null si faltan datos o las posesiones no son positivas.
 */
export function computeNbaRatingsFromTeamStats({ fga, fta, orb, tov, ppg, oppPpg, games } = {}) {
  const inputs = [fga, fta, orb, tov, ppg, oppPpg, games];
  // Number(null) es 0: un dato ausente no debe pasar como cero.
  if (inputs.some((v) => v === null || v === undefined || v === '')) return null;
  const nums = inputs.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v)) || !Number.isFinite(Number(games)) || Number(games) <= 0) return null;
  const [fgaN, ftaN, orbN, tovN, ppgN, oppPpgN] = nums;
  const pace = fgaN + 0.44 * ftaN - orbN + tovN;
  if (!(pace > 0)) return null;
  return {
    pace: Number(pace.toFixed(1)),
    ortg: Number(((100 * ppgN) / pace).toFixed(1)),
    drtg: Number(((100 * oppPpgN) / pace).toFixed(1)),
    games: Number(games)
  };
}

/** Encoge un rating hacia el promedio de liga según partidos jugados. */
export function shrinkTowardLeague(value, games, leagueAvg, k = NBA_RATINGS_SHRINK_K) {
  const g = Math.max(0, Number(games) || 0);
  return Number((((g * value) + (k * leagueAvg)) / (g + k)).toFixed(1));
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'StatsAIPro/1.0' },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statValue(stats, name) {
  const s = (stats || []).find((x) => x && x.name === name);
  if (!s) return null;
  const v = typeof s.value === 'number' ? s.value : parseFloat(s.displayValue);
  return Number.isFinite(v) ? v : null;
}

function collectStandingsEntries(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v) => collectStandingsEntries(v, out));
    return;
  }
  if (node.team && Array.isArray(node.stats)) out.push(node);
  Object.values(node).forEach((v) => collectStandingsEntries(v, out));
}

function collectStatCategories(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v) => collectStatCategories(v, out));
    return;
  }
  if (Array.isArray(node.stats) && typeof node.name === 'string') {
    node.stats.forEach((s) => out.push(s));
  }
  Object.values(node).forEach((v) => collectStatCategories(v, out));
}

/**
 * Descarga los ratings en vivo de los 30 equipos desde ESPN.
 * Devuelve { ratings, leagueAvg, fetchedAt, season, teams, notices }.
 * Nunca lanza por un equipo individual: el equipo que falle queda fuera y se registra en notices.
 * Lanza solo si no se pudo obtener ni la tabla de posiciones (sin ella no hay ids ni puntos en contra).
 */
export async function fetchLiveNbaRatings({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, concurrency = FETCH_CONCURRENCY } = {}) {
  const notices = [];
  const standings = await fetchJson(STANDINGS_URL, fetchImpl, timeoutMs);
  const entries = [];
  collectStandingsEntries(standings, entries);
  if (!entries.length) throw new Error('ESPN standings sin equipos');

  const teams = entries.map((e) => ({
    id: String(e.team?.id || ''),
    name: e.team?.displayName || e.team?.name || '',
    oppPpg: statValue(e.stats, 'avgPointsAgainst'),
    ppgStandings: statValue(e.stats, 'avgPointsFor')
  })).filter((t) => t.id && t.name);
  if (!teams.length) throw new Error('ESPN standings sin ids de equipo');

  const season = standings?.season?.displayName || standings?.requestedSeason?.displayName || null;

  // Descarga de stats por equipo con concurrencia acotada.
  const results = new Array(teams.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < teams.length) {
      const i = next;
      next += 1;
      const team = teams[i];
      try {
        const json = await fetchJson(TEAM_STATS_URL(team.id), fetchImpl, timeoutMs);
        const allStats = [];
        collectStatCategories(json?.results?.stats, allStats);
        results[i] = {
          team,
          fga: statValue(allStats, 'avgFieldGoalsAttempted'),
          fta: statValue(allStats, 'avgFreeThrowsAttempted'),
          orb: statValue(allStats, 'avgOffensiveRebounds'),
          tov: statValue(allStats, 'avgTurnovers'),
          ppg: statValue(allStats, 'avgPoints') ?? team.ppgStandings,
          games: statValue(allStats, 'gamesPlayed')
        };
      } catch (err) {
        notices.push(`Sin stats de ${team.name} (${err.message}); usa tabla estática.`);
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, teams.length) }, () => worker()));

  const raw = [];
  for (const r of results) {
    if (!r) continue;
    const computed = computeNbaRatingsFromTeamStats({
      fga: r.fga, fta: r.fta, orb: r.orb, tov: r.tov,
      ppg: r.ppg, oppPpg: r.team.oppPpg, games: r.games
    });
    if (!computed) {
      notices.push(`Stats incompletas de ${r.team.name}; usa tabla estática.`);
      continue;
    }
    raw.push({ key: normalizeNbaTeamKey(r.team.name), name: r.team.name, ...computed });
  }
  if (!raw.length) throw new Error('ESPN no devolvió stats útiles para ningún equipo');

  const avg = (field) => raw.reduce((s, r) => s + r[field], 0) / raw.length;
  const leagueAvg = {
    pace: Number(avg('pace').toFixed(1)),
    ortg: Number(avg('ortg').toFixed(1)),
    drtg: Number(avg('drtg').toFixed(1))
  };

  const ratings = {};
  for (const r of raw) {
    ratings[r.key] = {
      pace: shrinkTowardLeague(r.pace, r.games, leagueAvg.pace),
      ortg: shrinkTowardLeague(r.ortg, r.games, leagueAvg.ortg),
      drtg: shrinkTowardLeague(r.drtg, r.games, leagueAvg.drtg),
      games: r.games,
      source: 'live-espn'
    };
  }

  return {
    ratings,
    leagueAvg,
    fetchedAt: new Date().toISOString(),
    season,
    teams: Object.keys(ratings).length,
    notices
  };
}

/** Devuelve el payload cacheado (6h) o lo descarga; null si ESPN falla. */
export async function getLiveNbaRatingsCached({ fetchImpl = fetch, force = false, ...opts } = {}) {
  const now = Date.now();
  if (!force && cachedPayload && (now - cachedAt < NBA_RATINGS_CACHE_TTL_MS)) return cachedPayload;
  try {
    cachedPayload = await fetchLiveNbaRatings({ fetchImpl, ...opts });
    cachedAt = now;
    return cachedPayload;
  } catch (err) {
    console.warn('[NBA] Ratings en vivo no disponibles; se usa la tabla estática:', err.message);
    cachedPayload = null;
    return null;
  }
}

export function clearNbaRatingsCache() {
  cachedPayload = null;
  cachedAt = 0;
}

/**
 * Carga los ratings en vivo y los activa en hoops.js (setLiveNbaRatings).
 * Devuelve el payload o null si ESPN falló (el modelo sigue con la tabla estática).
 */
export async function ensureLiveNbaRatings(opts = {}) {
  const payload = await getLiveNbaRatingsCached(opts);
  if (payload) setLiveNbaRatings(payload.ratings);
  return payload;
}
