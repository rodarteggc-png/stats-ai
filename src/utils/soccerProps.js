// src/utils/soccerProps.js
/**
 * Motor Matemático para Player Props de Fútbol
 * Proyecta Tiros a Puerta (Shots on Target) y Probabilidad de Anotar (Anytime Goalscorer)
 */

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
 * Calcula la proyección de tiros a puerta para un jugador
 */
export function calculateSoccerPlayerProps(player, teamXG, opponentDefXG, homeAdvantage = 1.0) {
  if (!player || !player.name) return null;
  
  // Un jugador estrella suele ser responsable del ~35% del xG ofensivo del equipo
  const playerXgShare = 0.35;
  
  // Proyección base del equipo cruzando ataque vs defensa
  const teamProjectedXg = teamXG * opponentDefXG * homeAdvantage;
  
  // Proyección de goles esperados para el jugador
  const playerExpectedGoals = teamProjectedXg * playerXgShare;
  
  // Conversión: Se necesitan aprox 3.2 tiros a puerta para 1 gol (0.31 xG por tiro)
  const projectedShotsOnTarget = playerExpectedGoals * 3.2;
  
  // Línea estándar de apuestas para un goleador es 0.5 tiros a puerta (Más de 0.5)
  // O 1.5 para superestrellas (Haaland, Messi). Usaremos 0.5 para la mayoría.
  const baseLine = projectedShotsOnTarget > 1.8 ? 1.5 : 0.5;
  
  // Probabilidades Poisson
  let underProb = 0;
  for (let k = 0; k <= Math.floor(baseLine); k++) {
    underProb += poisson(projectedShotsOnTarget, k);
  }
  const overProb = 1 - underProb;
  
  const overPct = Number((overProb * 100).toFixed(1));
  const underPct = Number((underProb * 100).toFixed(1));
  
  const edge = Number((overPct - 52.4).toFixed(1));
  const fairOdds = (100 / overPct).toFixed(2);
  const marketOdds = (2.20 - (projectedShotsOnTarget * 0.4)).toFixed(2); // Simulated market odds
  
  return {
    playerName: player.name,
    projectedSot: projectedShotsOnTarget.toFixed(2),
    projectedGoals: playerExpectedGoals.toFixed(2),
    line: baseLine,
    pickType: `MÁS DE (OVER) ${baseLine} Tiros a Puerta`,
    fullPick: `${player.name} Más de ${baseLine} Tiros a Puerta`,
    prob: overPct,
    edge,
    fairOdds,
    marketOdds: marketOdds > 1.10 ? marketOdds : '1.30',
    isSharp: edge >= 3.5 && overPct >= 65,
    reason: `El jugador monopoliza la ofensiva. El equipo proyecta ${teamProjectedXg.toFixed(2)} xG contra una defensa débil (${opponentDefXG.toFixed(2)} coef. def). Proyección matemática: ${projectedShotsOnTarget.toFixed(2)} Tiros a Puerta.`
  };
}

export function generateDailySoccerProps(games = []) {
  const sotCandidates = [];

  games.forEach(game => {
    if (!game.home || !game.away) return;
    
    const hAttack = parseFloat(game.home.xG) || 1.35;
    const aDefense = parseFloat(game.away.defenseXG) || 1.10;
    
    if (game.home.keyPlayer && game.home.keyPlayer.name && game.home.keyPlayer.name !== 'Goleador') {
      const homeProp = calculateSoccerPlayerProps(game.home.keyPlayer, hAttack, aDefense, 1.15);
      if (homeProp) sotCandidates.push({ ...homeProp, team: game.home.name, opponent: game.away.name, matchId: game.id, gameDate: game.gameDate, league: game.league });
    }
    
    const aAttack = parseFloat(game.away.xG) || 1.05;
    const hDefense = parseFloat(game.home.defenseXG) || 1.10;
    
    if (game.away.keyPlayer && game.away.keyPlayer.name && game.away.keyPlayer.name !== 'Extremo') {
      const awayProp = calculateSoccerPlayerProps(game.away.keyPlayer, aAttack, hDefense, 0.90);
      if (awayProp) sotCandidates.push({ ...awayProp, team: game.away.name, opponent: game.home.name, matchId: game.id, gameDate: game.gameDate, league: game.league });
    }
  });

  sotCandidates.sort((a, b) => b.edge - a.edge);

  return sotCandidates.slice(0, 4);
}
