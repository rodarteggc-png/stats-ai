// src/utils/kelly.js
// MOTOR DE GESTIÓN DE BANCA CUANTITATIVA - CRITERIO DE KELLY FRACCIONAL
// Calcula dinámicamente el tamaño óptimo de la apuesta (Stake en Unidades)
// en función de la probabilidad calibrada, la cuota del mercado y el edge real.

/**
 * Criterio de Kelly Fraccional para gestión de capital profesional.
 * 
 * Fórmula de Kelly:
 *   f* = (p * b - q) / b
 * donde:
 *   p = probabilidad calibrada del modelo (0 a 1)
 *   q = 1 - p (probabilidad de pérdida)
 *   b = cuota decimal - 1 (ganancia neta)
 * 
 * Escalamiento Cuantitativo:
 * - 1 Unidad = 1% del Bankroll total.
 * - Para apuestas deportivas, Full Kelly es excesivamente agresivo; se utiliza Kelly Fraccional (0.10x - 0.25x).
 * - Techo prudencial de seguridad (Cap): 2.0 Unidades máximo por selección.
 * - Piso mínimo para jugada con valor: 0.4 Unidades.
 * 
 * @param {number|string} modelProb - Probabilidad estimada (ej. 62 o "62%")
 * @param {number|string} decimalOdds - Cuota decimal del mercado (ej. 1.91 o "1.91")
 * @param {number} fraction - Multiplicador fraccional de Kelly (default: 0.10 para un rango óptimo de 0.5u - 2.0u)
 * @param {number} maxUnitsCap - Límite superior estricto de unidades (default: 2.0u)
 * @returns {{ kellyPct: string, units: string, rawUnits: number, riskLevel: string, edge: string }}
 */
export function calculateKellyStake(modelProb, decimalOdds, fraction = 0.10, maxUnitsCap = 2.0) {
  let pVal = 0;
  if (typeof modelProb === 'string') {
    pVal = parseFloat(modelProb.replace('%', '').trim());
  } else if (typeof modelProb === 'number') {
    pVal = modelProb;
  }

  const oVal = typeof decimalOdds === 'string' ? parseFloat(decimalOdds) : (decimalOdds || 0);

  const p = (pVal || 0) / 100;
  const q = 1 - p;
  const b = oVal - 1; // ganancia neta

  if (isNaN(b) || b <= 0 || isNaN(p) || p <= 0 || p >= 1) {
    return {
      kellyPct: "0.00",
      units: "0.0",
      rawUnits: 0,
      riskLevel: "⛔ NO APOSTAR",
      edge: "0.0"
    };
  }

  // Full Kelly: f* = (p * b - q) / b
  const fullKelly = ((p * b) - q) / b;

  // Edge real = Probabilidad del modelo - Probabilidad implícita
  const impliedProb = 1 / oVal;
  const edge = (p - impliedProb) * 100;

  if (fullKelly <= 0 || edge <= 0) {
    return {
      kellyPct: "0.00",
      units: "0.0",
      rawUnits: 0,
      riskLevel: "⛔ SIN VENTAJA",
      edge: edge.toFixed(1)
    };
  }

  // Fracción de Kelly ajustada
  const adjKelly = fullKelly * fraction;

  // Escalamiento a unidades de banca:
  // 1 Unidad = 1% del bankroll.
  const unroundedUnits = adjKelly * 100;
  const boundedUnits = Math.min(Math.max(unroundedUnits, 0.4), maxUnitsCap);
  const units = boundedUnits.toFixed(1);

  let riskLevel;
  if (boundedUnits <= 0.7) riskLevel = "🟢 Bajo (Conservador)";
  else if (boundedUnits <= 1.2) riskLevel = "🟡 Moderado (Valor Sólido)";
  else if (boundedUnits <= 1.7) riskLevel = "🟠 Alto (Ventaja Fuerte)";
  else riskLevel = "🔥 Élite (Máximo Permitido)";

  return {
    kellyPct: (adjKelly * 100).toFixed(2),
    units,
    rawUnits: boundedUnits,
    riskLevel,
    edge: edge.toFixed(1)
  };
}

/**
 * Genera el string descriptivo y exacto para el Tribunal de Consenso y las Alertas de Telegram.
 * @param {Object} params
 * @param {number|string} params.prob - Probabilidad del pick
 * @param {number|string} params.odds - Cuota decimal
 * @param {number} params.votesPassed - Cantidad de votos del Tribunal (0 a 3)
 * @returns {string} Texto formateado con unidades y justificación matemática
 */
export function formatDynamicStake({ prob, odds, votesPassed = 3 }) {
  if (votesPassed < 2) {
    return '0.0 Unidades (Veto del Tribunal — No Apostar)';
  }

  // Si 3/3 votos -> Fracción completa estándar (0.10x sobre Kelly, máx 2.0u)
  // Si 2/3 votos -> Haircut del 50% de seguridad preventiva ante el voto discrepante (máx 1.0u)
  const fraction = votesPassed === 3 ? 0.10 : 0.05;
  const fractionLabel = votesPassed === 3 ? 'Quarter Kelly' : 'Eighth Kelly / Cobertura';
  const cap = votesPassed === 3 ? 2.0 : 1.0;

  const kelly = calculateKellyStake(prob, odds, fraction, cap);

  if (kelly.rawUnits <= 0 || parseFloat(kelly.edge) <= 0) {
    return votesPassed === 3 
      ? '1.0 Unidad (Stake Fijo de Protección)' 
      : '0.5 Unidades (Stake Prudente de Cobertura)';
  }

  return `${kelly.units} Unidades (${fractionLabel} | Edge +${kelly.edge}%)`;
}
