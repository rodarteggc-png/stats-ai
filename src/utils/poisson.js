// src/utils/poisson.js

// Factorial helper
function factorial(n) {
  if (n === 0 || n === 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

// Poisson Probability formula: (lambda^k * e^-lambda) / k!
function poissonProbability(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * TAREA 1: Factor de ajuste Dixon-Coles para Poisson Bivariado
 * Corrige la subestimación de empates de baja anotación (0-0, 1-1).
 * Parámetro rho calibrado por liga deportiva:
 * - Ligas de baja anotación / empates frecuentes (Liga MX, Serie A): rho ≈ -0.16
 * - Ligas balanceadas / élite (Premier League, La Liga, UCL): rho ≈ -0.12
 * - Ligas ofensivas y abiertas (Bundesliga, Eredivisie, MLS): rho ≈ -0.06
 */
export const LEAGUE_RHO_MAP = {
  'liga mx': -0.16,
  'mexico': -0.16,
  'serie a': -0.15,
  'ligue 1': -0.15,
  'argentina': -0.16,
  'copa libertadores': -0.15,
  'copa sudamericana': -0.15,
  'premier league': -0.12,
  'laliga': -0.12,
  'la liga': -0.12,
  'champions league': -0.11,
  'uefa champions': -0.11,
  'europa league': -0.11,
  'conference league': -0.11,
  'bundesliga': -0.06,
  'eredivisie': -0.05,
  'mls': -0.06,
  'major league soccer': -0.06,
  'primeira liga': -0.10
};

export function getCalibratedRhoForLeague(leagueName = '') {
  if (!leagueName) return -0.13;
  const norm = String(leagueName).toLowerCase().trim();
  for (const [key, rhoVal] of Object.entries(LEAGUE_RHO_MAP)) {
    if (norm.includes(key)) return rhoVal;
  }
  return -0.13;
}

export function dixonColesAdjustment(lambda1, lambda2, x, y, rho = -0.13) {
  if (x === 0 && y === 0) {
    return Math.max(0, 1 - (lambda1 * lambda2 * rho));
  }
  if (x === 1 && y === 0) {
    return Math.max(0, 1 + (lambda1 * rho));
  }
  if (x === 0 && y === 1) {
    return Math.max(0, 1 + (lambda2 * rho));
  }
  if (x === 1 && y === 1) {
    return Math.max(0, 1 - rho);
  }
  return 1.0;
}

/**
 * Calcula la matriz de probabilidades de un partido usando Poisson Bivariado (Dixon-Coles),
 * Elo, Fatiga, Localía y Memoria IA con calibración dinámica de rho por liga.
 */
export function calculateMatchProbabilities(
  homeXG, awayXG, 
  homeElo = 1500, awayElo = 1500, 
  homeRest = 7, awayRest = 7, 
  homePenalty = 0, awayPenalty = 0,
  maxGoals = 6,
  applyHomeAdvantage = false,
  rho = -0.13,
  leagueName = ''
) {
  let hXG = parseFloat(homeXG) || 1.25;
  let aXG = parseFloat(awayXG) || 1.10;
  const effectiveRho = leagueName ? getCalibratedRhoForLeague(leagueName) : rho;

  // 1. Modificador ELO (Fuerza de Calendario calibrada: 100 pts Elo = 0.05 xG)
  const eloDiff = homeElo - awayElo;
  hXG += (eloDiff / 2000);
  aXG -= (eloDiff / 2000);

  // 2. Modificador de Localía Estándar (solo si no viene pre-ajustado por splits de liga)
  if (applyHomeAdvantage) {
    hXG += 0.15;
    aXG = Math.max(0.1, aXG - 0.10);
  }

  // 3. Modificador de Fatiga
  if (homeRest < 4) hXG *= 0.90; // Penalización del 10% por jugar hace 3 días o menos
  if (awayRest < 4) aXG *= 0.90;

  // 4. Modificador de Memoria de Lecciones Aprendidas (IA con Cap de Seguridad)
  const rawHPen = parseFloat(homePenalty) || 0;
  const rawAPen = parseFloat(awayPenalty) || 0;
  const hPen = rawHPen > 1 ? rawHPen / 100 : rawHPen;
  const aPen = rawAPen > 1 ? rawAPen / 100 : rawAPen;
  if (hPen > 0) hXG *= (1 - Math.min(hPen, 0.08));
  if (aPen > 0) aXG *= (1 - Math.min(aPen, 0.08));

  hXG = Math.max(0.1, hXG);
  aXG = Math.max(0.1, aXG);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let under15 = 0;
  let over25 = 0;
  let under25 = 0;
  let over35 = 0;
  let under35 = 0;
  let bttsYes = 0;
  let bttsNo = 0;

  const exactScores = {};

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const baseProb = poissonProbability(hXG, i) * poissonProbability(aXG, j);
      
      // Aplicar Poisson Bivariado con Dixon-Coles exacto calibrado por liga
      const adjustment = dixonColesAdjustment(hXG, aXG, i, j, effectiveRho);
      const prob = baseProb * adjustment;
      
      exactScores[`${i}-${j}`] = prob;

      if (i > j) homeWin += prob;
      else if (i === j) draw += prob;
      else awayWin += prob;

      if (i + j > 1.5) over15 += prob;
      else under15 += prob;

      if (i + j > 2.5) over25 += prob;
      else under25 += prob;

      if (i + j > 3.5) over35 += prob;
      else under35 += prob;
      
      if (i > 0 && j > 0) bttsYes += prob;
      else bttsNo += prob;
    }
  }

  // Normalizar para asegurar que sumen exactamente 1 (debido a los ajustes de rho)
  const totalRaw = homeWin + draw + awayWin;
  homeWin /= totalRaw; draw /= totalRaw; awayWin /= totalRaw;
  
  const totalOu15 = over15 + under15;
  over15 /= totalOu15; under15 /= totalOu15;

  const totalOu = over25 + under25;
  over25 /= totalOu; under25 /= totalOu;

  const totalOu35 = over35 + under35;
  over35 /= totalOu35; under35 /= totalOu35;
  
  const totalBtts = bttsYes + bttsNo;
  bttsYes /= totalBtts; bttsNo /= totalBtts;

  const mostLikelyScores = Object.entries(exactScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([score, p]) => ({ score, prob: ((p / totalRaw) * 100).toFixed(1) + '%' }));

  const hWinPct = (homeWin * 100).toFixed(1);
  const drawPct = (draw * 100).toFixed(1);
  const aWinPct = (awayWin * 100).toFixed(1);

  // Calcular mercados protegidos (DNB y Doble Oportunidad)
  const dnb = calculateDnbProbabilities(hWinPct, aWinPct);
  const doubleChance = calculateDoubleChanceProbabilities(hWinPct, drawPct, aWinPct);

  return {
    homeWin: hWinPct,
    draw: drawPct,
    awayWin: aWinPct,
    over15: (over15 * 100).toFixed(1),
    under15: (under15 * 100).toFixed(1),
    over25: (over25 * 100).toFixed(1),
    under25: (under25 * 100).toFixed(1),
    over35: (over35 * 100).toFixed(1),
    under35: (under35 * 100).toFixed(1),
    bttsYes: (bttsYes * 100).toFixed(1),
    bttsNo: (bttsNo * 100).toFixed(1),
    dnb,
    doubleChance,
    mostLikelyScores
  };
}

/**
 * Convierte una probabilidad porcentual en una cuota decimal justa
 * @param {number|string} probability - Probabilidad entre 0 y 100
 */
export function getFairOddsDecimal(probability) {
  const p = parseFloat(probability);
  if (isNaN(p) || p <= 0) return "1.90";
  return (100 / Math.min(p, 99.5)).toFixed(2);
}

export function calculateTrueEdge(modelProb, realMarketOdds) {
  const p = parseFloat(modelProb) / 100;
  const odds = parseFloat(realMarketOdds);
  if (!odds || odds <= 1.0) return { edge: 0, isPositiveEV: false, impliedProb: 0 };
  
  const impliedProb = 1 / odds;
  const trueEdge = (p - impliedProb) * 100;
  return {
    edge: +trueEdge.toFixed(1),
    isPositiveEV: trueEdge > 2.0, // Mínimo 2% de Edge real
    impliedProb: +(impliedProb * 100).toFixed(1)
  };
}

/**
 * Calcula probabilidades de DNB (Empate Apuesta No Válida / Draw No Bet)
 */
export function calculateDnbProbabilities(homeWinPct, awayWinPct) {
  const hw = parseFloat(homeWinPct) || 0;
  const aw = parseFloat(awayWinPct) || 0;
  const total = hw + aw;
  if (total <= 0) return { homeDnb: "50.0", awayDnb: "50.0", homeOdds: "2.00", awayOdds: "2.00" };
  const homeDnbProb = (hw / total) * 100;
  const awayDnbProb = (aw / total) * 100;
  return {
    homeDnb: homeDnbProb.toFixed(1),
    awayDnb: awayDnbProb.toFixed(1),
    homeOdds: getFairOddsDecimal(homeDnbProb),
    awayOdds: getFairOddsDecimal(awayDnbProb)
  };
}

/**
 * Calcula probabilidades de Doble Oportunidad (1X, X2, 12)
 */
export function calculateDoubleChanceProbabilities(homeWinPct, drawPct, awayWinPct) {
  const hw = parseFloat(homeWinPct) || 0;
  const dr = parseFloat(drawPct) || 0;
  const aw = parseFloat(awayWinPct) || 0;
  const dc1X = Math.min(99.0, hw + dr);
  const dcX2 = Math.min(99.0, aw + dr);
  const dc12 = Math.min(99.0, hw + aw);
  return {
    dc1X: dc1X.toFixed(1),
    dcX2: dcX2.toFixed(1),
    dc12: dc12.toFixed(1),
    odds1X: getFairOddsDecimal(dc1X),
    oddsX2: getFairOddsDecimal(dcX2),
    odds12: getFairOddsDecimal(dc12)
  };
}

/**
 * TAREA 2: Proyección de Córners con GameStateModifier
 * 
 * Calcula la proyección de córners inyectando la dinámica táctica del Game State:
 * Si el Favorito Local tiene >55% de ganar en el mercado 1X2, pero el marcador base proyecta
 * un empate o derrota temporal (asimetría táctica / asedio obligado), aplica un multiplicador
 * de x1.35 a los córners esperados del local.
 * 
 * Soporta firma unificada y retrocompatible:
 * - calculatePropProbabilities(homeAvg, awayAvg, line, probs1X2)
 * - calculatePropProbabilities(homeCorners, awayCorners, cardsHome, cardsAway, keyPlayer, probs1X2)
 */
export function calculatePropProbabilities(homeAvg, awayAvg, lineOrCardsHome = 9.5, cardsAwayOrProbs = 4.5, keyPlayer = null, maybeProbs = null) {
  // Manejo de firma extendida si se pasan cards y keyPlayer:
  let line = 9.5;
  let matchProbs1X2 = null;

  if (typeof lineOrCardsHome === 'number') {
    line = lineOrCardsHome;
    matchProbs1X2 = typeof cardsAwayOrProbs === 'object' && cardsAwayOrProbs !== null ? cardsAwayOrProbs : null;
  } else {
    // Si se invocó con firma de objeto de App.jsx: (homeCorners, awayCorners, cardsHome, cardsAway, player, probs)
    matchProbs1X2 = typeof maybeProbs === 'object' && maybeProbs !== null ? maybeProbs : (typeof cardsAwayOrProbs === 'object' ? cardsAwayOrProbs : null);
  }

  let hCorners = parseFloat(homeAvg || 5.0);
  let aCorners = parseFloat(awayAvg || 4.2);

  // Inyección de GameStateModifier
  let gameStateMultiplier = 1.0;
  let isGameStateAsymmetry = false;

  if (matchProbs1X2) {
    const homeWinProb = parseFloat(matchProbs1X2.homeWin || 0);
    const drawProb = parseFloat(matchProbs1X2.draw || 0);
    const awayWinProb = parseFloat(matchProbs1X2.awayWin || 0);

    // Condición: Favorito Local > 55% pero probabilidad de no ganar (empate + derrota) >= 40%
    // o marcador proyecta resistencia defensiva del rival
    if (homeWinProb > 55.0 && (drawProb + awayWinProb) >= 38.0) {
      isGameStateAsymmetry = true;
      gameStateMultiplier = 1.35;
      hCorners *= gameStateMultiplier; // Multiplicador x1.35 por asedio táctico
    }
  }

  const combinedCorners = hCorners + aCorners;
  let underCornersProb = 0;
  for (let k = 0; k <= Math.floor(line); k++) {
    underCornersProb += poissonProbability(combinedCorners, k);
  }
  const overCornersProb = 1 - underCornersProb;

  const cornersResult = {
    expectedTotal: combinedCorners.toFixed(1),
    homeExpectedCorners: hCorners.toFixed(1),
    awayExpectedCorners: aCorners.toFixed(1),
    over: Number((overCornersProb * 100).toFixed(1)),
    under: Number((underCornersProb * 100).toFixed(1)),
    line,
    gameStateModifier: gameStateMultiplier,
    isGameStateAsymmetry
  };

  // Si se llamó con firma simple de 3 parámetros, retornar formato estándar
  // pero enriquecido con expectedTotal
  return {
    ...cornersResult,
    corners: cornersResult
  };
}

/**
 * FASE 4.2 - FALLBACK MERCADO ASIÁTICO VIG-FREE (HANDICAP ASIÁTICO 0 / DRAW NO BET)
 * 
 * Si no hay modelo Poisson/xG disponible, deriva la probabilidad real removiendo
 * el margen de la casa de apuestas (overround/vig) del mercado Draw No Bet / Asian Handicap 0.
 * Reconstruye el mercado 1X2 contemplando la masa de probabilidad de Empate (típicamente 26%).
 * 
 * @param {number|string} homeOddsDnb - Cuota decimal de Home DNB (AH 0)
 * @param {number|string} awayOddsDnb - Cuota decimal de Away DNB (AH 0)
 * @param {number} estimatedDrawPct - Porcentaje estimado de empate de la liga (default: 26.0%)
 */
export function deriveAsianHandicapVigFreeProbabilities(homeOddsDnb, awayOddsDnb, estimatedDrawPct = 26.0) {
  const hOdds = parseFloat(homeOddsDnb) || 1.90;
  const aOdds = parseFloat(awayOddsDnb) || 1.90;

  // 1. Probabilidades implícitas brutas con margen
  const rawH = 1 / hOdds;
  const rawA = 1 / aOdds;
  const vig = rawH + rawA; // ej. 1.05 (5% de margen)

  // 2. Probabilidades justas normalizadas (Vig-Free en DNB)
  const fairHomeDnb = vig > 0 ? rawH / vig : 0.50;
  const fairAwayDnb = vig > 0 ? rawA / vig : 0.50;

  // 3. Reintegración obligatoria del EMPATE (Mercado 3 vías 1X2)
  const drawProb = Math.min(35.0, Math.max(18.0, parseFloat(estimatedDrawPct) || 26.0)) / 100;
  const decisiveMass = 1 - drawProb;

  const homeWinProb = fairHomeDnb * decisiveMass;
  const awayWinProb = fairAwayDnb * decisiveMass;

  const hWinPct = Number((homeWinProb * 100).toFixed(1));
  const drawPct = Number((drawProb * 100).toFixed(1));
  const aWinPct = Number((awayWinProb * 100).toFixed(1));

  const doubleChance = calculateDoubleChanceProbabilities(hWinPct, drawPct, aWinPct);
  const dnb = {
    homeDnb: (fairHomeDnb * 100).toFixed(1),
    awayDnb: (fairAwayDnb * 100).toFixed(1),
    homeOdds: getFairOddsDecimal((fairHomeDnb * 100).toFixed(1)),
    awayOdds: getFairOddsDecimal((fairAwayDnb * 100).toFixed(1))
  };

  return {
    source: 'asian_handicap_vig_free',
    vigPercent: Number(((vig - 1) * 100).toFixed(2)),
    homeWin: hWinPct.toFixed(1),
    draw: drawPct.toFixed(1),
    awayWin: aWinPct.toFixed(1),
    dnb,
    doubleChance,
    fairHomeDnb: Number((fairHomeDnb * 100).toFixed(1)),
    fairAwayDnb: Number((fairAwayDnb * 100).toFixed(1))
  };
}
