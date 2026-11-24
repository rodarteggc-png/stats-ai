import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectSafePicks,
  formatSafePicksMessage,
  recordSafePicks,
  SAFE_MIN_CAL_PROB,
  SAFE_MIN_ODDS,
  SAFE_MAX_ODDS
} from '../api/_lib/safePicks.js';
import { applySoccerSafeCalibration } from '../src/utils/calibration.js';
import { minPlayedForLeague } from '../api/_lib/futureData.js';

// Picks Seguros — 2026-11-24. Favoritos ML con probabilidad calibrada >= 55%
// y cuota DraftKings 1.13–1.50. NO son +EV (EV según el modelo negativo).
// La calibración es la SUAVE DE FÚTBOL (A=0.36/B=-0.03, decisión de Tavo
// 2026-11-24 15:16 CST), no el par global del refit Fase 3 (A=0.34/B=-0.33):
// con el global, las crudas reales del 24 nov —Real Madrid 80.2, Betis
// 69.2— ya NO calificaban (80.2 → cal 53.6, 69.2 → cal 48.6) y el tier se
// vaciaba. Con la suave: Real Madrid 80.2 → 61.6, Betis 69.2 → 56.5.
// Probabilidades crudas del stub: Real Madrid-like 90 → cal 68.2;
// Bodø 54.3 → cal 50.8 (sigue sin calificar); Betis-like 88 → cal 66.5.
const NOW = Date.parse('2026-11-24T12:00:00Z'); // 06:00 CST, antes del saque

function match({ home, away, homeXG, awayXG, homeOdds, awayOdds, gameDate, league = 'UEFA Champions League' }) {
  return {
    league,
    gameDate,
    home: { name: home, xG: String(homeXG), elo: 1500, daysRest: 3 },
    away: { name: away, xG: String(awayXG), elo: 1500, daysRest: 3 },
    market: { homeOdds: String(homeOdds), awayOdds: String(awayOdds) }
  };
}

// Stub de calculateMatchProbabilities: devuelve la prob cruda según el xG
// local (numérico), para no depender del Poisson real en estos tests.
function stubCalcProbs(rawByHomeXG) {
  return (homeXG) => {
    const raw = rawByHomeXG[Number(homeXG)] || { homeWin: '50.0', awayWin: '25.0' };
    return { homeWin: raw.homeWin, awayWin: raw.awayWin };
  };
}

const deps = {
  calculateMatchProbabilities: stubCalcProbs({
    2.5: { homeWin: '90', awayWin: '6.3' },   // Real Madrid-like
    2.37: { homeWin: '54.3', awayWin: '22.8' },  // Bodø-like
    1.2: { homeWin: '11.1', awayWin: '88' }   // Betis-like (favorito visitante)
  }),
  applyPlattCalibration: applySoccerSafeCalibration
};

test('Seguros: un favorito con cal 68.2 @1.13 califica (Real Madrid-like)', () => {
  const picks = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.13, awayOdds: 15, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].team, 'Real Madrid');
  assert.equal(picks[0].side, 'home');
  assert.equal(picks[0].odds, 1.13);
  assert.equal(picks[0].calProb, 68.2);
  assert.equal(picks[0].label, 'SEGURO');
  assert.ok(picks[0].evCalPct < 0, 'el EV según el modelo es negativo y se muestra');
});

test('Seguros: Bodø-like (cal 50.8 @1.37) NO califica', () => {
  const picks = selectSafePicks([
    match({ home: 'Bodo/Glimt', away: 'LASK Linz', homeXG: 2.37, awayXG: 1.46, homeOdds: 1.37, awayOdds: 7, gameDate: '2026-11-24T17:45:00Z' })
  ], NOW, deps);
  assert.equal(picks.length, 0);
});

test('Seguros: favorito visitante con cal 66.5 @1.28 califica (Betis-like)', () => {
  const picks = selectSafePicks([
    match({ home: 'Slovan Bratislava', away: 'Real Betis', homeXG: 1.2, awayXG: 2.0, homeOdds: 9.5, awayOdds: 1.28, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].team, 'Real Betis');
  assert.equal(picks[0].side, 'away');
  assert.equal(picks[0].calProb, 66.5);
});

test('Seguros: cuota fuera de rango no califica aunque la prob sea alta', () => {
  const tooShort = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.10, awayOdds: 15, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  assert.equal(tooShort.length, 0);
  const tooLong = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.60, awayOdds: 15, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  assert.equal(tooLong.length, 0);
  assert.equal(SAFE_MIN_ODDS, 1.13);
  assert.equal(SAFE_MAX_ODDS, 1.5);
  assert.equal(SAFE_MIN_CAL_PROB, 55);
});

test('Seguros: partidos ya iniciados o a más de 12 h se excluyen', () => {
  const picks = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.13, awayOdds: 15, gameDate: '2026-11-24T11:00:00Z' }), // ya empezó
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.13, awayOdds: 15, gameDate: '2026-11-25T02:00:00Z' })  // >12 h
  ], NOW, deps);
  assert.equal(picks.length, 0);
});

test('Seguros: el mensaje lleva la etiqueta SEGURO y el aviso de no +EV', () => {
  const picks = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.13, awayOdds: 15, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  const msg = formatSafePicksMessage(picks, 'MARTES 24 NOV', 9);
  assert.ok(msg.includes('PICKS SEGUROS'), 'encabezado');
  assert.ok(msg.includes('SEGURO') || msg.includes('Seguros'), 'etiqueta');
  assert.ok(msg.includes('NO son +EV'), 'aviso de no +EV');
  assert.ok(msg.includes('Real Madrid'), 'el pick');
  assert.ok(msg.includes('1.13'), 'la cuota');
  assert.ok(msg.includes('68.2%'), 'la probabilidad calibrada');
  const empty = formatSafePicksMessage([], 'MARTES 24 NOV', 9);
  assert.ok(empty.includes('No hay picks seguros'), 'mensaje vacío');
});

// Los 6 seguros en vivo del 24 nov califican con la calibración suave de
// fútbol (crudas derivadas de la corrida en vivo: Real Madrid 80.2 @1.14,
// Rangers 79.1 @1.22, Como 75.1 @1.27, Man City 73.4 @1.25, Leipzig 70.4
// @1.34, Betis 69.2 @1.24). Con el par global del refit (0.34/-0.33) los
// 6 se caían (Real Madrid 53.6, Betis 48.6); con la suave pasan todos.
test('Seguros: los 6 picks en vivo del 24 nov califican con la calibración suave', () => {
  const liveDeps = {
    calculateMatchProbabilities: stubCalcProbs({
      2.5: { homeWin: '80.2', awayWin: '10' },  // Real Madrid
      2.4: { homeWin: '79.1', awayWin: '10' },  // Rangers
      2.3: { homeWin: '75.1', awayWin: '12' },  // Como
      2.2: { homeWin: '73.4', awayWin: '13' },  // Man City
      2.1: { homeWin: '70.4', awayWin: '14' },  // Leipzig
      1.2: { homeWin: '11.1', awayWin: '69.2' } // Betis (visitante)
    }),
    applyPlattCalibration: applySoccerSafeCalibration
  };
  const picks = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.14, awayOdds: 15, gameDate: '2026-11-24T20:00:00Z' }),
    match({ home: 'Rangers', away: 'Braga', homeXG: 2.4, awayXG: 1.1, homeOdds: 1.22, awayOdds: 12, gameDate: '2026-11-24T20:00:00Z' }),
    match({ home: 'Como', away: 'AEK Athens', homeXG: 2.3, awayXG: 1.2, homeOdds: 1.27, awayOdds: 11, gameDate: '2026-11-24T20:00:00Z' }),
    match({ home: 'Man City', away: 'Napoli', homeXG: 2.2, awayXG: 1.3, homeOdds: 1.25, awayOdds: 12, gameDate: '2026-11-24T20:00:00Z' }),
    match({ home: 'RB Leipzig', away: 'Lens', homeXG: 2.1, awayXG: 1.4, homeOdds: 1.34, awayOdds: 9, gameDate: '2026-11-24T20:00:00Z' }),
    match({ home: 'Slovan Bratislava', away: 'Real Betis', homeXG: 1.2, awayXG: 2.0, homeOdds: 9.5, awayOdds: 1.24, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, liveDeps);
  assert.equal(picks.length, 6);
  const byTeam = Object.fromEntries(picks.map((p) => [p.team, p.calProb]));
  assert.equal(byTeam['Real Madrid'], 61.6);
  assert.equal(byTeam['Rangers'], 61.0);
  assert.equal(byTeam['Como'], 59.1);
  assert.equal(byTeam['Man City'], 58.3);
  assert.equal(byTeam['RB Leipzig'], 57.0);
  assert.equal(byTeam['Real Betis'], 56.5);
});

test('Seguros: recordSafePicks escribe una línea JSON por pick solo en la ruta dada', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-picks-'));
  const file = join(dir, 'safe_picks_ledger.jsonl');
  const picks = [
    { game: 'Real Madrid vs PSV Eindhoven', team: 'Real Madrid', odds: 1.13, calProb: 67 },
    { game: 'Slovan Bratislava vs Real Betis', team: 'Real Betis', odds: 1.28, calProb: 58.1 }
  ];
  const written = recordSafePicks(picks, file);
  assert.equal(written, 2);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.pick, 'Real Madrid ML');
  assert.equal(first.odds, 1.13);
  assert.equal(first.calProb, 67);
  assert.equal(JSON.parse(lines[1]).pick, 'Real Betis ML');
  assert.equal(recordSafePicks([], file), 0);
  rmSync(dir, { recursive: true, force: true });
});

// Fix A — 2026-11-24: mínimo de partidos para modelar en /futuro.
test('Fix A: minPlayedForLeague es 4 para copas y 5 para el resto', () => {
  assert.equal(minPlayedForLeague('Cup'), 4);
  assert.equal(minPlayedForLeague('League'), 5);
  assert.equal(minPlayedForLeague(undefined), 5);
  assert.equal(minPlayedForLeague(''), 5);
});
