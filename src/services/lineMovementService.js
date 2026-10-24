// src/services/lineMovementService.js
// DETECTOR DE MOVIMIENTOS DE LÍNEA INSTITUCIONAL (LINE MOVEMENT & STEAM MOVES)
// Analiza el desplazamiento entre la Línea de Apertura (Opening Line) y la Línea Actual (Current/Closing)
// en Spreads, Totales y Moneylines sin costo de API (extraído directamente de los feeds deportivos).

/**
 * Analiza el movimiento de cuotas y líneas en un partido
 * @param {Object} oddsObj - Objeto de cuotas del partido (ej. comp.odds de ESPN o vegas de match)
 * @returns {Object} Diagnóstico de movimiento de línea y presión institucional
 */
export function analyzeLineMovement(oddsObj = {}) {
  if (!oddsObj) return { hasMovement: false, movements: [] };

  const movements = [];
  let isSharpSteam = false;

  // 1. ANÁLISIS DE SPREAD
  try {
    const spreadInfo = oddsObj.pointSpread || oddsObj.spread;
    if (spreadInfo) {
      const homeOpen = parseFloat(spreadInfo.home?.open?.line);
      const homeClose = parseFloat(spreadInfo.home?.close?.line);

      if (!isNaN(homeOpen) && !isNaN(homeClose) && homeOpen !== homeClose) {
        const delta = Number((homeClose - homeOpen).toFixed(1));
        const absDelta = Math.abs(delta);
        const favorsHome = delta < 0; // Se hace más favorito el local (ej. -3.5 a -5.0)

        const isSteam = absDelta >= 1.5;
        if (isSteam) isSharpSteam = true;

        movements.push({
          market: 'SPREAD',
          open: homeOpen,
          current: homeClose,
          delta,
          isSteam,
          favors: favorsHome ? 'HOME' : 'AWAY',
          badgeText: `${isSteam ? '🚨 STEAM SPREAD' : '📈 AJUSTE SPREAD'}: Línea abrió en ${homeOpen > 0 ? '+' : ''}${homeOpen} y se movió a ${homeClose > 0 ? '+' : ''}${homeClose} (${delta > 0 ? '+' : ''}${delta} pts)`
        });
      }
    }
  } catch (e) {}

  // 2. ANÁLISIS DE TOTALES (OVER / UNDER)
  try {
    const totalInfo = oddsObj.total || oddsObj.overUnder;
    if (totalInfo) {
      const overOpenStr = totalInfo.over?.open?.line || totalInfo.open;
      const overCloseStr = totalInfo.over?.close?.line || totalInfo.close;

      const numOpen = parseFloat(String(overOpenStr || '').replace(/[ou]/gi, ''));
      const numClose = parseFloat(String(overCloseStr || '').replace(/[ou]/gi, ''));

      if (!isNaN(numOpen) && !isNaN(numClose) && numOpen !== numClose) {
        const delta = Number((numClose - numOpen).toFixed(1));
        const absDelta = Math.abs(delta);
        const isUnderPressure = delta < 0; // La línea cayó

        const isSteam = absDelta >= 2.0;
        if (isSteam) isSharpSteam = true;

        movements.push({
          market: 'TOTALS',
          open: numOpen,
          current: numClose,
          delta,
          isSteam,
          favors: isUnderPressure ? 'UNDER' : 'OVER',
          badgeText: `${isSteam ? '🚨 STEAM TOTAL' : '📉 AJUSTE TOTAL'}: Abrió en ${numOpen} y se desplazó a ${numClose} (${delta > 0 ? '+' : ''}${delta} pts hacia el ${isUnderPressure ? 'UNDER' : 'OVER'})`
        });
      }
    }
  } catch (e) {}

  // 3. ANÁLISIS DE MONEYLINE
  try {
    const mlInfo = oddsObj.moneyLine || oddsObj.moneyline;
    if (mlInfo) {
      const homeOpenOdds = parseInt(mlInfo.home?.open?.odds, 10);
      const homeCloseOdds = parseInt(mlInfo.home?.close?.odds, 10);

      if (!isNaN(homeOpenOdds) && !isNaN(homeCloseOdds) && homeOpenOdds !== homeCloseOdds) {
        const deltaCents = homeCloseOdds - homeOpenOdds;
        const absDeltaCents = Math.abs(deltaCents);
        const isSteam = absDeltaCents >= 20;
        if (isSteam) isSharpSteam = true;

        movements.push({
          market: 'MONEYLINE',
          open: homeOpenOdds,
          current: homeCloseOdds,
          delta: deltaCents,
          isSteam,
          favors: deltaCents < 0 ? 'HOME' : 'AWAY',
          badgeText: `${isSteam ? '🚨 STEAM MONEYLINE' : '💰 AJUSTE ML'}: Abrió en ${homeOpenOdds > 0 ? '+' : ''}${homeOpenOdds} y cerró en ${homeCloseOdds > 0 ? '+' : ''}${homeCloseOdds}`
        });
      }
    }
  } catch (e) {}

  return {
    hasMovement: movements.length > 0,
    isSharpSteam,
    movements,
    summaryText: movements.map(m => m.badgeText).join(' | ')
  };
}
