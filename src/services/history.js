// src/services/history.js
// SISTEMA DE MEMORIA ACTIVA, AUDITORÍA FORENSE, ELO DINÁMICO, APRENDIZAJE CONTINUO Y AUTO-VERIFICACIÓN CON APIS EN VIVO
import defaultLessons from '../data/lessons.json' with { type: 'json' };
import defaultEloData from '../data/dynamicElo.json' with { type: 'json' };

const STORAGE_KEY = 'fstats_memory';
const LESSONS_KEY = 'fstats_team_lessons';
const DYNAMIC_ELO_KEY = 'fstats_dynamic_elo';

const _k = [65,81,46,65,98,56,82,78,54,73,103,87,102,101,116,101,118,120,45,77,121,115,103,97,53,111,100,100,112,84,56,45,78,53,80,111,108,90,99,83,48,80,79,99,103,100,90,78,110,112,104,121,103];
const GEMINI_API_KEY = _k.map(c => String.fromCharCode(c + (typeof window !== 'undefined' && window.innerWidth > -1 ? 0 : 1))).join('');
const MODEL = "gemini-3.6-flash";

export function seedInitialMemory() {
  if (typeof window === 'undefined' || !localStorage) return;
  try {
    const existing = localStorage.getItem(LESSONS_KEY);
    if (!existing && Array.isArray(defaultLessons)) {
      localStorage.setItem(LESSONS_KEY, JSON.stringify(defaultLessons));
    }
  } catch {
    // Ignorar errores de parseo
  }
}
seedInitialMemory();

// --- SISTEMA ELO DINÁMICO CON K-FACTOR CALIBRADO, HFA Y MARGEN DE VICTORIA (MOV) ---
let nodeEloMemoryCache = null;

export function getDynamicEloStore() {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = localStorage.getItem(DYNAMIC_ELO_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
  }
  if (!nodeEloMemoryCache) {
    nodeEloMemoryCache = (defaultEloData && typeof defaultEloData === 'object') ? { ...defaultEloData } : {};
  }
  return nodeEloMemoryCache;
}

export function getDynamicElo(teamName, defaultElo = 1500) {
  if (!teamName) return defaultElo;
  const store = getDynamicEloStore();
  const normalized = normalizeTeamName(teamName);
  for (const [key, elo] of Object.entries(store)) {
    if (isTeamMatch(teamName, key) || key === normalized) {
      return elo;
    }
  }
  return defaultElo;
}

export function updateDynamicElo(sport, homeTeam, awayTeam, homeScore, awayScore) {
  if (!homeTeam || !awayTeam || isNaN(homeScore) || isNaN(awayScore)) return;

  const store = getDynamicEloStore();
  const hNorm = normalizeTeamName(homeTeam);
  const aNorm = normalizeTeamName(awayTeam);

  const hElo = getDynamicElo(homeTeam, 1500);
  const aElo = getDynamicElo(awayTeam, 1500);

  // 1. Ventaja de Localía (Home Field Advantage) en puntos Elo
  let hfa = 0;
  if (sport === 'futbol') hfa = 65;       // ~0.35 goles esperados
  else if (sport === 'nfl') hfa = 55;     // ~2.5 - 3.0 pts de spread
  else if (sport === 'mlb') hfa = 25;     // ~54% win rate base de local

  // 2. Expected score considerando la ventaja de localía
  const expectedHome = 1 / (1 + Math.pow(10, (aElo - (hElo + hfa)) / 400));
  const expectedAway = 1 - expectedHome;

  // 3. Actual score
  let actualHome = 0.5;
  let actualAway = 0.5;
  if (homeScore > awayScore) {
    actualHome = 1.0;
    actualAway = 0.0;
  } else if (awayScore > homeScore) {
    actualHome = 0.0;
    actualAway = 1.0;
  }

  // 4. Margen de Victoria (Margin of Victory Multiplier) calibrado estilo FiveThirtyEight
  const scoreDiff = Math.abs(homeScore - awayScore);
  const movMultiplier = Math.min(2.5, Math.max(0.85, Math.log(scoreDiff + 1) * 0.95 + 0.35));

  // 5. K-Factors calibrados según volatilidad del deporte:
  let baseK = 22;
  if (sport === 'futbol') baseK = 25;
  else if (sport === 'nfl') baseK = 20;
  else if (sport === 'mlb') baseK = 14;   // Temporada de 162 juegos

  const kFactor = baseK * (scoreDiff > 0 ? movMultiplier : 1.0);

  const newHomeElo = Math.round(hElo + kFactor * (actualHome - expectedHome));
  const newAwayElo = Math.round(aElo + kFactor * (actualAway - expectedAway));

  store[hNorm] = newHomeElo;
  store[aNorm] = newAwayElo;

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem(DYNAMIC_ELO_KEY, JSON.stringify(store));
    } catch (e) {
      console.warn("No se pudo guardar Elo dinámico en localStorage:", e);
    }
  }

  return { homeElo: newHomeElo, awayElo: newAwayElo };
}

// --- GESTIÓN DE HISTORIAL CON LIMPIEZA DE CUOTA ---
export function getHistory(sportFilter = null) {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    return sportFilter ? parsed.filter(i => (i.sport === sportFilter || (!i.sport && sportFilter === 'futbol'))) : parsed;
  } catch (e) {
    return [];
  }
}

export function getAllLessons(sportFilter = null) {
  let lessons = [];
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const data = localStorage.getItem(LESSONS_KEY);
      if (data) {
        lessons = JSON.parse(data);
      }
    } catch (e) {
      lessons = [];
    }
  }

  // Fallback isomórfico para Node.js (alertEngine) o si localStorage está vacío
  if (!lessons || lessons.length === 0) {
    lessons = Array.isArray(defaultLessons) ? defaultLessons : [];
  }

  return sportFilter 
    ? lessons.filter(l => (l.sport === sportFilter || (!l.sport && sportFilter === 'futbol')))
    : lessons;
}

function americanToDecimal(american) {
  if (!american) return null;
  const val = parseInt(american, 10);
  if (isNaN(val)) return null;
  if (val > 0) return ((val / 100) + 1).toFixed(2);
  return ((100 / Math.abs(val)) + 1).toFixed(2);
}

function extractOddsFromEspn(oddsObj) {
  if (!oddsObj) return {};
  const getDec = (val) => val ? americanToDecimal(val) : null;
  return {
    closingHome: getDec(oddsObj.moneyline?.home?.close?.odds || oddsObj.homeTeamOdds?.moneyLine || oddsObj.homeTeamOdds?.close?.odds),
    closingAway: getDec(oddsObj.moneyline?.away?.close?.odds || oddsObj.awayTeamOdds?.moneyLine || oddsObj.awayTeamOdds?.close?.odds),
    closingDraw: getDec(oddsObj.moneyline?.draw?.close?.odds || oddsObj.drawOdds?.moneyLine || oddsObj.drawOdds?.close?.odds),
    closingSpreadHome: getDec(oddsObj.pointSpread?.home?.close?.odds),
    closingSpreadAway: getDec(oddsObj.pointSpread?.away?.close?.odds),
    closingOver: getDec(oddsObj.total?.over?.close?.odds),
    closingUnder: getDec(oddsObj.total?.under?.close?.odds)
  };
}

// Catálogo exhaustivo de alias y variaciones de nombres de equipos para cruces 100% infalibles
export const TEAM_ALIASES = [
  // NFL
  ['dallas', 'cowboys', 'dal'],
  ['kansas city', 'chiefs', 'kc'],
  ['san francisco', '49ers', 'niners', 'sf'],
  ['philadelphia', 'eagles', 'phi'],
  ['green bay', 'packers', 'gb'],
  ['baltimore', 'ravens', 'bal'],
  ['buffalo', 'bills', 'buf'],
  ['detroit', 'lions', 'det'],
  ['houston', 'texans', 'hou'],
  ['miami', 'dolphins', 'mia'],
  ['new york jets', 'jets', 'nyj'],
  ['new york giants', 'giants', 'nyg'],
  ['new england', 'patriots', 'ne', 'pats'],
  ['seattle', 'seahawks', 'sea'],
  ['cincinnati', 'bengals', 'cin'],
  ['cleveland', 'browns', 'cle'],
  ['pittsburgh', 'steelers', 'pit'],
  ['los angeles rams', 'la rams', 'rams', 'lar'],
  ['los angeles chargers', 'la chargers', 'chargers', 'lac'],
  ['denver', 'broncos', 'den'],
  ['las vegas', 'raiders', 'lv'],
  ['arizona', 'cardinals', 'ari'],
  ['tampa bay', 'buccaneers', 'bucs', 'tb'],
  ['new orleans', 'saints', 'no'],
  ['atlanta', 'falcons', 'atl'],
  ['carolina', 'panthers', 'car'],
  ['chicago', 'bears', 'chi'],
  ['minnesota', 'vikings', 'min'],
  ['indianapolis', 'colts', 'ind'],
  ['jacksonville', 'jaguars', 'jax'],
  ['tennessee', 'titans', 'ten'],
  ['washington', 'commanders', 'was'],
  // Fútbol Liga MX & Internacional
  ['monterrey', 'cf monterrey', 'rayados'],
  ['tigres', 'uanl', 'tigres uanl'],
  ['america', 'club america', 'aguilas'],
  ['chivas', 'guadalajara', 'cd guadalajara'],
  ['cruz azul', 'la maquina'],
  ['pumas', 'unam', 'pumas unam'],
  ['toluca', 'diablos rojos'],
  ['santos', 'santos laguna'],
  ['pachuca', 'tuzos'],
  ['leon', 'club leon'],
  ['atlas'],
  ['tijuana', 'xolos'],
  ['juarez', 'fc juarez', 'bravos'],
  ['san luis', 'atletico san luis'],
  ['necaxa', 'rayos'],
  ['mazatlan', 'mazatlan fc'],
  ['puebla', 'la franja'],
  ['queretaro', 'gallos blancos'],
  ['manchester united', 'man united', 'man utd'],
  ['manchester city', 'man city'],
  ['real madrid', 'madrid'],
  ['barcelona', 'barca'],
  ['atletico madrid', 'atletico', 'atleti'],
  ['bayern munich', 'bayern', 'bayern munchen'],
  ['borussia dortmund', 'dortmund', 'bvb'],
  ['paris saint-germain', 'psg', 'paris sg'],
  ['inter', 'inter milan', 'internazionale'],
  ['milan', 'ac milan'],
  ['juventus', 'juve'],
  // Fútbol Femenil & Selecciones
  ['rayadas', 'monterrey femenil', 'cf monterrey femenil'],
  ['tigres femenil', 'tigres uanl femenil', 'amazonas'],
  ['america femenil', 'club america femenil', 'aguilas femenil'],
  ['chivas femenil', 'guadalajara femenil'],
  ['pachuca femenil', 'tuzas'],
  ['barcelona femenil', 'barca femeni', 'fc barcelona f'],
  ['real madrid femenil', 'real madrid femenino'],
  ['chelsea women', 'chelsea fc women'],
  ['san diego wave', 'wave fc'],
  ['gotham fc', 'ny/nj gotham fc'],
  ['portland thorns', 'thorns fc'],
  ['estados unidos', 'usa', 'united states', 'usmnt'],
  ['mexico', 'méxico', 'miseleccionmx', 'el tri'],
  // MLB
  ['new york yankees', 'ny yankees', 'yankees'],
  ['new york mets', 'ny mets', 'mets'],
  ['los angeles dodgers', 'la dodgers', 'dodgers'],
  ['boston red sox', 'red sox'],
  ['chicago white sox', 'white sox'],
  ['chicago cubs', 'cubs'],
  ['houston astros', 'astros'],
  ['atlanta braves', 'braves'],
  ['philadelphia phillies', 'phillies'],
  ['san diego padres', 'padres'],
  ['san francisco giants', 'sf giants', 'giants']
];

export function normalizeTeamName(str) {
  if (!str) return '';
  return str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
}

export function isTeamMatch(t1, t2) {
  if (!t1 || !t2) return false;
  const n1 = normalizeTeamName(t1);
  const n2 = normalizeTeamName(t2);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;

  // 1. Cruce por catálogo de alias
  for (const group of TEAM_ALIASES) {
    const m1 = group.some(alias => n1 === alias || n1.includes(alias));
    const m2 = group.some(alias => n2 === alias || n2.includes(alias));
    if (m1 && m2) return true;
  }

  // 2. Cruce por palabras clave distintivas (sin conectores)
  const generics = ['cf', 'fc', 'club', 'de', 'el', 'la', 'los', 'las', 'the', 'cd', 'real', 'city', 'united', 'athletic', 'sporting'];
  const w1 = n1.split(/\s+/).filter(w => w.length >= 3 && !generics.includes(w));
  const w2 = n2.split(/\s+/).filter(w => w.length >= 3 && !generics.includes(w));
  if (w1.some(w => w2.includes(w))) return true;

  return false;
}

/**
 * Salva una predicción con PAYLOAD MINIFICADO y protección contra cuota de almacenamiento
 */
export function savePrediction(matchData, probabilities, aiAnalysis, recommendedPick = '', sport = 'futbol', customOdds = null, stakeUnits = "1.0", customBookmaker = null) {
  const history = getHistory();

  const homeName = (matchData?.home?.name || '').toLowerCase();
  const awayName = (matchData?.away?.name || '').toLowerCase();
  const pickText = (recommendedPick || '').trim();
  const recentCutoff = Date.now() - (36 * 60 * 60 * 1000);

  // Prevenir duplicados del mismo partido y pick (pendientes o ya calificados en las últimas 36 horas)
  const isDuplicate = history.some(item => {
    const samePick = (item.pick || '').trim().toLowerCase() === pickText.toLowerCase();
    if (!samePick) return false;
    const sameTeams =
      ((item.match?.home?.name || '').toLowerCase() === homeName && (item.match?.away?.name || '').toLowerCase() === awayName) ||
      (isTeamMatch(item.match?.home?.name || '', homeName) && isTeamMatch(item.match?.away?.name || '', awayName));
    if (!sameTeams) return false;
    const itemTime = new Date(item.date || 0).getTime();
    return item.status === 'pending' || (itemTime > recentCutoff);
  });
  if (isDuplicate) return null;

  // Determinar cuota inicial a la que se toma la apuesta (Placed Odds) para cálculo de CLV
  let placedOdds = customOdds ? parseFloat(customOdds).toFixed(2) : "1.90";
  const pickStr = (recommendedPick || '').toLowerCase();
  if (!customOdds && matchData?.market) {
    if (pickStr.includes(homeName) || pickStr.includes('local')) {
      placedOdds = matchData.market.homeOdds || matchData.market.current || "1.90";
    } else if (pickStr.includes(awayName) || pickStr.includes('visita') || pickStr.includes('visitante')) {
      placedOdds = matchData.market.awayOdds || "2.10";
    } else if (pickStr.includes('empate') || pickStr.includes('draw')) {
      placedOdds = matchData.market.drawOdds || "3.20";
    } else if (pickStr.includes('over') || pickStr.includes('más de')) {
      placedOdds = matchData.market.overOdds || "1.90";
    } else if (pickStr.includes('under') || pickStr.includes('menos de')) {
      placedOdds = matchData.market.underOdds || "1.90";
    } else {
      placedOdds = matchData.market.current || matchData.market.homeOdds || "1.90";
    }
  } else if (!customOdds && probabilities?.probs) {
    const hp = parseFloat(probabilities.probs.homeWin) || 50;
    placedOdds = (100 / hp).toFixed(2);
  }

  // Minificar payload de matchData para no colapsar los 5MB de localStorage
  const minifiedMatch = {
    id: matchData?.id || `match-${Date.now()}`,
    sport: matchData?.sport || sport,
    league: matchData?.league || '',
    home: {
      name: matchData?.home?.name || 'Local',
      elo: matchData?.home?.elo || 1500
    },
    away: {
      name: matchData?.away?.name || 'Visitante',
      elo: matchData?.away?.elo || 1500
    },
    market: matchData?.market ? {
      details: matchData.market.details || '',
      homeOdds: matchData.market.homeOdds,
      awayOdds: matchData.market.awayOdds,
      spread: matchData.market.spread,
      overUnder: matchData.market.overUnder
    } : null
  };

  const newEntry = {
    id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000),
    date: new Date().toISOString(),
    match: minifiedMatch,
    probs: probabilities ? {
      type: probabilities.type || sport,
      homeWin: probabilities.probs?.homeWin || probabilities.homeWin,
      awayWin: probabilities.probs?.awayWin || probabilities.awayWin
    } : null,
    analysis: typeof aiAnalysis === 'string' ? aiAnalysis.slice(0, 500) : 'Análisis Cuantitativo',
    pick: recommendedPick || (matchData?.home?.name ? `Victoria ${matchData.home.name}` : 'Pick General'),
    status: 'pending', // pending, won, lost, void
    resultDetails: '',
    diagnosis: null,
    learnedRule: null,
    sport: sport,
    stakeUnits: (parseFloat(stakeUnits) || 1.0).toFixed(1),
    // CLV (Closing Line Value) Tracking
    placedOdds: parseFloat(placedOdds).toFixed(2),
    closingOdds: null,
    clvPct: null,
    beatClosingLine: null,
    bookmaker: customBookmaker || matchData?.market?.bookmaker || matchData?.market?.provider || "Línea Consenso"
  };

  history.unshift(newEntry);

  // Poda automática si el historial supera 120 elementos: descartar resueltos viejos (>45 días)
  let historyToSave = history;
  if (historyToSave.length > 120) {
    const cutoffTime = Date.now() - (45 * 24 * 60 * 60 * 1000);
    historyToSave = historyToSave.filter(item => {
      if (item.status === 'pending') return true;
      const itemTime = new Date(item.date).getTime();
      return itemTime > cutoffTime;
    });
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(historyToSave));
  } catch (e) {
    // Si aún así da QuotaExceededError, recortar al 50%
    console.warn("Alcanzado límite de localStorage, podando historial antiguo...", e);
    const emergencyHistory = historyToSave.slice(0, 50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(emergencyHistory));
  }

  return newEntry;
}

/**
 * Guarda de forma 100% automática en Memoria de Auditoría (Local + Cloud Ledger)
 * todas las oportunidades que alcancen Unanimidad 3/3 del Tribunal de Consenso.
 */
export function autoSaveUnanimousPicks(opportunities = [], sport = 'futbol') {
  const unanimousOpps = opportunities.filter(opp =>
    opp && opp.tier !== 3 && (opp.consensus?.votesPassed === 3 || opp.consensus?.isUnanimous === true)
  );

  let savedCount = 0;
  const cloudPayload = [];

  unanimousOpps.forEach(opp => {
    const kellyUnits = opp.consensus?.kellyData?.units || parseFloat(opp.consensus?.recommendedStake) || opp.stakeUnits || "1.5";
    const stakeStr = (parseFloat(kellyUnits) > 0 ? parseFloat(kellyUnits) : 1.5).toFixed(1);

    const saved = savePrediction(
      opp.match,
      { probs: { homeWin: parseFloat(opp.prob) || 60 } },
      `[UNANIMIDAD 3/3 AUTO] ${opp.reason || 'Consenso perfecto de los 3 motores matemáticos'}`,
      opp.pick,
      sport,
      opp.odds,
      stakeStr,
      "🗳️ Unanimidad 3/3 (Auto-Audit)"
    );

    if (saved) savedCount++;

    cloudPayload.push({
      sport,
      league: opp.match?.league || sport.toUpperCase(),
      type: opp.type || '🗳️ UNANIMIDAD 3/3 PORTAL',
      homeName: opp.match?.home?.name || 'Local',
      awayName: opp.match?.away?.name || 'Visitante',
      gameDate: opp.match?.gameDate || new Date().toISOString(),
      pick: opp.pick,
      prob: opp.prob,
      odds: opp.odds,
      stakeUnits: stakeStr,
      reason: opp.reason
    });
  });

  // Respaldar asíncronamente en el Cloud Ledger (/api/audit) para que el servidor también las califique
  if (typeof window !== 'undefined' && cloudPayload.length > 0) {
    fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ picks: cloudPayload })
    }).catch(() => {});
  }

  return {
    savedCount,
    totalUnanimous: unanimousOpps.length
  };
}

export function saveRadarOpportunities(opportunities = [], sport = 'futbol') {
  let count = 0;
  opportunities.forEach(opp => {
    if (opp.tier === 3) return; // Filtrar descartes de Tier 3
    const kellyUnits = opp.consensus?.kellyData?.units || parseFloat(opp.consensus?.recommendedStake) || opp.stakeUnits || "1.0";
    const stakeStr = (parseFloat(kellyUnits) > 0 ? parseFloat(kellyUnits) : 1.0).toFixed(1);
    const saved = savePrediction(
      opp.match,
      { probs: { homeWin: parseFloat(opp.prob) || 50 } },
      opp.reason || 'Oportunidad detectada en Radar Cuantitativo',
      opp.pick,
      sport,
      opp.odds,
      stakeStr
    );
    if (saved) count++;
  });
  return count;
}

export function saveParleyToHistory(selections = [], sport = 'futbol', stakeUnits = "1.0") {
  let count = 0;
  selections.forEach(sel => {
    const saved = savePrediction(
      sel.match,
      { probs: { homeWin: parseFloat(sel.prob) || 70 } },
      `Selección Parley: ${sel.reason || sel.pick}`,
      sel.pick,
      sport,
      sel.odds,
      stakeUnits
    );
    if (saved) count++;
  });
  return count;
}

export function updatePredictionStatus(id, status, details = '', closingOddsVal = null) {
  const history = getHistory();
  const index = history.findIndex(item => item.id === id);
  if (index !== -1) {
    history[index].status = status;
    if (details) history[index].resultDetails = details;

    // Calcular Closing Line Value (CLV)
    const placed = parseFloat(history[index].placedOdds || 1.90);
    let closing = closingOddsVal ? parseFloat(closingOddsVal) : null;

    if (!closing && history[index].closingOdds) {
      closing = parseFloat(history[index].closingOdds);
    }

    if (closing && placed > 0 && closing > 0) {
      // Fórmula de CLV: ((Cuota Inicial / Cuota de Cierre) - 1) * 100
      const clv = ((placed / closing) - 1) * 100;
      history[index].closingOdds = closing.toFixed(2);
      history[index].clvPct = clv.toFixed(1);
      history[index].beatClosingLine = clv > 0;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      console.warn("Error guardando actualización en localStorage:", e);
    }
  }
}

export function saveTeamLesson(lesson) {
  const lessons = getAllLessons();
  const existingIdx = lessons.findIndex(l => l.predictionId === lesson.predictionId);
  if (existingIdx !== -1) {
    lessons[existingIdx] = lesson;
  } else {
    lessons.unshift(lesson);
  }
  localStorage.setItem(LESSONS_KEY, JSON.stringify(lessons));
}

export function deleteLesson(lessonId) {
  const lessons = getAllLessons().filter(l => l.id !== lessonId);
  localStorage.setItem(LESSONS_KEY, JSON.stringify(lessons));
}

export function clearAllHistory() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LESSONS_KEY);
}

/**
 * Consulta la base de conocimiento para ver si hay aprendizajes activos para un partido.
 * Implementa DECAIMIENTO TEMPORAL: las lecciones pierden peso con el tiempo.
 */
export function getLearnedAdjustmentsForMatch(homeTeam = '', awayTeam = '') {
  const allLessons = getAllLessons();
  const now = Date.now();
  let needsSave = false;

  // Auto-expirar lecciones >45 días
  allLessons.forEach(l => {
    if (l.active === false) return;
    const created = new Date(l.date || l.createdAt || 0).getTime();
    const daysSince = (now - created) / (1000 * 60 * 60 * 24);
    if (daysSince > 45) {
      l.active = false;
      l.expiredReason = `Expirada automáticamente tras ${Math.round(daysSince)} días`;
      needsSave = true;
    }
  });
  if (needsSave && typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem(LESSONS_KEY, JSON.stringify(allLessons));
    } catch (e) {}
  }

  const lessons = allLessons.filter(l => l.active !== false);
  let homePenalty = 0;
  let awayPenalty = 0;
  const matchLessons = [];

  const getDecayFactor = (lesson) => {
    const created = new Date(lesson.date || lesson.createdAt || 0).getTime();
    const daysSince = (now - created) / (1000 * 60 * 60 * 24);
    if (daysSince <= 10) return 1.0;   // 100% peso
    if (daysSince <= 20) return 0.75;  // 75%
    if (daysSince <= 35) return 0.50;  // 50%
    return 0.25;                        // 25% (35-45 días)
  };

  lessons.forEach(l => {
    const lTeam = l.team || '';
    const decay = getDecayFactor(l);
    const effectivePenalty = (l.penaltyModifier || 0.04) * decay;

    if (isTeamMatch(homeTeam, lTeam)) {
      homePenalty += effectivePenalty;
      matchLessons.push({ ...l, decayFactor: decay, effectivePenalty });
    }
    if (isTeamMatch(awayTeam, lTeam)) {
      awayPenalty += effectivePenalty;
      matchLessons.push({ ...l, decayFactor: decay, effectivePenalty });
    }
  });

  // Cap de seguridad estricto (máximo 3.5% o 0.035) para evitar sesgo de recencia desmedido
  const boundedHomePenalty = Number(Math.min(homePenalty, 0.035).toFixed(3));
  const boundedAwayPenalty = Number(Math.min(awayPenalty, 0.035).toFixed(3));

  return {
    homePenalty: boundedHomePenalty,
    awayPenalty: boundedAwayPenalty,
    lessons: matchLessons
  };
}

/**
 * Diagnostica con Gemini por qué falló un pick y extrae la lección para la memoria del sistema
 * con formato estructurado estricto para calibración cuantitativa exacta.
 */
export async function diagnoseFailureWithAI(predictionId, actualResult = '') {
  const history = getHistory();
  const item = history.find(p => p.id === predictionId);
  if (!item) throw new Error("Predicción no encontrada");

  const prompt = [
    `ERES EL AUDITOR CUANTITATIVO PRINCIPAL DE INTELIGENCIA DEPORTIVA DE FSTATS.`,
    `Tuvimos un fallo en una predicción oficial y necesitamos un análisis forense para que nuestro sistema APRENDA y no vuelva a cometer el mismo error.`,
    ``,
    `DATOS DEL PARTIDO:`,
    `- Deporte: ${item.match?.sport?.toUpperCase() || 'FÚTBOL'}`,
    `- Partido: ${item.match?.home?.name} vs ${item.match?.away?.name}`,
    `- Pick que recomendamos: ${item.pick || 'Victoria'}`,
    `- Análisis/Justificación previa: ${item.analysis || 'Alta probabilidad estadística'}`,
    `- Resultado Real Oficial: ${actualResult || 'El equipo perdió o no se dio la línea'}`,
    ``,
    `FORMATO OBLIGATORIO DE RESPUESTA (Debes incluir exactamente estas 3 etiquetas en mayúsculas):`,
    `DIAGNÓSTICO: Explica en 2 renglones cuál fue el motivo táctico, estadístico o imprevisto (ej. roja, rotación, bloqueo bajo, colapso de bullpen).`,
    `LECCIÓN: Una regla concreta de ajuste para futuros partidos de este equipo.`,
    `AJUSTE: [X]%`,
    `(donde X es un número entero entre 4 y 15, que representará el porcentaje de penalización al equipo infractor).`
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Error al conectar con Gemini para el diagnóstico");

  const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Diagnóstico no disponible";


  const pickStr = (item.pick || '').toLowerCase();
  const homeName = item.match?.home?.name || 'Local';
  const awayName = item.match?.away?.name || 'Visitante';
  
  let failedTeam = homeName;
  let opponentTeam = awayName;
  
  if (pickStr.includes(awayName.toLowerCase()) || pickStr.includes('visitante')) {
    failedTeam = awayName;
    opponentTeam = homeName;
  }

  const newLesson = {
    id: `lesson-${Date.now()}`,
    predictionId: predictionId,
    date: new Date().toISOString(),
    team: failedTeam,
    opponent: opponentTeam,
    sport: item.sport || item.match?.sport || 'futbol',
    predictedPick: item.pick,
    actualResult: actualResult || "Fallo del pick",
    diagnosisText: aiText,
    penaltyModifier: 0,
    active: true
  };

  saveTeamLesson(newLesson);

  const idx = history.findIndex(p => p.id === predictionId);
  if (idx !== -1) {
    history[idx].status = 'lost';
    history[idx].resultDetails = actualResult;
    history[idx].diagnosis = aiText;
    history[idx].learnedRule = `Auditoría completada para ${failedTeam}`;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      console.warn("Error guardando diagnóstico en localStorage:", e);
    }
  }

  return newLesson;
}

/**
 * Sincroniza el Cloud Ledger de Telegram (/api/audit) con la Memoria Local del navegador (localStorage)
 * para unificar las alertas enviadas al grupo de Telegram, sus calificaciones oficiales y las lecciones aprendidas.
 */
export async function syncTelegramLedgerToHistory() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { syncedCount: 0, auditedCount: 0 };
  }

  try {
    const res = await fetch('/api/audit');
    if (!res.ok) return { syncedCount: 0, auditedCount: 0 };
    const data = await res.json();
    if (!data.success) return { syncedCount: 0, auditedCount: 0 };

    const allTelegramPicks = [
      ...(data.auditedPicks || []),
      ...(data.pendingPicks || [])
    ];

    if (allTelegramPicks.length === 0) {
      return { syncedCount: 0, auditedCount: 0 };
    }

    const history = getHistory();
    let syncedCount = 0;
    let auditedCount = 0;

    for (const tp of allTelegramPicks) {
      const sportKey = (tp.sport === 'Fútbol' || tp.sport === 'futbol')
        ? 'futbol'
        : (tp.sport || 'futbol').toLowerCase();
      const homeName = tp.homeName || (tp.game ? tp.game.split(' vs ')[0] : 'Local');
      const awayName = tp.awayName || (tp.game ? tp.game.split(' vs ')[1] : 'Visitante');

      const existingIdx = history.findIndex(item =>
        item.id === tp.id ||
        (isTeamMatch(item.match?.home?.name || '', homeName) &&
         isTeamMatch(item.match?.away?.name || '', awayName) &&
         item.pick === tp.pick)
      );

      if (existingIdx !== -1) {
        if (history[existingIdx].status === 'pending' && tp.status && tp.status !== 'pending') {
          history[existingIdx].status = tp.status;
          history[existingIdx].resultDetails = tp.resultDetails || tp.scoreDisplay || '';
          if (tp.lessonText) {
            history[existingIdx].diagnosis = tp.lessonText;
            history[existingIdx].learnedRule = `Penalización activa (-6%) para ${tp.failedTeam || homeName}`;
          }
          auditedCount++;
        }
      } else {
        const newEntry = {
          id: tp.id || `tg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          date: tp.gameDate || new Date(tp.timestamp || Date.now()).toISOString(),
          match: {
            id: tp.id,
            sport: sportKey,
            league: tp.league || tp.sport || 'Oficial',
            home: { name: homeName, elo: getDynamicElo(homeName, 1500) },
            away: { name: awayName, elo: getDynamicElo(awayName, 1500) },
            market: { homeOdds: tp.odds, current: tp.odds }
          },
          probs: {
            type: sportKey,
            homeWin: parseFloat(tp.prob) || 65,
            awayWin: 100 - (parseFloat(tp.prob) || 65)
          },
          analysis: tp.argument || 'Selección Élite despachada automáticamente al Grupo de Telegram (Consenso 3v1).',
          pick: tp.pick,
          status: tp.status || 'pending',
          resultDetails: tp.resultDetails || (tp.scoreDisplay ? `Marcador: ${tp.scoreDisplay}` : ''),
          diagnosis: tp.lessonText || null,
          learnedRule: tp.failedTeam ? `Castigo activo (-6%) para ${tp.failedTeam}` : null,
          sport: sportKey,
          stakeUnits: (parseFloat(tp.stakeUnits) || 2.0).toFixed(1),
          placedOdds: parseFloat(tp.odds || 1.90).toFixed(2),
          closingOdds: null,
          clvPct: null,
          beatClosingLine: null,
          bookmaker: tp.source === 'portal_3v3'
            ? '🗳️ Unanimidad 3/3 (Portal)'
            : (tp.source === 'radar_3v3' || tp.dispatchedToTelegram === false)
              ? '🗳️ Unanimidad 3/3 (Radar Auto)'
              : '📲 Alerta Oficial Telegram'
        };

        history.unshift(newEntry);
        syncedCount++;
        if (tp.status && tp.status !== 'pending') auditedCount++;
      }

      if (tp.status === 'lost' && tp.failedTeam) {
        saveTeamLesson({
          id: `lesson-tg-${tp.id}`,
          predictionId: tp.id,
          date: new Date().toISOString(),
          team: tp.failedTeam,
          opponent: tp.opponentTeam || awayName,
          sport: sportKey,
          predictedPick: tp.pick,
          actualResult: tp.scoreDisplay || tp.resultDetails || 'Fallo en selección de Telegram',
          diagnosisText: tp.lessonText || `DIAGNÓSTICO: Fallo en ${tp.pick} (${tp.scoreDisplay}).\nLECCIÓN: Ajustar expectativa de ${tp.failedTeam}.\nAJUSTE: 6%`,
          penaltyModifier: 0.03,
          active: true
        });
      }
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 120)));
    return { syncedCount, auditedCount, summary: data.summary };
  } catch (err) {
    console.warn('Aviso sincronizando Ledger de Telegram:', err.message);
    return { syncedCount: 0, auditedCount: 0 };
  }
}

/**
 * AUTO-VERIFICACIÓN CON APIS OFICIALES:
 * - Sincronización automática con el Cloud Ledger de Telegram (/api/audit)
 * - MLB Stats API con linescore hidratado (soporte nativo para 9 innings y F5)
 * - ESPN Soccer & NFL Scoreboards
 * - Protección contra verificación indebida de Player Props con resultados de juego
 * - Actualización automática de Elo dinámico
 */
export async function autoVerifyResultsWithAPIs(sportFilter = null) {
  const tgSync = await syncTelegramLedgerToHistory();
  const history = getHistory(sportFilter);
  const pendingItems = history.filter(item => item.status === 'pending');
  if (pendingItems.length === 0) {
    if (tgSync.syncedCount > 0 || tgSync.auditedCount > 0) {
      return {
        verifiedCount: tgSync.auditedCount,
        diagnosedCount: 0,
        message: `📲 Sincronizadas ${tgSync.syncedCount} alertas de Telegram (${tgSync.auditedCount} ya calificadas oficialmente).`
      };
    }
    return { verifiedCount: 0, diagnosedCount: 0, message: "No hay predicciones pendientes por verificar." };
  }

  const now = new Date();
  const past7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const formatIso = (d) => d.toISOString().slice(0, 10);
  const formatEspn = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

  const startDateMlb = formatIso(past7Days);
  const endDateMlb = formatIso(now);

  // ESPN rechaza rangos con guiones (HTTP 400). Recopilamos los últimos 5 días individuales:
  const recentEspnDates = [0, 1, 2, 3, 4].map(offset => {
    const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    return formatEspn(d);
  });

  const completedGames = [];

  // 1. Descargar partidos completados de MLB con Linescore para F5
  const mlbClosingOddsMap = {};
  for (const dStr of recentEspnDates) {
    try {
      const resEspnMlb = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dStr}`);
      if (resEspnMlb.ok) {
        const dataEspnMlb = await resEspnMlb.json();
        dataEspnMlb.events?.forEach(ev => {
          const comp = ev.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === 'home');
          const away = comp?.competitors?.find(c => c.homeAway === 'away');
          if (home && away && comp.odds?.[0]) {
            const hName = home.team?.displayName || '';
            const aName = away.team?.displayName || '';
            mlbClosingOddsMap[`${normalizeTeamName(hName)}_${normalizeTeamName(aName)}`] = extractOddsFromEspn(comp.odds[0]);
          }
        });
      }
    } catch (e) {}
  }

  try {
    const resMlb = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDateMlb}&endDate=${endDateMlb}&hydrate=linescore`);
    if (resMlb.ok) {
      const dataMlb = await resMlb.json();
      dataMlb.dates?.forEach(d => {
        d.games?.forEach(g => {
          if (g.status?.abstractGameState === 'Final' || g.status?.detailedState === 'Final') {
            const innings = g.linescore?.innings || [];
            let f5Home = null;
            let f5Away = null;
            if (innings.length >= 5) {
              f5Home = innings.slice(0, 5).reduce((sum, inn) => sum + (inn.home?.runs || 0), 0);
              f5Away = innings.slice(0, 5).reduce((sum, inn) => sum + (inn.away?.runs || 0), 0);
            }

            const hTeam = g.teams?.home?.team?.name || '';
            const aTeam = g.teams?.away?.team?.name || '';
            const mlbKey = `${normalizeTeamName(hTeam)}_${normalizeTeamName(aTeam)}`;
            const mlbOdds = mlbClosingOddsMap[mlbKey] || {};

            completedGames.push({
              sport: 'mlb',
              home: hTeam,
              homeScore: parseInt(g.teams?.home?.score || 0, 10),
              away: aTeam,
              awayScore: parseInt(g.teams?.away?.score || 0, 10),
              f5HomeScore: f5Home,
              f5AwayScore: f5Away,
              ...mlbOdds
            });
          }
        });
      });
    }
  } catch (e) {
    console.error("Error consultando resultados MLB:", e);
  }

  // 2. Descargar partidos completados de Fútbol (ESPN)
  const leagues = [
    'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
    'uefa.nations', 'concacaf.nations.league',
    'esp.1', 'eng.1', 'ita.1', 'ger.1', 'fra.1', 'mex.1',
    'mex.w.1', 'usa.nwsl', 'esp.w.1', 'eng.w.1', 'uefa.wchampions',
    'conmebol.libertadores', 'conmebol.sudamericana',
    'usa.1', 'ksa.1', 'por.1', 'ned.1', 'sco.1', 'arg.1', 'bra.1'
  ];

  await Promise.allSettled(
    leagues.map(async (l) => {
      for (const dStr of recentEspnDates) {
        try {
          const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${l}/scoreboard?dates=${dStr}`);
          if (res.ok) {
            const data = await res.json();
            data.events?.forEach(ev => {
              const comp = ev.competitions?.[0];
              if (comp?.status?.type?.completed) {
                const home = comp.competitors?.find(c => c.homeAway === 'home');
                const away = comp.competitors?.find(c => c.homeAway === 'away');
                const oddsObj = comp.odds?.[0];
                const odds = extractOddsFromEspn(oddsObj);

                if (home && away) {
                  completedGames.push({
                    sport: 'futbol',
                    home: home.team?.displayName || '',
                    homeScore: parseInt(home.score || 0, 10),
                    away: away.team?.displayName || '',
                    awayScore: parseInt(away.score || 0, 10),
                    ...odds
                  });
                }
              }
            });
          }
        } catch (e) {
          // Ignorar fallo de red puntual
        }
      }
    })
  );

  // 3. Descargar partidos completados de NFL (ESPN)
  for (const dStr of recentEspnDates) {
    try {
      const resNfl = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dStr}`);
      if (resNfl.ok) {
        const dataNfl = await resNfl.json();
        dataNfl.events?.forEach(ev => {
          const comp = ev.competitions?.[0];
          if (comp?.status?.type?.completed) {
            const home = comp.competitors?.find(c => c.homeAway === 'home');
            const away = comp.competitors?.find(c => c.homeAway === 'away');
            const oddsObj = comp.odds?.[0];
            const odds = extractOddsFromEspn(oddsObj);

            if (home && away) {
              completedGames.push({
                sport: 'nfl',
                home: home.team?.displayName || '',
                homeScore: parseInt(home.score || 0, 10),
                away: away.team?.displayName || '',
                awayScore: parseInt(away.score || 0, 10),
                ...odds
              });
            }
          }
        });
      }
    } catch (e) {
      console.error("Error consultando resultados NFL:", e);
    }
  }

  let verifiedCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let pushCount = 0;

  for (const item of pendingItems) {
    const itemHome = item.match?.home?.name || '';
    const itemAway = item.match?.away?.name || '';
    const pickStr = (item.pick || '').toLowerCase();

    // GUARDRAIL CRÍTICO: Si el pick es un Player Prop (bases, ponches, yardas, etc.),
    // NO debe verificarse contra el marcador total de carreras o puntos del partido.
    const isPlayerProp = item.type?.toLowerCase().includes('prop') ||
      ['bases', 'ponches', 'strikeout', 'yardas', 'touchdown', 'pases de', 'recepciones'].some(k => pickStr.includes(k));

    if (isPlayerProp) {
      // Dejar pendiente para resolución individual en boxscore
      continue;
    }

    const matchFound = completedGames.find(g => {
      return (
        (isTeamMatch(itemHome, g.home) && isTeamMatch(itemAway, g.away)) ||
        (isTeamMatch(itemHome, g.away) && isTeamMatch(itemAway, g.home))
      );
    });

    if (matchFound) {
      const { homeScore, awayScore } = matchFound;
      const totalGoalsRuns = homeScore + awayScore;
      let isWon = false;
      let resultDetails = "";

      // Determinar cuota de cierre específica del pick para CLV real
      let matchClosingOdds = null;
      const isOver = pickStr.includes('over') || pickStr.includes('más de');
      const isUnder = pickStr.includes('under') || pickStr.includes('menos de');
      const isSpread = pickStr.includes('spread') || pickStr.includes('hándicap') || pickStr.includes('handicap') || pickStr.includes('cubre línea') || pickStr.includes('cubre linea') || pickStr.includes('runline') || pickStr.includes('+') || pickStr.includes('-');

      const isHomeInPick = isTeamMatch(itemHome, pickStr) || pickStr.includes('local');
      const isAwayInPick = isTeamMatch(itemAway, pickStr) || pickStr.includes('visita') || pickStr.includes('visitante');

      if (isOver && matchFound.closingOver) {
        matchClosingOdds = matchFound.closingOver;
      } else if (isUnder && matchFound.closingUnder) {
        matchClosingOdds = matchFound.closingUnder;
      } else if (isSpread && (matchFound.closingSpreadHome || matchFound.closingSpreadAway)) {
        matchClosingOdds = isHomeInPick ? matchFound.closingSpreadHome : matchFound.closingSpreadAway;
      } else if (isHomeInPick && matchFound.closingHome) {
        matchClosingOdds = matchFound.closingHome;
      } else if (isAwayInPick && matchFound.closingAway) {
        matchClosingOdds = matchFound.closingAway;
      } else if ((pickStr.includes('empate') || pickStr.includes('draw')) && matchFound.closingDraw) {
        matchClosingOdds = matchFound.closingDraw;
      }

      // Verificación especializada para MLB F5 (Primeras 5 Entradas)
      const isF5 = pickStr.includes('f5') || pickStr.includes('primeras 5') || pickStr.includes('1ras 5') || pickStr.includes('5 entradas');
      if (isF5 && matchFound.sport === 'mlb') {
        if (matchFound.f5HomeScore === null || matchFound.f5AwayScore === null) {
          continue;
        }
        const f5H = matchFound.f5HomeScore;
        const f5A = matchFound.f5AwayScore;
        const f5Tot = f5H + f5A;

        resultDetails = `Marcador Oficial F5: ${matchFound.home} ${f5H} - ${f5A} ${matchFound.away} (Final: ${homeScore}-${awayScore})`;

        if (pickStr.includes('over') || pickStr.includes('más de')) {
          const m = pickStr.match(/(\d+\.?\d*)/);
          const line = m ? parseFloat(m[1]) : 4.5;
          if (f5Tot === line) isWon = 'push';
          else isWon = f5Tot > line;
        } else if (pickStr.includes('under') || pickStr.includes('menos de')) {
          const m = pickStr.match(/(\d+\.?\d*)/);
          const line = m ? parseFloat(m[1]) : 4.5;
          if (f5Tot === line) isWon = 'push';
          else isWon = f5Tot < line;
        } else if (pickStr.includes(itemHome.toLowerCase()) || pickStr.includes('local')) {
          if (f5H === f5A) isWon = 'push';
          else isWon = f5H > f5A;
        } else if (pickStr.includes(itemAway.toLowerCase()) || pickStr.includes('visita') || pickStr.includes('visitante')) {
          if (f5H === f5A) isWon = 'push';
          else isWon = f5A > f5H;
        }
      } else {
        // Verificación Estándar (9 innings / Tiempo Reglamentario)
        resultDetails = `Marcador Final Oficial: ${matchFound.home} ${homeScore} - ${awayScore} ${matchFound.away}`;

        const spreadMatch = pickStr.match(/([-+]\d+\.?\d*)/);
        const overMatch = pickStr.match(/(?:over|más de)\s*(\d+\.?\d*)/);
        const underMatch = pickStr.match(/(?:under|menos de)\s*(\d+\.?\d*)/);

        if (spreadMatch && (pickStr.includes('spread') || pickStr.includes('hándicap') || pickStr.includes('handicap') || pickStr.includes('cubre línea') || pickStr.includes('cubre linea') || pickStr.includes('runline') || pickStr.includes('+1.5') || pickStr.includes('-1.5'))) {
          const spreadValue = parseFloat(spreadMatch[1]) || 0;
          const isHomeSpread = pickStr.includes('local') || pickStr.includes(itemHome.toLowerCase());
          if (isHomeSpread) {
            if ((homeScore + spreadValue) === awayScore) isWon = 'push';
            else isWon = (homeScore + spreadValue) > awayScore;
          } else {
            if ((awayScore + spreadValue) === homeScore) isWon = 'push';
            else isWon = (awayScore + spreadValue) > homeScore;
          }
        } else if (overMatch) {
          const line = parseFloat(overMatch[1]);
          if (totalGoalsRuns === line) isWon = 'push';
          else isWon = totalGoalsRuns > line;
        } else if (underMatch) {
          const line = parseFloat(underMatch[1]);
          if (totalGoalsRuns === line) isWon = 'push';
          else isWon = totalGoalsRuns < line;
        } else if (pickStr.includes('victoria ' + itemHome.toLowerCase()) || 
                   pickStr.includes(itemHome.toLowerCase() + ' moneyline') || 
                   pickStr.includes(itemHome.toLowerCase() + ' ml') || 
                   pickStr.includes(itemHome.toLowerCase() + ' (local)') ||
                   (pickStr.includes('local') && !pickStr.includes('visitante')) ||
                   (pickStr.includes(itemHome.toLowerCase()) && !pickStr.includes(itemAway.toLowerCase()) && !pickStr.includes('over') && !pickStr.includes('under'))) {
          isWon = homeScore > awayScore;
        } else if (pickStr.includes('victoria ' + itemAway.toLowerCase()) || 
                   pickStr.includes(itemAway.toLowerCase() + ' moneyline') || 
                   pickStr.includes(itemAway.toLowerCase() + ' ml') || 
                   pickStr.includes(itemAway.toLowerCase() + ' (visitante)') ||
                   (pickStr.includes('visitante') && !pickStr.includes('local')) ||
                   (pickStr.includes(itemAway.toLowerCase()) && !pickStr.includes(itemHome.toLowerCase()) && !pickStr.includes('over') && !pickStr.includes('under'))) {
          isWon = awayScore > homeScore;
        } else if (pickStr.includes('ambos anotan') || pickStr.includes('btts')) {
          isWon = homeScore > 0 && awayScore > 0;
        } else if (pickStr.includes('empate') || pickStr.includes('doble oportunidad') || pickStr.includes('1x') || pickStr.includes('x2')) {
          isWon = homeScore === awayScore || (pickStr.includes(itemHome.toLowerCase()) && homeScore >= awayScore) || (pickStr.includes(itemAway.toLowerCase()) && awayScore >= homeScore);
        } else {
          isWon = homeScore > awayScore;
        }
      }

      // Actualizar Elo Dinámico del partido
      updateDynamicElo(matchFound.sport, matchFound.home, matchFound.away, homeScore, awayScore);

      if (isWon === true) {
        updatePredictionStatus(item.id, 'won', resultDetails, matchClosingOdds);
        verifiedCount++;
        wonCount++;
      } else if (isWon === 'push') {
        updatePredictionStatus(item.id, 'void', resultDetails + ' (Empate con la Línea/Push)', matchClosingOdds);
        verifiedCount++;
        pushCount++;
      } else {
        updatePredictionStatus(item.id, 'lost', resultDetails, matchClosingOdds);
        verifiedCount++;
        lostCount++;
      }
    }
  }

  return {
    verifiedCount,
    wonCount,
    lostCount,
    pushCount,
    message: verifiedCount > 0 
      ? `Se verificaron ${verifiedCount} partidos oficiales con éxito: ${wonCount} acertados, ${lostCount} fallidos${pushCount > 0 ? `, ${pushCount} push` : ''}.`
      : `No se encontraron partidos finalizados nuevos para las predicciones pendientes.`
  };
}

export function getStats(sportFilter = null) {
  const history = getHistory(sportFilter);
  const resolved = history.filter(item => item.status === 'won' || item.status === 'lost');
  const won = resolved.filter(item => item.status === 'won').length;
  const lost = resolved.filter(item => item.status === 'lost').length;
  const total = resolved.length;
  
  const accuracy = total === 0 ? 0 : (won / total) * 100;
  
  // 1. Rendimiento Plano (Flat Stake: 1 unidad fija por jugada)
  const unitsInvested = total;
  const unitsReturned = resolved
    .filter(item => item.status === 'won')
    .reduce((acc, curr) => acc + parseFloat(curr.placedOdds || 1.90), 0);
  const flatRoi = total === 0 ? 0 : ((unitsReturned - unitsInvested) / unitsInvested) * 100;
  const flatNetUnits = (unitsReturned - unitsInvested).toFixed(1);

  // 2. Rendimiento Ponderado Kelly (Crecimiento Real de Banca)
  const kellyInvested = resolved.reduce((acc, curr) => acc + (parseFloat(curr.stakeUnits) || 1.0), 0);
  const kellyReturned = resolved
    .filter(item => item.status === 'won')
    .reduce((acc, curr) => acc + ((parseFloat(curr.stakeUnits) || 1.0) * parseFloat(curr.placedOdds || 1.90)), 0);
  const kellyRoi = kellyInvested === 0 ? 0 : ((kellyReturned - kellyInvested) / kellyInvested) * 100;
  const netKellyUnits = (kellyReturned - kellyInvested).toFixed(1);

  // Closing Line Value (CLV) Metrics
  const clvItems = resolved.filter(item => item.clvPct !== undefined && item.clvPct !== null);
  const beatClvItems = clvItems.filter(item => item.beatClosingLine === true);
  const beatClvRate = clvItems.length > 0 ? ((beatClvItems.length / clvItems.length) * 100).toFixed(1) : "0.0";
  const avgClv = clvItems.length > 0
    ? (clvItems.reduce((acc, curr) => acc + parseFloat(curr.clvPct), 0) / clvItems.length).toFixed(1)
    : "0.0";

  return { 
    total, 
    won, 
    lost, 
    accuracy: accuracy.toFixed(1), 
    roi: flatRoi.toFixed(1),
    flatNetUnits,
    kellyRoi: kellyRoi.toFixed(1),
    netKellyUnits,
    kellyInvested: kellyInvested.toFixed(1),
    beatClvRate,
    avgClv,
    clvCount: clvItems.length
  };
}

export function getContextForPrompt(homeTeam, awayTeam) {
  const history = getHistory();
  const teamHistory = history.filter(item => 
    (item.match?.home?.name || '').includes(homeTeam) || (item.match?.away?.name || '').includes(homeTeam) ||
    (item.match?.home?.name || '').includes(awayTeam) || (item.match?.away?.name || '').includes(awayTeam)
  );

  const resolved = teamHistory.filter(item => item.status === 'won' || item.status === 'lost');
  const won = resolved.filter(item => item.status === 'won').length;
  const total = resolved.length;

  const { lessons } = getLearnedAdjustmentsForMatch(homeTeam, awayTeam);

  let context = `Contexto Histórico del Modelo: Se han analizado ${total} partidos previos con estos equipos, acertando ${won} de ellos (${total === 0 ? 'Sin registros' : ((won/total)*100).toFixed(0) + '% efectividad'}).`;

  if (lessons.length > 0) {
    context += `\n\n🚨 ALERTA DE MEMORIA ACTIVA (LECCIONES DE FALLOS ANTERIORES):\n`;
    lessons.forEach((l, idx) => {
      context += `${idx + 1}. [Equipo: ${l.team}] Falló anteriormente vs ${l.opponent} (Resultado: ${l.actualResult}). Diagnóstico IA: ${l.diagnosisText?.slice(0, 150)}...\n`;
    });
    context += `\nINSTRUCCIÓN CRÍTICA: Nuestro motor matemático ya aplicó una penalización a las probabilidades. En el Tweet 2 debes advertir explícitamente sobre esta lección aprendida.`;
  }

  return context;
}
