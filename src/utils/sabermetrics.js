// src/utils/sabermetrics.js

export function getFairOddsDecimal(probability) {
  const p = parseFloat(probability);
  if (isNaN(p) || p <= 0) return "1.90";
  return (100 / Math.min(p, 99.5)).toFixed(2);
}

/**
 * Función auxiliar de distribución Poisson discreta: (λ^k * e^-λ) / k!
 */
function poissonProbability(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

/**
 * Matriz cuantitativa de probabilidades para Béisbol (MLB).
 * Modela la distribución conjunta de carreras independientemente del fútbol,
 * resolviendo empates con regla empírica de extra-innings y calculando Runline (+/-1.5).
 */
function calculateBaseballMatrix(homeLambda, awayLambda, maxRuns = 14) {
  let homeWinReg = 0;
  let awayWinReg = 0;
  let tieReg = 0;
  let homeMinus15 = 0; // Home gana por 2 o más
  let awayMinus15 = 0; // Away gana por 2 o más

  const scores = {};

  for (let i = 0; i <= maxRuns; i++) {
    const pHome = poissonProbability(homeLambda, i);
    for (let j = 0; j <= maxRuns; j++) {
      const pAway = poissonProbability(awayLambda, j);
      const prob = pHome * pAway;
      scores[`${i}-${j}`] = prob;

      if (i > j) {
        homeWinReg += prob;
        if (i - j >= 2) homeMinus15 += prob;
      } else if (j > i) {
        awayWinReg += prob;
        if (j - i >= 2) awayMinus15 += prob;
      } else {
        tieReg += prob;
      }
    }
  }

  // Normalizar
  const total = homeWinReg + awayWinReg + tieReg;
  homeWinReg /= total;
  awayWinReg /= total;
  tieReg /= total;
  homeMinus15 /= total;
  awayMinus15 /= total;

  // Extra-innings: En MLB moderna (ghost runner en 2da base), el local gana el ~53.5% de extra-innings (último turno al bate)
  const homeWinFinal = homeWinReg + (tieReg * 0.535);
  const awayWinFinal = awayWinReg + (tieReg * 0.465);

  return {
    homeWinReg,
    awayWinReg,
    tieReg,
    homeWinFinal,
    awayWinFinal,
    homeMinus15, // Home cubre -1.5
    awayPlus15: 1 - homeMinus15, // Away cubre +1.5
    awayMinus15, // Away cubre -1.5
    homePlus15: 1 - awayMinus15, // Home cubre +1.5
    scores
  };
}

/**
 * Motor Sabermétrico para MLB con Park Factors, Ponderación Abridor/Bullpen,
 * Runlines (+/- 1.5), Totals y Mercado Profesional F5 (Primeras 5 Entradas).
 */
export function calculateMlbProbabilities(
  homeOps, awayPitcherWhip, 
  awayOps, homePitcherWhip, 
  homeElo = 1500, awayElo = 1500, 
  homeRest = 1, awayRest = 1,
  homePenalty = 0, awayPenalty = 0,
  homeTeamName = "",
  awayBullpenWhip = 1.28,
  homeBullpenWhip = 1.28
) {
  const parkFactors = {
    'Colorado': 1.28, 'Cincinnati': 1.15, 'Boston': 1.12, 
    'Texas': 1.08, 'White Sox': 1.05, 'Kansas City': 1.05,
    'Atlanta': 1.04, 'Philadelphia': 1.03, 'Angels': 1.02,
    'Baltimore': 1.01, 'Toronto': 1.00, 'Houston': 1.00,
    'Minnesota': 0.99, 'Dodgers': 0.99, 'Washington': 0.98,
    'Arizona': 0.98, 'Cubs': 0.97, 'Milwaukee': 0.97,
    'Pittsburgh': 0.96, 'San Diego': 0.95, 'Cleveland': 0.95,
    'Yankees': 0.95, 'Miami': 0.94, 'Detroit': 0.94,
    'Oakland': 0.93, 'Tampa Bay': 0.92, 'Mets': 0.91,
    'St. Louis': 0.90, 'San Francisco': 0.88, 'Seattle': 0.86
  };
  
  let pf = 1.0;
  for (let team in parkFactors) {
    if (homeTeamName && homeTeamName.includes(team)) { pf = parkFactors[team]; break; }
  }

  const mlbRunFactor = 4.8 * pf; 

  // Ponderación de Pitcheo: 62% Abridor + 38% Bullpen para Juego Completo (9 innings)
  const effectiveAwayPitchingWhip = (parseFloat(awayPitcherWhip) * 0.62) + (parseFloat(awayBullpenWhip) * 0.38);
  const effectiveHomePitchingWhip = (parseFloat(homePitcherWhip) * 0.62) + (parseFloat(homeBullpenWhip) * 0.38);

  let homeExpectedRuns = parseFloat(homeOps) * effectiveAwayPitchingWhip * mlbRunFactor;
  let awayExpectedRuns = parseFloat(awayOps) * effectiveHomePitchingWhip * mlbRunFactor;

  // Ventaja de Localía en Béisbol (+0.18 carreras)
  homeExpectedRuns += 0.18;

  // Modificador fino de ELO
  const eloDiff = homeElo - awayElo;
  homeExpectedRuns += (eloDiff / 2500);
  awayExpectedRuns -= (eloDiff / 2500);

  homeExpectedRuns = Math.max(1.0, homeExpectedRuns);
  awayExpectedRuns = Math.max(1.0, awayExpectedRuns);

  // 1. CÁLCULO DE JUEGO COMPLETO (9 INNINGS + EXTRA INNINGS)
  const fullGameMatrix = calculateBaseballMatrix(homeExpectedRuns, awayExpectedRuns, 14);

  const totalExpectedRuns = homeExpectedRuns + awayExpectedRuns;
  
  let under85Prob = 0;
  let under75Prob = 0;
  let under95Prob = 0;
  for (let k = 0; k <= 18; k++) {
    const p = poissonProbability(totalExpectedRuns, k);
    if (k <= 7) under75Prob += p;
    if (k <= 8) under85Prob += p;
    if (k <= 9) under95Prob += p;
  }

  // 2. CÁLCULO DEL MERCADO F5 (FIRST 5 INNINGS - PRIMERAS 5 ENTRADAS)
  // En F5 el abridor lanza el 100% de los innings (5/9 del total) y NO participa el bullpen
  const f5Factor = (5 / 9);
  let homeF5Runs = parseFloat(homeOps) * parseFloat(awayPitcherWhip) * mlbRunFactor * f5Factor;
  let awayF5Runs = parseFloat(awayOps) * parseFloat(homePitcherWhip) * mlbRunFactor * f5Factor;
  homeF5Runs += 0.10; // Ventaja local en F5

  homeF5Runs = Math.max(0.5, homeF5Runs);
  awayF5Runs = Math.max(0.5, awayF5Runs);

  let f5HomeWin = 0;
  let f5AwayWin = 0;
  let f5Draw = 0;
  for (let i = 0; i <= 10; i++) {
    const pi = poissonProbability(homeF5Runs, i);
    for (let j = 0; j <= 10; j++) {
      const pj = poissonProbability(awayF5Runs, j);
      const prob = pi * pj;
      if (i > j) f5HomeWin += prob;
      else if (j > i) f5AwayWin += prob;
      else f5Draw += prob;
    }
  }
  const f5Total = f5HomeWin + f5AwayWin + f5Draw || 1;
  f5HomeWin /= f5Total;
  f5AwayWin /= f5Total;
  f5Draw /= f5Total;

  const f5TotalRuns = (homeF5Runs + awayF5Runs).toFixed(1);

  // F5 Moneyline (Draw No Bet / Push si termina empatado en la 5ta)
  const f5Resolved = f5HomeWin + f5AwayWin;
  const f5HomeMlProb = f5Resolved > 0 ? ((f5HomeWin / f5Resolved) * 100).toFixed(1) : "50.0";
  const f5AwayMlProb = f5Resolved > 0 ? ((f5AwayWin / f5Resolved) * 100).toFixed(1) : "50.0";

  let under45Prob = 0;
  for (let k = 0; k <= 4; k++) under45Prob += poissonProbability(parseFloat(f5TotalRuns), k);
  const over45Prob = 1 - under45Prob;

  return {
    homeWin: (fullGameMatrix.homeWinFinal * 100).toFixed(1),
    awayWin: (fullGameMatrix.awayWinFinal * 100).toFixed(1),
    expectedTotal: totalExpectedRuns.toFixed(1),
    over85: ((1 - under85Prob) * 100).toFixed(1),
    under85: (under85Prob * 100).toFixed(1),
    over75: ((1 - under75Prob) * 100).toFixed(1),
    under75: (under75Prob * 100).toFixed(1),
    over95: ((1 - under95Prob) * 100).toFixed(1),
    under95: (under95Prob * 100).toFixed(1),
    homeExpectedRuns: homeExpectedRuns.toFixed(1),
    awayExpectedRuns: awayExpectedRuns.toFixed(1),
    // Runline (+/- 1.5)
    runline: {
      homeMinus15: (fullGameMatrix.homeMinus15 * 100).toFixed(1),
      awayPlus15: (fullGameMatrix.awayPlus15 * 100).toFixed(1),
      awayMinus15: (fullGameMatrix.awayMinus15 * 100).toFixed(1),
      homePlus15: (fullGameMatrix.homePlus15 * 100).toFixed(1)
    },
    // Mercado F5 (Primeras 5 Entradas)
    f5: {
      homeWin: (f5HomeWin * 100).toFixed(1),
      draw: (f5Draw * 100).toFixed(1),
      awayWin: (f5AwayWin * 100).toFixed(1),
      homeMl: f5HomeMlProb,
      awayMl: f5AwayMlProb,
      homeOdds: getFairOddsDecimal(f5HomeMlProb),
      awayOdds: getFairOddsDecimal(f5AwayMlProb),
      expectedTotal: f5TotalRuns,
      over45: (over45Prob * 100).toFixed(1),
      under45: (under45Prob * 100).toFixed(1)
    }
  };
}
