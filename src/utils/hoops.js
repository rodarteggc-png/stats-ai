// src/utils/hoops.js
// MOTOR CUANTITATIVO PARA BALONCESTO (NBA) - STATS-AI PRO
// Basado en el modelo institucional de 4 Factores de Dean Oliver, Posesiones (Pace) y Ratings Ofensivo/Defensivo por 100 posesiones.

// Base de ratings institucionales de Pace, ORtg (Offensive Rating) y DRtg (Defensive Rating) para las 30 franquicias NBA
// Promedio de liga: Pace = 99.2 posesiones | ORtg = 114.5 | DRtg = 114.5
const NBA_TEAM_METRICS = {
  'boston celtics': { pace: 98.5, ortg: 122.2, drtg: 110.6 },
  'oklahoma city thunder': { pace: 100.8, ortg: 118.3, drtg: 111.0 },
  'denver nuggets': { pace: 97.2, ortg: 117.8, drtg: 112.3 },
  'minnesota timberwolves': { pace: 97.6, ortg: 114.6, drtg: 108.4 },
  'dallas mavericks': { pace: 100.1, ortg: 117.0, drtg: 114.9 },
  'new york knicks': { pace: 95.9, ortg: 117.3, drtg: 112.4 },
  'milwaukee bucks': { pace: 100.5, ortg: 117.6, drtg: 115.0 },
  'indiana pacers': { pace: 102.3, ortg: 120.5, drtg: 117.6 },
  'philadelphia 76ers': { pace: 98.3, ortg: 116.2, drtg: 113.0 },
  'cleveland cavaliers': { pace: 98.2, ortg: 114.7, drtg: 112.1 },
  'phoenix suns': { pace: 98.9, ortg: 116.8, drtg: 113.7 },
  'new orleans pelicans': { pace: 98.4, ortg: 116.5, drtg: 111.9 },
  'los angeles clippers': { pace: 97.8, ortg: 117.9, drtg: 114.6 },
  'los angeles lakers': { pace: 101.3, ortg: 115.4, drtg: 114.8 },
  'miami heat': { pace: 96.8, ortg: 113.3, drtg: 111.5 },
  'golden state warriors': { pace: 100.2, ortg: 116.9, drtg: 114.5 },
  'sacramento kings': { pace: 99.8, ortg: 116.2, drtg: 114.4 },
  'orlando magic': { pace: 97.5, ortg: 112.9, drtg: 110.8 },
  'chicago bulls': { pace: 97.1, ortg: 114.0, drtg: 115.7 },
  'atlanta hawks': { pace: 101.5, ortg: 116.4, drtg: 118.4 },
  'houston rockets': { pace: 99.2, ortg: 114.5, drtg: 112.8 },
  'utah jazz': { pace: 100.6, ortg: 115.0, drtg: 119.6 },
  'brooklyn nets': { pace: 97.3, ortg: 112.4, drtg: 115.5 },
  'toronto raptors': { pace: 99.7, ortg: 112.3, drtg: 118.1 },
  'memphis grizzlies': { pace: 98.1, ortg: 106.8, drtg: 113.7 },
  'san antonio spurs': { pace: 101.8, ortg: 109.8, drtg: 115.6 },
  'portland trail blazers': { pace: 98.0, ortg: 107.6, drtg: 116.6 },
  'charlotte hornets': { pace: 97.8, ortg: 108.6, drtg: 119.2 },
  'washington wizards': { pace: 102.7, ortg: 110.2, drtg: 118.9 },
  'detroit pistons': { pace: 100.4, ortg: 109.0, drtg: 118.0 }
};

const LEAGUE_AVERAGE_PACE = 99.2;
const LEAGUE_AVERAGE_EFFICIENCY = 114.5;
const HOME_COURT_ADVANTAGE_PTS = 2.4;

function getTeamBaseline(teamName = '') {
  const norm = teamName.toLowerCase().trim();
  for (const [key, val] of Object.entries(NBA_TEAM_METRICS)) {
    if (norm.includes(key) || key.includes(norm)) {
      return val;
    }
  }
  return { pace: LEAGUE_AVERAGE_PACE, ortg: LEAGUE_AVERAGE_EFFICIENCY, drtg: LEAGUE_AVERAGE_EFFICIENCY };
}

// Función de aproximación a la distribución normal acumulada (CDF)
function normalCdf(x, mean, stdDev) {
  const z = (x - mean) / stdDev;
  const t = 1.0 / (1.0 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014337 * Math.exp(-0.5 * z * z);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (z > 0) p = 1.0 - p;
  return p;
}

/**
 * Calcula probabilidades cuantitativas para un partido de NBA (Moneyline, Spreads y Over/Under)
 */
export function calculateNbaProbabilities(match) {
  if (!match) return null;

  const homeName = match.home?.name || 'Local';
  const awayName = match.away?.name || 'Visitante';
  const homeStats = getTeamBaseline(homeName);
  const awayStats = getTeamBaseline(awayName);

  // 1. Proyección de ritmo (Pace esperado en 48 minutos)
  const expectedPace = (homeStats.pace * awayStats.pace) / LEAGUE_AVERAGE_PACE;

  // 2. Eficiencia ofensiva esperada por cada 100 posesiones (ajustada por defensa rival)
  const homeExpectedEfficiency = (homeStats.ortg * awayStats.drtg) / LEAGUE_AVERAGE_EFFICIENCY;
  const awayExpectedEfficiency = (awayStats.ortg * homeStats.drtg) / LEAGUE_AVERAGE_EFFICIENCY;

  // 3. Puntos proyectados
  const homeBasePts = (expectedPace / 100) * homeExpectedEfficiency;
  const awayBasePts = (expectedPace / 100) * awayExpectedEfficiency;

  const projectedHomeScore = homeBasePts + (HOME_COURT_ADVANTAGE_PTS / 2);
  const projectedAwayScore = awayBasePts - (HOME_COURT_ADVANTAGE_PTS / 2);
  const projectedTotal = projectedHomeScore + projectedAwayScore;
  const projectedSpread = projectedHomeScore - projectedAwayScore; // Positivo si gana local

  // Desviación estándar histórica en NBA: Margen ~ 11.2 pts | Total ~ 17.5 pts
  const spreadStdDev = 11.2;
  const totalStdDev = 17.5;

  // Probabilidad de victoria directa (Moneyline)
  // P(Home > Away) = P(Margin > 0)
  const homeWinProb = 1 - normalCdf(0, projectedSpread, spreadStdDev);
  const awayWinProb = 1 - homeWinProb;

  // Evaluación de cuotas de mercado (Vegas / Pinnacle)
  const marketSpread = parseFloat(match.spread || (match.odds?.spread !== undefined ? match.odds.spread : 0));
  const marketTotal = parseFloat(match.total || (match.odds?.overUnder !== undefined ? match.odds.overUnder : Math.round(projectedTotal)));

  // Probabilidad de cubrir el spread de mercado
  // Si marketSpread es -4.5 para Home, Home cubre si Margin >= 4.5
  const homeCoverProb = 1 - normalCdf(-marketSpread, projectedSpread, spreadStdDev);
  const awayCoverProb = 1 - homeCoverProb;

  // Probabilidad de Over / Under
  const overProb = 1 - normalCdf(marketTotal, projectedTotal, totalStdDev);
  const underProb = 1 - overProb;

  return {
    sport: 'Baloncesto',
    league: 'NBA',
    projectedPace: Number(expectedPace.toFixed(1)),
    homeExpectedScore: Number(projectedHomeScore.toFixed(1)),
    awayExpectedScore: Number(projectedAwayScore.toFixed(1)),
    projectedTotal: Number(projectedTotal.toFixed(1)),
    projectedSpread: Number(projectedSpread.toFixed(1)),
    homeWinProb: Number((homeWinProb * 100).toFixed(1)),
    awayWinProb: Number((awayWinProb * 100).toFixed(1)),
    homeCoverProb: Number((homeCoverProb * 100).toFixed(1)),
    awayCoverProb: Number((awayCoverProb * 100).toFixed(1)),
    overProb: Number((overProb * 100).toFixed(1)),
    underProb: Number((underProb * 100).toFixed(1)),
    marketSpread,
    marketTotal
  };
}
