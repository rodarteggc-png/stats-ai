// src/utils/rlmDetector.js
// DETECTOR AVANZADO DE REVERSE LINE MOVEMENT (RLM) Y DINERO INTELIGENTE (SHARP MONEY)
// Identifica movimientos institucionales de cuotas y spreads en contra de la tendencia pública de retail.

/**
 * Normaliza y compara líneas de apertura y cierre para detectar RLM.
 * 
 * Reglas de Detección de Reverse Line Movement:
 * 1. Spreads NFL/NCAAF:
 *    - Si un favorito abre en -7.0 o -4.5 y la línea se mueve hacia el underdog (-6.0, -3.5)
 *      pese a que el público apoya al favorito, hay RLM a favor del underdog.
 *    - Si un underdog abre en +7.5 y baja a +6.5 o +6.0, el dinero inteligente tomó los puntos.
 * 2. Totales (Over / Under):
 *    - El 70%+ de los apostadores recreativos apuestan al OVER. Si la línea de total BAJA
 *      (ej. 48.5 -> 46.5 en americano, o 2.5 -> 2.25 en fútbol), hay RLM masivo en el UNDER.
 * 3. Línea de Dinero (Moneyline / 1X2):
 *    - Si la cuota de un rival cae más de un 6.0% (steam) con cuotas en rango competitivo,
 *      indica que los sindicatos profesionales están comprando esa cuota.
 *
 * @param {Object} params
 * @param {string} params.sport - 'futbol', 'mlb', 'nfl', 'ncaaf'
 * @param {Object} params.match - Datos del partido con mercado (market, vegas)
 * @param {string} params.pick - Texto de la selección analizada
 * @param {string} params.pickType - Tipo de selección (Spread, Totales, 1X2, BTTS, etc.)
 * @returns {Object} Diagnóstico de RLM
 */
export function detectReverseLineMovement({
  sport = 'futbol',
  match = {},
  pick = '',
  pickType = '',
  publicData = null
}) {
  const sLower = (sport || '').toLowerCase();
  const mkt = match.market || {};
  const pTypeUpper = (pickType || '').toUpperCase();
  const pickStr = (pick || '').toLowerCase();

  const isNflOrCollege = sLower.includes('nfl') || sLower.includes('ncaaf');
  const isMlb = sLower.includes('mlb') || sLower.includes('beisbol');
  const isSoccer = sLower.includes('futbol') || sLower.includes('soccer');

  const homeName = (match.home?.name || '').toLowerCase();
  const awayName = (match.away?.name || '').toLowerCase();

  const isOverPick = pTypeUpper.includes('OVER') || (pickStr.includes('over') && !pickStr.includes('under'));
  const isUnderPick = pTypeUpper.includes('UNDER') || pickStr.includes('under');
  const isBtts = pTypeUpper.includes('AMBOS ANOTAN') || pTypeUpper.includes('BTTS');
  const isTotalsMarket = isOverPick || isUnderPick || isBtts;

  let isHomeSide = false;
  let isAwaySide = false;
  if (!isTotalsMarket) {
    if (pickStr.includes(homeName) || pTypeUpper.includes('LOCAL') || pickStr.includes('(1x)')) {
      isHomeSide = true;
    } else if (pickStr.includes(awayName) || pTypeUpper.includes('VISITANTE') || pickStr.includes('(x2)')) {
      isAwaySide = true;
    }
  }

  const result = {
    isRlmDetected: false,
    rlmType: null, // 'FAVORABLE', 'TRAMPA_ADVERSA', 'NEUTRAL'
    confidenceBonus: 0, // Puntos porcentuales para reforzar el edge
    isTrapForPick: false, // true si el dinero profesional está en contra de nuestro pick
    isVetoedByMarket: false, // REGLA 4.7: true si se debe cancelar automáticamente el pick
    badgeText: null,
    reason: null
  };

  // 1. ANÁLISIS DE RLM EN MERCADOS DE TOTALES (OVER / UNDER)
  if (isTotalsMarket) {
    const totalOpen = parseFloat(mkt.totalOpen || mkt.openOverUnder || match.vegas?.overUnder);
    const totalClose = parseFloat(mkt.totalClose || mkt.currentOverUnder || match.vegas?.overUnder);
    const totalDelta = parseFloat(mkt.totalDelta) || (totalClose && totalOpen ? (totalClose - totalOpen) : 0);

    // En apuestas deportivas, el público masivo siempre empuja el OVER.
    // Si la línea se desploma (totalDelta <= -1.0 en americano o -0.25 en soccer), es un RLM hacia el UNDER.
    const underRlmThreshold = isNflOrCollege ? -1.0 : -0.25;
    const overRlmThreshold = isNflOrCollege ? 1.0 : 0.25;

    if (totalDelta <= underRlmThreshold) {
      result.isRlmDetected = true;
      if (isUnderPick) {
        result.rlmType = 'FAVORABLE';
        if (publicData && publicData.total_under_public) {
          const uTickets = parseFloat(publicData.total_under_public);
          const uMoney = parseFloat(publicData.total_under_money) || uTickets;
          if (uTickets < 45 && uMoney > 55) {
            result.confidenceBonus = isNflOrCollege ? 4.5 : 3.5;
            result.badgeText = '💎 RLM VERDADERO (UNDER VERIFICADO)';
            result.reason = `Línea tumbada ${Math.abs(totalDelta).toFixed(1)} pts. El público apoya el Over (${(100-uTickets).toFixed(0)}%), pero el dinero fuerte (${uMoney}%) está con el Under.`;
          } else {
            result.confidenceBonus = isNflOrCollege ? 2.5 : 1.5;
            result.badgeText = '🚨 SHARP STEAM (UNDER)';
            result.reason = `Línea tumbada ${Math.abs(totalDelta).toFixed(1)} pts, pero el público también apoya el Under (${uTickets}%). Steam puro, no RLM genuino.`;
          }
        } else {
          result.confidenceBonus = isNflOrCollege ? 3.5 : 2.5;
          result.badgeText = '🚨 RLM CONFIRMADO (UNDER INSTITUCIONAL)';
          result.reason = `El público masivo suele respaldar el Over, pero el dinero profesional tumbó la línea ${Math.abs(totalDelta).toFixed(1)} pts (${totalOpen} -> ${totalClose}), confirmando valor en el Under.`;
        }
      } else {
        result.rlmType = 'TRAMPA_ADVERSA';
        result.isTrapForPick = true;
        result.confidenceBonus = -4.0;
        result.badgeText = '⚠️ ALERTA TRAMPA RLM (LÍNEA EN CAÍDA)';
        result.reason = `Trampa de Over público: el dinero institucional desplomó la línea de ${totalOpen} a ${totalClose} (${totalDelta.toFixed(1)} pts), jugando directamente contra nuestro pronóstico.`;
      }
      return result;
    } else if (totalDelta >= overRlmThreshold && isOverPick) {
      result.isRlmDetected = true;
      result.rlmType = 'FAVORABLE';
      result.confidenceBonus = 2.0;
      result.badgeText = '🔥 STEAM INSTITUCIONAL EN OVER';
      result.reason = `Línea de total inflada +${totalDelta.toFixed(1)} pts por fuerte entrada de capital profesional (${totalOpen} -> ${totalClose}).`;
      return result;
    }
  }

  // 2. ANÁLISIS DE RLM EN SPREADS (NFL / NCAAF)
  if (isNflOrCollege && !isTotalsMarket) {
    const spreadOpen = parseFloat(mkt.spreadOpen !== undefined ? mkt.spreadOpen : (match.vegas?.spread !== undefined ? match.vegas.spread : -3.5));
    const spreadClose = parseFloat(mkt.spreadClose !== undefined ? mkt.spreadClose : (match.vegas?.spread !== undefined ? match.vegas.spread : -3.5));
    const spreadDeltaHome = parseFloat(mkt.spreadDeltaHome) || (spreadClose - spreadOpen);

    // spreadDeltaHome < 0 significa que la línea se movió A FAVOR del local (ej. -2.5 a -4.0)
    // spreadDeltaHome > 0 significa que la línea se movió A FAVOR del visitante (ej. +3.5 a +1.5 o local de -6.5 a -5.0)
    if (Math.abs(spreadDeltaHome) >= 1.0) {
      result.isRlmDetected = true;
      const favoredSide = spreadDeltaHome < 0 ? 'home' : 'away';
      const favoredTeamName = favoredSide === 'home' ? match.home?.name : match.away?.name;

      if ((isHomeSide && favoredSide === 'home') || (isAwaySide && favoredSide === 'away')) {
        result.rlmType = 'FAVORABLE';
        if (publicData && publicData[`spread_${favoredSide}_public`]) {
          const tickets = parseFloat(publicData[`spread_${favoredSide}_public`]);
          const money = parseFloat(publicData[`spread_${favoredSide}_money`]) || tickets;
          if (tickets < 45 && money > 55) {
            result.confidenceBonus = 5.0;
            result.badgeText = '💎 RLM VERDADERO (SPREAD VERIFICADO)';
            result.reason = `Línea de spread movida ${Math.abs(spreadDeltaHome).toFixed(1)} pts a favor de ${favoredTeamName}. El público apoya al rival (${(100-tickets).toFixed(0)}%) pero el dinero fuerte (${money}%) está de nuestro lado.`;
          } else {
            result.confidenceBonus = 2.5;
            result.badgeText = '🚨 SHARP STEAM (SPREAD)';
            result.reason = `Línea de spread movida ${Math.abs(spreadDeltaHome).toFixed(1)} pts a favor de ${favoredTeamName}, pero el público también apoya (${tickets}%). Steam puro, no RLM genuino.`;
          }
        } else {
          result.confidenceBonus = 3.5;
          result.badgeText = '🚨 RLM CONFIRMADO (DINERO SINDICATO)';
          result.reason = `Línea de spread movida ${Math.abs(spreadDeltaHome).toFixed(1)} pts a favor de ${favoredTeamName} contra el flujo general de retail.`;
        }
      } else {
        result.rlmType = 'TRAMPA_ADVERSA';
        result.isTrapForPick = true;
        result.confidenceBonus = -4.5;
        result.badgeText = '⚠️ ADVERTENCIA TRAMPA SPREAD (RLM RIVAL)';
        result.reason = `El dinero institucional de Las Vegas movió la línea ${Math.abs(spreadDeltaHome).toFixed(1)} pts en contra de nuestro lado para respaldar a ${favoredTeamName}.`;
      }
      return result;
    }
  }

  // 3. ANÁLISIS DE RLM EN CUOTAS DE MONEYLINE / 1X2 (MLB, FÚTBOL)
  const homeDropPct = parseFloat(mkt.homeDropPct) || 0;
  const awayDropPct = parseFloat(mkt.awayDropPct) || 0;

  const hOpen = parseFloat(mkt.openHome || match.home?.openOdds || 0);
  const hClose = parseFloat(mkt.homeOdds || match.home?.odds || 0);
  const aOpen = parseFloat(mkt.openAway || match.away?.openOdds || 0);
  const aClose = parseFloat(mkt.awayOdds || match.away?.odds || 0);

  const homeRisePct = parseFloat(mkt.homeRisePct) || (hOpen > 0 && hClose > hOpen ? Number((((hClose / hOpen) - 1) * 100).toFixed(1)) : 0);
  const awayRisePct = parseFloat(mkt.awayRisePct) || (aOpen > 0 && aClose > aOpen ? Number((((aClose / aOpen) - 1) * 100).toFixed(1)) : 0);

  // FILTRO SHARP BOOKMAKER: El Drift (subida de cuota) SÓLO se penaliza si proviene de
  // casas de apuestas institucionales ('pinnacle', 'circa', 'betcris').
  // Se ignora el movimiento puramente recreacional o margen inflado de casas de retail.
  const bookmakerStr = (mkt.bookmaker || mkt.bookie || mkt.provider || match.bookmaker || 'Pinnacle').toLowerCase();
  const isSharpBookie = bookmakerStr.includes('pinnacle') || 
                        bookmakerStr.includes('circa') || 
                        bookmakerStr.includes('betcris') || 
                        mkt.isSharpBookmaker === true;

  // REGLA 4.7: FILTRO DE VETO (MICROESTRUCTURA DE MERCADO SHARP)
  // Si el modelo dice "Apostar Local", pero la cuota en un Sharp Bookie subió (>= 3.5%)
  // o el mercado institucional está comprando al Visitante (awayDropPct >= 5.0%), EL PICK SE CANCELA AUTOMÁTICAMENTE.
  if (isHomeSide) {
    if (homeRisePct >= 3.5 && isSharpBookie) {
      result.isRlmDetected = true;
      result.rlmType = 'TRAMPA_ADVERSA';
      result.isTrapForPick = true;
      result.isVetoedByMarket = true;
      result.confidenceBonus = -10.0;
      result.badgeText = `⛔ VETO SHARP DRIFT (${bookmakerStr.toUpperCase()})`;
      result.reason = `Veto Regla 4.7: La cuota en ${bookmakerStr.toUpperCase()} subió de ${hOpen ? hOpen.toFixed(2) : 'apertura'} a ${hClose.toFixed(2)} (+${homeRisePct.toFixed(1)}%). El dinero profesional apuesta en contra del Local; pick cancelado.`;
      return result;
    }
    if (awayDropPct >= 5.0) {
      result.isRlmDetected = true;
      result.rlmType = 'TRAMPA_ADVERSA';
      result.isTrapForPick = true;
      result.isVetoedByMarket = true;
      result.confidenceBonus = -10.0;
      result.badgeText = '⛔ VETO MICROESTRUCTURA (STEAM EN RIVAL)';
      result.reason = `Veto Regla 4.7: Fuerte entrada de capital profesional en el rival ${match.away?.name || 'Visitante'} (cuota cayó -${awayDropPct.toFixed(1)}% desde apertura). Pick cancelado.`;
      return result;
    }
  } else if (isAwaySide) {
    if (awayRisePct >= 3.5 && isSharpBookie) {
      result.isRlmDetected = true;
      result.rlmType = 'TRAMPA_ADVERSA';
      result.isTrapForPick = true;
      result.isVetoedByMarket = true;
      result.confidenceBonus = -10.0;
      result.badgeText = `⛔ VETO SHARP DRIFT (${bookmakerStr.toUpperCase()})`;
      result.reason = `Veto Regla 4.7: La cuota en ${bookmakerStr.toUpperCase()} subió de ${aOpen ? aOpen.toFixed(2) : 'apertura'} a ${aClose.toFixed(2)} (+${awayRisePct.toFixed(1)}%). El dinero profesional apuesta en contra del Visitante; pick cancelado.`;
      return result;
    }
    if (homeDropPct >= 5.0) {
      result.isRlmDetected = true;
      result.rlmType = 'TRAMPA_ADVERSA';
      result.isTrapForPick = true;
      result.isVetoedByMarket = true;
      result.confidenceBonus = -10.0;
      result.badgeText = '⛔ VETO MICROESTRUCTURA (STEAM EN LOCAL)';
      result.reason = `Veto Regla 4.7: Fuerte entrada de capital profesional en el rival local ${match.home?.name || 'Local'} (cuota cayó -${homeDropPct.toFixed(1)}% desde apertura). Pick cancelado.`;
      return result;
    }
  }

  // Detección de caída favorable a nuestro lado (confirmación institucional)
  if (isHomeSide && homeDropPct >= 5.0) {
    result.isRlmDetected = true;
    result.rlmType = 'FAVORABLE';
    if (publicData && publicData.ml_home_public) {
      const tickets = parseFloat(publicData.ml_home_public);
      const money = parseFloat(publicData.ml_home_money) || tickets;
      if (tickets < 45 && money > 55) {
        result.confidenceBonus = 5.0;
        result.badgeText = '💎 RLM VERDADERO (VERIFICADO)';
        result.reason = `Cuota colapsó -${homeDropPct.toFixed(1)}% pese a que el público apoya al rival (${(100-tickets).toFixed(0)}%). El dinero fuerte (${money}%) respaldó a ${match.home?.name}.`;
      } else {
        result.confidenceBonus = 2.0;
        result.badgeText = '🔥 STEAM (FLUJO DE MERCADO)';
        result.reason = `Cuota de ${match.home?.name} colapsó -${homeDropPct.toFixed(1)}% pero el público también la apoya (${tickets}%). Es flujo positivo, pero no RLM puro.`;
      }
    } else {
      result.confidenceBonus = 3.0;
      result.badgeText = '🔥 SHARP STEAM CONFIRMADO';
      result.reason = `Cuota de ${match.home?.name} colapsó -${homeDropPct.toFixed(1)}% desde apertura por absorción de liquidez institucional.`;
    }
    return result;
  } else if (isAwaySide && awayDropPct >= 5.0) {
    result.isRlmDetected = true;
    result.rlmType = 'FAVORABLE';
    if (publicData && publicData.ml_away_public) {
      const tickets = parseFloat(publicData.ml_away_public);
      const money = parseFloat(publicData.ml_away_money) || tickets;
      if (tickets < 45 && money > 55) {
        result.confidenceBonus = 5.0;
        result.badgeText = '💎 RLM VERDADERO (VERIFICADO)';
        result.reason = `Cuota colapsó -${awayDropPct.toFixed(1)}% pese a que el público apoya al rival (${(100-tickets).toFixed(0)}%). El dinero fuerte (${money}%) respaldó a ${match.away?.name}.`;
      } else {
        result.confidenceBonus = 2.0;
        result.badgeText = '🔥 STEAM (FLUJO DE MERCADO)';
        result.reason = `Cuota de ${match.away?.name} colapsó -${awayDropPct.toFixed(1)}% pero el público también la apoya (${tickets}%). Es flujo positivo, pero no RLM puro.`;
      }
    } else {
      result.confidenceBonus = 3.0;
      result.badgeText = '🔥 SHARP STEAM CONFIRMADO';
      result.reason = `Cuota de ${match.away?.name} colapsó -${awayDropPct.toFixed(1)}% desde apertura por absorción de liquidez institucional.`;
    }
    return result;
  }

  return result;
}

/**
 * REGLA 4.7: Evalúa si un pick debe ser vetado automáticamente por microestructura de mercado
 * @param {Object} params - { match, sport, pick, pickType }
 * @returns {{ isVetoed: boolean, reason: string|null, badgeText: string|null }}
 */
export function evaluateMarketMicrostructureVeto({ match = {}, sport = 'futbol', pick = '', pickType = '' }) {
  const rlm = detectReverseLineMovement({ sport, match, pick, pickType });
  if (rlm.isVetoedByMarket || (rlm.isTrapForPick && rlm.rlmType === 'TRAMPA_ADVERSA')) {
    return {
      isVetoed: true,
      reason: rlm.reason,
      badgeText: rlm.badgeText || '⛔ VETO MICROESTRUCTURA DE MERCADO'
    };
  }
  return { isVetoed: false, reason: null, badgeText: null };
}
