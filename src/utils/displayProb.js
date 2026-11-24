// src/utils/displayProb.js — R5 (2026-11-24, plan de afinación fase 1).
// Tope de probabilidad MOSTRADA en 80%.
//
// Evidencia (diagnóstico forense 2026-11-24, §1.3): el cubo 80%+ predice
// 86.77% y acierta 40.0% (z=3.02). El tope es SOLO de display: ninguna
// superficie que muestra una probabilidad (tarjeta de pick, cheatsheet,
// /futuro, slate paper) puede mostrar más de 80%. La probabilidad interna
// del modelo (opp.prob) y todos los gates (EV, consenso, prob_below_min,
// stake) siguen usando el valor real sin topar: estas funciones nunca
// mutan el pick, solo formatean lo que se muestra.
//
// No se aplica al tier de Picks Seguros (api/_lib/safePicks.js): tiene su
// propio formateador y el brief de fase 1 lo deja fuera. Tampoco al
// simulador web (src/App.jsx): no comparte este formateador.
export const DISPLAY_PROB_CAP_PCT = 80;

/**
 * Devuelve la probabilidad a mostrar (número 0-100), topada en 80.
 * Acepta número o texto con '%' ('94.8%'). Si no es numérica, devuelve
 * la entrada tal cual (el llamador la renderiza como antes).
 */
export function capDisplayedProb(prob) {
  const n = typeof prob === 'string' ? parseFloat(prob) : Number(prob);
  if (!Number.isFinite(n)) return prob;
  return Math.min(n, DISPLAY_PROB_CAP_PCT);
}

/**
 * Formatea una probabilidad para mostrarla, con sufijo % y tope en 80.
 * Conserva los decimales de la entrada ('94.8%' -> '80.0%', '60%' -> '60%').
 */
export function formatDisplayedProb(prob) {
  const capped = capDisplayedProb(prob);
  if (typeof capped !== 'number' || !Number.isFinite(capped)) return String(prob ?? '');
  const m = String(prob).match(/\.(\d+)/);
  const decimals = m ? m[1].length : 0;
  return `${capped.toFixed(decimals)}%`;
}
