import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEspnFootballTeamStats } from '../src/services/sportsApi.js';

// Stats reales de ESPN para NFL/NCAAF (2026-11-19).
// Antes, passYardsAvg era un estimado derivado (YPP × 45). Ahora se parsean
// las categorías reales de ESPN (/teams/{id}/statistics) y el QB muestra
// yardas/TD/INT medidos. Fixture con los valores reales de Indianapolis
// Colts verificados en vivo el 19 nov 2026 (10 juegos).

const COLTS_CATEGORIES = [
  { name: 'passing', stats: [
    { name: 'completionPct', displayValue: '59.8' },
    { name: 'completions', displayValue: '195' },
    { name: 'interceptions', displayValue: '12' },
    { name: 'netPassingYards', displayValue: '1,667' },
    { name: 'netPassingYardsPerGame', displayValue: '166.7' },
    { name: 'passingAttempts', displayValue: '326' },
    { name: 'passingTouchdowns', displayValue: '7' },
    { name: 'QBRating', displayValue: '67.2' },
    { name: 'sacks', displayValue: '26' },
  ] },
  { name: 'rushing', stats: [
    { name: 'rushingYards', displayValue: '1,209' },
    { name: 'rushingYardsPerGame', displayValue: '120.9' },
    { name: 'rushingTouchdowns', displayValue: '12' },
    { name: 'teamGamesPlayed', displayValue: '10' },
    { name: 'totalYards', displayValue: '3,047' },
  ] },
  { name: 'receiving', stats: [
    { name: 'receivingYards', displayValue: '1,838' },
    { name: 'receivingYardsPerGame', displayValue: '183.8' },
    { name: 'receivingTouchdowns', displayValue: '7' },
  ] },
  { name: 'general', stats: [
    { name: 'totalOffensivePlays', displayValue: '609' },
    { name: 'turnOverDifferential', displayValue: '2' },
  ] },
];

test('parseEspnFootballTeamStats: valores reales de Colts (verificado en vivo)', () => {
  const s = parseEspnFootballTeamStats(COLTS_CATEGORIES);
  assert.equal(s.passYardsPerGame, 166.7, 'yardas por pase por juego');
  assert.equal(s.passYards, 1667, 'yardas por pase totales (coma eliminada)');
  assert.equal(s.passTd, 7, 'touchdowns por pase');
  assert.equal(s.passInt, 12, 'intercepciones');
  assert.equal(s.completionPct, 59.8, 'porcentaje de pases completos');
  assert.equal(s.rushYardsPerGame, 120.9, 'yardas por tierra por juego');
  assert.equal(s.rushTd, 12, 'touchdowns por tierra');
  assert.equal(s.recYardsPerGame, 183.8, 'yardas por recepción por juego');
  assert.equal(s.recTd, 7, 'touchdowns por recepción');
  assert.equal(s.gamesPlayed, 10, 'juegos jugados');
  assert.equal(s.totalYards, 3047, 'yardas totales');
  assert.equal(s.totalPlays, 609, 'jugadas ofensivas totales');
  assert.equal(s.turnoverDiff, 2, 'diferencial de balones perdidos');
});

test('parseEspnFootballTeamStats: el estimado YPP×45 ya no es la fuente', () => {
  const s = parseEspnFootballTeamStats(COLTS_CATEGORIES);
  // El estimado viejo era YPP × 45. YPP real de Colts = 3047/609 = 5.00,
  // así que el estimado habría dado ~225 yd/j. El dato real es 166.7.
  const ypp = s.totalYards / s.totalPlays;
  assert.ok(Math.abs(ypp - 5.0) < 0.05, `YPP ${ypp} ≈ 5.0`);
  assert.notEqual(s.passYardsPerGame, Math.round(ypp * 45),
    'el valor real (166.7) es distinto del estimado YPP×45 (~225)');
  assert.equal(s.passYardsPerGame, 166.7);
});

test('parseEspnFootballTeamStats: categorías vacías o ausentes -> todo null (fail-safe)', () => {
  for (const input of [[], null, undefined, [{ name: 'passing', stats: [] }]]) {
    const s = parseEspnFootballTeamStats(input);
    assert.equal(s.passYardsPerGame, null);
    assert.equal(s.passTd, null);
    assert.equal(s.passInt, null);
    assert.equal(s.rushYardsPerGame, null);
    assert.equal(s.totalYards, null);
    assert.equal(s.totalPlays, null);
  }
});

test('parseEspnFootballTeamStats: categoría parcial no rompe el resto', () => {
  const s = parseEspnFootballTeamStats([
    { name: 'passing', stats: [{ name: 'netPassingYardsPerGame', displayValue: '250.5' }] },
  ]);
  assert.equal(s.passYardsPerGame, 250.5);
  assert.equal(s.passTd, null, 'sin touchdowns en el fixture, queda null');
  assert.equal(s.rushYardsPerGame, null);
});
