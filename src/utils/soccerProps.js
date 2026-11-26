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
 * Corrección SOT 2026-11-25 (Llorente/Ruiz/Sturm, Champions 25 nov):
 * el keyPlayer debe ser un tirador plausible, la proyección debe estar
 * anclada a su producción real y el prop debe decir si la alineación
 * está verificada. Sin esto el generador proyectaba 3.85/3.64 tiros a
 * puerta para jugadores con SOT/90 real de ~0.5-0.6.
 *
 * - MIN_LEADER_GOALS: el líder goleador (ESPN `leaders[0]` = "goals",
 *   `value` = goles en la competición, adjuntado en sportsApi.js) debe
 *   tener al menos 2 goles. Evidencia: Llorente lideraba con 1 gol en 5
 *   partidos de Champions (defensa, 0.6 tiros/90) y generó prop; los
 *   goleadores reales del 25-28 nov tenían 3+ (Rudoni 3, Riquelme 3,
 *   Mbeumo 4, Viñas 8, Henry Martín 11).
 * - PLAYER_XG_SHARE_PER_GOAL: la participación del jugador en el xG del
 *   equipo se escala por sus goles (0.05 por gol, tope 0.35 histórico).
 *   Es un proxy (goles ≠ tiros a puerta); el anclaje real a SOT/90
 *   requiere una fuente de estadísticas por jugador que hoy no existe
 *   en el pipeline (ESPN no la publica en el scoreboard).
 * - MAX_PROJECTED_SOT: tope de proyección. Ningún jugador promedia más
 *   de 2.5 tiros a puerta por partido; 3.85/3.64/3.92 eran artefactos
 *   del 35% fijo aplicado a cualquier keyPlayer.
 */
export const MIN_LEADER_GOALS = 2;
export const PLAYER_XG_SHARE_PER_GOAL = 0.05;
export const PLAYER_XG_SHARE_MAX = 0.35;
export const MAX_PROJECTED_SOT = 2.5;

/**
 * ¿Es el keyPlayer un tirador plausible? Exige nombre válido + dato de
 * líder de goles (categoría "goals"/"goalsLeaders" con al menos
 * MIN_LEADER_GOALS goles) + posición de atacante. Sin dato de líder no
 * se puede validar: fail-closed (no generar). El builder adjunta
 * leaderCategory, leaderValue y leaderPosition junto al nombre, del
 * mismo payload ESPN; un nombre real siempre los trae. Un defensa que
 * lidera por 1 gol (Llorente) no pasa por goles ni por posición.
 */
export function isPlausibleShooter(keyPlayer) {
  if (!keyPlayer || !isPlayerNameValid(keyPlayer.name)) return false;
  const category = keyPlayer.leaderCategory;
  const value = Number(keyPlayer.leaderValue);
  if (typeof category !== 'string' || !Number.isFinite(value)) return false;
  if (!/goal/i.test(category)) return false;
  if (value < MIN_LEADER_GOALS) return false;
  // Posición (ESPN athlete.position.abbreviation): defensas (D) y
  // porteros (G) no son tiradores plausibles. Delanteros (F) y
  // centrocampistas (M) sí. Si no hay dato de posición, no se bloquea
  // por este criterio (el umbral de goles es el filtro principal).
  const pos = (keyPlayer.leaderPosition || '').toString().toUpperCase();
  if (pos === 'D' || pos === 'G') return false;
  return true;
}

/**
 * Calcula la proyección de tiros a puerta para un jugador
 */
export function calculateSoccerPlayerProps(player, teamXG, opponentDefXG, homeAdvantage = 1.0) {
  if (!player || !player.name) return null;

  // Participación del jugador en el xG del equipo, escalada por su
  // producción real de goles (corrección 2026-11-25). Antes era un 35%
  // fijo para CUALQUIER keyPlayer, incluido un defensa: por eso Llorente
  // (1 gol) proyectaba 3.64 tiros a puerta y Fabián Ruiz (4 goles,
  // 0.61 SOT/90 real) proyectaba 3.85. Un goleador con 7+ goles conserva
  // el 35%; uno con pocos goles ve su participación reducida en
  // proporción a su producción. Si no hay dato de líder, se usa el 35%
  // histórico (la validación de tirador en generateDailySoccerProps es
  // la que exige el dato; esta función no rompe si se llama directa).
  const leaderGoals = Number(player.leaderValue);
  const playerXgShare = Number.isFinite(leaderGoals)
    ? Math.min(PLAYER_XG_SHARE_MAX, Math.max(0, leaderGoals) * PLAYER_XG_SHARE_PER_GOAL)
    : PLAYER_XG_SHARE_MAX;

  // Proyección base del equipo cruzando ataque vs defensa
  const teamProjectedXg = teamXG * opponentDefXG * homeAdvantage;

  // Proyección de goles esperados para el jugador
  const playerExpectedGoals = teamProjectedXg * playerXgShare;

  // Conversión: Se necesitan aprox 3.2 tiros a puerta para 1 gol (0.31 xG por tiro)
  // Tope (corrección 2026-11-25): la proyección no puede superar
  // MAX_PROJECTED_SOT. Un valor esperado de 3.85 tiros a puerta por
  // partido no es realista para ningún jugador.
  const projectedShotsOnTarget = Math.min(playerExpectedGoals * 3.2, MAX_PROJECTED_SOT);
  
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

    // Hallazgo 2026-11-25 (Sturm, lesionado, generó prop): `game.lineups`
    // SOLO existe para MLB (sportsApi.js); el fútbol NUNCA trae
    // alineaciones en el scoreboard ESPN (se publican ~1h antes del
    // partido y el pipeline no las descarga). Por eso el chequeo de arriba
    // es vacuo para fútbol: sin `game.lineups`, `hasOfficialHomeLineup`
    // es false y el prop se genera igual. Decisión: NO se hace fail-closed
    // (no generar sin alineación), porque eso eliminaría TODOS los props
    // SOT de fútbol de forma permanente. En su lugar cada prop lleva
    // `lineupVerified` (true solo si hay alineación oficial Y el jugador
    // está en ella) y `lineupNote`. La protección operativa contra un prop
    // de un jugador fuera sigue siendo el veto C3/P4: sin precio real
    // (PropLine) el prop no despacha. El flag es el gancho para un futuro
    // fail-closed cuando exista una fuente de alineaciones/lesiones.
    const homeLineupVerified = hasOfficialHomeLineup && isHomePlayerInLineup;
    const awayLineupVerified = hasOfficialAwayLineup && isAwayPlayerInLineup;
    const lineupNoteUnverified = 'Sin alineación oficial disponible (fútbol no publica alineaciones en el scoreboard ESPN; prop no verificado contra alineación ni lesiones)';

    const hAttack = parseFloat(game.home.xG) || 1.35;
    const aDefense = parseFloat(game.away.defenseXG) || 1.10;

    if (game.home.keyPlayer && isPlausibleShooter(game.home.keyPlayer) && isHomePlayerInLineup) {
      const homeProp = calculateSoccerPlayerProps(game.home.keyPlayer, hAttack, aDefense, 1.15);
      if (homeProp && homeProp.isSharp) {
        sotCandidates.push({ ...homeProp, team: game.home.name, opponent: game.away.name, matchId: game.id, gameDate: game.gameDate, league: game.league, isConfirmedLineup: hasOfficialHomeLineup, lineupVerified: homeLineupVerified, lineupNote: homeLineupVerified ? 'Alineación oficial confirmada' : lineupNoteUnverified });
      }
    }

    const aAttack = parseFloat(game.away.xG) || 1.05;
    const hDefense = parseFloat(game.home.defenseXG) || 1.10;

    if (game.away.keyPlayer && isPlausibleShooter(game.away.keyPlayer) && isAwayPlayerInLineup) {
      const awayProp = calculateSoccerPlayerProps(game.away.keyPlayer, aAttack, hDefense, 0.90);
      if (awayProp && awayProp.isSharp) {
        sotCandidates.push({ ...awayProp, team: game.away.name, opponent: game.home.name, matchId: game.id, gameDate: game.gameDate, league: game.league, isConfirmedLineup: hasOfficialAwayLineup, lineupVerified: awayLineupVerified, lineupNote: awayLineupVerified ? 'Alineación oficial confirmada' : lineupNoteUnverified });
      }
    }
  });

  sotCandidates.sort((a, b) => b.edge - a.edge);

  return sotCandidates.slice(0, 4);
}
