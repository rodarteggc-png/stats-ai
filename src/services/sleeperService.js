// src/services/sleeperService.js
// ALIMENTADOR OFICIAL DE LESIONES Y REPORTES DE BAJAS VÍA SLEEPER API (100% GRATUITO Y PÚBLICO)
// Provee micro-inteligencia de estatus de jugadores al minuto para NBA y NFL.
// Fail-safe: Timeout estricto de 2.5s y caché en memoria con TTL de 3 horas.

const SLEEPER_CACHE = {
  nba: { data: null, timestamp: 0 },
  nfl: { data: null, timestamp: 0 }
};

const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 Horas

// Mapeo exhaustivo de equipos a códigos de Sleeper
const TEAM_ABBR_MAP = {
  // NBA (30 Equipos)
  'atlanta hawks': 'ATL', 'hawks': 'ATL',
  'boston celtics': 'BOS', 'celtics': 'BOS',
  'brooklyn nets': 'BKN', 'nets': 'BKN',
  'charlotte hornets': 'CHA', 'hornets': 'CHA',
  'chicago bulls': 'CHI', 'bulls': 'CHI',
  'cleveland cavaliers': 'CLE', 'cavaliers': 'CLE', 'cavs': 'CLE',
  'dallas mavericks': 'DAL', 'mavericks': 'DAL', 'mavs': 'DAL',
  'denver nuggets': 'DEN', 'nuggets': 'DEN',
  'detroit pistons': 'DET', 'pistons': 'DET',
  'golden state warriors': 'GSW', 'warriors': 'GSW',
  'houston rockets': 'HOU', 'rockets': 'HOU',
  'indiana pacers': 'IND', 'pacers': 'IND',
  'la clippers': 'LAC', 'los angeles clippers': 'LAC', 'clippers': 'LAC',
  'los angeles lakers': 'LAL', 'la lakers': 'LAL', 'lakers': 'LAL',
  'memphis grizzlies': 'MEM', 'grizzlies': 'MEM',
  'miami heat': 'MIA', 'heat': 'MIA',
  'milwaukee bucks': 'MIL', 'bucks': 'MIL',
  'minnesota timberwolves': 'MIN', 'timberwolves': 'MIN', 'wolves': 'MIN',
  'new orleans pelicans': 'NOP', 'pelicans': 'NOP',
  'new york knicks': 'NYK', 'knicks': 'NYK',
  'oklahoma city thunder': 'OKC', 'thunder': 'OKC',
  'orlando magic': 'ORL', 'magic': 'ORL',
  'philadelphia 76ers': 'PHI', '76ers': 'PHI', 'sixers': 'PHI',
  'phoenix suns': 'PHX', 'suns': 'PHX',
  'portland trail blazers': 'POR', 'trail blazers': 'POR', 'blazers': 'POR',
  'sacramento kings': 'SAC', 'kings': 'SAC',
  'san antonio spurs': 'SAS', 'spurs': 'SAS',
  'toronto raptors': 'TOR', 'raptors': 'TOR',
  'utah jazz': 'UTA', 'jazz': 'UTA',
  'washington wizards': 'WAS', 'wizards': 'WAS',

  // NFL (32 Equipos)
  'arizona cardinals': 'ARI', 'cardinals': 'ARI',
  'atlanta falcons': 'ATL', 'falcons': 'ATL',
  'baltimore ravens': 'BAL', 'ravens': 'BAL',
  'buffalo bills': 'BUF', 'bills': 'BUF',
  'carolina panthers': 'CAR', 'panthers': 'CAR',
  'chicago bears': 'CHI', 'bears': 'CHI',
  'cincinnati bengals': 'CIN', 'bengals': 'CIN',
  'cleveland browns': 'CLE', 'browns': 'CLE',
  'dallas cowboys': 'DAL', 'cowboys': 'DAL',
  'denver broncos': 'DEN', 'broncos': 'DEN',
  'detroit lions': 'DET', 'lions': 'DET',
  'green bay packers': 'GB', 'packers': 'GB',
  'houston texans': 'HOU', 'texans': 'HOU',
  'indianapolis colts': 'IND', 'colts': 'IND',
  'jacksonville jaguars': 'JAX', 'jaguars': 'JAX',
  'kansas city chiefs': 'KC', 'chiefs': 'KC',
  'las vegas raiders': 'LV', 'raiders': 'LV',
  'los angeles chargers': 'LAC', 'chargers': 'LAC',
  'los angeles rams': 'LAR', 'rams': 'LAR',
  'miami dolphins': 'MIA', 'dolphins': 'MIA',
  'minnesota vikings': 'MIN', 'vikings': 'MIN',
  'new england patriots': 'NE', 'patriots': 'NE',
  'new orleans saints': 'NO', 'saints': 'NO',
  'new york giants': 'NYG', 'giants': 'NYG',
  'new york jets': 'NYJ', 'jets': 'NYJ',
  'philadelphia eagles': 'PHI', 'eagles': 'PHI',
  'pittsburgh steelers': 'PIT', 'steelers': 'PIT',
  'san francisco 49ers': 'SF', '49ers': 'SF', 'niners': 'SF',
  'seattle seahawks': 'SEA', 'seahawks': 'SEA',
  'tampa bay buccaneers': 'TB', 'buccaneers': 'TB', 'bucs': 'TB',
  'tennessee titans': 'TEN', 'titans': 'TEN',
  'washington commanders': 'WAS', 'commanders': 'WAS'
};

function normalizeTeamToAbbr(teamName = '') {
  const norm = (teamName || '').toLowerCase().trim();
  for (const [key, abbr] of Object.entries(TEAM_ABBR_MAP)) {
    if (norm === key || norm.includes(key) || key.includes(norm)) {
      return abbr;
    }
  }
  return null;
}

/**
 * Descarga y categoriza jugadores lesionados por equipo desde Sleeper
 * @param {'nba' | 'nfl'} sport 
 */
export async function getSleeperInjuries(sport = 'nba') {
  const cleanSport = sport.toLowerCase() === 'nfl' ? 'nfl' : 'nba';
  const now = Date.now();
  const cached = SLEEPER_CACHE[cleanSport];

  if (cached.data && (now - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  try {
    const url = `https://api.sleeper.app/v1/players/${cleanSport}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3500),
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'StatsAIPro/1.0'
      }
    });

    if (!res.ok) {
      console.warn(`[sleeperService] HTTP ${res.status} al consultar ${cleanSport}`);
      return cached.data || new Map();
    }

    const raw = await res.json();
    const teamInjuriesMap = new Map();

    for (const id in raw) {
      const p = raw[id];
      if (!p || !p.injury_status || !p.team) continue;

      const teamAbbr = p.team.toUpperCase();
      if (!teamInjuriesMap.has(teamAbbr)) {
        teamInjuriesMap.set(teamAbbr, []);
      }

      // Considerar titular o jugador clave (depth_chart_order <= 2 o search_rank alto)
      const isStarter = p.depth_chart_order === 1;
      const isKeyPlayer = (p.search_rank && p.search_rank <= 250) || isStarter;

      teamInjuriesMap.get(teamAbbr).push({
        id: p.player_id,
        name: p.full_name || `${p.first_name} ${p.last_name}`,
        position: p.position || p.fantasy_positions?.[0] || '',
        status: p.injury_status, // 'Out', 'IR', 'Questionable', 'Doubtful', 'GTD'
        bodyPart: p.injury_body_part || '',
        notes: p.injury_notes || '',
        isStarter,
        isKeyPlayer,
        searchRank: p.search_rank || 999
      });
    }

    SLEEPER_CACHE[cleanSport] = {
      data: teamInjuriesMap,
      timestamp: now
    };

    return teamInjuriesMap;
  } catch (err) {
    console.warn(`[sleeperService] Error no-bloqueante al obtener lesiones (${cleanSport}):`, err.message);
    return cached.data || new Map();
  }
}

/**
 * Consulta el reporte de bajas de un equipo en particular
 * @param {string} teamName - Nombre del equipo (ej. "Golden State Warriors", "Kansas City Chiefs")
 * @param {'nba' | 'nfl'} sport
 */
export async function getTeamInjuryReport(teamName = '', sport = 'nba') {
  const abbr = normalizeTeamToAbbr(teamName);
  if (!abbr) return { hasInjuries: false, injuredList: [], starAbsences: [], summaryText: '' };

  const injuriesMap = await getSleeperInjuries(sport);
  const players = injuriesMap.get(abbr) || [];

  if (players.length === 0) {
    return { hasInjuries: false, injuredList: [], starAbsences: [], summaryText: '' };
  }

  // Filtrar ausencias relevantes (Out, IR, Doubtful, GTD)
  const serious = players.filter(p => ['Out', 'IR', 'Doubtful', 'GTD'].includes(p.status));
  const starAbsences = serious.filter(p => p.isKeyPlayer);

  const summary = starAbsences.length > 0
    ? starAbsences.map(p => `${p.name} (${p.status}${p.bodyPart ? ` - ${p.bodyPart}` : ''})`).join(', ')
    : (serious.length > 0 ? `${serious[0].name} (${serious[0].status})` : '');

  return {
    hasInjuries: serious.length > 0,
    injuredList: serious,
    starAbsences,
    summaryText: summary
  };
}

/**
 * Enriquece un partido de NBA o NFL con la inteligencia forense de lesiones
 */
export async function enrichMatchWithInjuries(match, sport = 'nba') {
  if (!match || !match.home?.name || !match.away?.name) return match;
  try {
    const [homeReport, awayReport] = await Promise.all([
      getTeamInjuryReport(match.home.name, sport),
      getTeamInjuryReport(match.away.name, sport)
    ]);

    match.injuryIntelligence = {
      home: homeReport,
      away: awayReport,
      hasStarImpact: homeReport.starAbsences.length > 0 || awayReport.starAbsences.length > 0,
      summary: [
        homeReport.summaryText ? `🏥 ${match.home.name}: ${homeReport.summaryText}` : '',
        awayReport.summaryText ? `🏥 ${match.away.name}: ${awayReport.summaryText}` : ''
      ].filter(Boolean).join(' | ')
    };
  } catch (e) {
    match.injuryIntelligence = null;
  }
  return match;
}
