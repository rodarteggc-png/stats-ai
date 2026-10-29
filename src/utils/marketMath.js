// src/utils/marketMath.js
// Matemática de mercado: remoción de vig, Valor Esperado real, detección de outliers y Confidence Tiers.
// No modifica los modelos (Poisson/Dixon-Coles/Monte Carlo); solo mide su salida contra el precio real.

const toNum = (v) => {
  const n = typeof v === 'string' ? parseFloat(v.replace('%', '')) : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Probabilidades sin vig a partir de cuotas decimales de TODOS los resultados de un mercado.
 * Método "power" (k tal que Σ(1/o_i)^k = 1): corrige el sesgo favorito-longshot mejor que el multiplicativo.
 * @returns {{ probs: number[], overround: number } | null} probs en 0-1
 */
export function removeVig(oddsList = [], method = 'power') {
  const odds = oddsList.map(toNum);
  if (odds.length < 2 || odds.some(o => !(o > 1))) return null;
  const implied = odds.map(o => 1 / o);
  const overround = implied.reduce((a, b) => a + b, 0);

  if (method === 'multiplicative' || overround <= 1) {
    return { probs: implied.map(p => p / overround), overround };
  }

  let lo = 1, hi = 5;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    const s = implied.reduce((a, p) => a + p ** k, 0);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return { probs: implied.map(p => p ** k), overround };
}

/** Probabilidad sin vig estimada cuando solo se conoce un lado de un mercado de dos vías. */
export function noVigFromSingleSide(odds, assumedOverround = 1.045) {
  const o = toNum(odds);
  if (!(o > 1)) return NaN;
  return (1 / o) / assumedOverround;
}

/** EV por unidad apostada en % : p·o − 1 */
export function expectedValuePct(probPct, odds) {
  const p = toNum(probPct) / 100;
  const o = toNum(odds);
  if (!(p > 0 && p < 1) || !(o > 1)) return NaN;
  return (p * o - 1) * 100;
}

/** Edge en puntos porcentuales contra la probabilidad implícita (con vig) de la cuota apostable. */
export function edgePp(probPct, odds) {
  const p = toNum(probPct);
  const o = toNum(odds);
  if (!(p > 0) || !(o > 1)) return NaN;
  return p - 100 / o;
}

/**
 * Mercado de Doble Oportunidad derivado de un 1X2 real: probabilidad de mercado sin vig y
 * cuota apostable estimada aplicando el mismo margen del libro.
 */
export function deriveDoubleChanceMarket(homeOdds, drawOdds, awayOdds, side = '1X') {
  const nv = removeVig([homeOdds, drawOdds, awayOdds]);
  if (!nv) return null;
  const [pH, pD, pA] = nv.probs;
  const fair = side === '1X' ? pH + pD : pD + pA;
  const bookOdds = 1 / (fair * nv.overround);
  return { marketProbPct: fair * 100, odds: Number(Math.max(1.01, bookOdds).toFixed(2)), overround: nv.overround };
}

/**
 * Un modelo que supera por mucho al precio de Pinnacle casi siempre está leyendo datos viejos
 * (alineación, lesión, clima) y no una ineficiencia real del mercado.
 */
export function isModelOutlier(modelProbPct, marketNoVigProbPct, maxGapPp = 12) {
  const m = toNum(modelProbPct);
  const k = toNum(marketNoVigProbPct);
  if (!Number.isFinite(m) || !Number.isFinite(k)) return false;
  return m - k > maxGapPp;
}

/**
 * Clasificación de confianza para gestión de stake y comunicación al suscriptor.
 * kellyMultiplier escala el stake Kelly ya calculado.
 */
export function getConfidenceTier({ probPct, odds, votesPassed = 2, oddsSource = 'market' }) {
  const ev = expectedValuePct(probPct, odds);
  const p = toNum(probPct);
  if (!Number.isFinite(ev) || ev <= 0) return { tier: 'NO_BET', label: '⛔ Sin valor', kellyMultiplier: 0, evPct: ev };

  const realPrice = oddsSource === 'market' || oddsSource === 'derived';
  if (ev >= 6 && p >= 55 && votesPassed >= 3 && realPrice) {
    return { tier: 'A', label: '🟢 Tier A (Élite)', kellyMultiplier: 1.0, evPct: ev };
  }
  if (ev >= 3.5 && votesPassed >= 2) {
    return { tier: 'B', label: '🟡 Tier B (Sólido)', kellyMultiplier: 0.75, evPct: ev };
  }
  if (ev >= 2) {
    return { tier: 'C', label: '🟠 Tier C (Valor Marginal)', kellyMultiplier: 0.5, evPct: ev };
  }
  return { tier: 'NO_BET', label: '⛔ EV insuficiente', kellyMultiplier: 0, evPct: ev };
}
