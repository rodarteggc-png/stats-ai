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
  
  // CANDADO DE CUOTA RENTABLE Y CALIBRACIÓN DE EDGE REAL:
  // En casas de apuestas reales (Bet365/Caliente/Novibet), cuotas por debajo de 1.65 en Player Props son trampas de valor asimétrico.
  // La probabilidad implícita DEBE medirse contra la cuota ofrecida real, no contra un flat 52.4%.
  const rawMarketOdds = Number((2.20 - (projectedShotsOnTarget * 0.25)).toFixed(2));
  const marketOdds = Math.max(1.65, rawMarketOdds).toFixed(2);
  const impliedProb = (1 / parseFloat(marketOdds)) * 100;
  const edge = Number((overPct - impliedProb).toFixed(1));
  const fairOdds = (100 / overPct).toFixed(2);
  
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
    marketOdds,
    isSharp: edge >= 4.0 && overPct >= 62.0 && parseFloat(marketOdds) >= 1.65,
    reason: `El jugador monopoliza la ofensiva (${projectedShotsOnTarget.toFixed(2)} remates proyectados vs defensa rival con ${opponentDefXG.toFixed(2)} coef. def). Edge real +${edge}% en cuota rentable ${marketOdds}.`
  };
}

// Whitelist de Ligas Comerciales donde las casas de apuestas (Novibet, Draftea, Playdoit, Caliente)
// abren de forma estándar mercados de Tiros a Puerta de Jugadores (Player Props).
// En torneos secundarios (Concacaf Nations League, Copas de selecciones menores, etc.) NO se generan props
// para evitar desperdiciar cupos del Top 6 con selecciones inexistentes en las casas locales.
export const SOCCER_PROPS_ALLOWED_LEAGUES = [
  'Champions League',
  'Europa League',
  'Conference League',
  'Premier League',
  'LaLiga',
  'Serie A',
  'Bundesliga',
  'Ligue 1',
  'Liga MX',
  'MLS'
];

function isPlayerNameValid(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 3) return false;
  const invalidPlaceholders = [
    'goleador', 'extremo', 'delantero', 'principal', 'titular',
    'delantero principal', 'extremo titular', 'jugador', 'leader'
  ];
  return !invalidPlaceholders.some(p => trimmed.toLowerCase().includes(p));
}

export function isPlayerInLineup(playerName, lineupArray = []) {
  if (!playerName || !Array.isArray(lineupArray) || lineupArray.length === 0) return false;
  const pLower = playerName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const pParts = pLower.split(/\s+/);
  const lastName = pParts[pParts.length - 1];

  return lineupArray.some(item => {
    const itemLower = (typeof item === 'string' ? item : (item.name || item.fullName || '')).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    if (itemLower.includes(pLower) || pLower.includes(itemLower)) return true;
    if (lastName.length >= 4 && itemLower.includes(lastName)) return true;
    return false;
  });
}

export function generateDailySoccerProps(games = [], options = {}) {
  const requireLineup = options.requireConfirmedLineup !== false;
  const sotCandidates = [];

  games.forEach(game => {
    if (!game.home || !game.away) return;
    
    // Candado Comercial: Solo generar Player Props en ligas donde las casas realmente abren el mercado
    const leagueName = game.league || '';
    const isFemenil = leagueName.toLowerCase().includes('femenil') || leagueName.toLowerCase().includes('women');
    const isCommercialPropLeague = SOCCER_PROPS_ALLOWED_LEAGUES.some(l => 
      leagueName.toLowerCase().includes(l.toLowerCase())
    ) && !isFemenil;
    if (!isCommercialPropLeague) return;

    // CANDADO ANTI-DNP: Si el juego ya tiene alineaciones oficiales confirmadas, el jugador DEBE estar en el XI titular
    const homeLineup = game.lineups?.home || [];
    const awayLineup = game.lineups?.away || [];
    const hasOfficialHomeLineup = game.lineups?.hasOfficialLineup || homeLineup.length >= 11;
    const hasOfficialAwayLineup = game.lineups?.hasOfficialLineup || awayLineup.length >= 11;

    const isHomePlayerInLineup = !hasOfficialHomeLineup || (game.home.keyPlayer && isPlayerInLineup(game.home.keyPlayer.name, homeLineup));
    const isAwayPlayerInLineup = !hasOfficialAwayLineup || (game.away.keyPlayer && isPlayerInLineup(game.away.keyPlayer.name, awayLineup));

    if (requireLineup && hasOfficialHomeLineup && !isHomePlayerInLineup) return;
    if (requireLineup && hasOfficialAwayLineup && !isAwayPlayerInLineup) return;

    const hAttack = parseFloat(game.home.xG) || 1.35;
    const aDefense = parseFloat(game.away.defenseXG) || 1.10;
    
    if (game.home.keyPlayer && isPlayerNameValid(game.home.keyPlayer.name) && isHomePlayerInLineup) {
      const homeProp = calculateSoccerPlayerProps(game.home.keyPlayer, hAttack, aDefense, 1.15);
      if (homeProp && homeProp.isSharp) {
        sotCandidates.push({ ...homeProp, team: game.home.name, opponent: game.away.name, matchId: game.id, gameDate: game.gameDate, league: game.league, isConfirmedLineup: hasOfficialHomeLineup });
      }
    }
    
    const aAttack = parseFloat(game.away.xG) || 1.05;
    const hDefense = parseFloat(game.home.defenseXG) || 1.10;
    
    if (game.away.keyPlayer && isPlayerNameValid(game.away.keyPlayer.name) && isAwayPlayerInLineup) {
      const awayProp = calculateSoccerPlayerProps(game.away.keyPlayer, aAttack, hDefense, 0.90);
      if (awayProp && awayProp.isSharp) {
        sotCandidates.push({ ...awayProp, team: game.away.name, opponent: game.home.name, matchId: game.id, gameDate: game.gameDate, league: game.league, isConfirmedLineup: hasOfficialAwayLineup });
      }
    }
  });

  sotCandidates.sort((a, b) => b.edge - a.edge);

  return sotCandidates.slice(0, 4);
}
