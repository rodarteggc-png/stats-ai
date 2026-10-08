// src/utils/tipsterAuditor.js
/**
 * MOTOR DE INTELIGENCIA CUALITATIVA Y BIG DATA — "TIPSTER PRO AUDITOR"
 * 
 * Actúa como una capa superior de juicio analítico humano-asistido por IA.
 * Evalúa cada selección que superó el Tribunal Matemático (Poisson / Sabermetría / Monte Carlo / RLM)
 * cruzándola contra 4 factores de contexto que los números fríos no ven:
 * 
 * 1. Fatiga Logística y Calendario (Rest & Travel Disadvantage)
 * 2. Motivación Asimétrica y Urgencia de Puntos (Match Leverage)
 * 3. Micro-Clima Táctico en Vivo (Viento, Temperatura y Lluvia)
 * 4. Concentración de Riesgo y Trampas de Vestidor
 */

/**
 * Evalúa la ventaja o desventaja de descanso entre dos contendientes.
 * @param {Object} match - Objeto con datos de local y visitante
 * @param {string} sport - 'futbol', 'mlb', 'nfl', 'ncaaf'
 * @returns {{ penaltyScore: number, trapWarning: string|null, restBadge: string|null }}
 */
export function evaluateRestAndTravel(match = {}, sport = 'futbol') {
  const sLower = (sport || '').toLowerCase();
  const homeRest = match.home?.daysRest !== undefined ? parseInt(match.home.daysRest, 10) : 4;
  const awayRest = match.away?.daysRest !== undefined ? parseInt(match.away.daysRest, 10) : 4;

  let penaltyScore = 0;
  let trapWarning = null;
  let restBadge = null;

  // 1. Fútbol Americano (NFL / NCAAF): Semana Corta (Sunday to Thursday)
  if (sLower.includes('nfl') || sLower.includes('ncaaf')) {
    // Si un equipo juega con 4 o menos días de descanso (semana corta de Jueves)
    if (homeRest <= 4 && awayRest >= 6) {
      penaltyScore += 4.5;
      trapWarning = `Semana Corta Crítica: ${match.home?.name || 'Local'} jugó hace 4 días; ${match.away?.name || 'Visitante'} llega con ${awayRest} días de descanso.`;
    } else if (awayRest <= 4 && homeRest >= 6) {
      penaltyScore += 5.5; // Doble castigo si además es visitante
      trapWarning = `Semana Corta + Viaje: ${match.away?.name || 'Visitante'} viaja con solo ${awayRest} días de descanso frente a ${match.home?.name || 'Local'} fresco (${homeRest} días).`;
    } else if (homeRest >= 10 || awayRest >= 10) {
      restBadge = '🔋 Vientas de Bye Week / Descanso Prolongado';
    }
  }

  // 2. Fútbol Soccer: Sobrecarga de Partidos (Champions, Copas, Conmebol)
  if (sLower.includes('futbol') || sLower.includes('soccer')) {
    const restDiff = Math.abs(homeRest - awayRest);
    if (awayRest <= 2 && homeRest >= 5) {
      penaltyScore += 6.0;
      trapWarning = `Trampa de Congestión: ${match.away?.name || 'Visitante'} disputó partido hace 48-72h. Fatiga muscular severa frente al local fresco.`;
    } else if (homeRest <= 2 && awayRest >= 5) {
      penaltyScore += 4.5;
      trapWarning = `Desgaste de Plantilla: ${match.home?.name || 'Local'} viene de jugar entre semana con riesgo de rotación de titulares.`;
    } else if (restDiff >= 4) {
      const favoredTeam = homeRest > awayRest ? match.home?.name : match.away?.name;
      restBadge = `⚡ Ventaja Física de Calendario (+${restDiff} días para ${favoredTeam})`;
    }
  }

  // 3. MLB: Series de Giras Extensas (Road Trip Fatigue)
  if (sLower.includes('mlb') || sLower.includes('beisbol')) {
    const awayDaysAway = match.away?.consecutiveRoadGames || 1;
    if (awayDaysAway >= 6) {
      penaltyScore += 3.5;
      trapWarning = `Fatiga de Gira MLB: ${match.away?.name} disputa su sexto juego consecutivo fuera de casa. Bullpen exigido.`;
    }
  }

  return { penaltyScore, trapWarning, restBadge };
}

/**
 * Evalúa el clima en estadios abiertos y su impacto directo en Totales y Spreads.
 * @param {Object} match - Datos del partido con clima
 * @param {string} sport - Deporte
 * @param {string} pick - Texto del pick
 * @returns {{ isWeatherAdverse: boolean, weatherNote: string|null, bonusEdge: number }}
 */
export function evaluateWeatherTactics(match = {}, sport = 'futbol', pick = '') {
  const sLower = (sport || '').toLowerCase();
  const pickStr = (pick || '').toLowerCase();
  const weather = match.weather || {};
  const windMph = parseFloat(weather.windMph || weather.windSpeed || 0);
  const tempF = parseFloat(weather.tempF || 65);
  const isRain = Boolean(weather.isRain || weather.precipitation);
  const isIndoor = Boolean(match.stadium?.isDome || match.stadium?.isRetractableClosed || weather.isDome);

  if (isIndoor) {
    return { isWeatherAdverse: false, weatherNote: '🏟️ Estadio Techado (Clima Controlado 0% Viento)', bonusEdge: 0 };
  }

  const isOverPick = pickStr.includes('over') || pickStr.includes('más de');
  const isUnderPick = pickStr.includes('under') || pickStr.includes('menos de');

  // 1. Impacto en Totales de NFL / NCAAF
  if (sLower.includes('nfl') || sLower.includes('ncaaf')) {
    if (windMph >= 15) {
      if (isOverPick) {
        return {
          isWeatherAdverse: true,
          weatherNote: `⚠️ Clima Adverso: Viento de ${windMph} mph en campo abierto suprime pases profundos y goles de campo largos. Veto a Over.`,
          bonusEdge: -4.5
        };
      }
      if (isUnderPick) {
        return {
          isWeatherAdverse: false,
          weatherNote: `💨 Ventaja Táctica de Viento (${windMph} mph): Desacelera el juego aéreo rival e infla posesiones terrestres. Respaldo al Under.`,
          bonusEdge: 3.5
        };
      }
    }

    if (tempF <= 25 && isUnderPick) {
      return {
        isWeatherAdverse: false,
        weatherNote: `❄️ Congelador Táctico (${tempF}°F): Balón rígido y temperaturas bajo cero favorecen defensas y consumen el reloj.`,
        bonusEdge: 2.5
      };
    }
  }

  // 2. Impacto en MLB (Viento y Densidad del Aire)
  if (sLower.includes('mlb') || sLower.includes('beisbol')) {
    const windDirection = (weather.windDirection || '').toLowerCase();
    const isBlowingIn = windDirection.includes('in') || windDirection.includes('adentro');
    const isBlowingOut = windDirection.includes('out') || windDirection.includes('afuera');

    if (windMph >= 12 && isBlowingIn) {
      if (isOverPick) {
        return {
          isWeatherAdverse: true,
          weatherNote: `⚠️ Viento en Contra (${windMph} mph hacia home): Frena batazos profundos en los jardines. Peligro para Over de carreras.`,
          bonusEdge: -5.0
        };
      }
      if (isUnderPick) {
        return {
          isWeatherAdverse: false,
          weatherNote: `🌬️ Viento Aliado (${windMph} mph hacia adentro): Suprime cuadrangulares y extrabases. Gran viento para Under.`,
          bonusEdge: 4.0
        };
      }
    }
  }

  return { isWeatherAdverse: false, weatherNote: null, bonusEdge: 0 };
}

/**
 * Evalúa la asimetría de motivación e incentivos en la tabla de posiciones.
 * @param {Object} match - Datos del partido
 * @param {string} pick - Texto del pick
 * @returns {{ isLeverageTrap: boolean, motivationNote: string|null }}
 */
export function evaluateMotivationalLeverage(match = {}, pick = '') {
  const home = match.home || {};
  const away = match.away || {};
  const pickStr = (pick || '').toLowerCase();

  // Detección de rachas colapsadas vs equipos con urgencia extrema
  const homeStreak = (home.streak || '').toUpperCase();
  const awayStreak = (away.streak || '').toUpperCase();

  const isHomePicked = pickStr.includes((home.name || '').toLowerCase());
  const isAwayPicked = pickStr.includes((away.name || '').toLowerCase());

  // Alerta de equipo desmotivado en caída libre
  if (isHomePicked && homeStreak.includes('L5') || homeStreak.includes('L6')) {
    return {
      isLeverageTrap: true,
      motivationNote: `⚠️ Crisis de Confianza: ${home.name} arrastra 5+ derrotas consecutivas. Moral y química comprometidas.`
    };
  }

  if (isAwayPicked && awayStreak.includes('L5') || awayStreak.includes('L6')) {
    return {
      isLeverageTrap: true,
      motivationNote: `⚠️ Crisis de Confianza: ${away.name} arrastra 5+ derrotas consecutivas fuera de casa. Moral comprometida.`
    };
  }

  return { isLeverageTrap: false, motivationNote: null };
}

/**
 * DICTAMEN INTEGRAL DEL TIPSTER PRO
 * Cruza los 4 pilares cualitativos para emitir el veredicto definitivo.
 * 
 * @param {Object} candidate - Selección aprobada matemáticamente
 * @returns {{ isApproved: boolean, grade: string, badgeTitle: string, reason: string, tipsterSeal: string }}
 */
export function auditCandidateAsTipsterPro(candidate = {}) {
  const match = candidate.match || {};
  const sport = candidate.sport || 'Fútbol';
  const pick = candidate.pick || '';
  const odds = parseFloat(candidate.odds || 1.90);
  const probNum = parseFloat(candidate.prob || 60);

  // 1. Auditoría de Descanso y Calendario
  const restEval = evaluateRestAndTravel(match, sport);

  // 2. Auditoría Meteorológica
  const weatherEval = evaluateWeatherTactics(match, sport, pick);

  // 3. Auditoría de Motivación y Confianza
  const motivationEval = evaluateMotivationalLeverage(match, pick);

  // ================= CRITERIO DE VETO CUALITATIVO =================
  // Un Tipster Pro veta si:
  // a) Hay trampa de clima severo contra un Over
  if (weatherEval.isWeatherAdverse) {
    return {
      isApproved: false,
      grade: 'VETO_CUALITATIVO',
      badgeTitle: '⛔ VETO TIPSTER PRO (CLIMA ADVERSO)',
      reason: weatherEval.weatherNote,
      tipsterSeal: '❌ Rechazado por Condiciones Climáticas Hostiles'
    };
  }

  // b) Hay trampa crítica de fatiga en un favorito corto
  if (restEval.penaltyScore >= 5.0 && odds <= 1.70) {
    return {
      isApproved: false,
      grade: 'VETO_CUALITATIVO',
      badgeTitle: '⛔ VETO TIPSTER PRO (TRAMPA DE FATIGA)',
      reason: restEval.trapWarning,
      tipsterSeal: '❌ Rechazado por Desventaja Severa de Descanso'
    };
  }

  // c) Equipo en crisis psicológica de vestidor con 5+ derrotas seguidas
  if (motivationEval.isLeverageTrap && odds <= 1.75) {
    return {
      isApproved: false,
      grade: 'VETO_CUALITATIVO',
      badgeTitle: '⛔ VETO TIPSTER PRO (CRISIS DE VESTIDOR)',
      reason: motivationEval.motivationNote,
      tipsterSeal: '❌ Rechazado por Dinámica Negativa Prolongada'
    };
  }

  // ================= CRITERIO DE GRADUACIÓN DE CONVICCIÓN =================
  let qualityPoints = 0;
  const reasons = [];

  if (candidate.consensus?.votesPassed === 3) qualityPoints += 3;
  if (candidate.consensus?.rlmInfo?.isRlmDetected && candidate.consensus?.rlmInfo?.rlmType === 'FAVORABLE') {
    qualityPoints += 3;
    reasons.push('Dinero profesional institucional ratificado');
  }
  if (weatherEval.bonusEdge > 0) {
    qualityPoints += 2;
    if (weatherEval.weatherNote) reasons.push(weatherEval.weatherNote);
  }
  if (restEval.restBadge) {
    qualityPoints += 1.5;
    reasons.push(restEval.restBadge);
  }
  if (probNum >= 68.0) {
    qualityPoints += 2;
  }

  let grade = 'A';
  let badgeTitle = '🧠 *DICTAMEN TIPSTER PRO:* `Grado A (Alta Convicción)`';
  if (qualityPoints >= 7) {
    grade = 'A+';
    badgeTitle = '💎 *DICTAMEN TIPSTER PRO:* `Grado A+ (Máxima Convicción Élite)`';
  } else if (qualityPoints >= 4) {
    grade = 'A';
    badgeTitle = '🧠 *DICTAMEN TIPSTER PRO:* `Grado A (Ventaja Confirmada)`';
  } else {
    grade = 'B+';
    badgeTitle = '🔍 *DICTAMEN TIPSTER PRO:* `Grado B+ (Valor con Cobertura)`';
  }

  const defaultReason = reasons.length > 0 
    ? reasons.join(' • ')
    : 'Línea blindada sin trampas de fatiga, vestidor alineado y clima táctico favorable.';

  return {
    isApproved: true,
    grade,
    badgeTitle,
    reason: defaultReason,
    tipsterSeal: `✅ Validado por Tipster Pro (${grade})`
  };
}
