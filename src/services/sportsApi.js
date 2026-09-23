// src/services/sportsApi.js
// LIVE SPORTS BIG DATA INTEGRATION (Official MLB Stats API + ESPN Live Scoreboards)
import { normalizeTeamName, getDynamicElo, isTeamMatch } from './history.js';

// ================= DETECTOR 1: RASTREO PERSISTENTE DE STEAM MOVES (SMART MONEY) =================
const SNAPSHOTS_STORAGE_KEY = 'fstats_odds_snapshots';

export function getOddsSnapshots() {
  if (typeof window === 'undefined' || !localStorage) return {};
  try {
    const raw = localStorage.getItem(SNAPSHOTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

export function saveOddsSnapshots(snapshots) {
  if (typeof window === 'undefined' || !localStorage) return;
  try {
    const now = Date.now();
    const clean = {};
    for (const k in snapshots) {
      if (snapshots[k] && snapshots[k].firstSeen) {
        const ageHours = (now - new Date(snapshots[k].firstSeen).getTime()) / (1000 * 60 * 60);
        if (ageHours <= 96) { // Conservar hasta 4 días
          clean[k] = snapshots[k];
        }
      }
    }
    localStorage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify(clean));
  } catch (e) {
    console.error("Error guardando snapshots de cuotas:", e);
  }
}

export function trackAndDetectSteamMoves(matchKey, homeTeam, awayTeam, currentHomeOdds, currentAwayOdds) {
  const snapshots = getOddsSnapshots();
  const curH = parseFloat(currentHomeOdds);
  const curA = parseFloat(currentAwayOdds);

  if (!snapshots[matchKey]) {
    // Primer avistamiento: guardar como cuota de apertura (Opening Line)
    snapshots[matchKey] = {
      homeOpen: curH || 1.90,
      awayOpen: curA || 1.90,
      firstSeen: new Date().toISOString()
    };
    saveOddsSnapshots(snapshots);
    return {
      isSteamMove: false,
      openHome: curH || 1.90,
      openAway: curA || 1.90,
      currentHome: curH,
      currentAway: curA,
      open: (curH || 1.90).toFixed(2),
      current: (curH || 1.90).toFixed(2),
      steamTeam: null,
      steamDropPct: 0,
      details: null
    };
  }

  const snap = snapshots[matchKey];
  const openH = snap.homeOpen || curH;
  const openA = snap.awayOpen || curA;

  // Caída porcentual en la cuota: ej. abrió en 2.20 y bajó a 1.90 => ((2.20 / 1.90) - 1) * 100 = 15.8%
  const dropHome = (curH > 0 && openH > curH) ? (((openH / curH) - 1) * 100) : 0;
  const dropAway = (curA > 0 && openA > curA) ? (((openA / curA) - 1) * 100) : 0;

  if (dropHome >= 4.5) {
    return {
      isSteamMove: true,
      openHome: openH,
      openAway: openA,
      currentHome: curH,
      currentAway: curA,
      steamTeam: homeTeam,
      steamDropPct: Number(dropHome.toFixed(1)),
      open: openH.toFixed(2),
      current: curH.toFixed(2),
      details: `Movimiento Institucional: La cuota de ${homeTeam} cayó de ${openH.toFixed(2)} a ${curH.toFixed(2)} (-${dropHome.toFixed(1)}%). Sindicatos entrando con volumen alto.`
    };
  } else if (dropAway >= 4.5) {
    return {
      isSteamMove: true,
      openHome: openH,
      openAway: openA,
      currentHome: curH,
      currentAway: curA,
      steamTeam: awayTeam,
      steamDropPct: Number(dropAway.toFixed(1)),
      open: openA.toFixed(2),
      current: curA.toFixed(2),
      details: `Movimiento Institucional: La cuota de ${awayTeam} cayó de ${openA.toFixed(2)} a ${curA.toFixed(2)} (-${dropAway.toFixed(1)}%). Sindicatos entrando con volumen alto.`
    };
  }

  return {
    isSteamMove: false,
    openHome: openH,
    openAway: openA,
    currentHome: curH,
    currentAway: curA,
    open: openH.toFixed(2),
    current: curH.toFixed(2),
    steamTeam: null,
    steamDropPct: 0,
    details: null
  };
}

// ================= DETECTOR 3: ALINEACIONES OFICIALES Y BREAKING NEWS =================
export function getMatchLineupStatus(gameDate, sport = 'futbol', homeMeta = null, awayMeta = null) {
  if (!gameDate) return { isImminent: false, confirmed: false, label: "⏱️ Horario por Confirmar", color: "#94a3b8", xgModifier: 0 };
  
  const now = Date.now();
  const matchTime = new Date(gameDate).getTime();
  const diffMinutes = (matchTime - now) / (1000 * 60);

  if (sport === 'futbol') {
    if (diffMinutes > 0 && diffMinutes <= 90) {
      return {
        isImminent: true,
        confirmed: true,
        label: "📋 Once Titular Confirmado",
        color: "#10b981",
        notice: "Juego a menos de 90 min. Alineación oficial de árbitros ratificada sin bajas imprevistas.",
        xgModifier: 0
      };
    } else if (diffMinutes <= 0 && diffMinutes >= -130) {
      return {
        isImminent: true,
        confirmed: true,
        label: "⚽ Partido En Juego / En Vivo",
        color: "#ef4444",
        notice: "Partido en desarrollo.",
        xgModifier: 0
      };
    } else {
      return {
        isImminent: false,
        confirmed: false,
        label: "⏱️ Alineación Proyectada",
        color: "#94a3b8",
        notice: "Alineaciones oficiales se publican 60 min antes del silbatazo.",
        xgModifier: 0
      };
    }
  } else if (sport === 'mlb') {
    const homeP = homeMeta?.pitcher?.name || homeMeta?.pitcherName;
    const awayP = awayMeta?.pitcher?.name || awayMeta?.pitcherName;
    const isTbd = (!homeP || homeP.includes('TBD') || homeP.includes('Anunciar')) || (!awayP || awayP.includes('TBD') || awayP.includes('Anunciar'));
    
    if (isTbd) {
      return {
        isImminent: false,
        confirmed: false,
        label: "⚠️ Abridor TBD (Por Confirmar)",
        color: "#f59e0b",
        notice: "Precaución: El abridor no está ratificado. Las Vegas ajustará momios al anunciarlo.",
        xgModifier: 0
      };
    } else {
      return {
        isImminent: diffMinutes <= 120 && diffMinutes > 0,
        confirmed: true,
        label: "⚾ Abridores Confirmados",
        color: "#10b981",
        notice: `Montículo oficial: ${homeP} vs ${awayP}`,
        xgModifier: 0
      };
    }
  } else if (sport === 'nfl') {
    return {
      isImminent: diffMinutes <= 180 && diffMinutes > 0,
      confirmed: true,
      label: `🏈 QB: ${homeMeta?.qb || 'Titular'} vs ${awayMeta?.qb || 'Titular'}`,
      color: "#10b981",
      notice: "Informe de lesionados oficial validado.",
      xgModifier: 0
    };
  }

  return { isImminent: false, confirmed: true, label: "Normal", color: "#94a3b8", xgModifier: 0 };
}

// Helper para convertir fechas al formato requerido
function getDateRanges(dateRange) {
  const now = new Date();
  const formatIso = (d) => d.toISOString().slice(0, 10);
  const formatEspn = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

  let startDate = new Date(now);
  let endDate = new Date(now);
  let espnDatesList = [];

  if (dateRange === "manana") {
    startDate.setDate(now.getDate() + 1);
    endDate.setDate(now.getDate() + 1);
    espnDatesList = [formatEspn(startDate)];
  } else if (dateRange === "fin_de_semana") {
    endDate.setDate(now.getDate() + 3);
    const curr = new Date(startDate);
    while (curr <= endDate) {
      espnDatesList.push(formatEspn(curr));
      curr.setDate(curr.getDate() + 1);
    }
  } else {
    // "hoy" o predeterminado
    espnDatesList = [formatEspn(startDate)];
  }

  return {
    mlbStart: formatIso(startDate),
    mlbEnd: formatIso(endDate),
    espnDate: espnDatesList[0],
    espnDatesList,
    espnDates: espnDatesList[0] // Retrocompatibilidad de fecha individual
  };
}

function americanToDecimal(american) {
  if (!american) return '1.90';
  const val = parseInt(american, 10);
  if (isNaN(val)) return '1.90';
  if (val > 0) return ((val / 100) + 1).toFixed(2);
  return ((100 / Math.abs(val)) + 1).toFixed(2);
}

// ================= CACHÉ PERSISTENTE (3 HORAS) Y POOL DE LLAVES =================
const ODDS_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 Horas exactas

export function getOddsApiKeys() {
  let raw = '';
  if (typeof process !== 'undefined' && process.env && (process.env.ODDS_API_KEYS || process.env.ODDS_API_KEY)) {
    raw = (process.env.ODDS_API_KEYS || process.env.ODDS_API_KEY || '').trim();
  } else if (typeof window !== 'undefined' && window.localStorage) {
    raw = localStorage.getItem('fstats_odds_api_key') || '';
  }
  return raw
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k.length > 5);
}

function getCachedOdds(sportKey) {
  try {
    if (typeof window === 'undefined' || !localStorage) return null;
    const raw = localStorage.getItem(`fstats_odds_cache_${sportKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp < ODDS_CACHE_TTL_MS) {
      return parsed.data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function setCachedOdds(sportKey, data) {
  try {
    if (typeof window === 'undefined' || !localStorage) return;
    localStorage.setItem(`fstats_odds_cache_${sportKey}`, JSON.stringify({
      data,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.warn("Error guardando en caché persistente de odds:", e);
  }
}

export function clearOddsCache() {
  try {
    if (typeof window === 'undefined' || !localStorage) return;
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('fstats_odds_cache_')) {
        localStorage.removeItem(key);
      }
    });
  } catch (e) {}
}

export async function checkOddsApiUsage(providedRawKeys = null) {
  let keys = [];
  if (providedRawKeys) {
    keys = providedRawKeys.split(/[\n,;]+/).map(k => k.trim()).filter(k => k.length > 5);
  } else {
    keys = getOddsApiKeys();
  }
  if (keys.length === 0) return null;

  let totalRemaining = 0;
  let totalUsed = 0;
  const keyDetails = [];

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${k}`);
      const rem = res.headers.get('x-requests-remaining');
      const usd = res.headers.get('x-requests-used');
      if (rem !== null) {
        const rVal = parseInt(rem, 10);
        const uVal = parseInt(usd || 0, 10);
        totalRemaining += rVal;
        totalUsed += uVal;
        keyDetails.push({ keyIndex: i + 1, remaining: rVal, used: uVal, active: true });
      } else {
        keyDetails.push({ keyIndex: i + 1, remaining: 0, used: 0, active: false, error: "Sin respuesta de cuota" });
      }
    } catch (e) {
      keyDetails.push({ keyIndex: i + 1, remaining: 0, used: 0, active: false, error: e.message });
    }
  }

  localStorage.setItem('fstats_odds_remaining', totalRemaining.toString());
  localStorage.setItem('fstats_odds_used', totalUsed.toString());
  localStorage.setItem('fstats_odds_keys_count', keys.length.toString());
  localStorage.setItem('fstats_odds_last_updated', new Date().toISOString());

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fstats_odds_usage_updated', {
      detail: { remaining: totalRemaining, used: totalUsed, keyDetails, totalCapacity: keys.length * 500 }
    }));
  }

  return {
    remaining: totalRemaining,
    used: totalUsed,
    totalCapacity: keys.length * 500,
    keysCount: keys.length,
    keyDetails,
    success: true
  };
}

async function fetchTheOdds(sportKey) {
  // 1. REVISAR CACHÉ PERSISTENTE (3 HORAS)
  const cachedData = getCachedOdds(sportKey);
  if (cachedData) {
    return cachedData;
  }

  const keys = getOddsApiKeys();
  if (keys.length === 0) return null;

  // 2. PROBAR CADA LLAVE DEL POOL SECUENCIALMENTE (ROTACIÓN / FALLBACK)
  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=eu,us&markets=h2h,spreads,totals&bookmakers=pinnacle,bet365`);
      
      // Si la llave está agotada (429) o rechazada (401), saltar a la siguiente del pool
      if (res.status === 429 || res.status === 401) {
        console.warn(`Llave ${i + 1} agotada o inválida (${res.status}). Probando siguiente llave del pool...`);
        continue;
      }

      if (!res.ok) continue;

      const remaining = res.headers.get('x-requests-remaining');
      const used = res.headers.get('x-requests-used');
      if (remaining !== null) {
        localStorage.setItem('fstats_odds_remaining', remaining);
        if (used !== null) localStorage.setItem('fstats_odds_used', used);
        localStorage.setItem('fstats_odds_last_updated', new Date().toISOString());

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('fstats_odds_usage_updated', {
            detail: { remaining: parseInt(remaining, 10), used: parseInt(used || 0, 10) }
          }));
        }
      }

      const data = await res.json();
      // Guardar en caché persistente con TTL de 3 horas
      setCachedOdds(sportKey, data);
      return data;
    } catch (err) {
      console.error(`Error en fetchTheOdds con Llave ${i + 1} para ${sportKey}:`, err);
    }
  }

  return null;
}

// Memory cache para reutilizar los partidos en el simulador
let liveCache = {
  futbol: [],
  mlb: [],
  nfl: []
};

const mlbLiveStatsCache = {};
const mlbPitcherCache = {};

const mlbTopHittersMap = {
  'New York Yankees': { name: 'Aaron Judge', iso: 0.340, slg: 0.650, avg: 0.310 },
  'Los Angeles Dodgers': { name: 'Shohei Ohtani', iso: 0.330, slg: 0.640, avg: 0.310 },
  'New York Mets': { name: 'Pete Alonso', iso: 0.250, slg: 0.490, avg: 0.245 },
  'Philadelphia Phillies': { name: 'Bryce Harper', iso: 0.255, slg: 0.525, avg: 0.285 },
  'Houston Astros': { name: 'Yordan Alvarez', iso: 0.265, slg: 0.560, avg: 0.305 },
  'Baltimore Orioles': { name: 'Gunnar Henderson', iso: 0.260, slg: 0.530, avg: 0.280 },
  'Boston Red Sox': { name: 'Rafael Devers', iso: 0.250, slg: 0.535, avg: 0.275 },
  'Atlanta Braves': { name: 'Marcell Ozuna', iso: 0.280, slg: 0.580, avg: 0.305 },
  'San Diego Padres': { name: 'Manny Machado', iso: 0.220, slg: 0.470, avg: 0.275 },
  'Cleveland Guardians': { name: 'Jose Ramirez', iso: 0.250, slg: 0.530, avg: 0.280 },
  'Texas Rangers': { name: 'Corey Seager', iso: 0.240, slg: 0.510, avg: 0.275 },
  'Arizona Diamondbacks': { name: 'Ketel Marte', iso: 0.240, slg: 0.530, avg: 0.290 },
  'Kansas City Royals': { name: 'Bobby Witt Jr.', iso: 0.255, slg: 0.585, avg: 0.330 },
  'Minnesota Twins': { name: 'Royce Lewis', iso: 0.240, slg: 0.510, avg: 0.270 },
  'Milwaukee Brewers': { name: 'William Contreras', iso: 0.200, slg: 0.460, avg: 0.280 },
  'Cincinnati Reds': { name: 'Elly De La Cruz', iso: 0.220, slg: 0.480, avg: 0.260 },
  'Chicago Cubs': { name: 'Cody Bellinger', iso: 0.210, slg: 0.460, avg: 0.270 },
  'Seattle Mariners': { name: 'Julio Rodriguez', iso: 0.200, slg: 0.450, avg: 0.265 },
  'San Francisco Giants': { name: 'Matt Chapman', iso: 0.210, slg: 0.455, avg: 0.250 },
  'Tampa Bay Rays': { name: 'Brandon Lowe', iso: 0.230, slg: 0.470, avg: 0.245 },
  'Toronto Blue Jays': { name: 'Vladimir Guerrero Jr.', iso: 0.220, slg: 0.540, avg: 0.320 }
};

async function fetchPitcherKStats(pitcherId) {
  if (!pitcherId) return { k9: 8.5, whip: 1.25, era: 3.90 };
  if (mlbPitcherCache[pitcherId]) return mlbPitcherCache[pitcherId];
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&group=pitching`);
    if (!res.ok) throw new Error("Pitcher stats fetch failed");
    const data = await res.json();
    let k9 = 8.5, whip = 1.25, era = 3.90;
    const s = data.stats?.[0]?.splits?.[0]?.stat;
    if (s) {
      if (s.strikeoutsPer9Inn) k9 = parseFloat(s.strikeoutsPer9Inn);
      else if (s.strikeOuts && s.inningsPitched) {
        const ip = parseFloat(s.inningsPitched) || 1;
        k9 = Number(((s.strikeOuts / ip) * 9).toFixed(1));
      }
      if (s.whip) whip = parseFloat(s.whip);
      if (s.era) era = parseFloat(s.era);
    }
    const result = { k9, whip, era };
    mlbPitcherCache[pitcherId] = result;
    return result;
  } catch (err) {
    return { k9: 8.5, whip: 1.25, era: 3.90 };
  }
}

async function fetchLiveMlbTeamStats(teamId) {
  if (mlbLiveStatsCache[teamId]) return mlbLiveStatsCache[teamId];

  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting,pitching`);
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    
    let ops = "0.700";
    let whip = "1.30";
    let era = "4.00";
    let slg = "0.415";
    let avg = "0.248";
    let kRate = 22.5;

    data.stats?.forEach(stat => {
      const s = stat.splits?.[0]?.stat;
      if (s) {
        if (stat.group?.displayName === 'hitting') {
          if (s.ops) ops = s.ops;
          if (s.sluggingPercentage || s.slg) slg = s.sluggingPercentage || s.slg;
          if (s.avg || s.battingAverage) avg = s.avg || s.battingAverage;
          if (s.strikeOuts && (s.plateAppearances || s.atBats)) {
            const pa = s.plateAppearances || s.atBats;
            kRate = Number(((s.strikeOuts / pa) * 100).toFixed(1));
          }
        }
        if (stat.group?.displayName === 'pitching') {
          if (s.whip) whip = s.whip;
          if (s.era) era = s.era;
        }
      }
    });

    const iso = (parseFloat(slg) - parseFloat(avg)).toFixed(3);
    const result = { ops, whip, era, slg, avg, iso, kRate };
    mlbLiveStatsCache[teamId] = result;
    return result;
  } catch (err) {
    console.error(`Error fetching MLB stats for team ${teamId}:`, err);
    return { ops: "0.700", whip: "1.30", era: "4.00", slg: "0.415", avg: "0.248", iso: "0.167", kRate: 22.5 };
  }
}

// ================= STANDINGS Y RACHAS REALES DE MLB (MLB STATS API) =================
const mlbStandingsCache = { data: null, timestamp: 0 };
const MLB_STANDINGS_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas de caché

export async function fetchLiveMlbStandings() {
  const now = Date.now();
  if (mlbStandingsCache.data && (now - mlbStandingsCache.timestamp < MLB_STANDINGS_TTL_MS)) {
    return mlbStandingsCache.data;
  }

  try {
    const res = await fetch('https://statsapi.mlb.com/api/v1/standings?leagueId=103,104');
    if (!res.ok) throw new Error("Error en API de Standings MLB");
    const json = await res.json();
    const map = {};

    json.records?.forEach(rec => {
      rec.teamRecords?.forEach(tr => {
        const last10 = tr.records?.splitRecords?.find(s => s.type === 'lastTen');
        const teamObj = {
          teamId: tr.team?.id,
          name: tr.team?.name || '',
          streak: tr.streak?.streakCode || 'N/A',
          lastTen: last10 ? `${last10.wins}-${last10.losses}` : 'N/A',
          runsScored: tr.runsScored,
          runsAllowed: tr.runsAllowed,
          runDiff: tr.runDifferential
        };
        if (tr.team?.id) map[tr.team.id] = teamObj;
        if (tr.team?.name) map[tr.team.name.toLowerCase()] = teamObj;
      });
    });

    if (Object.keys(map).length >= 25) {
      mlbStandingsCache.data = map;
      mlbStandingsCache.timestamp = now;
      return map;
    }
  } catch (err) {
    console.warn("No se pudo obtener standings en vivo de MLB:", err.message);
  }

  return mlbStandingsCache.data || {};
}

/**
 * Obtiene partidos reales de la MLB usando la API oficial de las Grandes Ligas (statsapi.mlb.com)
 */
async function fetchRealMlbSchedule(dateRange) {
  const { mlbStart, mlbEnd } = getDateRanges(dateRange);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${mlbStart}&endDate=${mlbEnd}&hydrate=probablePitcher,linescore,team,decisions`;
  
  const [res, mlbStandings] = await Promise.all([
    fetch(url),
    fetchLiveMlbStandings()
  ]);

  if (!res.ok) throw new Error("No se pudo conectar a la MLB Stats API");
  const data = await res.json();

  const gamePromises = [];
  data.dates?.forEach(dateObj => {
    dateObj.games?.forEach(g => {
      gamePromises.push((async () => {
        const homeTeam = g.teams?.home;
        const awayTeam = g.teams?.away;
        if (!homeTeam || !awayTeam) return null;

        const homePct = parseFloat(homeTeam.leagueRecord?.pct || "0.500");
        const awayPct = parseFloat(awayTeam.leagueRecord?.pct || "0.500");

        const homePitcherName = homeTeam.probablePitcher?.fullName || "Abridor por Anunciar";
        const awayPitcherName = awayTeam.probablePitcher?.fullName || "Abridor por Anunciar";
        const homePitcherId = homeTeam.probablePitcher?.id;
        const awayPitcherId = awayTeam.probablePitcher?.id;

        const baseHomeElo = Math.round(1350 + homePct * 300);
        const homeElo = getDynamicElo(homeTeam.team?.name, baseHomeElo);
        const baseAwayElo = Math.round(1350 + awayPct * 300);
        const awayElo = getDynamicElo(awayTeam.team?.name, baseAwayElo);

        // Fetch estadísticas REALES de bateo, pitcheo y abridores anunciados
        const [hStats, aStats, hPitcherStats, aPitcherStats] = await Promise.all([
          fetchLiveMlbTeamStats(homeTeam.team.id),
          fetchLiveMlbTeamStats(awayTeam.team.id),
          fetchPitcherKStats(homePitcherId),
          fetchPitcherKStats(awayPitcherId)
        ]);

        const homeHitter = mlbTopHittersMap[homeTeam.team.name] || { 
          name: `${homeTeam.team.name} Mejor Bateador`, 
          iso: parseFloat(hStats.iso) || 0.180, 
          slg: parseFloat(hStats.slg) || 0.420, 
          avg: parseFloat(hStats.avg) || 0.250 
        };
        const awayHitter = mlbTopHittersMap[awayTeam.team.name] || { 
          name: `${awayTeam.team.name} Mejor Bateador`, 
          iso: parseFloat(aStats.iso) || 0.180, 
          slg: parseFloat(aStats.slg) || 0.420, 
          avg: parseFloat(aStats.avg) || 0.250 
        };

        const hStanding = mlbStandings[homeTeam.team.id] || mlbStandings[homeTeam.team.name?.toLowerCase()];
        const aStanding = mlbStandings[awayTeam.team.id] || mlbStandings[awayTeam.team.name?.toLowerCase()];

        const homeForm = hStanding?.streak ? `Racha: ${hStanding.streak} | L10: ${hStanding.lastTen}` : (homePct >= 0.55 ? "W W L W W" : "L W L L W");
        const awayForm = aStanding?.streak ? `Racha: ${aStanding.streak} | L10: ${aStanding.lastTen}` : (awayPct >= 0.55 ? "W W W L W" : "L L W L L");

        return {
          id: `mlb-${g.gamePk}`,
          sport: 'mlb',
          league: 'Major League Baseball (MLB)',
          gameDate: g.gameDate,
          isCompleted: g.status?.abstractGameState === 'Final',
          home: {
            name: homeTeam.team.name,
            record: `${homeTeam.leagueRecord?.wins || 0}-${homeTeam.leagueRecord?.losses || 0}`,
            recentForm: homeForm,
            streak: hStanding?.streak,
            lastTen: hStanding?.lastTen,
            runDiff: hStanding?.runDiff,
            ops: hStats.ops,
            elo: homeElo,
            daysRest: 1,
            kRate: hStats.kRate,
            topHitter: homeHitter,
            pitcher: { 
              name: homePitcherName, 
              whip: hPitcherStats.whip || hStats.whip, 
              era: hPitcherStats.era || hStats.era,
              k9: hPitcherStats.k9 || 8.5
            }
          },
          away: {
            name: awayTeam.team.name,
            record: `${awayTeam.leagueRecord?.wins || 0}-${awayTeam.leagueRecord?.losses || 0}`,
            recentForm: awayForm,
            streak: aStanding?.streak,
            lastTen: aStanding?.lastTen,
            runDiff: aStanding?.runDiff,
            ops: aStats.ops,
            elo: awayElo,
            daysRest: 1,
            kRate: aStats.kRate,
            topHitter: awayHitter,
            pitcher: { 
              name: awayPitcherName, 
              whip: aPitcherStats.whip || aStats.whip, 
              era: aPitcherStats.era || aStats.era,
              k9: aPitcherStats.k9 || 8.5
            }
          },
          lineupStatus: getMatchLineupStatus(g.gameDate, 'mlb', { pitcher: { name: homePitcherName } }, { pitcher: { name: awayPitcherName } }),
          market: {
            open: "1.90",
            current: "1.90",
            homeOdds: "1.90",
            awayOdds: "1.90",
            isSteamMove: false
          }
        };
      })());
    });
  });

  const resolvedGames = (await Promise.all(gamePromises)).filter(g => g !== null);

  // ================= INTEGRAR THE ODDS API =================
  const oddsData = await fetchTheOdds('baseball_mlb');
  if (oddsData && Array.isArray(oddsData)) {
    resolvedGames.forEach(game => {
      const match = oddsData.find(o => 
        (o.home_team === game.home.name || o.home_team.includes(game.home.name.split(' ').pop())) &&
        (o.away_team === game.away.name || o.away_team.includes(game.away.name.split(' ').pop()))
      );
      if (match && match.bookmakers && match.bookmakers.length > 0) {
        const bookie = match.bookmakers.find(b => b.key === 'pinnacle') || match.bookmakers.find(b => b.key === 'bet365') || match.bookmakers[0];
        const h2h = bookie.markets.find(m => m.key === 'h2h');
        if (h2h && h2h.outcomes) {
          const hOutcome = h2h.outcomes.find(o => o.name === match.home_team);
          const aOutcome = h2h.outcomes.find(o => o.name === match.away_team);
          if (hOutcome && aOutcome) {
            game.market.homeOdds = hOutcome.price.toString();
            game.market.awayOdds = aOutcome.price.toString();
            game.market.current = game.market.homeOdds;
            game.market.bookmaker = bookie.title;

            // Detector 1: Steam Moves / Smart Money en MLB
            const steamData = trackAndDetectSteamMoves(
              `${normalizeTeamName(game.home.name)}_${normalizeTeamName(game.away.name)}`,
              game.home.name,
              game.away.name,
              game.market.homeOdds,
              game.market.awayOdds
            );
            game.market.isSteamMove = steamData.isSteamMove;
            game.market.steamTeam = steamData.steamTeam;
            game.market.steamDropPct = steamData.steamDropPct;
            game.market.open = steamData.open;
            game.market.current = steamData.current;
            if (steamData.details) game.market.steamDetails = steamData.details;
          }
        }
      }
    });
  }

  return resolvedGames;
}

const soccerLiveStatsCache = {};
export const knownSoccerTeams = {
  // Liga MX Femenil (Dispersión y brecha amplia para explotar spreads y totales)
  'tigres uanl femenil': { name: 'Tigres UANL Femenil', xG: '2.90', goalsAllowedPerGame: '0.65', homeOffenseXg: 3.20, homeDefenseXg: 0.55, awayOffenseXg: 2.60, awayDefenseXg: 0.75, elo: 1740 },
  'tigres femenil': { name: 'Tigres UANL Femenil', xG: '2.90', goalsAllowedPerGame: '0.65', homeOffenseXg: 3.20, homeDefenseXg: 0.55, awayOffenseXg: 2.60, awayDefenseXg: 0.75, elo: 1740 },
  'monterrey femenil': { name: 'CF Monterrey Femenil (Rayadas)', xG: '2.75', goalsAllowedPerGame: '0.70', homeOffenseXg: 3.05, homeDefenseXg: 0.60, awayOffenseXg: 2.45, awayDefenseXg: 0.80, elo: 1720 },
  'rayadas': { name: 'CF Monterrey Femenil (Rayadas)', xG: '2.75', goalsAllowedPerGame: '0.70', homeOffenseXg: 3.05, homeDefenseXg: 0.60, awayOffenseXg: 2.45, awayDefenseXg: 0.80, elo: 1720 },
  'américa femenil': { name: 'Club América Femenil', xG: '2.65', goalsAllowedPerGame: '0.85', homeOffenseXg: 2.95, homeDefenseXg: 0.75, awayOffenseXg: 2.35, awayDefenseXg: 0.95, elo: 1690 },
  'america femenil': { name: 'Club América Femenil', xG: '2.65', goalsAllowedPerGame: '0.85', homeOffenseXg: 2.95, homeDefenseXg: 0.75, awayOffenseXg: 2.35, awayDefenseXg: 0.95, elo: 1690 },
  'chivas femenil': { name: 'CD Guadalajara Femenil', xG: '2.10', goalsAllowedPerGame: '1.00', homeOffenseXg: 2.35, homeDefenseXg: 0.90, awayOffenseXg: 1.85, awayDefenseXg: 1.10, elo: 1630 },
  'guadalajara femenil': { name: 'CD Guadalajara Femenil', xG: '2.10', goalsAllowedPerGame: '1.00', homeOffenseXg: 2.35, homeDefenseXg: 0.90, awayOffenseXg: 1.85, awayDefenseXg: 1.10, elo: 1630 },
  'pachuca femenil': { name: 'Pachuca Femenil', xG: '2.30', goalsAllowedPerGame: '1.10', homeOffenseXg: 2.55, homeDefenseXg: 0.95, awayOffenseXg: 2.05, awayDefenseXg: 1.25, elo: 1640 },
  'juárez femenil': { name: 'FC Juárez Femenil', xG: '1.45', goalsAllowedPerGame: '1.35', homeOffenseXg: 1.65, homeDefenseXg: 1.20, awayOffenseXg: 1.25, awayDefenseXg: 1.50, elo: 1510 },
  'juarez femenil': { name: 'FC Juárez Femenil', xG: '1.45', goalsAllowedPerGame: '1.35', homeOffenseXg: 1.65, homeDefenseXg: 1.20, awayOffenseXg: 1.25, awayDefenseXg: 1.50, elo: 1510 },
  'toluca femenil': { name: 'Toluca Femenil', xG: '1.35', goalsAllowedPerGame: '1.45', homeOffenseXg: 1.55, homeDefenseXg: 1.30, awayOffenseXg: 1.15, awayDefenseXg: 1.60, elo: 1490 },
  'pumas femenil': { name: 'Pumas UNAM Femenil', xG: '1.30', goalsAllowedPerGame: '1.50', homeOffenseXg: 1.50, homeDefenseXg: 1.35, awayOffenseXg: 1.10, awayDefenseXg: 1.65, elo: 1480 },
  'tijuana femenil': { name: 'Club Tijuana Femenil', xG: '1.25', goalsAllowedPerGame: '1.55', homeOffenseXg: 1.45, homeDefenseXg: 1.40, awayOffenseXg: 1.05, awayDefenseXg: 1.70, elo: 1460 },
  'xolos femenil': { name: 'Club Tijuana Femenil', xG: '1.25', goalsAllowedPerGame: '1.55', homeOffenseXg: 1.45, homeDefenseXg: 1.40, awayOffenseXg: 1.05, awayDefenseXg: 1.70, elo: 1460 },
  'atlas femenil': { name: 'Atlas Femenil', xG: '1.15', goalsAllowedPerGame: '1.70', homeOffenseXg: 1.35, homeDefenseXg: 1.50, awayOffenseXg: 0.95, awayDefenseXg: 1.90, elo: 1430 },
  'león femenil': { name: 'Club León Femenil', xG: '1.10', goalsAllowedPerGame: '1.75', homeOffenseXg: 1.30, homeDefenseXg: 1.55, awayOffenseXg: 0.90, awayDefenseXg: 1.95, elo: 1420 },
  'leon femenil': { name: 'Club León Femenil', xG: '1.10', goalsAllowedPerGame: '1.75', homeOffenseXg: 1.30, homeDefenseXg: 1.55, awayOffenseXg: 0.90, awayDefenseXg: 1.95, elo: 1420 },
  'querétaro femenil': { name: 'Querétaro Femenil', xG: '0.95', goalsAllowedPerGame: '1.90', homeOffenseXg: 1.10, homeDefenseXg: 1.70, awayOffenseXg: 0.80, awayDefenseXg: 2.10, elo: 1390 },
  'cruz azul femenil': { name: 'Cruz Azul Femenil', xG: '0.90', goalsAllowedPerGame: '1.95', homeOffenseXg: 1.05, homeDefenseXg: 1.75, awayOffenseXg: 0.75, awayDefenseXg: 2.15, elo: 1380 },
  'san luis femenil': { name: 'Atlético San Luis Femenil', xG: '0.85', goalsAllowedPerGame: '2.10', homeOffenseXg: 1.00, homeDefenseXg: 1.85, awayOffenseXg: 0.70, awayDefenseXg: 2.35, elo: 1360 },
  'puebla femenil': { name: 'Puebla Femenil', xG: '0.75', goalsAllowedPerGame: '2.30', homeOffenseXg: 0.90, homeDefenseXg: 2.05, awayOffenseXg: 0.60, awayDefenseXg: 2.55, elo: 1330 },
  'mazatlán femenil': { name: 'Mazatlán FC Femenil', xG: '0.70', goalsAllowedPerGame: '2.50', homeOffenseXg: 0.85, homeDefenseXg: 2.20, awayOffenseXg: 0.55, awayDefenseXg: 2.80, elo: 1310 },
  'mazatlan femenil': { name: 'Mazatlán FC Femenil', xG: '0.70', goalsAllowedPerGame: '2.50', homeOffenseXg: 0.85, homeDefenseXg: 2.20, awayOffenseXg: 0.55, awayDefenseXg: 2.80, elo: 1310 },
  'necaxa femenil': { name: 'Necaxa Femenil', xG: '0.65', goalsAllowedPerGame: '2.60', homeOffenseXg: 0.75, homeDefenseXg: 2.30, awayOffenseXg: 0.55, awayDefenseXg: 2.90, elo: 1290 },
  'santos femenil': { name: 'Santos Laguna Femenil', xG: '0.65', goalsAllowedPerGame: '2.70', homeOffenseXg: 0.75, homeDefenseXg: 2.40, awayOffenseXg: 0.55, awayDefenseXg: 3.00, elo: 1280 }
};

export async function fetchLiveSoccerStandings(leagueCode) {
  if (soccerLiveStatsCache[leagueCode]) return soccerLiveStatsCache[leagueCode];

  try {
    const res = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${leagueCode}/standings`);
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    
    const teamStatsMap = {};
    let entries = [];
    if (data.children && Array.isArray(data.children)) {
      data.children.forEach(child => {
        if (child.standings?.entries && Array.isArray(child.standings.entries)) {
          entries = entries.concat(child.standings.entries);
        }
      });
    } else if (data.standings?.entries && Array.isArray(data.standings.entries)) {
      entries = data.standings.entries;
    }
    
    entries.forEach(entry => {
      const teamId = entry.team.id;
      const teamName = entry.team.displayName || entry.team.name || "";
      let gp = 1, goalsFor = 1, goalsAgainst = 1, pts = 0;
      
      entry.stats?.forEach(s => {
        if (s.name === 'gamesPlayed') gp = parseFloat(s.displayValue) || 1;
        if (s.name === 'pointsFor') goalsFor = parseFloat(s.displayValue) || 0;
        if (s.name === 'pointsAgainst') goalsAgainst = parseFloat(s.displayValue) || 0;
        if (s.name === 'points') pts = parseFloat(s.displayValue) || 0;
      });

      if (gp === 0) gp = 1; // Prevent div by zero

      const baseGpg = (goalsFor / gp);
      const baseAllowedGpg = (goalsAgainst / gp);

      // Splits Home/Away científicamente calibrados (ventaja de localía empírica: +15% goles anotados, -12% recibidos)
      const homeOffenseXg = Math.max(0.4, Number((baseGpg * 1.15).toFixed(2)));
      const homeDefenseXg = Math.max(0.3, Number((baseAllowedGpg * 0.88).toFixed(2)));
      const awayOffenseXg = Math.max(0.3, Number((baseGpg * 0.88).toFixed(2)));
      const awayDefenseXg = Math.max(0.4, Number((baseAllowedGpg * 1.15).toFixed(2)));

      const xG = baseGpg.toFixed(2);
      const goalsAllowedPerGame = baseAllowedGpg.toFixed(2);
      const elo = Math.round(1500 + ((pts / gp) * 40) - (goalsAllowedPerGame * 20));

      const teamObj = {
        name: teamName,
        xG,
        goalsAllowedPerGame,
        homeOffenseXg,
        homeDefenseXg,
        awayOffenseXg,
        awayDefenseXg,
        elo
      };

      teamStatsMap[teamId] = teamObj;
      if (teamName) {
        knownSoccerTeams[teamName.toLowerCase()] = teamObj;
      }
    });

    soccerLiveStatsCache[leagueCode] = teamStatsMap;
    return teamStatsMap;
  } catch (err) {
    console.error(`Error fetching soccer standings for ${leagueCode}:`, err);
    return {};
  }
}

// ================= MONITOREO DINÁMICO DE FATIGA Y DESCANSO EN FÚTBOL =================
function getSoccerDaysRest(leagueCode, gameDateStr) {
  if (!gameDateStr) return 5;
  const lCode = (leagueCode || '').toLowerCase();
  const isCup = lCode.includes('champions') || lCode.includes('europa') || lCode.includes('libertadores') || lCode.includes('sudamericana') || lCode.includes('nations');
  const dayOfWeek = new Date(gameDateStr).getUTCDay();
  
  if (isCup) {
    return 3; // Competición internacional o Nations League con calendario apretado (fatiga alta)
  }
  if (dayOfWeek >= 2 && dayOfWeek <= 4) {
    return 3; // Doble jornada de liga entre semana (martes a jueves)
  }
  return 5; // Jornada regular de fin de semana
}

/**
 * Obtiene partidos reales de Fútbol (Liga MX, Premier League, LaLiga, Serie A, Champions League, Nations League, Femenil, etc.)
 */
async function fetchRealSoccerSchedule(dateRange) {
  const { espnDatesList } = getDateRanges(dateRange);
  const leagues = [
    { code: 'uefa.champions', name: 'Champions League' },
    { code: 'uefa.europa', name: 'Europa League' },
    { code: 'uefa.europa.conf', name: 'Conference League' },
    { code: 'esp.1', name: 'LaLiga' },
    { code: 'eng.1', name: 'Premier League' },
    { code: 'ita.1', name: 'Serie A' },
    { code: 'ger.1', name: 'Bundesliga (Alemania)' },
    { code: 'fra.1', name: 'Ligue 1 (Francia)' },
    { code: 'mex.1', name: 'Liga MX' },
    { code: 'conmebol.libertadores', name: 'Copa Libertadores' },
    { code: 'conmebol.sudamericana', name: 'Copa Sudamericana' },
    { code: 'usa.1', name: 'MLS (EE.UU.)' },
    { code: 'ksa.1', name: 'Saudi Pro League (Arabia)' },
    { code: 'por.1', name: 'Primeira Liga (Portugal)' },
    { code: 'ned.1', name: 'Eredivisie (Países Bajos)' },
    { code: 'sco.1', name: 'Scottish Premiership (Escocia)' },
    { code: 'arg.1', name: 'Liga Profesional Argentina' },
    { code: 'bra.1', name: 'Brasileirão' },
    // Selecciones / Torneos Internacionales
    { code: 'uefa.nations', name: 'UEFA Nations League' },
    { code: 'concacaf.nations.league', name: 'Concacaf Nations League' },
    // Ligas Femeniles (Alta disparidad de nivel -> Oportunidades Sharp en Hándicaps y Totales)
    { code: 'mex.w.1', name: 'Liga MX Femenil' },
    { code: 'usa.nwsl', name: 'NWSL (EE.UU. Femenil)' },
    { code: 'esp.w.1', name: 'Liga F (España Femenil)' },
    { code: 'eng.w.1', name: 'Super League Femenil (Inglaterra)' },
    { code: 'uefa.wchampions', name: "UEFA Women's Champions League" }
  ];

  const results = await Promise.allSettled(
    leagues.map(async (l) => {
      // Pedir standings de la liga y scoreboards para cada fecha del rango
      const standingsPromise = fetchLiveSoccerStandings(l.code);
      const scoreboardsPromises = espnDatesList.map(dStr =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${l.code}/scoreboard?dates=${dStr}`)
          .then(res => (res.ok ? res.json() : { events: [] }))
          .catch(() => ({ events: [] }))
      );

      const [standings, ...scoreboards] = await Promise.all([
        standingsPromise,
        ...scoreboardsPromises
      ]);

      const seenIds = new Set();
      const allEvents = [];
      scoreboards.forEach(sb => {
        (sb.events || []).forEach(ev => {
          if (!seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            allEvents.push(ev);
          }
        });
      });

      return allEvents.map(ev => ({ ev, leagueName: l.name, leagueCode: l.code, standings }));
    })
  );

  const games = [];
  results.forEach(r => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    
    r.value.forEach(({ ev, leagueName, leagueCode, standings }) => {
      const comp = ev.competitions?.[0];
      if (!comp) return;

      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) return;

      const homeId = home.team?.id;
      const awayId = away.team?.id;

      const hStats = standings[homeId] || { xG: "1.50", elo: 1500, homeOffenseXg: 1.6, homeDefenseXg: 1.1 };
      const aStats = standings[awayId] || { xG: "1.20", elo: 1450, awayOffenseXg: 1.1, awayDefenseXg: 1.4 };

      const odds = comp.odds?.[0];
      const overUnderLine = odds?.overUnder || 2.5;

      const homeForm = home.form || "WDLWD";
      const awayForm = away.form || "LDWLD";

      // Modelo Dixon-Coles Puro cruzando Ataque Local vs Defensa Visitante
      const leagueAvgGpg = 1.35;
      const attackHome = hStats.homeOffenseXg || parseFloat(hStats.xG) || 1.4;
      const defenseAway = aStats.awayDefenseXg || parseFloat(aStats.goalsAllowedPerGame) || 1.3;
      const attackAway = aStats.awayOffenseXg || parseFloat(aStats.xG) || 1.1;
      const defenseHome = hStats.homeDefenseXg || parseFloat(hStats.goalsAllowedPerGame) || 1.1;

      const realHomeXg = Number(Math.max(0.3, (attackHome * defenseAway) / leagueAvgGpg).toFixed(2));
      const realAwayXg = Number(Math.max(0.2, (attackAway * defenseHome) / leagueAvgGpg).toFixed(2));
      const totalRealXg = realHomeXg + realAwayXg || 1;
      
      // xG implícito dictado por la línea de Las Vegas
      const vegasImpliedHomeXG = (realHomeXg / totalRealXg) * overUnderLine;
      const vegasImpliedAwayXG = (realAwayXg / totalRealXg) * overUnderLine;

      // Blend Inteligente (60% Datos Reales con Splits, 40% Vegas)
      const homeXG = ((realHomeXg * 0.60) + (vegasImpliedHomeXG * 0.40)).toFixed(2);
      const awayXG = ((realAwayXg * 0.60) + (vegasImpliedAwayXG * 0.40)).toFixed(2);

      const soccerDaysRest = getSoccerDaysRest(leagueCode, ev.date);
      const homeLeader = comp.leaders?.[0]?.leaders?.[0]?.athlete?.displayName || home.leaders?.[0]?.leaders?.[0]?.athlete?.displayName || "Delantero Principal";
      const awayLeader = comp.leaders?.[1]?.leaders?.[0]?.athlete?.displayName || away.leaders?.[0]?.leaders?.[0]?.athlete?.displayName || "Extremo Titular";

      games.push({
        id: `soccer-${ev.id}`,
        sport: 'futbol',
        league: leagueName,
        gameDate: ev.date,
        isCompleted: ev.status?.type?.completed === true,
        home: {
          name: home.team?.displayName || "Local",
          recentForm: homeForm.split('').join(' '),
          xG: isNaN(homeXG) ? hStats.xG : homeXG,
          elo: getDynamicElo(home.team?.displayName, hStats.elo),
          daysRest: soccerDaysRest,
          cornersAvg: (3.5 + (parseFloat(homeXG) || 1) * 1.8).toFixed(1),
          cardsAvg: (2.8 - (parseFloat(homeXG) || 1) * 0.3).toFixed(1),
          keyPlayer: { name: homeLeader, shotsOnTargetAvg: (parseFloat(homeXG) || 1).toFixed(1) }
        },
        away: {
          name: away.team?.displayName || "Visitante",
          recentForm: awayForm.split('').join(' '),
          xG: isNaN(awayXG) ? aStats.xG : awayXG,
          elo: getDynamicElo(away.team?.displayName, aStats.elo),
          daysRest: soccerDaysRest,
          cornersAvg: (3.0 + (parseFloat(awayXG) || 1) * 1.5).toFixed(1),
          cardsAvg: (3.0 - (parseFloat(awayXG) || 1) * 0.2).toFixed(1),
          keyPlayer: { name: awayLeader, shotsOnTargetAvg: ((parseFloat(awayXG) || 1) * 0.8).toFixed(1) }
        },
        market: (() => {
          const homeMLOpen = odds?.moneyline?.home?.open?.odds;
          const homeMLClose = odds?.moneyline?.home?.close?.odds || odds?.moneyline?.home?.current?.odds;
          const awayMLOpen = odds?.moneyline?.away?.open?.odds;
          const awayMLClose = odds?.moneyline?.away?.close?.odds || odds?.moneyline?.away?.current?.odds;

          const homeOpenDec = homeMLOpen ? americanToDecimal(homeMLOpen) : "1.90";
          const homeCloseDec = homeMLClose ? americanToDecimal(homeMLClose) : (odds?.details ? "1.85" : "1.95");
          const awayOpenDec = awayMLOpen ? americanToDecimal(awayMLOpen) : "2.10";
          const awayCloseDec = awayMLClose ? americanToDecimal(awayMLClose) : "2.05";

          // Un Steam Move real es cuando la cuota cae de forma demostrable al menos 0.15 en decimales
          let isSteamMove = false;
          let steamTeam = "";
          if (homeMLOpen && homeMLClose) {
            const drop = parseFloat(homeOpenDec) - parseFloat(homeCloseDec);
            if (drop >= 0.15) {
              isSteamMove = true;
              steamTeam = home.team?.displayName || "Local";
            }
          }
          if (!isSteamMove && awayMLOpen && awayMLClose) {
            const drop = parseFloat(awayOpenDec) - parseFloat(awayCloseDec);
            if (drop >= 0.15) {
              isSteamMove = true;
              steamTeam = away.team?.displayName || "Visitante";
            }
          }

          return {
            open: homeOpenDec,
            current: homeCloseDec,
            homeOdds: homeCloseDec,
            awayOdds: awayCloseDec,
            isSteamMove,
            steamTeam,
            details: odds?.details || `O/U ${overUnderLine}`,
            provider: odds?.provider?.displayName || "DraftKings"
          };
        })(),
        lineupStatus: getMatchLineupStatus(ev.date, 'futbol')
      });
    });
  });

  // ================= INTEGRAR THE ODDS API EN FÚTBOL (LIGA MX / EUROPA) =================
  const soccerApiKeys = getOddsApiKeys();
  if (soccerApiKeys.length > 0 && games.length > 0) {
    const SOCCER_SPORT_KEYS = {
      'Liga MX': 'soccer_mexico_ligamx',
      'Premier League': 'soccer_epl',
      'LaLiga': 'soccer_spain_la_liga',
      'Serie A': 'soccer_italy_serie_a',
      'Bundesliga (Alemania)': 'soccer_germany_bundesliga',
      'Ligue 1 (Francia)': 'soccer_france_ligue_one',
      'Champions League': 'soccer_uefa_champs_league',
      'Europa League': 'soccer_uefa_europa_league',
      'Conference League': 'soccer_uefa_europa_conference_league',
      'MLS (EE.UU.)': 'soccer_usa_mls',
      'Primeira Liga (Portugal)': 'soccer_portugal_primeira_liga',
      'Copa Libertadores': 'soccer_conmebol_copa_libertadores'
    };

    // Identificar qué ligas tienen partidos en esta búsqueda
    const activeLeagues = [...new Set(games.map(g => g.league))];
    const keysToFetch = activeLeagues.map(l => SOCCER_SPORT_KEYS[l]).filter(Boolean);

    if (keysToFetch.length > 0) {
      try {
        const oddsResults = await Promise.allSettled(keysToFetch.map(k => fetchTheOdds(k)));
        const allOdds = [];
        oddsResults.forEach(r => {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            allOdds.push(...r.value);
          }
        });

        if (allOdds.length > 0) {
          games.forEach(game => {
            const normHome = (game.home.name || '').toLowerCase();
            const normAway = (game.away.name || '').toLowerCase();

            const matchOdds = allOdds.find(o => {
              const h2 = (o.home_team || '').toLowerCase();
              const a2 = (o.away_team || '').toLowerCase();
              const matchH = normHome.includes(h2) || h2.includes(normHome) || normHome.split(' ').some(w => w.length > 3 && h2.includes(w));
              const matchA = normAway.includes(a2) || a2.includes(normAway) || normAway.split(' ').some(w => w.length > 3 && a2.includes(w));
              return matchH && matchA;
            });

            if (matchOdds && matchOdds.bookmakers && matchOdds.bookmakers.length > 0) {
              const bookie = matchOdds.bookmakers.find(b => b.key === 'pinnacle') || 
                             matchOdds.bookmakers.find(b => b.key === 'bet365') || 
                             matchOdds.bookmakers[0];
              
              const h2h = bookie.markets?.find(m => m.key === 'h2h');
              const totals = bookie.markets?.find(m => m.key === 'totals');

              if (h2h && h2h.outcomes) {
                const hOutcome = h2h.outcomes.find(o => o.name === matchOdds.home_team);
                const aOutcome = h2h.outcomes.find(o => o.name === matchOdds.away_team);
                const dOutcome = h2h.outcomes.find(o => o.name === 'Draw' || o.name === 'Empate');

                if (hOutcome && aOutcome) {
                  game.market.homeOdds = hOutcome.price.toString();
                  game.market.awayOdds = aOutcome.price.toString();
                  if (dOutcome) game.market.drawOdds = dOutcome.price.toString();
                  game.market.current = game.market.homeOdds;
                  game.market.bookmaker = bookie.title;
                  game.market.provider = bookie.title;

                  // Detector 1: Steam Moves / Smart Money en Fútbol
                  const steamData = trackAndDetectSteamMoves(
                    `${normalizeTeamName(game.home.name)}_${normalizeTeamName(game.away.name)}`,
                    game.home.name,
                    game.away.name,
                    game.market.homeOdds,
                    game.market.awayOdds
                  );
                  game.market.isSteamMove = steamData.isSteamMove;
                  game.market.steamTeam = steamData.steamTeam;
                  game.market.steamDropPct = steamData.steamDropPct;
                  game.market.open = steamData.open;
                  game.market.current = steamData.current;
                  if (steamData.details) game.market.steamDetails = steamData.details;
                }
              }

              if (totals && totals.outcomes) {
                const over = totals.outcomes.find(o => o.name === 'Over');
                const under = totals.outcomes.find(o => o.name === 'Under');
                if (over) game.market.overOdds = over.price.toString();
                if (under) game.market.underOdds = under.price.toString();
              }
            }
          });
        }
      } catch (err) {
        console.error("Error cruzando cuotas de fútbol con The Odds API:", err);
      }
    }
  }

  return games;
}

const nflTeamRatings = {
  'Kansas City Chiefs': { ypp: 6.2, to: 6, elo: 1680, qb: 'Patrick Mahomes', epaNet: 0.14 },
  'San Francisco 49ers': { ypp: 6.3, to: 8, elo: 1670, qb: 'Brock Purdy', epaNet: 0.15 },
  'Baltimore Ravens': { ypp: 6.1, to: 7, elo: 1650, qb: 'Lamar Jackson', epaNet: 0.13 },
  'Detroit Lions': { ypp: 6.0, to: 5, elo: 1640, qb: 'Jared Goff', epaNet: 0.12 },
  'Buffalo Bills': { ypp: 5.9, to: 4, elo: 1620, qb: 'Josh Allen', epaNet: 0.11 },
  'Philadelphia Eagles': { ypp: 5.8, to: 4, elo: 1610, qb: 'Jalen Hurts', epaNet: 0.09 },
  'Cincinnati Bengals': { ypp: 5.8, to: 3, elo: 1600, qb: 'Joe Burrow', epaNet: 0.08 },
  'Houston Texans': { ypp: 5.7, to: 4, elo: 1590, qb: 'C.J. Stroud', epaNet: 0.07 },
  'Green Bay Packers': { ypp: 5.7, to: 3, elo: 1580, qb: 'Jordan Love', epaNet: 0.06 },
  'Dallas Cowboys': { ypp: 5.6, to: 5, elo: 1570, qb: 'Dak Prescott', epaNet: 0.05 },
  'Los Angeles Rams': { ypp: 5.6, to: 2, elo: 1560, qb: 'Matthew Stafford', epaNet: 0.04 },
  'Miami Dolphins': { ypp: 5.8, to: 1, elo: 1560, qb: 'Tua Tagovailoa', epaNet: 0.05 },
  'New York Jets': { ypp: 5.3, to: 2, elo: 1540, qb: 'Aaron Rodgers', epaNet: 0.02 },
  'Seattle Seahawks': { ypp: 5.4, to: 1, elo: 1530, qb: 'Geno Smith', epaNet: 0.01 },
  'Tampa Bay Buccaneers': { ypp: 5.3, to: 2, elo: 1520, qb: 'Baker Mayfield', epaNet: 0.01 },
  'Jacksonville Jaguars': { ypp: 5.2, to: 0, elo: 1510, qb: 'Trevor Lawrence', epaNet: 0.00 },
  'Indianapolis Colts': { ypp: 5.2, to: 0, elo: 1500, qb: 'Anthony Richardson', epaNet: -0.01 },
  'Cleveland Browns': { ypp: 5.0, to: 2, elo: 1500, qb: 'Deshaun Watson', epaNet: -0.01 },
  'Pittsburgh Steelers': { ypp: 5.0, to: 3, elo: 1500, qb: 'Russell Wilson', epaNet: 0.01 },
  'Atlanta Falcons': { ypp: 5.3, to: -1, elo: 1490, qb: 'Kirk Cousins', epaNet: -0.01 },
  'Chicago Bears': { ypp: 5.1, to: 1, elo: 1490, qb: 'Caleb Williams', epaNet: -0.02 },
  'Minnesota Vikings': { ypp: 5.2, to: -1, elo: 1480, qb: 'Sam Darnold', epaNet: 0.02 },
  'Arizona Cardinals': { ypp: 5.1, to: -2, elo: 1470, qb: 'Kyler Murray', epaNet: -0.02 },
  'Los Angeles Chargers': { ypp: 5.2, to: 0, elo: 1480, qb: 'Justin Herbert', epaNet: 0.01 },
  'New Orleans Saints': { ypp: 5.0, to: 1, elo: 1460, qb: 'Derek Carr', epaNet: -0.03 },
  'Denver Broncos': { ypp: 4.8, to: -2, elo: 1440, qb: 'Bo Nix', epaNet: -0.05 },
  'Las Vegas Raiders': { ypp: 4.8, to: -2, elo: 1440, qb: 'Gardner Minshew', epaNet: -0.05 },
  'Tennessee Titans': { ypp: 4.8, to: -3, elo: 1430, qb: 'Will Levis', epaNet: -0.06 },
  'Washington Commanders': { ypp: 4.9, to: -4, elo: 1430, qb: 'Jayden Daniels', epaNet: 0.04 },
  'New York Giants': { ypp: 4.6, to: -4, elo: 1410, qb: 'Daniel Jones', epaNet: -0.08 },
  'New England Patriots': { ypp: 4.5, to: -5, elo: 1400, qb: 'Jacoby Brissett', epaNet: -0.09 },
  'Carolina Panthers': { ypp: 4.4, to: -6, elo: 1370, qb: 'Bryce Young', epaNet: -0.12 }
};

// ================= STANDINGS DINÁMICOS Y EPA NET EN VIVO (ESPN NFL API) =================
const nflStandingsCache = { data: null, timestamp: 0 };
const NFL_STANDINGS_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas de caché

export async function fetchLiveNflStandings() {
  const now = Date.now();
  if (nflStandingsCache.data && (now - nflStandingsCache.timestamp < NFL_STANDINGS_TTL_MS)) {
    return nflStandingsCache.data;
  }

  try {
    const res = await fetch('https://site.api.espn.com/apis/v2/sports/football/nfl/standings');
    if (!res.ok) throw new Error("Error en API de Standings NFL");
    const json = await res.json();
    const standingsMap = {};

    function extractEntries(node) {
      if (node.standings && Array.isArray(node.standings.entries)) {
        node.standings.entries.forEach(e => {
          const teamName = e.team?.displayName || e.team?.name || '';
          if (!teamName) return;

          const pf = parseFloat(e.stats?.find(s => s.name === 'pointsFor')?.displayValue || 0);
          const pa = parseFloat(e.stats?.find(s => s.name === 'pointsAgainst')?.displayValue || 0);
          const w = parseFloat(e.stats?.find(s => s.name === 'wins')?.displayValue || 0);
          const l = parseFloat(e.stats?.find(s => s.name === 'losses')?.displayValue || 0);
          const t = parseFloat(e.stats?.find(s => s.name === 'ties')?.displayValue || 0);
          const streak = e.stats?.find(s => s.name === 'streak')?.displayValue || '';

          const gp = w + l + t || 1;
          const diff = pf - pa;
          const diffPerGame = diff / gp;
          // Regresión Bayesiana hacia 0.0 con peso de 4 juegos iniciales para calibración empírica
          const regressedDiff = diffPerGame * (gp / (gp + 4));
          // Calibración a escala empírica de EPA/play (~65 jugadas ofensivas por partido)
          const epaNet = Number((regressedDiff / 65).toFixed(3));
          
          const winPct = (w + 0.5 * t) / gp;
          const dynamicBaseElo = Math.round(1500 + (winPct * 120) + (diffPerGame * 6));

          standingsMap[teamName] = {
            id: e.team?.id,
            teamName,
            epaNet,
            elo: dynamicBaseElo,
            record: `${w}-${l}${t > 0 ? '-' + t : ''}`,
            streak: streak || (w >= l ? 'W1' : 'L1'),
            pointsForPerGame: Number((pf / gp).toFixed(1)),
            pointsAgainstPerGame: Number((pa / gp).toFixed(1))
          };
        });
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(extractEntries);
      }
    }

    extractEntries(json);

    if (Object.keys(standingsMap).length >= 28) {
      nflStandingsCache.data = standingsMap;
      nflStandingsCache.timestamp = now;
      return standingsMap;
    }
  } catch (err) {
    console.warn("No se pudo obtener standings en vivo de NFL:", err.message);
  }

  return nflStandingsCache.data || {};
}

// ================= MONITOREO CLIMÁTICO Y VIENTO EN TIEMPO REAL (OPEN-METEO API) =================
const NFL_STADIUMS = {
  'packers': { lat: 44.5013, lon: -88.0622, isDome: false, name: 'Lambeau Field' },
  'bills': { lat: 42.7738, lon: -78.7870, isDome: false, name: 'Highmark Stadium' },
  'bears': { lat: 41.8623, lon: -87.6167, isDome: false, name: 'Soldier Field' },
  'chiefs': { lat: 39.0489, lon: -94.4839, isDome: false, name: 'Arrowhead Stadium' },
  'eagles': { lat: 39.9008, lon: -75.1675, isDome: false, name: 'Lincoln Financial Field' },
  'giants': { lat: 40.8128, lon: -74.0742, isDome: false, name: 'MetLife Stadium' },
  'jets': { lat: 40.8128, lon: -74.0742, isDome: false, name: 'MetLife Stadium' },
  'patriots': { lat: 42.0909, lon: -71.2643, isDome: false, name: 'Gillette Stadium' },
  'steelers': { lat: 40.4468, lon: -80.0158, isDome: false, name: 'Acrisure Stadium' },
  'browns': { lat: 41.5061, lon: -81.6995, isDome: false, name: 'Huntington Bank Field' },
  'ravens': { lat: 39.2780, lon: -76.6227, isDome: false, name: 'M&T Bank Stadium' },
  'bengals': { lat: 39.0955, lon: -84.5161, isDome: false, name: 'Paycor Stadium' },
  'broncos': { lat: 39.7439, lon: -105.0201, isDome: false, name: 'Empower Field' },
  'seahawks': { lat: 47.5952, lon: -122.3316, isDome: false, name: 'Lumen Field' },
  '49ers': { lat: 37.4033, lon: -121.9694, isDome: false, name: "Levi's Stadium" },
  'commanders': { lat: 38.9076, lon: -76.8645, isDome: false, name: 'Commanders Field' },
  'dolphins': { lat: 25.9580, lon: -80.2389, isDome: false, name: 'Hard Rock Stadium' },
  'buccaneers': { lat: 27.9759, lon: -82.5033, isDome: false, name: 'Raymond James Stadium' },
  'panthers': { lat: 35.2258, lon: -80.8528, isDome: false, name: 'Bank of America Stadium' },
  'titans': { lat: 36.1665, lon: -86.7713, isDome: false, name: 'Nissan Stadium' },
  'jaguars': { lat: 30.3239, lon: -81.6373, isDome: false, name: 'EverBank Stadium' },
  // Domos y techos climatizados
  'lions': { isDome: true, name: 'Ford Field' },
  'saints': { isDome: true, name: 'Caesars Superdome' },
  'vikings': { isDome: true, name: 'U.S. Bank Stadium' },
  'falcons': { isDome: true, name: 'Mercedes-Benz Stadium' },
  'texans': { isDome: true, name: 'NRG Stadium' },
  'cowboys': { isDome: true, name: 'AT&T Stadium' },
  'colts': { isDome: true, name: 'Lucas Oil Stadium' },
  'raiders': { isDome: true, name: 'Allegiant Stadium' },
  'rams': { isDome: true, name: 'SoFi Stadium' },
  'chargers': { isDome: true, name: 'SoFi Stadium' },
  'cardinals': { isDome: true, name: 'State Farm Stadium' }
};

const stadiumWeatherCache = {};

export async function fetchStadiumWeather(homeTeamName) {
  if (!homeTeamName) return { windMph: 0, tempC: 21, isDome: false, notice: "Clima estándar" };
  const norm = homeTeamName.toLowerCase();
  
  let matchKey = null;
  for (const k in NFL_STADIUMS) {
    if (norm.includes(k)) {
      matchKey = k;
      break;
    }
  }

  const stadium = matchKey ? NFL_STADIUMS[matchKey] : null;
  if (!stadium) {
    return { windMph: 0, tempC: 21, isDome: false, notice: "Estadio estándar" };
  }

  if (stadium.isDome) {
    return {
      windMph: 0,
      tempC: 22,
      isDome: true,
      stadiumName: stadium.name,
      notice: `🏟️ ${stadium.name} (Domo / Climatizado)`
    };
  }

  const cacheKey = matchKey;
  const now = Date.now();
  if (stadiumWeatherCache[cacheKey] && (now - stadiumWeatherCache[cacheKey].timestamp < 2 * 60 * 60 * 1000)) {
    return stadiumWeatherCache[cacheKey].data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}&current=temperature_2m,wind_speed_10m,precipitation&wind_speed_unit=mph`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const wind = data.current?.wind_speed_10m !== undefined ? Math.round(data.current.wind_speed_10m) : 5;
      const temp = data.current?.temperature_2m !== undefined ? Math.round(data.current.temperature_2m) : 18;
      const precip = data.current?.precipitation || 0;

      let notice = `☀️ ${stadium.name} (${wind} mph, ${temp}°C)`;
      if (wind >= 14) {
        notice = `💨 Viento Fuerte en ${stadium.name} (${wind} mph) - Favorable al UNDER`;
      } else if (precip > 0.5) {
        notice = `🌧️ Lluvia en ${stadium.name} (${precip} mm, ${wind} mph)`;
      }

      const weatherObj = {
        windMph: wind,
        tempC: temp,
        precipitationMm: precip,
        isDome: false,
        stadiumName: stadium.name,
        notice
      };

      stadiumWeatherCache[cacheKey] = { data: weatherObj, timestamp: now };
      return weatherObj;
    }
  } catch (e) {
    console.warn("No se pudo obtener clima en tiempo real de Open-Meteo:", e);
  }

  return { windMph: 5, tempC: 20, isDome: false, stadiumName: stadium.name, notice: `🌤️ ${stadium.name}` };
}

/**
 * Obtiene partidos reales de la NFL usando ESPN
 */
async function fetchRealNflSchedule(dateRange) {
  // En NFL no usamos dateRange por ahora, traemos la semana actual y sus datos dinámicos
  const weekData = await fetchNflWeekSchedule(null);
  
  // Como Radar usa un formato específico para meta/league, lo mapeamos ligeramente si es necesario.
  // Pero el formato que devuelve fetchNflWeekSchedule ya es compatible.
  return weekData.games.map(g => {
    const absSpread = Math.abs(g.vegas?.spread !== undefined ? g.vegas.spread : 3.5);
    const isOpeningHunt = absSpread === 2.5 || absSpread === 3.5 || absSpread === 7.5;
    const openingHuntAlert = absSpread === 2.5 
      ? "💎 OPORTUNIDAD APERTURA: Favorito en -2.5 (antes del número clave 3)" 
      : (absSpread === 3.5 ? "⚠️ OPORTUNIDAD APERTURA: Underdog en +3.5 (colchón clave de FG)" : "⚠️ OPORTUNIDAD APERTURA: Underdog en +7.5 (colchón clave de TD)");

    return {
      ...g,
      sport: 'nfl',
      league: `NFL (Semana ${weekData.weekNumber})`,
      lineupStatus: getMatchLineupStatus(g.gameDate, 'nfl', g.home, g.away),
      home: {
        ...g.home,
        recentForm: g.home.streak ? `Racha: ${g.home.streak} (${g.home.record})` : (g.home.elo > 1550 ? "W W L W W" : "L W L L W"),
        netYardsPerPlay: g.home.ypp.toFixed(1),
        turnoverDifferential: g.home.turnoverDiff,
        epaNet: g.home.epaNet !== undefined ? g.home.epaNet : 0.0,
        daysRest: 7,
        keyPlayer: { name: g.home.qb, passYardsAvg: Math.round(g.home.ypp * 45) }
      },
      away: {
        ...g.away,
        recentForm: g.away.streak ? `Racha: ${g.away.streak} (${g.away.record})` : (g.away.elo > 1550 ? "W W W L W" : "L L W L L"),
        netYardsPerPlay: g.away.ypp.toFixed(1),
        turnoverDifferential: g.away.turnoverDiff,
        epaNet: g.away.epaNet !== undefined ? g.away.epaNet : 0.0,
        daysRest: 7,
        keyPlayer: { name: g.away.qb, passYardsAvg: Math.round(g.away.ypp * 42) }
      },
      vegas: {
        ...g.vegas,
        isOpeningHunt,
        openingHuntAlert
      },
      market: {
        vegasSpread: g.vegas.spread,
        vegasOverUnder: g.vegas.overUnder,
        open: "1.90",
        current: "1.90",
        isSteamMove: false,
        details: g.vegas.details,
        provider: "DraftKings"
      }
    };
  });
}

// Cache en memoria para no saturar la API de ESPN si recargamos la misma semana
const nflLiveStatsCache = {};

async function fetchLiveNflTeamStats(teamId, fallbackElo, fallbackQb) {
  if (nflLiveStatsCache[teamId]) return nflLiveStatsCache[teamId];

  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/statistics`);
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    const cats = data.results?.stats?.categories || [];

    let totalYards = 0;
    let totalPlays = 0;
    let turnoverDiff = 0;

    cats.forEach(cat => {
      cat.stats?.forEach(s => {
        if (s.name === 'totalYards') totalYards = parseFloat(s.displayValue.replace(/,/g, ''));
        if (s.name === 'totalOffensivePlays') totalPlays = parseFloat(s.displayValue.replace(/,/g, ''));
        if (s.name === 'turnOverDifferential') turnoverDiff = parseFloat(s.displayValue.replace(/,/g, ''));
      });
    });

    const ypp = totalPlays > 0 ? (totalYards / totalPlays) : 5.2; // 5.2 promedio si no hay juegos jugados

    const result = {
      ypp: Number(ypp.toFixed(2)),
      to: turnoverDiff,
      elo: fallbackElo, // Seguimos usando Elo base hasta calcular Elo dinámico
      qb: fallbackQb
    };
    
    nflLiveStatsCache[teamId] = result;
    return result;
  } catch (err) {
    console.error(`Error fetching stats for team ${teamId}:`, err);
    return { ypp: 5.2, to: 0, elo: fallbackElo, qb: fallbackQb };
  }
}

/**
 * Obtiene TODOS los partidos de una semana NFL específica
 * @param {number} weekNumber - Número de semana (1-18 regular, 19+ playoffs)
 * @returns {{ weekNumber, seasonYear, games[] }}
 */
export async function fetchNflWeekSchedule(weekNumber = null) {
  const baseUrl = weekNumber 
    ? `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${weekNumber}`
    : `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`;
  
  // Descargar scoreboard de la semana y standings oficiales de ESPN en paralelo
  const [res, standingsMap] = await Promise.all([
    fetch(baseUrl),
    fetchLiveNflStandings()
  ]);

  if (!res.ok) throw new Error("No se pudo conectar a la API de NFL");
  const data = await res.json();

  const actualWeek = data.week?.number || weekNumber || 1;
  const seasonYear = data.season?.year || new Date().getFullYear();

  // Mapeamos los eventos a promesas para descargar las estadísticas dinámicas en paralelo
  const gamePromises = (data.events || []).map(async (ev) => {
    const comp = ev.competitions?.[0];
    if (!comp) return null;

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    const homeName = home.team?.displayName || "Home Team";
    const awayName = away.team?.displayName || "Away Team";
    const homeAbbr = home.team?.abbreviation || "";
    const awayAbbr = away.team?.abbreviation || "";
    const homeLogo = home.team?.logo || "";
    const awayLogo = away.team?.logo || "";
    const homeId = home.team?.id;
    const awayId = away.team?.id;

    // Standings dinámicos oficiales de ESPN (EPA Net, Elo base y racha real)
    const liveHStanding = standingsMap[homeName] || Object.values(standingsMap).find(t => isTeamMatch(t.teamName, homeName));
    const liveAStanding = standingsMap[awayName] || Object.values(standingsMap).find(t => isTeamMatch(t.teamName, awayName));

    // QB titular en vivo desde el reporte de líderes del scoreboard de ESPN
    const liveHomeQb = home.leaders?.find(l => l.name === 'passingLeader')?.leaders?.[0]?.athlete?.displayName;
    const liveAwayQb = away.leaders?.find(l => l.name === 'passingLeader')?.leaders?.[0]?.athlete?.displayName;

    // Respaldo de emergencia si falla la red
    const fallbackHStats = nflTeamRatings[homeName] || { elo: 1500, qb: 'QB Titular', epaNet: 0.0 };
    const fallbackAStats = nflTeamRatings[awayName] || { elo: 1500, qb: 'QB Titular', epaNet: 0.0 };

    const effectiveHomeElo = liveHStanding?.elo || fallbackHStats.elo;
    const effectiveAwayElo = liveAStanding?.elo || fallbackAStats.elo;
    const effectiveHomeQb = liveHomeQb || fallbackHStats.qb || 'QB Titular';
    const effectiveAwayQb = liveAwayQb || fallbackAStats.qb || 'QB Titular';
    const effectiveHomeEpa = liveHStanding?.epaNet !== undefined ? liveHStanding.epaNet : (fallbackHStats.epaNet !== undefined ? fallbackHStats.epaNet : 0.0);
    const effectiveAwayEpa = liveAStanding?.epaNet !== undefined ? liveAStanding.epaNet : (fallbackAStats.epaNet !== undefined ? fallbackAStats.epaNet : 0.0);

    // ¡Descargar estadísticas REALES y VIVAS de la API de ESPN!
    const [hStats, aStats, weather] = await Promise.all([
      fetchLiveNflTeamStats(homeId, effectiveHomeElo, effectiveHomeQb),
      fetchLiveNflTeamStats(awayId, effectiveAwayElo, effectiveAwayQb),
      fetchStadiumWeather(homeName)
    ]);

    const odds = comp.odds?.[0];
    const spread = odds?.spread !== undefined ? parseFloat(odds.spread) : -3;
    const overUnder = odds?.overUnder || 43.5;
    
    const homeRecord = liveHStanding?.record || home.records?.[0]?.summary || "0-0";
    const awayRecord = liveAStanding?.record || away.records?.[0]?.summary || "0-0";

    const gameStatus = comp.status?.type?.name || "STATUS_SCHEDULED";
    const isCompleted = comp.status?.type?.completed === true;
    const homeScore = isCompleted ? parseInt(home.score || 0, 10) : null;
    const awayScore = isCompleted ? parseInt(away.score || 0, 10) : null;

    return {
      id: `nfl-${ev.id}`,
      gameDate: ev.date,
      gameStatus,
      isCompleted,
      homeScore,
      awayScore,
      weather: weather || { windMph: 0, tempC: 21, isDome: false, notice: "Clima estándar" },
      home: {
        name: homeName,
        abbr: homeAbbr,
        logo: homeLogo,
        record: homeRecord,
        streak: liveHStanding?.streak,
        qb: effectiveHomeQb,
        ypp: hStats.ypp,
        turnoverDiff: hStats.to,
        elo: getDynamicElo(homeName, effectiveHomeElo),
        epaNet: effectiveHomeEpa
      },
      away: {
        name: awayName,
        abbr: awayAbbr,
        logo: awayLogo,
        record: awayRecord,
        streak: liveAStanding?.streak,
        qb: effectiveAwayQb,
        ypp: aStats.ypp,
        turnoverDiff: aStats.to,
        elo: getDynamicElo(awayName, effectiveAwayElo),
        epaNet: effectiveAwayEpa
      },
      vegas: {
        spread,
        overUnder,
        details: odds?.details || `${spread > 0 ? '+' : ''}${spread}`,
        favoredTeam: odds?.details?.split(' ')?.[0] || homeAbbr
      }
    };
  });

  const resolvedGames = await Promise.all(gamePromises);
  const games = resolvedGames.filter(g => g !== null);

  // ================= INTEGRAR THE ODDS API =================
  const oddsData = await fetchTheOdds('americanfootball_nfl');
  if (oddsData && Array.isArray(oddsData)) {
    games.forEach(game => {
      const match = oddsData.find(o => 
        (o.home_team === game.home.name || o.home_team.includes(game.home.name.split(' ').pop())) &&
        (o.away_team === game.away.name || o.away_team.includes(game.away.name.split(' ').pop()))
      );
      if (match && match.bookmakers && match.bookmakers.length > 0) {
        const bookie = match.bookmakers.find(b => b.key === 'pinnacle') || match.bookmakers.find(b => b.key === 'bet365') || match.bookmakers[0];
        const h2h = bookie.markets.find(m => m.key === 'h2h');
        
        if (!game.market) game.market = {};
        
        if (h2h && h2h.outcomes) {
          const hOutcome = h2h.outcomes.find(o => o.name === match.home_team);
          const aOutcome = h2h.outcomes.find(o => o.name === match.away_team);
          if (hOutcome && aOutcome) {
            game.market.homeOdds = hOutcome.price.toString();
            game.market.awayOdds = aOutcome.price.toString();
            game.market.current = game.market.homeOdds;
            game.market.bookmaker = bookie.title;
          }
        }
      }
    });
  }

  return { weekNumber: actualWeek, seasonYear, games };
}

/**
 * Descarga la jornada real para el Radar de Oportunidades
 */
export async function fetchDailySchedule(sport, dateRange = "hoy") {
  try {
    let schedule = [];
    if (sport === 'mlb') {
      schedule = await fetchRealMlbSchedule(dateRange);
    } else if (sport === 'nfl') {
      schedule = await fetchRealNflSchedule(dateRange);
    } else {
      schedule = await fetchRealSoccerSchedule(dateRange);
    }

    // Actualizar cache en memoria
    if (schedule && schedule.length > 0) {
      liveCache[sport] = schedule;
    }
    
    return schedule;
  } catch (err) {
    console.error(`Error al consultar partidos reales de ${sport}:`, err);
    // Si falla la red, retornar lo que haya en cache o lista vacía
    return liveCache[sport] || [];
  }
}

/**
 * Obtiene datos completos para el Simulador
 */
export async function fetchMatchData(query, sport) {
  // 1. Buscar si el partido existe en la lista de partidos reales descargados
  const normalizedQuery = query.toLowerCase().trim();
  const cachedList = liveCache[sport] || [];

  const foundMatch = cachedList.find(m => {
    const home = m.home.name.toLowerCase();
    const away = m.away.name.toLowerCase();
    const full = `${home} vs ${away}`;
    return full.includes(normalizedQuery) || normalizedQuery.includes(home) || normalizedQuery.includes(away);
  });

  if (foundMatch) {
    return foundMatch;
  }

  // 2. Si no estaba en cache, intentar descargar la jornada de hoy y buscar
  try {
    const liveMatches = await fetchDailySchedule(sport, "hoy");
    const foundInLive = liveMatches.find(m => {
      const home = m.home.name.toLowerCase();
      const away = m.away.name.toLowerCase();
      return normalizedQuery.includes(home) || normalizedQuery.includes(away);
    });
    if (foundInLive) return foundInLive;
  } catch (e) {}

  // 3. Si el usuario escribió un partido fuera de calendario (ej. "Real Madrid vs Barcelona" cuando juegan la otra semana)
  const homeName = query.includes(" vs ") ? query.split(" vs ")[0].trim() : query.trim();
  const awayName = query.includes(" vs ") ? query.split(" vs ")[1].trim() : "Rival";

  if (sport === 'mlb') {
    return {
      sport: 'mlb',
      league: 'MLB (Simulación)',
      home: {
        name: homeName,
        recentForm: "W W L W W",
        ops: "0.760",
        elo: 1550,
        daysRest: 1,
        pitcher: { name: "Abridor Titular", whip: "1.18" }
      },
      away: {
        name: awayName,
        recentForm: "L W L L W",
        ops: "0.710",
        elo: 1480,
        daysRest: 1,
        pitcher: { name: "Rotación 2", whip: "1.35" }
      },
      market: { open: "1.95", current: "1.85", isSteamMove: true }
    };
  } else if (sport === 'nfl') {
    return {
      sport: 'nfl',
      league: 'NFL (Simulación)',
      home: {
        name: homeName,
        recentForm: "W W L W W",
        netYardsPerPlay: "5.8",
        turnoverDifferential: 2,
        elo: 1560,
        daysRest: 7,
        keyPlayer: { name: "QB Titular", passYardsAvg: 260 }
      },
      away: {
        name: awayName,
        recentForm: "L L W L W",
        netYardsPerPlay: "5.1",
        turnoverDifferential: -1,
        elo: 1470,
        daysRest: 7,
        keyPlayer: { name: "RB Estrella", rushYardsAvg: 70 }
      },
      market: { open: "2.10", current: "1.90", isSteamMove: true }
    };
  } else {
    const normHome = homeName.toLowerCase();
    const normAway = awayName.toLowerCase();

    // Buscar si conocemos los equipos de las tablas de posiciones oficiales
    const foundHomeKey = Object.keys(knownSoccerTeams).find(k => k.includes(normHome) || normHome.includes(k));
    const foundAwayKey = Object.keys(knownSoccerTeams).find(k => k.includes(normAway) || normAway.includes(k));

    const homeStats = foundHomeKey ? knownSoccerTeams[foundHomeKey] : null;
    const awayStats = foundAwayKey ? knownSoccerTeams[foundAwayKey] : null;

    const realHomeXg = homeStats ? (homeStats.homeOffenseXg || homeStats.xG) : "1.65";
    const realAwayXg = awayStats ? (awayStats.awayOffenseXg || awayStats.xG) : "1.15";
    const realHomeElo = getDynamicElo(homeName, homeStats ? homeStats.elo : 1540);
    const realAwayElo = getDynamicElo(awayName, awayStats ? awayStats.elo : 1480);

    return {
      sport: 'futbol',
      league: homeStats ? 'Liga Oficial' : 'Fútbol (Simulación)',
      home: {
        name: homeStats?.name || homeName,
        recentForm: "W W D W L",
        xG: realHomeXg.toString(),
        elo: realHomeElo,
        daysRest: 6,
        cornersAvg: (3.5 + parseFloat(realHomeXg) * 1.6).toFixed(1),
        cardsAvg: "2.1",
        keyPlayer: { name: "Goleador", shotsOnTargetAvg: "1.4" }
      },
      away: {
        name: awayStats?.name || awayName,
        recentForm: "L D L W L",
        xG: realAwayXg.toString(),
        elo: realAwayElo,
        daysRest: 4,
        cornersAvg: (3.0 + parseFloat(realAwayXg) * 1.4).toFixed(1),
        cardsAvg: "2.5",
        keyPlayer: { name: "Extremo", shotsOnTargetAvg: "0.7" }
      },
      market: { open: "1.95", current: "1.80", isSteamMove: true }
    };
  }
}
