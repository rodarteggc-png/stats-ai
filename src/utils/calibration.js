// src/utils/calibration.js
// CALIBRACIÓN BAYESIANA CONTINUA (PLATT SCALING) Y AUDITORÍA DE BRIER SCORE
// Corrige la sobreconfianza o subestimación estadística en modelos estocásticos para alinear
// las probabilidades calculadas exactamente con las tasas empíricas de cobro en el mundo real.

/**
 * Coeficientes empíricos de Platt Scaling por deporte.
 * Calibrados a partir de los datos históricos de auditoría forense para mitigar sesgos de cola.
 * Formulación: P_calibrada = 1 / (1 + exp(A * logit(P_raw) + B))
 *
 * 2026-11-10 (afinación, decisión de Tavo): los defaults ya NO son los de la
 * era del backtest (A≈0.85-0.92). El ajuste pooled sobre el ledger real
 * (37 picks cerrados, 17W-20L) pide A≈0.20, B≈-0.35, PERO ese ajuste está
 * fitado solo sobre picks DESPACHADOS (muestra seleccionada: ya pasaron los
 * mínimos de prob/EV y el consenso) y su encogimiento deja el slate vacío
 * (corrida en seco 2026-11-10: 0 emitidos, todo vetado por EV). Por eso los
 * defaults usan una corrección PARCIAL (A=0.65, B=-0.20): corrige la
 * sobreconfianza (cruda 75% → 64.9% en vez de ~73%) sin silenciar el motor.
 * El modo paper ahora registra TODAS las oportunidades (emitidas + vetadas)
 * y las califica, así que la próxima recalibración se fitará sobre una
 * muestra sin sesgo de selección. El refit por deporte (recalibrateFromAudit,
 * umbral 30 picks) sigue adaptando por deporte cuando haya muestra suficiente.
 *
 * 2026-11-24 (Fase 3 del plan, R2+R3, decisión de Tavo 12:39 CST — la
 * corrección parcial ya NO basta: el diagnóstico forense, n=56, gap +16.43,
 * Brier 0.2955, exige el refit honesto aunque el slate +EV casi se vacíe):
 * - R2 global: TODOS los deportes a A=0.34, B=-0.33 (refit con candado
 *   A₂=0.40/B₂=-0.334 compuesto con la calibración efectiva del despacho
 *   A≈0.85; Fase 2 lo recomputó: 0.341/-0.335, sin cambio material).
 *   Cruda 70% → ~49%, cruda 85% → 56.5%. El piso del candado en
 *   recalibrateFromAudit baja de A≥0.40 a A≥0.25 para poder expresar el refit.
 * - R3 NBA (interino hasta n=30 cerrados): A=0.36, B=-0.60 — el par honesto
 *   de despacho (refit con candado 0.40/-0.60 compuesto con el coeficiente NBA
 *   viejo 0.90: 0.40×0.90=0.36; B: 0.40×0.00-0.60=-0.60). NO usar el 0.40/-0.60
 *   sin componer del informe: eso contaría dos veces. Un pick NBA que con los
 *   coeficientes viejos se guardaba como 80% (cruda ≈82.4%) ahora calibra ~49%.
 * - R4 fútbol: SIN refit propio en el slate; el fútbol queda cubierto por
 *   el par global. PERO el tier Seguro usa el refit suave A≈0.36/B≈-0.03
 *   (applySoccerSafeCalibration, decisión de Tavo 2026-11-24 15:16 CST):
 *   el Seguro es solo favoritos ML de fútbol y el refit global lo
 *   sobrecorrige; con el par suave el umbral cal≥55% exige cruda ≥65.5%.
 * Consecuencia aceptada: /futuro (cal≥65%) ahora exige cruda ≥94.2% y se
 * vacía casi siempre; su umbral NO se baja para compensar. El tier Seguro
 * ya NO se vacía: los 6 seguros en vivo del 24 nov califican con el par
 * suave (Real Madrid 80.2 → 61.6, Betis 69.2 → 56.5).
 */
let PLATT_COEFFICIENTS = {
  futbol: { A: 0.34, B: -0.33 },
  nfl: { A: 0.34, B: -0.33 },
  ncaaf: { A: 0.34, B: -0.33 },
  mlb: { A: 0.34, B: -0.33 },
  nba: { A: 0.36, B: -0.60 }
};

// Cargar coeficientes auto-aprendidos (Área 11) de memoria local si existen
if (typeof window !== 'undefined' && window.localStorage) {
  try {
    const saved = localStorage.getItem('fstats_platt_coefs');
    if (saved) {
      const parsed = JSON.parse(saved);
      PLATT_COEFFICIENTS = { ...PLATT_COEFFICIENTS, ...parsed };
    }
  } catch (e) {}
}

export function getPlattCoefficients() {
  return { ...PLATT_COEFFICIENTS };
}

export function hydratePlattCoefficients(newCoefs = {}) {
  if (!newCoefs || typeof newCoefs !== 'object') return;
  PLATT_COEFFICIENTS = {
    ...PLATT_COEFFICIENTS,
    ...newCoefs
  };
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem('fstats_platt_coefs', JSON.stringify(PLATT_COEFFICIENTS));
    } catch (e) {}
  }
}

export function recalibrateFromAudit(auditedPicks, sport, options = {}) {
  // R8 (2026-11-24): `options.persist === false` calcula la sugerencia SIN
  // tocar la calibración en vigor. La auditoría diaria usa persist:false:
  // sus coeficientes son una sugerencia para revisión humana (futura R2),
  // nunca una calibración silenciosa del despacho. Con persist:true (defecto,
  // ruta del navegador en history.js) el comportamiento no cambia.
  const sLower = (sport || 'futbol').toLowerCase();
  let key = 'futbol';
  if (sLower.includes('ncaaf') || sLower.includes('colegial')) key = 'ncaaf';
  else if (sLower.includes('nfl')) key = 'nfl';
  else if (sLower.includes('mlb') || sLower.includes('beisbol')) key = 'mlb';
  else if (sLower.includes('nba') || sLower.includes('baloncesto') || sLower.includes('basket')) key = 'nba';

  // Filtrar exclusivamente selecciones completadas del deporte en cuestión
  const valid = auditedPicks.filter(p => {
    if (!p || (p.status !== 'won' && p.status !== 'lost')) return false;
    const pSport = (p.sport || '').toLowerCase();
    if (key === 'ncaaf') return pSport.includes('ncaaf') || pSport.includes('colegial');
    if (key === 'nfl') return pSport.includes('nfl');
    if (key === 'mlb') return pSport.includes('mlb') || pSport.includes('beisbol');
    if (key === 'nba') return pSport.includes('nba') || pSport.includes('baloncesto') || pSport.includes('basket');
    return pSport.includes('futbol') || pSport.includes('fútbol') || (!pSport && key === 'futbol');
  });

  // UMBRAL MATEMÁTICO: Mínimo 30 observaciones auditadas reales
  if (valid.length < 30) {
    return PLATT_COEFFICIENTS[key];
  }
  
  // Descenso de Gradiente (Gradient Descent) optimizando la Log-Loss binaria exacta:
  // L = - (1/N) * sum [ y * ln(p_cal) + (1 - y) * ln(1 - p_cal) ]
  // p_cal = 1 / (1 + exp(-(A * logit + B)))
  let A = PLATT_COEFFICIENTS[key]?.A || 1.0;
  let B = PLATT_COEFFICIENTS[key]?.B || 0.0;
  const lr = 0.015;
  const epochs = 600;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let gradA = 0;
    let gradB = 0;

    for (let i = 0; i < valid.length; i++) {
      const p = valid[i];
      // Platt se ajusta sobre la salida CRUDA del modelo; usar la ya calibrada compone el sesgo en cada ciclo
      const rawProbVal = parseFloat(p.rawProb) || parseFloat(p.prob) || (p.probs?.homeWin ? parseFloat(p.probs.homeWin) : 60);
      const rawP = Math.max(0.01, Math.min(0.99, rawProbVal / 100));
      const logit = Math.log(rawP / (1 - rawP));

      // Sigmoide escalada: p_cal = 1 / (1 + exp(-(A * logit + B)))
      const z = A * logit + B;
      const calP = 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, z))));
      const y = p.status === 'won' ? 1.0 : 0.0;
      const error = calP - y; // Derivada de la Log-Loss respecto a z

      gradA += error * logit;
      gradB += error;
    }

    A -= lr * (gradA / valid.length);
    B -= lr * (gradB / valid.length);

    // Candado numérico para evitar coeficientes degenerados en muestras sesgadas.
    // Fase 3 (2026-11-24, R2): el piso baja de A≥0.40 a A≥0.25 — el refit
    // honesto (global 0.34, NBA 0.36) queda por debajo del piso viejo y el
    // código no podía expresarlo. Los demás topes no cambian (A≤1.80,
    // B∈[-0.60, 0.60]).
    A = Math.max(0.25, Math.min(1.80, A));
    B = Math.max(-0.60, Math.min(0.60, B));
  }
  
  const newCoefs = { A: Number(A.toFixed(4)), B: Number(B.toFixed(4)) };
  // R8: solo persistir cuando se pide explícitamente. La auditoría (persist:false)
  // devuelve la sugerencia sin mutar la calibración documentada del despacho.
  if (options.persist === false) return newCoefs;
  PLATT_COEFFICIENTS[key] = newCoefs;

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem('fstats_platt_coefs', JSON.stringify(PLATT_COEFFICIENTS));
    } catch (e) {}
  }

  return newCoefs;
}

/**
 * Aplica una transformación logística de Platt Scaling a una probabilidad porcentual.
 * @param {number|string} rawProb - Probabilidad cruda (ej. 75 o "75%")
 * @param {string} sport - 'futbol', 'mlb', 'nfl', 'ncaaf'
 * @returns {number} Probabilidad calibrada (ej. 72.8)
 */
export function applyPlattCalibration(rawProb, sport = 'futbol') {
  const num = typeof rawProb === 'string' ? parseFloat(rawProb) : Number(rawProb);
  if (isNaN(num) || num <= 0 || num >= 100) return num;

  const sLower = (sport || 'futbol').toLowerCase();
  let key = 'futbol';
  if (sLower.includes('ncaaf') || sLower.includes('colegial')) key = 'ncaaf';
  else if (sLower.includes('nfl')) key = 'nfl';
  else if (sLower.includes('mlb') || sLower.includes('beisbol')) key = 'mlb';
  else if (sLower.includes('nba') || sLower.includes('baloncesto') || sLower.includes('basket')) key = 'nba';

  const { A, B } = PLATT_COEFFICIENTS[key] || PLATT_COEFFICIENTS.futbol;

  // Convertir a probabilidad en rango (0.01, 0.99)
  const p = Math.max(0.01, Math.min(0.99, num / 100));

  // Calcular logit(p) = ln(p / (1 - p))
  const logit = Math.log(p / (1 - p));

  // Evaluar función sigmoide escalada
  const calibratedP = 1 / (1 + Math.exp(-(A * logit + B)));

  // Retornar en porcentaje con un decimal
  return Number((calibratedP * 100).toFixed(1));
}

/**
 * Calibración Platt suave SOLO para el nivel Picks Seguros (fútbol).
 * 2026-11-24 (decisión de Tavo 15:16 CST, tras el refit Fase 3): el tier
 * Seguro usa el refit suave de fútbol A=0.36, B=-0.03 (R4 del diagnóstico)
 * en vez del par global A=0.34/B=-0.33. El Seguro es solo favoritos ML de
 * fútbol y la brecha de calibración del fútbol (+9.43, no significativa) es
 * mucho menor que la global (+16.43, dominada por NBA/spreads), así que el
 * refit global lo sobrecorrige. Con estos coeficientes el umbral cal≥55%
 * exige cruda ≥65.5% y los 6 seguros en vivo del 24 nov califican
 * (Real Madrid cruda 80.2 → 61.6, Betis 69.2 → 56.5). El slate +EV y
 * /futuro siguen con applyPlattCalibration (par global); esto NO cambia
 * ningún coeficiente del slate. Misma fórmula, mismo redondeo.
 */
export const SOCCER_SAFE_PLATT = { A: 0.36, B: -0.03 };

export function applySoccerSafeCalibration(rawProb) {
  const num = typeof rawProb === 'string' ? parseFloat(rawProb) : Number(rawProb);
  if (isNaN(num) || num <= 0 || num >= 100) return num;
  const p = Math.max(0.01, Math.min(0.99, num / 100));
  const logit = Math.log(p / (1 - p));
  const calibratedP = 1 / (1 + Math.exp(-(SOCCER_SAFE_PLATT.A * logit + SOCCER_SAFE_PLATT.B)));
  return Number((calibratedP * 100).toFixed(1));
}

/**
 * Calcula el Brier Score y métricas de fiabilidad sobre un conjunto de apuestas auditadas.
 * Brier Score: BS = (1/N) * sum((prob_i - outcome_i)^2)
 * Rango: 0.0 (predicción perfecta) a 1.0 (fallo absoluto). Un BS <= 0.18 es nivel élite institucional.
 * 
 * @param {Array} auditedPicks - Lista de selecciones auditadas con { prob, status: 'won'|'lost'|'push' }
 * @returns {Object} Métricas Brier y curva de fiabilidad
 */
export function calculateBrierMetrics(auditedPicks = []) {
  const validPicks = auditedPicks.filter(p => p && (p.status === 'won' || p.status === 'lost'));
  if (validPicks.length === 0) {
    return {
      brierScore: 0.20,
      calibrationGrade: 'Sin datos suficientes',
      accuracyVsExpected: 'N/A',
      reliabilityScore: 80
    };
  }

  let squaredDiffSum = 0;
  let expectedWins = 0;
  let actualWins = 0;

  // Bins de calibración (50-60%, 60-70%, 70-80%, 80-100%)
  const bins = {
    '50-59%': { total: 0, wins: 0, sumProb: 0 },
    '60-69%': { total: 0, wins: 0, sumProb: 0 },
    '70-79%': { total: 0, wins: 0, sumProb: 0 },
    '80%+':   { total: 0, wins: 0, sumProb: 0 }
  };

  validPicks.forEach(p => {
    const probDec = (parseFloat(p.prob) || 60) / 100;
    const outcome = p.status === 'won' ? 1.0 : 0.0;

    squaredDiffSum += Math.pow(probDec - outcome, 2);
    expectedWins += probDec;
    if (outcome === 1.0) actualWins += 1;

    const probPct = probDec * 100;
    let bKey = '50-59%';
    if (probPct >= 80) bKey = '80%+';
    else if (probPct >= 70) bKey = '70-79%';
    else if (probPct >= 60) bKey = '60-69%';

    bins[bKey].total += 1;
    bins[bKey].sumProb += probDec;
    if (outcome === 1.0) bins[bKey].wins += 1;
  });

  const brierScore = Number((squaredDiffSum / validPicks.length).toFixed(4));
  const reliabilityScore = Number((Math.max(0, (1 - (brierScore / 0.25))) * 100).toFixed(1));

  let calibrationGrade = 'Excelente';
  if (brierScore > 0.22) calibrationGrade = 'Desviado (Requiere recalibración)';
  else if (brierScore > 0.18) calibrationGrade = 'Aceptable';

  // Detalle de cada bin
  const binReport = Object.entries(bins).map(([name, data]) => {
    const avgExpected = data.total > 0 ? Number(((data.sumProb / data.total) * 100).toFixed(1)) : 0;
    const actualWinPct = data.total > 0 ? Number(((data.wins / data.total) * 100).toFixed(1)) : 0;
    return {
      bin: name,
      count: data.total,
      expectedRate: `${avgExpected}%`,
      actualRate: `${actualWinPct}%`,
      delta: Number((actualWinPct - avgExpected).toFixed(1))
    };
  });

  return {
    totalAudited: validPicks.length,
    brierScore,
    reliabilityScore,
    calibrationGrade,
    expectedWins: Number(expectedWins.toFixed(1)),
    actualWins,
    binReport
  };
}
