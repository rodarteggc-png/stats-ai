// src/utils/calibration.js
// CALIBRACIÓN BAYESIANA CONTINUA (PLATT SCALING) Y AUDITORÍA DE BRIER SCORE
// Corrige la sobreconfianza o subestimación estadística en modelos estocásticos para alinear
// las probabilidades calculadas exactamente con las tasas empíricas de cobro en el mundo real.

/**
 * Coeficientes empíricos de Platt Scaling por deporte.
 * Calibrados a partir de los datos históricos de auditoría forense para mitigar sesgos de cola.
 * Formulación: P_calibrada = 1 / (1 + exp(A * logit(P_raw) + B))
 */
let PLATT_COEFFICIENTS = {
  futbol: { A: 0.88, B: -0.04 }, // Ajusta riesgo de empate en favoritos inflados
  nfl: { A: 0.92, B: 0.00 },    // Calibrado con números clave 3 y 7
  ncaaf: { A: 0.85, B: 0.00 },  // Mayor regresión a la media por volatilidad colegial
  mlb: { A: 0.82, B: 0.02 },    // Suaviza sobreestimaciones provocadas por bullpen tardío
  nba: { A: 0.90, B: 0.00 }     // Calibrado con posesiones y ritmo NBA
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

export function recalibrateFromAudit(auditedPicks, sport) {
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

    // Candado numérico para evitar coeficientes degenerados en muestras sesgadas
    A = Math.max(0.40, Math.min(1.80, A));
    B = Math.max(-0.60, Math.min(0.60, B));
  }
  
  const newCoefs = { A: Number(A.toFixed(4)), B: Number(B.toFixed(4)) };
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
