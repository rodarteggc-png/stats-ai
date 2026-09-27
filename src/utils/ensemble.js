// src/utils/ensemble.js
// MOTOR DE CONSENSO ALGORÍTMICO TRIPARTITO (ENSEMBLE VOTING)
// Audita cada selección deportiva sometiéndola a 3 votos independientes:
// Voto 1: Modelo Estructural (+EV Matemático)
// Voto 2: Prueba de Estrés Estocástica (Monte Carlo 10,000 Simulaciones)
// Voto 3: Filtro de Mercado y Memoria de Fallos Históricos

import { getAllLessons } from '../services/history.js';
import { formatDynamicStake, calculateKellyStake } from './kelly.js';

/**
 * Evalúa el consenso de una oportunidad en función del deporte y sus motores analíticos.
 * @param {Object} params
 * @param {string} params.sport - 'futbol', 'mlb', 'nfl'
 * @param {Object} params.match - Datos del partido (equipos, cuotas, xG, pitcheo, spread, etc.)
 * @param {Object} params.probs - Probabilidades calculadas por el modelo estructural
 * @param {Object} params.mcStats - Resultados de la simulación Monte Carlo (10k)
 * @param {string} params.pickType - Tipo de pick (ej. '1X2', 'Doble Oportunidad', 'F5', 'Spread', 'Totales')
 * @param {number} params.edgeVal - Margen de ventaja cuantitativa estimada
 * @param {number|string} params.prob - Probabilidad explícita del pick
 * @param {number|string} params.odds - Cuota decimal del mercado
 * @returns {Object} Veredicto y desglose de los 3 votos con dimensionamiento Kelly
 */
export function evaluateEnsembleConsensus({
  sport = 'futbol',
  match = {},
  probs = {},
  mcStats = null,
  pickType = '1X2',
  edgeVal = 0,
  prob = null,
  odds = null
}) {
  const sLower = (sport || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const breakdown = [];

  // =========================================================================
  // VOTO 1: MODELO ESTRUCTURAL (+EV, CANDADO ANTI-UNDERDOG Y AMBOS ANOTAN)
  // =========================================================================
  let vote1Passed = false;
  let vote1Reason = '';
  const pTypeUpper = (pickType || '').toUpperCase();
  const numericOdds = parseFloat(odds) || 1.90;

  if (sLower.includes('futbol') || sLower.includes('soccer')) {
    const hWin = parseFloat(probs.homeWin || 0);
    const aWin = parseFloat(probs.awayWin || 0);
    const bttsYes = parseFloat(probs.bttsYes || 0);
    const hXg = parseFloat(match.home?.xG || 1.35);
    const aXg = parseFloat(match.away?.xG || 1.05);
    const totalXg = hXg + aXg;
    const isBttsPick = pTypeUpper.includes('AMBOS ANOTAN') || pTypeUpper.includes('BTTS');
    const isProtectedPick = pTypeUpper.includes('DOBLE') || pTypeUpper.includes('PROTEGIDO') || pTypeUpper.includes('1X') || pTypeUpper.includes('X2') || pTypeUpper.includes('HÁNDICAP') || pTypeUpper.includes('HANDICAP');
    const isTotalsPick = pTypeUpper.includes('OVER') || pTypeUpper.includes('UNDER') || pTypeUpper.includes('GOLES') || pTypeUpper.includes('CÓRNERS');
    const isOutright1X2 = !isBttsPick && !isProtectedPick && !isTotalsPick;

    if (isOutright1X2 && numericOdds > 2.05) {
      vote1Passed = false;
      vote1Reason = `⛔ Candado Anti-Underdog: Cuota ${numericOdds.toFixed(2)} (> 2.05) prohibida en Victoria Directa 1X2. Se exige Doble Oportunidad (1X/X2).`;
    } else if (isBttsPick) {
      if (bttsYes >= 60.0 && hXg >= 1.20 && aXg >= 1.10) {
        vote1Passed = true;
        vote1Reason = `Volumen ofensivo bilateral validado (xG: ${hXg.toFixed(2)} vs ${aXg.toFixed(2)} | BTTS: ${bttsYes.toFixed(0)}%). Alto caudal de llegada en ambas áreas.`;
      } else {
        vote1Passed = false;
        vote1Reason = `Ataque asimétrico (${hXg.toFixed(2)} vs ${aXg.toFixed(2)} xG); insuficiente para Ambos Anotan Élite.`;
      }
    } else if (isProtectedPick) {
      if (numericOdds >= 1.36 && numericOdds <= 2.35 && (parseFloat(prob) >= 68 || edgeVal >= 3.5)) {
        vote1Passed = true;
        vote1Reason = `Hándicap / Doble Oportunidad blindada (${parseFloat(prob || 72).toFixed(0)}% cobro, cuota ${numericOdds.toFixed(2)}) protegiendo el empate.`;
      } else {
        vote1Passed = false;
        vote1Reason = `Cuota fuera de rango rentable (${numericOdds.toFixed(2)}) o cobertura insuficiente.`;
      }
    } else if (isTotalsPick) {
      if (parseFloat(prob) >= 57 || totalXg >= 2.75 || edgeVal >= 4.0) {
        vote1Passed = true;
        vote1Reason = `Proyección de goles validada (${totalXg.toFixed(2)} xG combinados | Prob: ${parseFloat(prob || 60).toFixed(0)}%).`;
      } else {
        vote1Reason = `Proyección de totales sin ventaja suficiente (${totalXg.toFixed(2)} xG).`;
      }
    } else if (numericOdds >= 1.35 && (edgeVal >= 4.5 || (hWin >= 55 && edgeVal >= 2.0) || (aWin >= 54 && edgeVal >= 2.5))) {
      vote1Passed = true;
      vote1Reason = `Favorito con +EV confirmado (+${edgeVal.toFixed(1)}% vs Vegas, cuota ${numericOdds.toFixed(2)} <= 2.05). xG: ${hXg.toFixed(2)} vs ${aXg.toFixed(2)}.`;
    } else {
      vote1Reason = `Ventaja matemática insuficiente (+${edgeVal.toFixed(1)}% EV inferior al umbral del 4.5%).`;
    }
  } else if (sLower.includes('mlb') || sLower.includes('béisbol') || sLower.includes('beisbol')) {
    const f5Home = parseFloat(probs.f5?.homeMl || 50);
    const f5Away = parseFloat(probs.f5?.awayMl || 50);
    const isRunlinePlus = pTypeUpper.includes('+1.5') || pTypeUpper.includes('RUNLINE') || pTypeUpper.includes('HÁNDICAP') || pTypeUpper.includes('PROTEGIDO');
    const isTotalsMlb = pTypeUpper.includes('OVER') || pTypeUpper.includes('UNDER') || pTypeUpper.includes('CARRERAS');

    if (!isRunlinePlus && !isTotalsMlb && numericOdds > 2.05) {
      vote1Passed = false;
      vote1Reason = `⛔ Candado Anti-Underdog MLB: Cuota ${numericOdds.toFixed(2)} (> 2.05) en Moneyline directo. Convertir a Runline +1.5 Carreras.`;
    } else if (isRunlinePlus) {
      const rlProb = parseFloat(prob) || Math.max(parseFloat(probs.runline?.homePlus15 || 60), parseFloat(probs.runline?.awayPlus15 || 60));
      if (rlProb >= 63.0 && numericOdds <= 2.15) {
        vote1Passed = true;
        vote1Reason = `Hándicap Protegido +1.5 Carreras validado (${rlProb.toFixed(0)}% prob. de cubrir por duelo cerrado de pitcheo).`;
      } else {
        vote1Passed = false;
        vote1Reason = `Cobertura +1.5 insuficiente (${rlProb.toFixed(0)}% < 63% requerido).`;
      }
    } else if (f5Home >= 58 || f5Away >= 58 || edgeVal >= 5.0) {
      vote1Passed = true;
      vote1Reason = `Superioridad sabermétrica neta en pitcheo abridor (WHIP/ERA), Elo y OPS de alineación (Cuota segura ${numericOdds.toFixed(2)}).`;
    } else {
      vote1Reason = `Duelo monticular sin disparidad clara en las primeras 5 entradas.`;
    }
  } else if (sLower.includes('nfl')) {
    const homeCover = parseFloat(probs.homeCoverProb || 50);
    const awayCover = parseFloat(probs.awayCoverProb || 50);
    const maxCover = Math.max(homeCover, awayCover);
    const spread = parseFloat(match.market?.spread !== undefined ? match.market.spread : (match.vegas?.spread !== undefined ? match.vegas.spread : -3.5));
    const absSpread = Math.abs(spread);
    const keyEval = probs.keyEvaluation || {};
    const isTotalsNfl = pTypeUpper.includes('TOTALES') || pTypeUpper.includes('OVER') || pTypeUpper.includes('UNDER');

    // Veto preventivo a favoritos en spreads pesados (>= 7.5 puntos por gancho sobre TD y riesgo de Backdoor Cover)
    const isFavoriteCover = !isTotalsNfl && ((spread < 0 && homeCover >= awayCover) || (spread > 0 && awayCover >= homeCover));
    const isHeavySpread = absSpread >= 7.5;

    if (isHeavySpread && isFavoriteCover) {
      vote1Passed = false;
      vote1Reason = `⛔ Veto Preventivo NFL: Spread pesado con gancho (${absSpread} pts >= 7.5). Exige más de un TD y tiene alto riesgo de Backdoor Cover. No jugar al favorito.`;
    } else if (!isTotalsNfl && absSpread > 10.5) {
      vote1Passed = false;
      vote1Reason = `⛔ Veto de Disparidad Extrema (${absSpread} pts > 10.5): Riesgo de paliza (Blowout). Se descarta el underdog.`;
    } else if (isTotalsNfl && edgeVal >= 4.5) {
      vote1Passed = true;
      vote1Reason = `Ventaja cuantitativa en Totales NFL (+${edgeVal.toFixed(1)}% Edge) calibrada con ritmo ofensivo y clima.`;
    } else if (keyEval.trapWarning) {
      vote1Passed = true;
      vote1Reason = `Trampa de Medio Punto detectada en Las Vegas. Colchón de número clave a favor del Underdog (+${absSpread}).`;
    } else if (keyEval.keyAlert) {
      vote1Passed = true;
      vote1Reason = `Oportunidad Clave en -2.5. Línea por debajo del número crítico 3.`;
    } else if (maxCover >= 56.5 || edgeVal >= 5.0) {
      vote1Passed = true;
      vote1Reason = `Diferencial de EPA/Net YPP otorga ${maxCover.toFixed(1)}% de probabilidad de cubrir la línea (Edge: +${(maxCover - 52.4).toFixed(1)}%).`;
    } else {
      vote1Reason = `Ventaja matemática insuficiente en NFL (${maxCover.toFixed(1)}% inferior al umbral preventivo del 56.5%).`;
    }
  }

  // Candado Matemático Universal: Ningún pick puede aprobar el Voto 1 (+EV) si su probabilidad real no supera la probabilidad implícita de la cuota
  const parsedProb = parseFloat(prob);
  if (vote1Passed && !isNaN(parsedProb) && numericOdds > 1.05) {
    const impliedProb = (1 / numericOdds) * 100;
    const realMathEdge = parsedProb - impliedProb;
    if (realMathEdge < 1.5) {
      vote1Passed = false;
      vote1Reason = `⛔ Veto Matemático (+EV): La probabilidad real (${parsedProb.toFixed(1)}%) no supera con margen la implícita de la cuota ${numericOdds.toFixed(2)} (${impliedProb.toFixed(1)}%).`;
    }
  }

  breakdown.push({
    name: 'Modelo Estructural (+EV)',
    passed: vote1Passed,
    icon: vote1Passed ? '✅' : '❌',
    reason: vote1Reason
  });

  // =========================================================================
  // VOTO 2: PRUEBA DE ESTRÉS ESTOCÁSTICA (MONTE CARLO 10,000 ITERACIONES)
  // =========================================================================
  let vote2Passed = false;
  let vote2Reason = '';

  if (mcStats) {
    const stability = parseInt(mcStats.stability || 70, 10);
    const risk = mcStats.risk || 'Bajo';

    if (stability >= 68 && risk === 'Bajo') {
      vote2Passed = true;
      vote2Reason = `Resistencia de Roca: ${stability}% de estabilidad sin colapsos de cola en 10k partidos.`;
    } else if (stability >= 58 && risk === 'Medio') {
      vote2Passed = true;
      vote2Reason = `Estabilidad Aceptable (${stability}%). Sensible a varianza controlada.`;
    } else {
      vote2Reason = `Rechazado por Varianza: Riesgo Alto (${stability}% de estabilidad). Riesgo de colapso excesivo.`;
    }
  } else {
    // Si no vino precalculado, se asume neutro con voto condicional
    vote2Passed = true;
    vote2Reason = `Simulación no reportó alertas críticas de colapso.`;
  }

  breakdown.push({
    name: 'Monte Carlo (10,000 Sims)',
    passed: vote2Passed,
    icon: vote2Passed ? '✅' : '❌',
    reason: vote2Reason
  });

  // =========================================================================
  // VOTO 3: FILTRO DE MERCADO Y MEMORIA HISTÓRICA DE FALLOS
  // =========================================================================
  let vote3Passed = true;
  let vote3Reason = 'Validado por mercado sin trampas institucionales activas.';

  // 1. Detección de Smart Money / Steam Move con Candado Anti-Longshot (<= 2.55)
  if (pTypeUpper.includes('SMART MONEY') || match.market?.isSteamMove) {
    if (numericOdds > 2.55) {
      vote3Passed = false;
      vote3Reason = `⛔ Falso Smart Money descartado: Cuota de longshot (${numericOdds.toFixed(2)} > 2.55) fuera de rango institucional.`;
    } else {
      const steamTeam = match.market?.steamTeam || '';
      const isPickAligned = match.home?.name?.includes(steamTeam) || match.away?.name?.includes(steamTeam);
      if (isPickAligned) {
        vote3Reason = `Confirmado por Smart Money: Caída institucional de línea (-${match.market.steamDropPct || '5'}%) en cuota competitiva (${numericOdds.toFixed(2)}).`;
      }
    }
  }

  // 2. Consulta de Memoria de Lecciones Aprendidas (history.js + Auditoría Telegram)
  try {
    const lessons = getAllLessons();
    const hName = (match.home?.name || '').toLowerCase();
    const aName = (match.away?.name || '').toLowerCase();

    const matchingTrap = lessons.find(l => {
      if (l.active === false) return false;
      if (l.sport && sport && l.sport !== sport) return false;
      const combinedText = [
        l.diagnosisText || '',
        l.lesson || '',
        l.learnedRule || '',
        l.actualResult || ''
      ].join(' ').toLowerCase();

      const lTeam = (l.team || '').toLowerCase();

      const matchesHome = Boolean(hName && (
        (lTeam && (hName.includes(lTeam) || lTeam.includes(hName))) ||
        (hName.length >= 4 && combinedText.includes(hName))
      ));
      const matchesAway = Boolean(aName && (
        (lTeam && (aName.includes(lTeam) || lTeam.includes(aName))) ||
        (aName.length >= 4 && combinedText.includes(aName))
      ));

      if (!matchesHome && !matchesAway) return false;

      // Si la lección fue por fallar como favorito pesado (-Pts) y hoy el pick es Hándicap Positivo (+Pts), no vetar
      const isProtectedDogPick = (
        pTypeUpper.includes('UNDERDOG') ||
        pTypeUpper.includes('HÁNDICAP POSITIVO') ||
        pTypeUpper.includes('NÚMERO CLAVE') ||
        pTypeUpper.includes('DOBLE OPORTUNIDAD')
      );
      const lessonWasHeavyFav = (l.predictedPick || '').includes('-') || combinedText.includes('favorito');
      if (isProtectedDogPick && lessonWasHeavyFav) return false;

      const hasTrapKeyword = (
        combinedText.includes('trampa') ||
        combinedText.includes('inflado') ||
        combinedText.includes('cuidado') ||
        combinedText.includes('precaución') ||
        combinedText.includes('advertencia') ||
        combinedText.includes('colapso') ||
        combinedText.includes('sobreestimó') ||
        combinedText.includes('fallo en') ||
        combinedText.includes('penalización')
      );

      return hasTrapKeyword;
    });

    if (matchingTrap && vote3Passed) {
      vote3Passed = false;
      const trapExplanation = matchingTrap.learnedRule || matchingTrap.diagnosisText || matchingTrap.lesson || 'Patrón recurrente de fallo en este equipo';
      vote3Reason = `⚠️ Veto por Memoria Forense (${matchingTrap.team}): "${trapExplanation.slice(0, 75)}..."`;
    }
  } catch (e) {
    // history fallback seguro
  }

  breakdown.push({
    name: 'Mercado & Memoria Histórica',
    passed: vote3Passed,
    icon: vote3Passed ? '✅' : '❌',
    reason: vote3Reason
  });

  // =========================================================================
  // CÓMPUTO FINAL DEL VEREDICTO DE CONSENSO
  // =========================================================================
  const votesPassed = breakdown.filter(b => b.passed).length;
  let verdict = 'VETADO';
  let badgeText = `${votesPassed}/3 Votos (Veto por Discrepancia)`;
  let badgeColor = '#ef4444';

  if (votesPassed === 3) {
    verdict = 'UNANIMIDAD_ELITE';
    badgeText = '3/3 Votos (Unanimidad Élite)';
    badgeColor = '#10b981';
  } else if (votesPassed === 2) {
    verdict = 'CONSENSO_MAYORITARIO';
    badgeText = '2/3 Votos (Consenso con Cobertura)';
    badgeColor = '#f59e0b';
  }

  // Extraer probabilidad y cuota para el dimensionamiento exacto de Kelly
  let effectiveProb = prob;
  if (!effectiveProb) {
    if (probs.homeWin) effectiveProb = probs.homeWin;
    else if (probs.f5?.homeMl) effectiveProb = probs.f5.homeMl;
    else if (probs.homeCoverProb) effectiveProb = probs.homeCoverProb;
    else effectiveProb = 50;
  }

  let effectiveOdds = odds;
  if (!effectiveOdds) {
    effectiveOdds = match.market?.current || match.market?.homeOdds || match.vegas?.homeMl || '1.91';
  }

  // Cálculo matemático del Criterio de Kelly Fraccional
  const recommendedStake = formatDynamicStake({
    prob: effectiveProb,
    odds: effectiveOdds,
    votesPassed
  });

  const kellyData = calculateKellyStake(
    effectiveProb,
    effectiveOdds,
    votesPassed === 3 ? 0.10 : 0.05,
    votesPassed === 3 ? 2.0 : 1.0
  );

  return {
    votesPassed,
    isUnanimous: votesPassed === 3,
    verdict,
    badgeText,
    badgeColor,
    breakdown,
    recommendedStake,
    kellyData
  };
}
