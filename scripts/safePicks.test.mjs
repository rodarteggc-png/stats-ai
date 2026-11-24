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
import { applyPlattCalibration } from '../src/utils/calibration.js';
import { minPlayedForLeague } from '../api/_lib/futureData.js';

// Picks Seguros — 2026-11-24. Favoritos ML con probabilidad calibrada >= 55%
// y cuota DraftKings 1.13–1.50. NO son +EV (EV según el modelo negativo).
// Probabilidades crudas reales del modelo Poisson del 24 nov 2026:
// Real Madrid 80.2 → cal 67.0; Bodø 54.3 → cal 47.8; Betis 69.2 → cal 58.1.
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
    2.5: { homeWin: '80.2', awayWin: '6.3' },   // Real Madrid-like
    2.37: { homeWin: '54.3', awayWin: '22.8' },  // Bodø-like
    1.2: { homeWin: '11.1', awayWin: '69.2' }   // Betis-like (favorito visitante)
  }),
  applyPlattCalibration
};

test('Seguros: un favorito con cal 67.0 @1.13 califica (Real Madrid-like)', () => {
  const picks = selectSafePicks([
    match({ home: 'Real Madrid', away: 'PSV Eindhoven', homeXG: 2.5, awayXG: 1.0, homeOdds: 1.13, awayOdds: 15, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].team, 'Real Madrid');
  assert.equal(picks[0].side, 'home');
  assert.equal(picks[0].odds, 1.13);
  assert.equal(picks[0].calProb, 67);
  assert.equal(picks[0].label, 'SEGURO');
  assert.ok(picks[0].evCalPct < 0, 'el EV según el modelo es negativo y se muestra');
});

test('Seguros: Bodø-like (cal 47.8 @1.37) NO califica', () => {
  const picks = selectSafePicks([
    match({ home: 'Bodo/Glimt', away: 'LASK Linz', homeXG: 2.37, awayXG: 1.46, homeOdds: 1.37, awayOdds: 7, gameDate: '2026-11-24T17:45:00Z' })
  ], NOW, deps);
  assert.equal(picks.length, 0);
});

test('Seguros: favorito visitante con cal 58.1 @1.28 califica (Betis-like)', () => {
  const picks = selectSafePicks([
    match({ home: 'Slovan Bratislava', away: 'Real Betis', homeXG: 1.2, awayXG: 2.0, homeOdds: 9.5, awayOdds: 1.28, gameDate: '2026-11-24T20:00:00Z' })
  ], NOW, deps);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].team, 'Real Betis');
  assert.equal(picks[0].side, 'away');
  assert.equal(picks[0].calProb, 58.1);
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
  assert.ok(msg.includes('67%'), 'la probabilidad calibrada');
  const empty = formatSafePicksMessage([], 'MARTES 24 NOV', 9);
  assert.ok(empty.includes('No hay picks seguros'), 'mensaje vacío');
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
