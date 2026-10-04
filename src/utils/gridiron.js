// src/utils/gridiron.js

export function getFairOddsDecimal(probability) {
  const p = parseFloat(probability);
  if (isNaN(p) || p <= 0) return "1.91";
  return (100 / Math.min(p, 99.5)).toFixed(2);
}

/**
 * Función de Distribución Acumulada Normal Estándar Φ(z)
 * Aproximación analítica de alta precisión (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
 */
export function normalCdf(x, mean = 0, std = 1) {
  const z = (x - mean) / std;
  const absZ = Math.abs(z);
  const t = 1.0 / (1.0 + 0.2316419 * absZ);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))));
  const standardNormal = (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * absZ * absZ) * poly;
  return z >= 0 ? 1.0 - standardNormal : standardNormal;
}

/**
 * Probabilidades empíricas de márgenes de victoria en la NFL moderna
 */
export const KEY_NUMBERS = [
  { num: 3, weight: 15.2 }, // 15.2% de partidos terminan por 3 puntos
  { num: 7, weight: 9.8 },  // 9.8% terminan por 7 puntos
  { num: 6, weight: 6.1 },  // 6.1% por 6 puntos
  { num: 10, weight: 5.7 }, // 5.7% por 10 puntos
  { num: 4, weight: 5.2 }   // 5.2% por 4 puntos
];

/**
 * Calcula la probabilidad cuantitativa exacta de cubrir el Point Spread en la NFL.
 * Utiliza distribución normal empírica de márgenes de victoria (σ = 13.45)
 * con calibración analítica de los clusters de números clave (3 y 7).
 *
 * @param {number} expectedHomeLead - Margen proyectado a favor del local (> 0 gana local)
 * @param {number} vegasHomeSpread - Línea de spread del local (ej: -3.5 favorito, +3.5 underdog)
 * @param {boolean} forHome - True para calcular cobertura del local, False para visitante
 * @returns {number} Probabilidad porcentual entre 5% y 95%
 */
export function calculateSpreadCoverProbability(expectedHomeLead, vegasHomeSpread, forHome = true, isCollege = false) {
  const sigma = isCollege ? 16.5 : 13.45; // Desviación estándar: 16.5 en Colegial FBS / 13.45 en NFL
  const spread = parseFloat(vegasHomeSpread);
  const lead = parseFloat(expectedHomeLead);

  if (isNaN(spread) || isNaN(lead)) return 50.0;

  // P(Local Cubre) = P(Margen > -vegasHomeSpread) = 1 - Φ((-spread - lead) / σ) = Φ((lead + spread) / σ)
  let homeCoverProb = normalCdf(lead + spread, 0, sigma);

  // Calibración fina empírica en números clave
  const absSpread = Math.abs(spread);
  const favMargin = spread < 0 ? lead : -lead;
  const keyFactor = isCollege ? 0.6 : 1.0;

  if (absSpread === 3.5 && favMargin <= 3.8) {
    if (spread < 0) homeCoverProb = Math.max(0.35, homeCoverProb - (0.04 * keyFactor));
    else homeCoverProb = Math.min(0.75, homeCoverProb + (0.04 * keyFactor));
  } else if (absSpread === 7.5 && favMargin <= 7.8) {
    if (spread < 0) homeCoverProb = Math.max(0.38, homeCoverProb - (0.035 * keyFactor));
    else homeCoverProb = Math.min(0.74, homeCoverProb + (0.035 * keyFactor));
  } else if (absSpread === 2.5 && favMargin >= 2.6) {
    if (spread < 0) homeCoverProb = Math.min(0.70, homeCoverProb + (0.035 * keyFactor));
    else homeCoverProb = Math.max(0.30, homeCoverProb - (0.035 * keyFactor));
  }

  const resultProb = forHome ? homeCoverProb : (1 - homeCoverProb);
  return Number((Math.min(0.92, Math.max(0.08, resultProb)) * 100).toFixed(1));
}

/**
 * Calcula la probabilidad cuantitativa de Over / Under en Fútbol Americano (NFL / NCAAF)
 */
export function calculateTotalOverUnderProbability(predictedTotal, vegasTotal, windSpeedMph = 0, isCollege = false) {
  const pTot = parseFloat(predictedTotal) || (isCollege ? 53.5 : 43.5);
  const vTot = parseFloat(vegasTotal);
  if (isNaN(vTot) || vTot <= 0) {
    return {
      overProb: "50.0",
      underProb: "50.0",
      effectiveTotal: pTot.toFixed(1),
      windPenalty: "0.0",
      edge: 0,
      pick: "Pass",
      isValue: false,
      odds: "1.91"
    };
  }

  // Factor de degradación climática por viento en estadios abiertos
  let windPenalty = 0;
  const wind = parseFloat(windSpeedMph) || 0;
  if (wind >= 14) {
    windPenalty = Math.min(6.5, (wind - 12) * 0.35);
  }

  const effectiveTotal = Math.max(25.0, pTot - windPenalty);
  const sigmaTotal = isCollege ? 15.20 : 13.80;

  // P(Under) = P(Puntos < vegasTotal) = Φ((vegasTotal - effectiveTotal) / σ)
  const underProb = normalCdf(vTot - effectiveTotal, 0, sigmaTotal);
  const overProb = 1 - underProb;

  const underPct = Number((underProb * 100).toFixed(1));
  const overPct = Number((overProb * 100).toFixed(1));

  // Umbral de valor cuantitativo (+4% de edge sobre 52.4% breakeven de casino -110)
  const isUnder = underPct > overPct;
  const topProb = isUnder ? underPct : overPct;
  const edge = Number((topProb - 52.4).toFixed(1));
  const isValue = edge >= 4.0;
  const pick = isUnder ? `UNDER ${vTot} Pts` : `OVER ${vTot} Pts`;

  return {
    overProb: overPct.toFixed(1),
    underProb: underPct.toFixed(1),
    effectiveTotal: effectiveTotal.toFixed(1),
    windPenalty: windPenalty.toFixed(1),
    edge,
    pick,
    isValue,
    isUnder,
    odds: "1.91"
  };
}

export function evaluateNflSpreadValue(expectedHomeLead, vegasSpread, isCollege = false) {
  const marginDiff = expectedHomeLead + vegasSpread;
  const absVegas = Math.abs(vegasSpread);
  let keyAlert = null;
  let trapWarning = null;
  let heavySpreadWarning = null;
  let vetoFavoriteSpread = false;

  // 1. Detección de trampa de medio punto en 3 y 7 (tanto para favorito local como visitante)
  const favExpectedMargin = vegasSpread < 0 ? expectedHomeLead : -expectedHomeLead;
  if (absVegas === 3.5) {
    if (favExpectedMargin <= 3.6) {
      trapWarning = "⚠️ Trampa de Medio Punto en 3.5: Las Vegas infló al favorito. Gran valor cuantitativo en el Underdog (+3.5).";
    }
  } else if (absVegas === 7.5) {
    if (favExpectedMargin <= 7.6) {
      trapWarning = "⚠️ Trampa de Medio Punto en 7.5: Proyección cerrada dentro de un touchdown. Gran valor en Underdog (+7.5).";
    }
  } else if (absVegas === 2.5) {
    if (favExpectedMargin >= 2.6) {
      keyAlert = "💎 Oportunidad Clave: Favorito en -2.5 (por debajo del número 3). Gran valor en cubrir.";
    }
  }

  // 2. Filtro de Seguridad Preventivo: Spreads Pesados (>= 7.5 pts en NFL / >= 17.5 pts en Colegial)
  const heavySpreadThreshold = isCollege ? 17.5 : 7.5;
  if (absVegas >= heavySpreadThreshold) {
    vetoFavoriteSpread = true;
    heavySpreadWarning = `⚠️ Veto Preventivo de Spread Pesado (${absVegas} pts >= ${heavySpreadThreshold}): Alto riesgo de Backdoor Cover en 4to cuarto. No apostar al favorito en hándicap abultado.`;
  }

  return {
    marginDiff: Number(marginDiff.toFixed(1)),
    keyAlert,
    trapWarning,
    heavySpreadWarning,
    vetoFavoriteSpread,
    absVegas
  };
}

export function calculateNflProbabilities(
  homeYPP, homeTO, awayYPP, awayTO, 
  homePenalty = 0, awayPenalty = 0, 
  vegasSpread = -3.5,
  homeEpa = null, awayEpa = null,
  vegasTotal = null,
  windSpeedMph = 0,
  isCollege = false
) {
  const maxYpp = isCollege ? 7.4 : 6.6;
  const minYpp = isCollege ? 3.8 : 4.2;
  const defaultYpp = isCollege ? 5.6 : 5.3;
  const adjHomeYPP = Math.min(maxYpp, Math.max(minYpp, parseFloat(homeYPP) || defaultYpp));
  const adjAwayYPP = Math.min(maxYpp, Math.max(minYpp, parseFloat(awayYPP) || defaultYpp));

  // En fútbol americano colegial la ventaja de localía (HFA) es más pronunciada (~3.2 pts) vs NFL (~2.2 pts)
  const homeFieldAdvantage = isCollege ? 3.2 : 2.2;
  const yppDiff = adjHomeYPP - adjAwayYPP;
  const toDiff = (parseFloat(homeTO || 0) - parseFloat(awayTO || 0)) / (isCollege ? 12 : 17);

  let rawModelSpread;
  if (homeEpa !== null && awayEpa !== null && !isNaN(parseFloat(homeEpa)) && !isNaN(parseFloat(awayEpa))) {
    const epaDiff = parseFloat(homeEpa) - parseFloat(awayEpa);
    const epaPts = epaDiff * (isCollege ? 50 : 55);
    const yppPts = yppDiff * (isCollege ? 4.8 : 4.2);
    const toPts = toDiff * (isCollege ? 3.0 : 2.5);
    rawModelSpread = epaPts + yppPts + toPts + homeFieldAdvantage;
  } else {
    rawModelSpread = (yppDiff * (isCollege ? 7.2 : 6.5)) + (toDiff * (isCollege ? 3.5 : 3.0)) + homeFieldAdvantage;
  }

  // Anclaje Bayesiano con el Spread de Las Vegas
  // Peso dinámico: si el modelo y Vegas discrepan por más de 3 puntos, confiamos más en el modelo (menor anclaje).
  const spreadNum = parseFloat(vegasSpread) || -3.5;
  const vegasImpliedHomeLead = -spreadNum;
  const spreadDiff = Math.abs(rawModelSpread - vegasImpliedHomeLead);
  const anchorWeight = spreadDiff > 3.0 ? 0.20 : 0.40;
  let predictedPointSpread = (rawModelSpread * (1 - anchorWeight)) + (vegasImpliedHomeLead * anchorWeight);

  // Modificador de Memoria de Lecciones Aprendidas (IA con Cap de Seguridad)
  const rawHPen = parseFloat(homePenalty) || 0;
  const rawAPen = parseFloat(awayPenalty) || 0;
  const hPen = rawHPen > 1 ? rawHPen / 100 : rawHPen;
  const aPen = rawAPen > 1 ? rawAPen / 100 : rawAPen;
  const penaltySpreadAdjustment = (Math.min(hPen, 0.08) - Math.min(aPen, 0.08)) * 32;
  predictedPointSpread -= penaltySpreadAdjustment;

  // Convertir el Point Spread a Probabilidad de Victoria (Win Probability) vía Normal CDF
  const sigma = isCollege ? 16.5 : 13.45;
  const homeWinProb = normalCdf(predictedPointSpread, 0, sigma) * 100;
  const awayWinProb = 100 - homeWinProb;

  // Probabilidad de Cobertura de Spread (True Normal CDF)
  const homeCoverProb = calculateSpreadCoverProbability(predictedPointSpread, spreadNum, true, isCollege);
  const awayCoverProb = calculateSpreadCoverProbability(predictedPointSpread, spreadNum, false, isCollege);

  // Total de Puntos Estimado Calibrado:
  const baseAvgTotal = isCollege ? 52.8 : 43.8;
  const totalYpp = adjHomeYPP + adjAwayYPP;
  const epaTotalAdj = (homeEpa !== null && awayEpa !== null && !isNaN(parseFloat(homeEpa)) && !isNaN(parseFloat(awayEpa)))
    ? (parseFloat(homeEpa) + parseFloat(awayEpa)) * 28
    : 0;
  const rawModelTotal = baseAvgTotal + ((totalYpp - (isCollege ? 11.2 : 10.8)) * 3.2) + epaTotalAdj;
  const vTotNum = parseFloat(vegasTotal);
  const predictedTotalPoints = (!isNaN(vTotNum) && vTotNum > 24)
    ? Math.max(vTotNum - 7.0, Math.min(vTotNum + 7.0, (rawModelTotal * 0.60) + (vTotNum * 0.40)))
    : Math.max(28.0, Math.min(75.0, rawModelTotal));

  // Evaluación de Totales (Over/Under) contra Las Vegas y Viento
  const totalsEvaluation = calculateTotalOverUnderProbability(predictedTotalPoints, vegasTotal, windSpeedMph, isCollege);

  // Evaluación de Números Clave respecto a Las Vegas
  const keyEvaluation = evaluateNflSpreadValue(predictedPointSpread, spreadNum, isCollege);

  return {
    homeWin: homeWinProb.toFixed(1),
    awayWin: awayWinProb.toFixed(1),
    homeCoverProb: homeCoverProb.toFixed(1),
    awayCoverProb: awayCoverProb.toFixed(1),
    predictedSpread: (predictedPointSpread > 0 ? `-${predictedPointSpread.toFixed(1)}` : `+${Math.abs(predictedPointSpread).toFixed(1)}`),
    predictedTotal: predictedTotalPoints.toFixed(1),
    expectedHomeLead: predictedPointSpread.toFixed(1),
    keyEvaluation,
    totalsEvaluation
  };
}
