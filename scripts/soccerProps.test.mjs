import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSoccerPlayerProps,
  generateDailySoccerProps,
  isPlausibleShooter,
  MAX_PROJECTED_SOT,
  MIN_LEADER_GOALS,
} from '../src/utils/soccerProps.js';

// Corrección SOT 2026-11-25 (Llorente/Ruiz/Sturm, Champions 25 nov).
// El generador proyectaba 3.85/3.64 tiros a puerta para jugadores con
// SOT/90 real de ~0.5-0.6, porque aplicaba un 35% fijo del xG del equipo
// a CUALQUIER keyPlayer y no validaba tirador, posición ni alineación.

function soccerGame({ id, league, home, away, lineups } = {}) {
  return {
    id: id || 'soccer-test-1',
    league: league || 'Champions League',
    gameDate: '2026-11-25T14:00:00Z',
    home: {
      name: home?.name || 'Paris Saint-Germain',
      xG: home?.xG || '2.6',
      defenseXG: home?.defenseXG || '1.0',
      ...(home?.keyPlayer ? { keyPlayer: home.keyPlayer } : {}),
    },
    away: {
      name: away?.name || 'AS Roma',
      xG: away?.xG || '1.2',
      defenseXG: away?.defenseXG || '1.15',
      ...(away?.keyPlayer ? { keyPlayer: away.keyPlayer } : {}),
    },
    ...(lineups ? { lineups } : {}),
  };
}

const ruiz = { name: 'Fabián Ruiz', leaderCategory: 'goals', leaderValue: 4, leaderPosition: 'M' };
const llorente = { name: 'Marcos Llorente', leaderCategory: 'goals', leaderValue: 1, leaderPosition: 'D' };
const sturm = { name: 'Danijel Sturm', leaderCategory: 'goals', leaderValue: 2, leaderPosition: 'F' };
const vinas = { name: 'Federico Viñas', leaderCategory: 'goals', leaderValue: 8, leaderPosition: 'F' };

// (i) Un defensa con 1 gol (Llorente) NO genera prop.
// Antes: el 35% fijo le proyectaba 3.64 tiros a puerta y era sharp.
test('Llorente (defensa, líder con 1 gol) no genera prop', () => {
  assert.equal(isPlausibleShooter(llorente), false);
  const games = [soccerGame({
    id: 'soccer-atl-vik',
    home: { name: 'Atlético Madrid', xG: '2.0', defenseXG: '1.0', keyPlayer: llorente },
    away: { name: 'Viking FK', xG: '0.8', defenseXG: '1.1' },
  })];
  const props = generateDailySoccerProps(games, { requireConfirmedLineup: true });
  assert.equal(props.filter(p => p.playerName === 'Marcos Llorente').length, 0);
});

// (ii) Jugador fuera de la alineación oficial NO genera prop; sin dato
// de alineación el prop lleva lineupVerified: false (fútbol nunca trae
// alineaciones en el scoreboard ESPN, así que el flag es el registro
// explícito de que no está verificado, no un bloqueo total).
test('jugador fuera de la alineación oficial no genera prop; sin dato, lineupVerified es false', () => {
  const homeLineup = ['Jan Oblak', 'Robin Le Normand', 'Dávid Hancko', 'Arnau Ortiz', 'Giuliano Simeone', 'Pablo Barrios', 'Álex Baena', 'Alexander Sørloth', 'Julián Álvarez', 'Ademola Lookman', 'Conor Gallagher'];
  const awayLineup = ['Lubomir Belko', 'Henrik Heggheim', 'Gianni Stensness', 'Kristoffer Haugen', 'Tobias Moi', 'Kristoffer Askildsen', 'Henrik Bjørdal', 'Simen Kvia-Egeskog', 'Zlatko Tripic', 'Erik Botheim', 'Sander Svendsen'];
  const games = [soccerGame({
    id: 'soccer-sla-vil',
    home: { name: 'Slavia Prague', xG: '1.5', defenseXG: '1.0', keyPlayer: sturm },
    away: { name: 'Villarreal', xG: '1.3', defenseXG: '1.1' },
    lineups: { home: homeLineup, away: awayLineup, hasOfficialLineup: true },
  })];
  // Sturm no está en el XI titular → no genera prop.
  const props = generateDailySoccerProps(games, { requireConfirmedLineup: true });
  assert.equal(props.filter(p => p.playerName === 'Danijel Sturm').length, 0);

  // Sin dato de alineación (caso real del fútbol), el prop de un tirador
  // válido se genera pero marcado como no verificado.
  const noLineupGames = [soccerGame({
    id: 'soccer-tol-atl',
    league: 'Liga MX',
    home: { name: 'Toluca', xG: '2.5', defenseXG: '1.0', keyPlayer: vinas },
    away: { name: 'Atlas', xG: '1.2', defenseXG: '1.1' },
  })];
  const noLineupProps = generateDailySoccerProps(noLineupGames, { requireConfirmedLineup: true });
  const vinasProp = noLineupProps.find(p => p.playerName === 'Federico Viñas');
  assert.ok(vinasProp, 'Viñas debe generar prop');
  assert.equal(vinasProp.lineupVerified, false);
});

// (iii) La proyección de un jugador con SOT/90 real ~0.6 (Ruiz) queda
// acotada: de 3.85 (35% fijo) a 2.20 (participación escalada por sus 4
// goles). Nota honesta: con estos datos Ruiz sigue siendo sharp por el
// borde (edge exactamente 4.0, prob 64.6%); el anclaje completo a SOT/90
// real requiere una fuente de estadísticas por jugador que hoy no existe
// en el pipeline. El test fija la proyección acotada, no una promesa de
// que Ruiz nunca genere.
test('proyección de Ruiz queda acotada (3.85 -> 2.20) y la probabilidad baja (89.7% -> 64.6%)', () => {
  const prop = calculateSoccerPlayerProps(ruiz, 2.6, 1.15, 1.15);
  assert.ok(prop);
  assert.equal(prop.projectedSot, '2.20');
  assert.equal(prop.prob, 64.6);
  assert.ok(Number(prop.projectedSot) < 3.85);
  assert.ok(prop.prob < 89.7);
});

// (iv) Un delantero real con muchos goles (Viñas, 8) SÍ genera prop como
// antes (regresión), pero con la proyección topada en MAX_PROJECTED_SOT.
test('delantero real con 8 goles (Viñas) sí genera prop, con proyección topada', () => {
  assert.equal(isPlausibleShooter(vinas), true);
  const games = [soccerGame({
    id: 'soccer-tol-atl',
    league: 'Liga MX',
    home: { name: 'Toluca', xG: '2.5', defenseXG: '1.0', keyPlayer: vinas },
    away: { name: 'Atlas', xG: '1.2', defenseXG: '1.1' },
  })];
  const props = generateDailySoccerProps(games, { requireConfirmedLineup: true });
  const vinasProp = props.find(p => p.playerName === 'Federico Viñas');
  assert.ok(vinasProp, 'Viñas debe generar prop');
  assert.equal(vinasProp.projectedSot, '2.50');
  assert.equal(vinasProp.isSharp, true);
  // Antes era 90.3% (proyectaba 3.92); ahora 71.3% (topada en 2.5).
  assert.equal(vinasProp.prob, 71.3);
});

// Tope: ni el máximo goleador con xG altísimo supera MAX_PROJECTED_SOT.
test('tope MAX_PROJECTED_SOT: ni un goleador de 11 goles con xG alto supera 2.5', () => {
  const henry = { name: 'Henry Martín', leaderCategory: 'goals', leaderValue: 11, leaderPosition: 'F' };
  const prop = calculateSoccerPlayerProps(henry, 3.0, 1.5, 1.15);
  assert.ok(prop);
  assert.equal(prop.projectedSot, MAX_PROJECTED_SOT.toFixed(2));
});

// Sturm (2 goles, proyección baja) ya no es sharp: su probabilidad cae
// de 80.7% a 45.5% y no genera prop.
test('Sturm (2 goles) ya no es sharp tras escalar la proyección', () => {
  const prop = calculateSoccerPlayerProps(sturm, 1.5, 1.1, 1.15);
  assert.ok(prop);
  assert.equal(prop.isSharp, false);
  assert.ok(prop.prob < 62);
  const games = [soccerGame({
    id: 'soccer-sla-vil',
    home: { name: 'Slavia Prague', xG: '1.5', defenseXG: '1.0', keyPlayer: sturm },
    away: { name: 'Villarreal', xG: '1.3', defenseXG: '1.1' },
  })];
  const props = generateDailySoccerProps(games, { requireConfirmedLineup: true });
  assert.equal(props.filter(p => p.playerName === 'Danijel Sturm').length, 0);
});

// Casos borde de isPlausibleShooter.
test('isPlausibleShooter: casos borde', () => {
  // Categoría que no es de goles (p. ej. asistencias) no valida.
  assert.equal(isPlausibleShooter({ name: 'Pedro Alves', leaderCategory: 'assists', leaderValue: 9, leaderPosition: 'M' }), false);
  // Sin dato de líder no se puede validar: fail-closed.
  assert.equal(isPlausibleShooter({ name: 'Carlos Ruiz' }), false);
  assert.equal(isPlausibleShooter({ name: 'Carlos Ruiz', leaderCategory: 'goals' }), false);
  // Nombre placeholder no valida.
  assert.equal(isPlausibleShooter({ name: 'Delantero Principal', leaderCategory: 'goals', leaderValue: 8, leaderPosition: 'F' }), false);
  // Portero o defensa con muchos goles no valida por posición.
  assert.equal(isPlausibleShooter({ name: 'Portero X', leaderCategory: 'goals', leaderValue: 5, leaderPosition: 'G' }), false);
  assert.equal(isPlausibleShooter({ name: 'Defensa Y', leaderCategory: 'goals', leaderValue: 5, leaderPosition: 'D' }), false);
  // Delantero con exactamente MIN_LEADER_GOALS sí valida.
  assert.equal(isPlausibleShooter({ name: 'Atacante Z', leaderCategory: 'goals', leaderValue: MIN_LEADER_GOALS, leaderPosition: 'F' }), true);
  // Centrocampista goleador (Ocampos, 7 goles) sí valida.
  assert.equal(isPlausibleShooter({ name: 'Lucas Ocampos', leaderCategory: 'goals', leaderValue: 7, leaderPosition: 'M' }), true);
});
