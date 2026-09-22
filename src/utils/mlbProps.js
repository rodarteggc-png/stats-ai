// src/utils/mlbProps.js
/**
 * Motor Matemático para Player Props de MLB (Béisbol Profesional)
 * Calcula proyecciones avanzadas calibradas por Park Factors (Estadios) de:
 * 1. Ponches de Lanzadores Abridores (Pitcher Strikeouts - Over/Under)
 * 2. Bases Totales de Bateadores (Total Bases - Over 1.5 TB)
 */

export const MLB_PARK_FACTORS = {
  'Colorado': 1.28, 'Cincinnati': 1.15, 'Boston': 1.12, 
  'Texas': 1.08, 'White Sox': 1.05, 'Kansas City': 1.05,
  'Atlanta': 1.04, 'Philadelphia': 1.03, 'Angels': 1.02,
  'Baltimore': 1.01, 'Toronto': 1.00, 'Houston': 1.00,
  'Minnesota': 0.99, 'Dodgers': 0.99, 'Washington': 0.98,
  'Arizona': 0.98, 'Cubs': 0.97, 'Milwaukee': 0.97,
  'Pittsburgh': 0.96, 'San Diego': 0.95, 'Cleveland': 0.95,
  'Yankees': 0.95, 'Miami': 0.94, 'Detroit': 0.94,
  'Oakland': 0.93, 'Tampa Bay': 0.92, 'Mets': 0.91,
  'St. Louis': 0.90, 'San Francisco': 0.88, 'Seattle': 0.86
};

export function getParkFactor(homeTeamName = "") {
  if (!homeTeamName) return 1.0;
  for (const team in MLB_PARK_FACTORS) {
    if (homeTeamName.includes(team)) return MLB_PARK_FACTORS[team];
  }
  return 1.0;
}

function factorial(n) {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * Calcula la proyección de ponches de un abridor cruzando su ratio K/9 con la tasa de ponches del rival
 * y calibrando por el Park Factor del estadio local.
 * @param {Object} pitcher - { name, k9, whip, era, team }
 * @param {Object} opponentTeam - { name, kRate, ops } (kRate en % ej: 24.5)
 * @param {string} homeTeamName - Nombre del equipo local para determinar el Park Factor
 * @returns {Object} Proyección y recomendación de línea de ponches
 */
export function calculatePitcherKProjection(pitcher, opponentTeam, homeTeamName = "") {
  const k9 = parseFloat(pitcher?.k9) || 8.2;
  const whip = parseFloat(pitcher?.whip) || 1.30;
  const era = parseFloat(pitcher?.era) || 4.10;
  const pf = getParkFactor(homeTeamName);
  
  // Calibración por Park Factor:
  // En parques de bateadores/altura (ej: Colorado 1.28), la curva/slider quiebra menos (-15% K) y se toleran menos IP.
  // En parques marinos de lanzadores (ej: Seattle 0.86, SF 0.88), los pitchers ponchan más (+8% K).
  const parkKModifier = Math.pow(Math.max(0.70, 2.0 - pf), 0.6);

  // Innings proyectados en función del control del lanzador y el factor del estadio
  const stadiumIpPenalty = (pf - 1.0) * 1.5;
  const expectedIP = Math.max(3.8, Math.min(6.5, Number((6.7 - (whip * 1.15) - stadiumIpPenalty).toFixed(1))));

  // Tasa de ponches del rival (promedio de la liga es ~22.5%)
  const oppKRate = parseFloat(opponentTeam?.kRate) || 22.5;
  const oppKRatio = oppKRate / 22.5;

  // Proyección esperada de ponches (Lambda de Poisson calibrada)
  const projectedKs = Number(((k9 / 9) * expectedIP * oppKRatio * parkKModifier).toFixed(1));

  // Determinar la línea de mercado más probable en Las Vegas (ej: 4.5, 5.5, 6.5, 7.5)
  const baseLine = Math.floor(projectedKs);
  const standardLine = baseLine + 0.5;

  // Probabilidades Poisson para la línea estándar
  let underProb = 0;
  for (let k = 0; k <= baseLine; k++) {
    underProb += poisson(projectedKs, k);
  }
  const overProb = 1 - underProb;

  const overPct = Number((overProb * 100).toFixed(1));
  const underPct = Number((underProb * 100).toFixed(1));

  // Determinar si hay mayor valor en Over o en Under
  const isOver = projectedKs >= standardLine;
  const chosenLine = standardLine;
  const winProb = isOver ? overPct : underPct;
  const pickType = isOver ? "MÁS DE (OVER)" : "MENOS DE (UNDER)";
  
  // Margen de valor respecto a una probabilidad neutral del 50%
  const edge = Number((winProb - 52.4).toFixed(1));

  const fairOdds = winProb > 0 ? (100 / winProb).toFixed(2) : "1.90";

  return {
    pitcherName: pitcher?.name || "Abridor",
    team: pitcher?.team || "",
    opponent: opponentTeam?.name || "Rival",
    stadium: homeTeamName || "Estadio Neutral",
    parkFactor: pf.toFixed(2),
    k9: k9.toFixed(1),
    whip: whip.toFixed(2),
    era: era.toFixed(2),
    expectedIP,
    oppKRate: `${oppKRate.toFixed(1)}%`,
    projectedKs,
    line: chosenLine,
    pickType,
    fullPick: `${pitcher?.name || 'Abridor'} ${pickType} ${chosenLine} Ponches`,
    prob: winProb,
    edge,
    fairOdds,
    marketOdds: "1.87",
    isSharp: edge >= 4.5,
    reason: isOver 
      ? `Proyecta ${projectedKs} ponches en ~${expectedIP} entradas (Parque: ${homeTeamName || 'Local'}, PF: ${pf.toFixed(2)}). ${opponentTeam?.name || 'El rival'} sufre con un ${oppKRate.toFixed(1)}% de ponches colectivos.`
      : `Proyecta ${projectedKs} ponches. Entorno ofensivo en ${homeTeamName || 'estadio'} (PF: ${pf.toFixed(2)}) restringe la permanencia del abridor a ~${expectedIP} innings.`
  };
}

/**
 * Proyecta la probabilidad de que un bateador consiga más de 1.5 Bases Totales (Over 1.5 TB).
 * Ajusta SLG e ISO en base al Park Factor del estadio donde se disputa el juego.
 * @param {Object} batter - { name, team, avg, slg, iso, recentHits }
 * @param {Object} opposingPitcher - { name, whip, era, hr9 }
 * @param {string} homeTeamName - Nombre del equipo local para determinar el Park Factor
 * @returns {Object} Evaluación de valor para Over 1.5 Bases Totales
 */
export function calculateBatterTotalBases(batter, opposingPitcher, homeTeamName = "") {
  const iso = parseFloat(batter?.iso) || 0.180; // Isolated Power
  const slg = parseFloat(batter?.slg) || 0.440; // Slugging
  const avg = parseFloat(batter?.avg) || 0.255;
  const whip = parseFloat(opposingPitcher?.whip) || 1.30;
  const era = parseFloat(opposingPitcher?.era) || 4.10;
  const pf = getParkFactor(homeTeamName);

  // Factor de castigo al lanzador rival: lanzadores con alto WHIP/ERA permiten más extrabases
  const pitcherVulnerability = Math.max(0.85, Math.min(1.35, ((whip / 1.25) * 0.5) + ((era / 4.00) * 0.5)));

  // Proyección de turnos al bate (promedio 4.2 apariciones por juego para primeros bates)
  const expectedPA = 4.2;
  // Ajuste por Park Factor del estadio (altitud, dimensiones y clima)
  const adjustedSLG = slg * pitcherVulnerability * pf;
  const projectedTB = Number((expectedPA * (adjustedSLG / 4.0) * 1.8).toFixed(2));

  // Modelo empírico calibrado para probabilidad de Over 1.5 TB con ponderación de parque
  const powerFactor = (iso * 1.4) + (avg * 0.6);
  let over15Prob = Math.min(68, Math.max(34, (powerFactor * 100 * pitcherVulnerability * Math.pow(pf, 0.75)) + 12));
  over15Prob = Number(over15Prob.toFixed(1));

  // La cuota típica de Over 1.5 TB en casas de apuestas suele pagar entre 2.00 y 2.45 (+100 a +145)
  const estimatedMarketOdds = (2.10 + (0.240 - iso) * 1.5).toFixed(2);
  const impliedMarketProb = (100 / parseFloat(estimatedMarketOdds));
  const edge = Number((over15Prob - impliedMarketProb).toFixed(1));

  return {
    batterName: batter?.name || "Bateador",
    team: batter?.team || "",
    opponent: opposingPitcher?.team || "",
    opposingPitcher: opposingPitcher?.name || "Lanzador Rival",
    stadium: homeTeamName || "Estadio Neutral",
    parkFactor: pf.toFixed(2),
    iso: iso.toFixed(3),
    slg: slg.toFixed(3),
    avg: avg.toFixed(3),
    pitcherWhip: whip.toFixed(2),
    projectedTB,
    line: 1.5,
    fullPick: `${batter?.name || 'Bateador'} Más de 1.5 Bases Totales (Extrabase)`,
    prob: over15Prob,
    edge,
    fairOdds: (100 / over15Prob).toFixed(2),
    marketOdds: estimatedMarketOdds,
    isSharp: edge >= 3.0 && iso >= 0.190,
    reason: `Bateador de poder (ISO ${iso.toFixed(3)}, SLG ${slg.toFixed(3)}) en ${homeTeamName || 'estadio local'} (Park Factor: ${pf.toFixed(2)}) frente al abridor ${opposingPitcher?.name || 'rival'} (WHIP ${whip.toFixed(2)}, ERA ${era.toFixed(2)}). Un extrabase asegura el cobro directo.`
  };
}

/**
 * Escanea la lista de partidos de MLB del día y genera los Top Picks de Props
 * inyectando la sede oficial para cada enfrentamiento.
 * @param {Array} games - Lista de partidos de MLB con datos hidratados
 * @returns {{ topStrikeouts: Array, topTotalBases: Array }}
 */
export function generateDailyMlbProps(games = []) {
  const strikeoutCandidates = [];
  const totalBasesCandidates = [];

  games.forEach(game => {
    if (!game.home || !game.away) return;
    const homeTeamName = game.home.name;

    // Evaluaciones de Abridores para Ponches (Lanzador Local)
    if (game.home.pitcher?.name && !game.home.pitcher.name.includes("por Anunciar")) {
      const homeK = calculatePitcherKProjection(
        {
          name: game.home.pitcher.name,
          team: game.home.name,
          k9: game.home.pitcher.k9 || 8.6,
          whip: game.home.pitcher.whip || 1.25,
          era: game.home.pitcher.era || 3.90
        },
        {
          name: game.away.name,
          kRate: game.away.kRate || 23.2
        },
        homeTeamName
      );
      strikeoutCandidates.push({ ...homeK, matchId: game.id, gameDate: game.gameDate });
    }

    // Evaluaciones de Abridores para Ponches (Lanzador Visitante en estadio rival)
    if (game.away.pitcher?.name && !game.away.pitcher.name.includes("por Anunciar")) {
      const awayK = calculatePitcherKProjection(
        {
          name: game.away.pitcher.name,
          team: game.away.name,
          k9: game.away.pitcher.k9 || 8.6,
          whip: game.away.pitcher.whip || 1.25,
          era: game.away.pitcher.era || 3.90
        },
        {
          name: game.home.name,
          kRate: game.home.kRate || 23.2
        },
        homeTeamName
      );
      strikeoutCandidates.push({ ...awayK, matchId: game.id, gameDate: game.gameDate });
    }

    // Evaluaciones de Bateadores de Poder para Bases Totales (Bateador Local)
    if (game.home.topHitter && game.away.pitcher) {
      const homeBatterProp = calculateBatterTotalBases(
        {
          name: game.home.topHitter.name,
          team: game.home.name,
          iso: game.home.topHitter.iso,
          slg: game.home.topHitter.slg,
          avg: game.home.topHitter.avg
        },
        {
          name: game.away.pitcher.name,
          team: game.away.name,
          whip: game.away.pitcher.whip,
          era: game.away.pitcher.era
        },
        homeTeamName
      );
      totalBasesCandidates.push({ ...homeBatterProp, matchId: game.id, gameDate: game.gameDate });
    }

    // Evaluaciones de Bateadores de Poder para Bases Totales (Bateador Visitante)
    if (game.away.topHitter && game.home.pitcher) {
      const awayBatterProp = calculateBatterTotalBases(
        {
          name: game.away.topHitter.name,
          team: game.away.name,
          iso: game.away.topHitter.iso,
          slg: game.away.topHitter.slg,
          avg: game.away.topHitter.avg
        },
        {
          name: game.home.pitcher.name,
          team: game.home.name,
          whip: game.home.pitcher.whip,
          era: game.home.pitcher.era
        },
        homeTeamName
      );
      totalBasesCandidates.push({ ...awayBatterProp, matchId: game.id, gameDate: game.gameDate });
    }
  });

  // Ordenar por mayor Edge y seleccionar los mejores
  strikeoutCandidates.sort((a, b) => b.edge - a.edge);
  totalBasesCandidates.sort((a, b) => b.edge - a.edge);

  return {
    topStrikeouts: strikeoutCandidates.slice(0, 4),
    topTotalBases: totalBasesCandidates.slice(0, 4)
  };
}
