// scripts/tuningPhase1.test.mjs — Fase 1 del plan de afinación (2026-11-24).
// R1: TODOS los spreads en pausa (incluida NBA en vivo) y registro paper.
// R5: tope de probabilidad MOSTRADA en 80% (display-only).
// No toca el ledger real: el registro paper de estos tests usa un archivo
// temporal (recordPaperPick con { paperPath }).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyOpportunity, generateCheatsheetReport, recordPaperPick } from './alertEngine.js';
import { calculateKellyStake } from '../src/utils/kelly.js';
import { buildPaperEntry, computePaperStats, paperSlateMessage, vetoReasonLabel } from '../src/utils/paperLedger.js';
import { capDisplayedProb, formatDisplayedProb, DISPLAY_PROB_CAP_PCT } from '../src/utils/displayProb.js';
import { selectHighProbabilityCandidates, buildConservativeCombination, formatFutureMultiSport } from '../api/_lib/futureMultiSport.js';

// Perfil base que pasa todos los filtros salvo la pausa de spreads.
function spreadBase(overrides = {}) {
  return {
    sport: 'Baloncesto', league: 'NBA', game: 'Utah Jazz vs Miami Heat',
    pick: 'Utah Jazz +9.5 (Cubre Línea)', type: '🏀 SPREAD NBA', odds: 1.91, prob: '60',
    evPct: 5, match: { isPostponed: false }, oddsSource: 'market',
    ratingsSource: 'live',
    consensus: { votesPassed: 3 }, tipsterAudit: { isApproved: true },
    ...overrides,
  };
}

// ---------------- R1 ----------------

test('R1: un spread NBA con ratings en vivo se veta spread_paused y no se despacha', () => {
  const verdict = classifyOpportunity(spreadBase());
  assert.equal(verdict.approved, false);
  assert.equal(verdict.vetoReason, 'spread_paused');
});

test('R1: el veto cubre todos los deportes y el total equivalente sigue aprobado', () => {
  assert.equal(classifyOpportunity(spreadBase({ sport: 'Fútbol Americano', league: 'NFL' })).vetoReason, 'spread_paused');
  assert.equal(classifyOpportunity(spreadBase({ sport: 'NCAAF', league: 'NCAAF' })).vetoReason, 'spread_paused');
  const total = spreadBase({ pick: 'UNDER 240.5 Pts', type: '🏀 TOTALES NBA (UNDER)' });
  assert.equal(classifyOpportunity(total).approved, true);
  assert.equal(classifyOpportunity(total).vetoReason, null);
});

test('R1: la etiqueta del veto cita el récord forense (1W-12L)', () => {
  assert.match(vetoReasonLabel('spread_paused'), /1W-12L/);
  assert.equal(classifyOpportunity(spreadBase()).vetoDetail, 'Spreads en pausa: mercado en medición (1W-12L en el ledger)');
});

test('R1: la entrada paper de un spread vetado trae todo lo necesario para calificarlo después', () => {
  const opp = { ...spreadBase(), rawProb: 63.2, prob: '61.9', gameDate: '2026-11-24T18:00:00Z', oddsSource: 'market' };
  const entry = buildPaperEntry(opp, { vetoReason: 'spread_paused', vetoDetail: 'Spreads en pausa', shift: 'vespertino', wouldStake: 1.0 });
  assert.equal(entry.vetoReason, 'spread_paused');
  assert.equal(entry.paper, true);
  assert.equal(entry.status, 'PENDING');
  assert.equal(entry.sport, 'Baloncesto');
  assert.equal(entry.game, 'Utah Jazz vs Miami Heat');
  assert.equal(entry.gameDate, '2026-11-24T18:00:00Z');
  assert.equal(entry.type, '🏀 SPREAD NBA');
  assert.match(entry.pick, /\+9\.5/); // la línea, para el cover medio
  assert.equal(entry.prob, 61.9); // calibrada real (sin topar: el registro guarda el modelo)
  assert.equal(entry.rawProb, 63.2);
  assert.equal(entry.placedOdds, 1.91);
  assert.equal(entry.oddsSource, 'market');
  assert.match(entry.id, /veto-vespertino-2026-11-24/);
});

test('R1: recordPaperPick asienta el spread vetado en el ledger paper (temporal) y lo deduplica', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-phase1-'));
  const paperPath = path.join(dir, 'paper_ledger.jsonl');
  const entry = buildPaperEntry(spreadBase(), { vetoReason: 'spread_paused', shift: 'matutino', wouldStake: 1.0 });
  assert.equal(recordPaperPick(entry, { paperPath }), true);
  assert.equal(recordPaperPick(entry, { paperPath }), false); // duplicado por id
  const lines = fs.readFileSync(paperPath, 'utf-8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const saved = JSON.parse(lines[0]);
  assert.equal(saved.vetoReason, 'spread_paused');
  assert.equal(saved.paper, true);
  assert.match(saved.pick, /\+9\.5/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R1: el reporte paper agrupa los spreads vetados por motivo (base del criterio 20+)', () => {
  const entries = [
    buildPaperEntry(spreadBase(), { vetoReason: 'spread_paused', shift: 'matutino' }),
    buildPaperEntry(spreadBase({ game: 'Boston Celtics vs Chicago Bulls', pick: 'Chicago Bulls +10.5 (Cubre Línea)' }), { vetoReason: 'spread_paused', shift: 'matutino' }),
    buildPaperEntry(spreadBase({ pick: 'UNDER 240.5 Pts', type: '🏀 TOTALES NBA (UNDER)' }), { shift: 'matutino' }),
  ];
  const stats = computePaperStats(entries);
  assert.equal(stats.vetoReasons.spread_paused.count, 2);
  assert.equal(stats.vetoed.n, 2);
  assert.equal(stats.emitted.n, 1);
});

// ---------------- R5 ----------------

test('R5: el tope de display es 80 y no toca valores por debajo', () => {
  assert.equal(DISPLAY_PROB_CAP_PCT, 80);
  assert.equal(capDisplayedProb(94.8), 80);
  assert.equal(capDisplayedProb('94.8%'), 80);
  assert.equal(capDisplayedProb(80), 80);
  assert.equal(capDisplayedProb(60), 60);
  assert.equal(capDisplayedProb('60%'), 60);
  assert.equal(capDisplayedProb('sin dato'), 'sin dato');
});

test('R5: el formateador de display topa en 80% y conserva el resto', () => {
  assert.equal(formatDisplayedProb('94.8%'), '80.0%');
  assert.equal(formatDisplayedProb(94.8), '80.0%');
  assert.equal(formatDisplayedProb('60%'), '60%');
  assert.equal(formatDisplayedProb(60), '60%');
});

test('R5: la cheatsheet muestra 80% en un pick de 94.8% y no muta el pick', () => {
  const pick = {
    sport: 'Fútbol', league: 'Premier League', game: 'Liverpool vs Arsenal',
    pick: 'Victoria Liverpool (1X2)', odds: '1.90', prob: '94.8%', edgeStr: '+12.0% EV vs Vegas',
    match: { home: { name: 'Liverpool', defXg: 1.0, elo: 1600 }, away: { name: 'Arsenal', defXg: 1.0, elo: 1600 } },
  };
  const text = generateCheatsheetReport([pick], 'HOY');
  assert.match(text, /80\.0%/);
  assert.doesNotMatch(text, /94\.8/);
  assert.equal(pick.prob, '94.8%'); // display-only: el pick no se muta
});

test('R5: /futuro muestra 80.0% en un candidato de 94.8% y la selección sigue usando la prob interna', () => {
  const start = Date.parse('2026-11-02T18:00:00Z');
  const cand = { sport: 'NFL', game: 'A vs B', gameDate: '2026-11-03T18:00:00Z', pick: 'Victoria A', prob: '94.8%', odds: 1.5, oddsSource: 'market', evPct: 20, consensus: { votesPassed: 3 }, match: { home: { name: 'A' }, away: { name: 'B' } } };
  // La selección (gate >=65%) sigue usando la prob interna: el candidato entra.
  const selected = selectHighProbabilityCandidates([cand], start, start + 48 * 3600000);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].prob, '94.8%');
  const text = formatFutureMultiSport({ start: new Date(start).toISOString(), end: new Date(start + 48 * 3600000).toISOString(), coverage: { futbol: {}, nba: {}, nfl: {}, ncaaf: {}, mlb: {} }, candidates: selected, combination: null, notices: [], usage: { requests: 0, oddsCalls: 0, oddsCredits: 0 } });
  assert.match(text, /80\.0%/);
  assert.doesNotMatch(text, /94\.8/);
  assert.equal(cand.prob, '94.8%'); // display-only: el candidato no se muta
});

test('R5: /futuro calcula la conjunta MOSTRADA con las patas topadas, sin tocar la interna', () => {
  const legA = { game: 'A vs B', pick: 'Victoria A', prob: '94.8%', odds: 1.5, oddsSource: 'market', evPct: 20, consensus: { votesPassed: 3 }, match: { home: { name: 'A' }, away: { name: 'B' } } };
  const legB = { game: 'C vs D', pick: 'Victoria C', prob: '90%', odds: 1.6, oddsSource: 'market', evPct: 15, consensus: { votesPassed: 3 }, match: { home: { name: 'C' }, away: { name: 'D' } } };
  const combo = buildConservativeCombination([legA, legB]);
  assert.ok(Math.abs(combo.probability - 85.32) < 0.001); // interna intacta (gate >=60%)
  const start = Date.parse('2026-11-02T18:00:00Z');
  const text = formatFutureMultiSport({ start: new Date(start).toISOString(), end: new Date(start + 48 * 3600000).toISOString(), coverage: { futbol: {}, nba: {}, nfl: {}, ncaaf: {}, mlb: {} }, candidates: [legA, legB], combination: combo, notices: [], usage: { requests: 0, oddsCalls: 0, oddsCredits: 0 } });
  assert.match(text, /Probabilidad conjunta: 64\.0%/); // 80% x 80% mostrados
  assert.doesNotMatch(text, /85\.3/);
});

test('R5: el slate paper muestra la cal. topada y conserva la cruda como diagnóstico', () => {
  const entry = buildPaperEntry(spreadBase({ pick: 'UNDER 240.5 Pts', type: '🏀 TOTALES NBA (UNDER)' }), { shift: 'matutino' });
  entry.prob = 94.8;
  entry.rawProb = 94.8;
  const text = paperSlateMessage({ shiftLabel: 'VESPERTINO', dateStr: '2026-11-24', emitted: [entry], vetoed: [], approvedNotInSlate: [] });
  assert.match(text, /Prob cal\. 80 /);
  assert.match(text, /\(cruda 94\.8\)/); // la cruda sigue visible: es diagnóstico, solo la ve Tavo
});

test('R5: la matemática interna sigue usando la prob real (Kelly difiere entre 94.8% y 80%)', () => {
  // Fracción 0.01 para no tocar el tope de 2.0u: 94.8% -> ~0.9u, 80% -> ~0.6u.
  const kellyReal = calculateKellyStake('94.8', 1.91, 0.01, 2.0);
  const kellyCapped = calculateKellyStake('80', 1.91, 0.01, 2.0);
  assert.ok(kellyReal.rawUnits > 0 && kellyCapped.rawUnits > 0);
  assert.notEqual(kellyReal.rawUnits, kellyCapped.rawUnits);
  assert.ok(kellyReal.rawUnits > kellyCapped.rawUnits);
});
