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
export function calculateSpreadCoverProbability(expectedHomeLead, vegasHomeSpread, forHome = true) {
  const sigma = 13.45; // Desviación estándar empírica de márgenes en NFL moderna (Stern 1991 / NFELO)
  const spread = parseFloat(vegasHomeSpread);
  const lead = parseFloat(expectedHomeLead);

  if (isNaN(spread) || isNaN(lead)) return 50.0;

  // P(Local Cubre) = P(Margen > -vegasHomeSpread) = 1 - Φ((-spread - lead) / σ) = Φ((lead + spread) / σ)
  let homeCoverProb = normalCdf(lead + spread, 0, sigma);

  // Calibración fina empírica en números clave (clusters discontinuos de 3 y 7)
  const absSpread = Math.abs(spread);
  if (absSpread === 3.5 && spread < 0) {
    // Favorito local -3.5 vs Underdog visita +3.5: Si margen proyectado ronda 3 puntos, el underdog retiene valor masivo
    if (lead >= 2.0 && lead <= 4.2) {
      homeCoverProb = Math.max(0.38, homeCoverProb - 0.04);
    }
  } else if (absSpread === 7.5 && spread < 0) {
    if (lead >= 6.0 && lead <= 8.2) {
      homeCoverProb = Math.max(0.40, homeCoverProb - 0.035);
    }
  } else if (absSpread === 2.5 && spread < 0) {
    // Favorito local -2.5 (por debajo de 3): un gol de campo cubre
    if (lead >= 2.6) {
      homeCoverProb = Math.min(0.68, homeCoverProb + 0.035);
    }
  }

  const resultProb = forHome ? homeCoverProb : (1 - homeCoverProb);
  return Number((Math.min(0.92, Math.max(0.08, resultProb)) * 100).toFixed(1));
}

/**
 * Calcula la probabilidad cuantitativa de Over / Under en NFL
 * usando Distribución Normal con σ = 13.80 y factor de frenado por viento sostenido.
 *
 * @param {number} predictedTotal - Total de puntos estimado por el modelo
 * @param {number} vegasTotal - Línea de total de Las Vegas (ej: 44.5)
 * @param {number} windSpeedMph - Velocidad del viento sostenido en mph
 */
export function calculateTotalOverUnderProbability(predictedTotal, vegasTotal, windSpeedMph = 0) {
  const pTot = parseFloat(predictedTotal) || 43.5;
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

  // Factor de degradación climática por viento en estadios abiertos:
  // Viento sostenido >= 14 mph reduce pases largos y acierto de field goals (~0.35 pts menos por cada mph sobre 12 mph)
  let windPenalty = 0;
  const wind = parseFloat(windSpeedMph) || 0;
  if (wind >= 14) {
    windPenalty = Math.min(6.5, (wind - 12) * 0.35);
  }

  const effectiveTotal = Math.max(28.0, pTot - windPenalty);
  const sigmaTotal = 13.80; // Desviación estándar empírica de totales combinados en NFL

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

export function evaluateNflSpreadValue(expectedHomeLead, vegasSpread) {
  const marginDiff = expectedHomeLead + vegasSpread;
  const absVegas = Math.abs(vegasSpread);
  let keyAlert = null;
  let trapWarning = null;
  let heavySpreadWarning = null;
  let vetoFavoriteSpread = false;

  // 1. Detección de trampa de medio punto en 3 y 7 (los números más cruciales de la NFL)
  if (absVegas === 3.5) {
    if (vegasSpread < 0 && expectedHomeLead >= 2.0 && expectedHomeLead <= 4.2) {
      trapWarning = "⚠️ Trampa de Medio Punto en 3.5: Las Vegas infló al favorito. Gran valor cuantitativo en el Underdog (+3.5).";
    }
  } else if (absVegas === 7.5) {
    if (vegasSpread < 0 && expectedHomeLead >= 6.0 && expectedHomeLead <= 8.2) {
      trapWarning = "⚠️ Trampa de Medio Punto en 7.5: Proyección cerrada en un touchdown. Gran valor en Underdog (+7.5).";
    }
  } else if (absVegas === 2.5) {
    if (vegasSpread < 0 && expectedHomeLead >= 2.8) {
      keyAlert = "💎 Oportunidad Clave: Favorito en -2.5 (por debajo del número 3). Gran valor en cubrir.";
    }
  }

  // 2. Filtro de Seguridad Preventivo: Spreads Pesados (> 7.5 pts)
  // En la NFL moderna, los favoritos pesados juegan prevent defense al final y sufren Backdoor Covers frecuentes.
  if (absVegas > 7.5) {
    vetoFavoriteSpread = true;
    heavySpreadWarning = `⚠️ Veto Preventivo de Spread Pesado (${absVegas} pts > 7.5): Alto riesgo de Backdoor Cover en 4to cuarto. No apostar al favorito en hándicap abultado.`;
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
  windSpeedMph = 0
) {
  const adjHomeYPP = parseFloat(homeYPP);
  const adjAwayYPP = parseFloat(awayYPP);

  // En NFL, una ventaja de 1.0 en Net Yards Per Play equivale aprox a 7 puntos de diferencia.
  const yppDiff = adjHomeYPP - adjAwayYPP;
  // Un diferencial de Turnover de +1 equivale aprox a 3 puntos por partido.
  const toDiff = (parseFloat(homeTO) - parseFloat(awayTO)) / 17; // Temporada 17 juegos

  const homeFieldAdvantage = 2.4; // Puntos estándar de ventaja de local empírica en NFL moderna

  let predictedPointSpread;
  // Si disponemos de métricas de eficiencia EPA (Expected Points Added)
  if (homeEpa !== null && awayEpa !== null && !isNaN(parseFloat(homeEpa)) && !isNaN(parseFloat(awayEpa))) {
    const epaDiff = parseFloat(homeEpa) - parseFloat(awayEpa);
    // Ponderación cuantitativa: 60% EPA Net Efficiency + 25% Net YPP + 15% Turnover Differential
    const epaPts = epaDiff * 65; // 0.10 de ventaja en Net EPA/play = ~6.5 pts
    const yppPts = yppDiff * 4.5;
    const toPts = toDiff * 2.5;
    predictedPointSpread = epaPts + yppPts + toPts + homeFieldAdvantage;
  } else {
    predictedPointSpread = (yppDiff * 7) + (toDiff * 3) + homeFieldAdvantage;
  }

  // Modificador de Memoria de Lecciones Aprendidas (IA con Cap de Seguridad)
  const hPen = parseFloat(homePenalty) || 0;
  const aPen = parseFloat(awayPenalty) || 0;
  const penaltySpreadAdjustment = (Math.min(hPen, 0.04) - Math.min(aPen, 0.04)) * 30;
  predictedPointSpread -= penaltySpreadAdjustment;

  // Convertir el Point Spread a Probabilidad de Victoria (Win Probability) vía Normal CDF (σ = 13.45)
  const homeWinProb = normalCdf(predictedPointSpread, 0, 13.45) * 100;
  const awayWinProb = 100 - homeWinProb;

  // Probabilidad de Cobertura de Spread (True Normal CDF)
  const spreadNum = parseFloat(vegasSpread) || -3.5;
  const homeCoverProb = calculateSpreadCoverProbability(predictedPointSpread, spreadNum, true);
  const awayCoverProb = calculateSpreadCoverProbability(predictedPointSpread, spreadNum, false);

  // Total de Puntos Estimado (Baseline promedio NFL 43.5 + varianza por yardas)
  const totalYpp = adjHomeYPP + adjAwayYPP;
  const predictedTotalPoints = 43.5 + ((totalYpp - 10) * 4);

  // Evaluación de Totales (Over/Under) contra Las Vegas y Viento
  const totalsEvaluation = calculateTotalOverUnderProbability(predictedTotalPoints, vegasTotal, windSpeedMph);

  // Evaluación de Números Clave respecto a Las Vegas
  const keyEvaluation = evaluateNflSpreadValue(predictedPointSpread, spreadNum);

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
