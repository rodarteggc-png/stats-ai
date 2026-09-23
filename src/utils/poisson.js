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
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

// Factor de ajuste Dixon-Coles para Poisson Bivariado (Corrige la dependencia en empates bajos)
function dixonColesAdjustment(lambda1, lambda2, x, y, rho = -0.15) {
  if (x === 0 && y === 0) return Math.max(0, 1 - lambda1 * lambda2 * rho);
  if (x === 0 && y === 1) return Math.max(0, 1 + lambda1 * rho);
  if (x === 1 && y === 0) return Math.max(0, 1 + lambda2 * rho);
  if (x === 1 && y === 1) return Math.max(0, 1 - rho);
  return 1.0;
}

/**
 * Calcula la matriz de probabilidades de un partido usando Poisson Bivariado, Elo, Fatiga, Localía y Memoria IA
 */
export function calculateMatchProbabilities(
  homeXG, awayXG, 
  homeElo = 1500, awayElo = 1500, 
  homeRest = 7, awayRest = 7, 
  homePenalty = 0, awayPenalty = 0,
  maxGoals = 6,
  applyHomeAdvantage = false
) {
  let hXG = parseFloat(homeXG);
  let aXG = parseFloat(awayXG);

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
  const hPen = parseFloat(homePenalty) || 0;
  const aPen = parseFloat(awayPenalty) || 0;
  if (hPen > 0) hXG *= (1 - Math.min(hPen, 0.04));
  if (aPen > 0) aXG *= (1 - Math.min(aPen, 0.04));

  hXG = Math.max(0.1, hXG);
  aXG = Math.max(0.1, aXG);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let under15 = 0;
  let over25 = 0;
  let under25 = 0;
  let bttsYes = 0;
  let bttsNo = 0;

  const exactScores = {};

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      let baseProb = poissonProbability(hXG, i) * poissonProbability(aXG, j);
      
      // Aplicar Poisson Bivariado (Dixon-Coles)
      const adjustment = dixonColesAdjustment(hXG, aXG, i, j);
      const prob = baseProb * adjustment;
      
      exactScores[`${i}-${j}`] = prob;

      if (i > j) homeWin += prob;
      else if (i === j) draw += prob;
      else awayWin += prob;

      if (i + j > 1.5) over15 += prob;
      else under15 += prob;

      if (i + j > 2.5) over25 += prob;
      else under25 += prob;
      
      if (i > 0 && j > 0) bttsYes += prob;
      else bttsNo += prob;
    }
  }

  // Normalizar para asegurar que sumen 1 (por los ajustes de rho)
  const totalRaw = homeWin + draw + awayWin;
  homeWin /= totalRaw; draw /= totalRaw; awayWin /= totalRaw;
  
  const totalOu15 = over15 + under15;
  over15 /= totalOu15; under15 /= totalOu15;

  const totalOu = over25 + under25;
  over25 /= totalOu; under25 /= totalOu;
  
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
    bttsYes: (bttsYes * 100).toFixed(1),
    bttsNo: (bttsNo * 100).toFixed(1),
    dnb,
    doubleChance,
    mostLikelyScores
  };
}

/**
 * Convierte una probabilidad porcentual en una cuota americana/decimal justa
 * @param {number|string} probability - Probabilidad entre 0 y 100
 */
export function getFairOddsDecimal(probability) {
  const p = parseFloat(probability);
  if (isNaN(p) || p <= 0) return "1.90";
  return (100 / Math.min(p, 99.5)).toFixed(2);
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

export function calculatePropProbabilities(homeAvg, awayAvg, line) {
  const combinedLambda = parseFloat(homeAvg) + parseFloat(awayAvg);
  let underProb = 0;
  for (let k = 0; k <= Math.floor(line); k++) {
    underProb += poissonProbability(combinedLambda, k);
  }
  const overProb = 1 - underProb;
  return { over: (overProb * 100).toFixed(1), under: (underProb * 100).toFixed(1), line };
}
