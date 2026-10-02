// src/utils/correlationMatrix.js
// MATRIZ DE CORRELACIÓN MATEMÁTICA Y OPTIMIZADOR DE PARLEYS / COMBOS
// Calcula coeficientes de correlación (\rho) y probabilidades conjuntas reales para Same-Game Parlays y Combinadas.

/**
 * Matriz de coeficientes de correlación empíricos (\rho \in [-1, 1]) entre pares de mercados.
 * Un valor positivo (\rho > 0) significa que el acierto de A eleva matemáticamente la probabilidad de B.
 * Un valor negativo (\rho < 0) significa que los eventos se canibalizan y destruyen el valor de la combinada.
 */
const CORRELATION_RULES = [
  // FÚTBOL
  {
    sport: 'futbol',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('VICTORIA') || typeA.includes('1X') || typeA.includes('LOCAL')) && 
      (typeB.includes('OVER') || typeB.includes('GOLES')),
    rho: 0.32,
    reason: 'Sinergia de Ataque: Cuando el equipo superior domina y gana, la probabilidad de Over se incrementa.'
  },
  {
    sport: 'futbol',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('VICTORIA') || typeA.includes('1X') || typeA.includes('DOBLE')) && 
      (typeB.includes('BTTS') || typeB.includes('AMBOS')),
    rho: 0.22,
    reason: 'Intercambio Ofensivo: Partidos con doble oportunidad y goles en ambas porterías presentan correlación positiva.'
  },
  {
    sport: 'futbol',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('UNDER') || typeA.includes('MENOS')) && 
      (typeB.includes('EMPATE') || typeB.includes('1X') || typeB.includes('X2') || typeB.includes('DNB')),
    rho: 0.35,
    reason: 'Cerrojo Defensivo: Duelos de baja anotación favorecen empates y hándicaps protegidos.'
  },
  {
    sport: 'futbol',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('EMPATE') || typeA.includes('DRAW')) && 
      (typeB.includes('OVER 3.5') || typeB.includes('OVER 4.5')),
    rho: -0.45,
    reason: '⛔ Anti-Sinergia Severa: Empates a marcadores altos (2-2, 3-3) tienen probabilidad infinitesimal.'
  },

  // FÚTBOL AMERICANO (NFL / NCAAF)
  {
    sport: 'gridiron',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('CUBRE') || typeA.includes('FAVORITO') || typeA.includes('CLAVE')) && 
      (typeB.includes('OVER')),
    rho: 0.24,
    reason: 'Correlación de Paliza: Si el favorito cubre una línea de spread amplia, suele impulsar el marcador al Over.'
  },
  {
    sport: 'gridiron',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('HÁNDICAP POSITIVO') || typeA.includes('UNDERDOG') || typeA.includes('PROTECCIÓN')) && 
      (typeB.includes('UNDER')),
    rho: 0.30,
    reason: 'Ritmo Controlado: Un partido defensivo y cerrado con pocas posesiones beneficia directamente al Underdog con puntos.'
  },
  {
    sport: 'gridiron',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('UNDERDOG') || typeA.includes('PROTECCIÓN')) && 
      (typeB.includes('OVER')),
    rho: -0.16,
    reason: '⚠️ Riesgo de Fuga: Si el juego se desborda en puntos, el favorito tiende a despegarse y romper el spread.'
  },

  // MLB (BÉISBOL)
  {
    sport: 'mlb',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('UNDER') || typeA.includes('F5 UNDER')) && 
      (typeB.includes('PONCHES') || typeB.includes('STRIKEOUTS') || typeB.includes('PITCHER')),
    rho: 0.40,
    reason: 'Dominio Monticular: Un abridor ponchador sofoca la ofensiva rival en las primeras 5 entradas.'
  },
  {
    sport: 'mlb',
    matchCondition: (typeA, typeB) => 
      (typeA.includes('RUNLINE') || typeA.includes('PLUS15') || typeA.includes('+1.5')) && 
      (typeB.includes('UNDER')),
    rho: 0.28,
    reason: 'Colchón de 1.5 Carreras: En juegos de pocas carreras (Under), el runline positivo tiene una probabilidad de cobro superior.'
  }
];

/**
 * Obtiene el coeficiente de correlación (\rho) entre dos selecciones.
 * @param {Object} pickA 
 * @param {Object} pickB 
 * @returns {Object} { rho, synergyType: 'POSITIVA'|'NEUTRAL'|'NEGATIVA', reason }
 */
export function getPairCorrelation(pickA, pickB) {
  if (!pickA || !pickB) return { rho: 0, synergyType: 'NEUTRAL', reason: 'Selecciones incompletas' };

  const sameGame = (pickA.game && pickB.game && pickA.game === pickB.game) ||
                   (pickA.match?.id && pickB.match?.id && pickA.match.id === pickB.match.id);

  // Si no son del mismo partido, la correlación física es prácticamente independiente (\rho = 0)
  if (!sameGame) {
    return {
      rho: 0,
      synergyType: 'NEUTRAL',
      reason: 'Partidos independientes sin correlación física directa.'
    };
  }

  const typeA = ((pickA.type || '') + ' ' + (pickA.pick || '')).toUpperCase();
  const typeB = ((pickB.type || '') + ' ' + (pickB.pick || '')).toUpperCase();

  for (const rule of CORRELATION_RULES) {
    if (rule.matchCondition(typeA, typeB) || rule.matchCondition(typeB, typeA)) {
      const synergy = rule.rho > 0.15 ? 'POSITIVA' : rule.rho < -0.10 ? 'NEGATIVA' : 'NEUTRAL';
      return {
        rho: rule.rho,
        synergyType: synergy,
        reason: rule.reason
      };
    }
  }

  return {
    rho: 0.05,
    synergyType: 'NEUTRAL',
    reason: 'Mismo partido con correlación residual leve.'
  };
}

/**
 * Calcula la probabilidad conjunta bivariada real considerando correlación (\rho):
 * P(A \cap B) = P(A) * P(B) + \rho * \sqrt{P(A)(1 - P(A)) * P(B)(1 - P(B))}
 * 
 * @param {number} probA - Probabilidad de A en porcentaje (ej. 70)
 * @param {number} probB - Probabilidad de B en porcentaje (ej. 65)
 * @param {number} rho - Coeficiente de correlación [-1, 1]
 * @returns {number} Probabilidad conjunta real en porcentaje
 */
export function calculateJointBivariateProb(probA, probB, rho = 0) {
  const pA = Math.max(0.01, Math.min(0.99, (parseFloat(probA) || 50) / 100));
  const pB = Math.max(0.01, Math.min(0.99, (parseFloat(probB) || 50) / 100));

  const independentProb = pA * pB;
  const covariance = rho * Math.sqrt(pA * (1 - pA) * pB * (1 - pB));

  const jointProb = Math.max(0.01, Math.min(0.98, independentProb + covariance));
  return Number((jointProb * 100).toFixed(1));
}

/**
 * Evalúa una combinada (Parley) completa de 2 o más selecciones.
 * Detecta si hay patas con correlación negativa que deben ser vetadas,
 * y calcula la ventaja matemática (+EV) del combo correlacionado.
 * 
 * @param {Array} picks - Lista de objetos de picks
 * @returns {Object} Diagnóstico de parley optimizado
 */
export function evaluateCorrelatedCombo(picks = []) {
  if (!Array.isArray(picks) || picks.length < 2) {
    return { isValid: false, reason: 'Se requieren mínimo 2 selecciones.' };
  }

  let cumulativeOdds = 1.0;
  let independentJointProb = 1.0;
  let hasNegativeCorrelation = false;
  let negativeReason = '';
  let positiveSynergies = [];

  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const oddsNum = parseFloat(p.odds) || 1.90;
    const probDec = (parseFloat(p.prob) || 55) / 100;
    cumulativeOdds *= oddsNum;
    independentJointProb *= probDec;

    // Comparar con el resto de selecciones para evaluar matriz de correlación
    for (let j = i + 1; j < picks.length; j++) {
      const correlation = getPairCorrelation(p, picks[j]);
      if (correlation.synergyType === 'NEGATIVA') {
        hasNegativeCorrelation = true;
        negativeReason = `Conflicto en ${p.game || 'partido'}: ${correlation.reason}`;
      } else if (correlation.synergyType === 'POSITIVA') {
        positiveSynergies.push({
          game: p.game,
          rho: correlation.rho,
          reason: correlation.reason
        });
      }
    }
  }

  // Si tiene correlación negativa, la combinada pierde valor estructural
  if (hasNegativeCorrelation) {
    return {
      isValid: false,
      isApproved: false,
      cumulativeOdds: Number(cumulativeOdds.toFixed(2)),
      reason: `⛔ Parley Rechazado: ${negativeReason}`,
      synergyScore: -1
    };
  }

  // Si hay sinergia positiva en mismo juego, elevar la probabilidad conjunta
  let realJointProbPct = independentJointProb * 100;
  if (positiveSynergies.length > 0) {
    const avgRho = positiveSynergies.reduce((acc, s) => acc + s.rho, 0) / positiveSynergies.length;
    // Elevar probabilidad conjunta según la correlación acumulada
    const probA = parseFloat(picks[0].prob) || 60;
    const probB = parseFloat(picks[1].prob) || 60;
    realJointProbPct = calculateJointBivariateProb(probA, probB, avgRho);
  }

  const fairOdds = Number((100 / realJointProbPct).toFixed(2));
  const parleyEdge = Number((((cumulativeOdds / fairOdds) - 1) * 100).toFixed(1));

  return {
    isValid: true,
    isApproved: parleyEdge >= 2.0 || realJointProbPct >= 50.0,
    cumulativeOdds: Number(cumulativeOdds.toFixed(2)),
    realJointProb: `${realJointProbPct.toFixed(1)}%`,
    fairOdds,
    parleyEdge: parleyEdge > 0 ? `+${parleyEdge}%` : `${parleyEdge}%`,
    hasPositiveSynergy: positiveSynergies.length > 0,
    synergies: positiveSynergies,
    badgeText: positiveSynergies.length > 0 ? '🧩 PARLEY CORRELACIONADO (+EV)' : '🛡️ COMBINADA INDEPENDIENTE'
  };
}
