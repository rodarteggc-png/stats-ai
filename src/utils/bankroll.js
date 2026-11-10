// src/utils/bankroll.js
// GESTIÓN DE BANCA: topes y freno de drawdown sobre el RÉCORD REAL.
//
// Mejora 4 del plan 2026-11-10. No toca la matemática del modelo (Poisson,
// Dixon-Coles, Monte Carlo) ni los 5 candados: es control de riesgo sobre lo
// que el ledger ya demostró. El Kelly fraccionado (1/10 y 1/20) y el techo de
// 2.0u por pick ya existían en kelly.js; aquí se añaden las dos piezas que
// faltaban:
//  - Exposición diaria: máximo 6.0u nuevas por día (CDMX). Si la cartelera
//    supera el tope, se recorta por edge (se descartan las de menor edge).
//  - Freno de drawdown: si el drawdown de los últimos 30 días llega a 15.0u,
//    se bloquea el despacho de picks nuevos. Es red de seguridad de último
//    recurso, no objetivo de calidad: el objetivo interno es no perder más
//    de 6.0u en 30 días afinando el sistema (Tavo 2026-11-10); el stop-loss
//    es de cada jugador/suscriptor, el sistema no debe parar de generar picks.
//    El freno NO es permanente: se levanta solo cuando la ventana de 30 días
//    rueda y el drawdown baja, o con un reinicio manual explícito y registrado
//    (scripts/bankrollReset.mjs). Sin picks nuevos no hay resultados nuevos:
//    la recuperación es por el paso de la ventana, no por apostar más.
//
// Todo puro y testeable: recibe filas del ledger, no lee archivos.

export const BANKROLL = {
  maxStakeUnits: 2.0,
  maxDailyExposureUnits: 6.0,
  drawdownStopUnits: 15.0,
  drawdownWindowDays: 30,
  timeZone: 'America/Mexico_City',
};

const r2 = (n) => Math.round(n * 100) / 100;

function dateInZone(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Drawdown de los picks cerrados en la ventana (por fecha de cierre).
export function settledDrawdown(closedRows, nowMs = Date.now(), windowDays = BANKROLL.drawdownWindowDays, resetAtMs = null) {
  const windowStart = nowMs - windowDays * 86400000;
  const inWindow = closedRows
    .filter(r => r.result === 'WON' || r.result === 'LOST')
    .filter(r => {
      const at = Date.parse(r.closedAt || r.timestamp);
      if (!Number.isFinite(at)) return false;
      if (at < windowStart) return false;
      if (resetAtMs && at < resetAtMs) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.closedAt || a.timestamp) - Date.parse(b.closedAt || b.timestamp));
  let peak = 0;
  let running = 0;
  let maxDrawdown = 0;
  for (const r of inWindow) {
    running += Number(r.pnlUnits) || 0;
    if (running > peak) peak = running;
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }
  return {
    n: inWindow.length,
    peakUnits: r2(peak),
    currentUnits: r2(running),
    drawdownUnits: r2(peak - running),
    maxDrawdownUnits: r2(maxDrawdown),
  };
}

// Unidades ya comprometidas hoy (picks publicados hoy, por fecha CDMX).
export function exposureToday(allRows, nowMs = Date.now(), timeZone = BANKROLL.timeZone) {
  const today = dateInZone(nowMs, timeZone);
  return r2(allRows
    .filter(r => {
      const at = Date.parse(r.timestamp);
      return Number.isFinite(at) && dateInZone(at, timeZone) === today;
    })
    .reduce((acc, r) => acc + (Number(r.stakeUnits) || 0), 0));
}

export function evaluateBankroll({ closedRows, allRows, nowMs = Date.now(), resetAt = null } = {}) {
  const resetAtMs = resetAt ? Date.parse(resetAt) : null;
  const dd = settledDrawdown(closedRows, nowMs, BANKROLL.drawdownWindowDays, resetAtMs);
  const exposure = exposureToday(allRows, nowMs);
  const remaining = Math.max(0, r2(BANKROLL.maxDailyExposureUnits - exposure));
  const reasons = [];
  if (dd.drawdownUnits >= BANKROLL.drawdownStopUnits) {
    reasons.push(`Drawdown de ${dd.drawdownUnits}u en ${BANKROLL.drawdownWindowDays} días (límite ${BANKROLL.drawdownStopUnits}u).`);
  }
  if (remaining <= 0) {
    reasons.push(`Exposición diaria agotada: ${exposure}u comprometidas hoy (tope ${BANKROLL.maxDailyExposureUnits}u).`);
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    drawdownUnits: dd.drawdownUnits,
    maxDrawdownUnits: dd.maxDrawdownUnits,
    peakUnits: dd.peakUnits,
    settledInWindow: dd.n,
    exposureTodayUnits: exposure,
    remainingExposureUnits: remaining,
    resetAt: resetAt || null,
  };
}

// Recorta una cartelera (ya ordenada por edge descendente) a la exposición
// restante. No hay stakes parciales: un pick que no cabe entero se descarta.
export function trimSlateToExposure(picks, remainingExposureUnits) {
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const item of picks) {
    const stake = Math.min(Number(item.stake) || 0, BANKROLL.maxStakeUnits);
    if (stake <= 0 || used + stake > remainingExposureUnits + 1e-9) {
      dropped.push(item);
    } else {
      kept.push(item);
      used += stake;
    }
  }
  return { kept, dropped, usedUnits: r2(used) };
}

// Techo absoluto por pick (defensa en profundidad; Kelly ya lo aplica).
export function capStake(stakeUnits) {
  return Math.max(0, Math.min(Number(stakeUnits) || 0, BANKROLL.maxStakeUnits));
}
