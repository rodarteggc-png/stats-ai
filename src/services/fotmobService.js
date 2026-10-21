// src/services/fotmobService.js
// ALIMENTADOR DE EXPECTED GOALS (xG) VÍA FOTMOB PUBLIC DATA API
// Extrae métricas avanzadas de calidad de remates (xG, xGA, xGOT, Big Chances)
// para enriquecer las proyecciones de Poisson y Dixon-Coles en Fútbol.

const FOTMOB_CACHE = new Map();
const MATCH_DETAILS_CACHE = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalizeTeamName(name = '') {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Descarga la cartelera de partidos de una fecha determinada desde FotMob.
 */
export async function fetchFotmobMatchesForDate(dateStrYmd) {
  const cleanDate = (dateStrYmd || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const cached = FOTMOB_CACHE.get(cleanDate);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  try {
    const url = `https://www.fotmob.com/api/data/matches?date=${cleanDate}&timezone=America%2FMexico_City`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      console.warn(`[fotmobService] HTTP ${res.status} al consultar fecha ${cleanDate}`);
      return [];
    }
    const json = await res.json();
    const leagues = json.leagues || [];
    const allMatches = [];

    for (const l of leagues) {
      if (Array.isArray(l.matches)) {
        for (const m of l.matches) {
          allMatches.push({
            id: m.id,
            leagueName: l.name,
            homeName: m.home?.name || '',
            awayName: m.away?.name || '',
            homeScore: m.home?.score,
            awayScore: m.away?.score,
            isFinished: Boolean(m.status?.finished)
          });
        }
      }
    }

    FOTMOB_CACHE.set(cleanDate, { timestamp: Date.now(), data: allMatches });
    return allMatches;
  } catch (err) {
    console.warn(`[fotmobService] Error en fetchFotmobMatchesForDate:`, err.message);
    return [];
  }
}

/**
 * Consulta los detalles forenses de xG para un partido específico de FotMob.
 */
export async function fetchMatchXgDetails(fotmobMatchId) {
  if (!fotmobMatchId) return null;
  const cached = MATCH_DETAILS_CACHE.get(fotmobMatchId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  try {
    const url = `https://www.fotmob.com/api/data/matchDetails?matchId=${fotmobMatchId}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const json = await res.json();

    const periods = json.content?.stats?.Periods?.All?.stats || [];
    let homeXg = null;
    let awayXg = null;
    let homeBigChances = 0;
    let awayBigChances = 0;
    let homeShots = 0;
    let awayShots = 0;

    for (const group of periods) {
      if (Array.isArray(group.stats)) {
        for (const item of group.stats) {
          if (item.key === 'expected_goals' && Array.isArray(item.stats) && item.stats.length >= 2) {
            homeXg = parseFloat(item.stats[0]);
            awayXg = parseFloat(item.stats[1]);
          } else if (item.key === 'big_chance' && Array.isArray(item.stats) && item.stats.length >= 2) {
            homeBigChances = parseInt(item.stats[0], 10) || 0;
            awayBigChances = parseInt(item.stats[1], 10) || 0;
          } else if (item.key === 'total_shots' && Array.isArray(item.stats) && item.stats.length >= 2) {
            homeShots = parseInt(item.stats[0], 10) || 0;
            awayShots = parseInt(item.stats[1], 10) || 0;
          }
        }
      }
    }

    if (homeXg === null || awayXg === null || isNaN(homeXg) || isNaN(awayXg)) {
      return null;
    }

    const result = {
      matchId: fotmobMatchId,
      homeXg,
      awayXg,
      homeBigChances,
      awayBigChances,
      homeShots,
      awayShots,
      totalXg: Number((homeXg + awayXg).toFixed(2))
    };

    MATCH_DETAILS_CACHE.set(fotmobMatchId, { timestamp: Date.now(), data: result });
    return result;
  } catch (err) {
    return null;
  }
}

/**
 * Proyecta xG esperado para un enfrentamiento buscando datos recientes de FotMob
 */
export async function getMatchXgProjection(homeTeamName, awayTeamName) {
  if (!homeTeamName || !awayTeamName) return null;

  try {
    // Buscar en fechas recientes de ayer y hoy
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [matchesToday, matchesYest] = await Promise.all([
      fetchFotmobMatchesForDate(today),
      fetchFotmobMatchesForDate(yesterday)
    ]);

    const allMatches = [...matchesToday, ...matchesYest];
    const normHome = normalizeTeamName(homeTeamName);
    const normAway = normalizeTeamName(awayTeamName);

    // Buscar si el partido de hoy ya cuenta con datos de xG en vivo o si jugó ayer
    const match = allMatches.find(m => {
      const mh = normalizeTeamName(m.homeName);
      const ma = normalizeTeamName(m.awayName);
      return (mh.includes(normHome) || normHome.includes(mh)) && (ma.includes(normAway) || normAway.includes(ma));
    });

    if (match) {
      const details = await fetchMatchXgDetails(match.id);
      if (details) {
        return {
          hasXg: true,
          matchId: match.id,
          homeXg: details.homeXg,
          awayXg: details.awayXg,
          totalXg: details.totalXg,
          badgeText: `🔬 FotMob xG: ${details.homeXg} vs ${details.awayXg} (Total: ${details.totalXg} xG)`,
          note: `Expected Goals calibrado: ${details.homeBigChances} grandes ocasiones locales vs ${details.awayBigChances} visitantes.`
        };
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}
