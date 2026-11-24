// scripts/tuningPhase2.test.mjs — Fase 2 del plan de afinación (2026-11-24).
// R8: el despacho aplica la calibración DOCUMENTADA (global A=0.34/B=-0.33,
// NBA A=0.36/B=-0.60 desde la Fase 3, 2026-11-24); la
// auditoría solo SUGIERE coeficientes (persist:false) y el cloud ledger ya
// no los hidrata. R7: el ledger registra procedencia real (oddsSource /
// sharpBook / isPinnacle); sin procedencia queda null, nunca 'market'.
// No toca el ledger real: recordPickToLedger se llama con { ledgerFile }
// temporal (mismo patrón que recordPaperPick con { paperPath } en Fase 1).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { recordPickToLedger, attachSharpBookmaker } from './alertEngine.js';
import {
  applyPlattCalibration,
  recalibrateFromAudit,
  getPlattCoefficients,
  hydratePlattCoefficients,
} from '../src/utils/calibration.js';
import { buildPaperEntry } from '../src/utils/paperLedger.js';

const DOCUMENTED = { A: 0.34, B: -0.33 }; // global (fútbol, NFL, NCAAF, MLB)
const DOCUMENTED_NBA = { A: 0.36, B: -0.60 }; // R3 interino hasta n=30

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-phase2-'));
  return { dir, file: path.join(dir, 'pick_ledger.jsonl') };
}

function readLedger(file) {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function dispatchedPick(overrides = {}) {
  return {
    id: 'test-pick-001',
    sport: 'Fútbol',
    league: 'LaLiga',
    game: 'Deportivo vs Osasuna',
    gameDate: '2026-11-24T20:00:00Z',
    pick: 'Deportivo o Empate (1X)',
    type: '🛡️ DOBLE OPORTUNIDAD',
    odds: 1.27,
    prob: '72.9%',
    rawProb: '86.2',
    evPct: 5.16,
    consensus: { votesPassed: 2 },
    ...overrides,
  };
}

// ---------------- R8 ----------------

test('R8: el despacho aplica la calibración documentada, no la del ledger viejo', () => {
  // Las 7 filas con rawProb del ledger (oct 29 / nov 2) guardan Platt con los
  // coeficientes DE ESA ÉPOCA (fútbol 0.88/-0.04, NBA 0.90/0, NCAAF 0.85/0);
  // con los defaults documentados actuales (global 0.34/-0.33, NBA 0.36/-0.60)
  // dan estos valores.
  assert.equal(applyPlattCalibration(63.2, 'Baloncesto'), 40);
  assert.equal(applyPlattCalibration(86.2, 'Fútbol'), 57.3);
  assert.equal(applyPlattCalibration(87.7, 'Fútbol'), 58.4);
  // ...y NO los valores guardados entonces (61.9 / 82.8 / 84.4).
  assert.notEqual(applyPlattCalibration(63.2, 'Baloncesto'), 61.9);
  assert.notEqual(applyPlattCalibration(86.2, 'Fútbol'), 82.8);
  assert.deepEqual(getPlattCoefficients().futbol, DOCUMENTED);
  assert.deepEqual(getPlattCoefficients().nba, DOCUMENTED_NBA);
  assert.deepEqual(getPlattCoefficients().ncaaf, DOCUMENTED);
});

test('R8: con menos de 30 picks auditados no hay refit ni mutación', () => {
  const few = Array.from({ length: 10 }, (_, i) => ({
    sport: 'Fútbol', status: i % 2 ? 'won' : 'lost', prob: 65,
  }));
  const before = getPlattCoefficients();
  assert.deepEqual(recalibrateFromAudit(few, 'futbol'), DOCUMENTED);
  assert.deepEqual(getPlattCoefficients(), before);
});

// 30 picks de fútbol sistemáticamente sobreestimados (prob 85%, casi todos perdidos).
function miscalibratedFutbol() {
  return Array.from({ length: 30 }, (_, i) => ({
    sport: 'Fútbol', status: i < 5 ? 'won' : 'lost', prob: 85,
  }));
}

test('R8: la auditoría (persist:false) sugiere sin mutar la calibración del despacho', () => {
  const picks = miscalibratedFutbol();
  const suggested = recalibrateFromAudit(picks, 'futbol', { persist: false });
  assert.notDeepEqual(suggested, DOCUMENTED); // el refit sí se calculó
  // ...pero el despacho sigue con los defaults documentados, en el mismo proceso.
  assert.deepEqual(getPlattCoefficients().futbol, DOCUMENTED);
  assert.equal(applyPlattCalibration(86.2, 'Fútbol'), 57.3);
  assert.equal(applyPlattCalibration(63.2, 'Baloncesto'), 40);
});

test('R8: con persist (defecto, ruta del navegador) el refit sí se aplica y se restaura', () => {
  const picks = miscalibratedFutbol();
  const suggested = recalibrateFromAudit(picks, 'futbol', { persist: false });
  const applied = recalibrateFromAudit(picks, 'futbol');
  assert.deepEqual(applied, suggested);
  assert.deepEqual(getPlattCoefficients().futbol, suggested);
  // Restaurar los defaults documentados para no contaminar el resto de la suite.
  hydratePlattCoefficients({
    futbol: DOCUMENTED, nfl: DOCUMENTED, ncaaf: DOCUMENTED, mlb: DOCUMENTED, nba: DOCUMENTED_NBA,
  });
  assert.deepEqual(getPlattCoefficients().futbol, DOCUMENTED);
  assert.deepEqual(getPlattCoefficients().nba, DOCUMENTED_NBA);
});

// ---------------- R7 ----------------

test('R7: un pick con procedencia sharp queda registrado con sus valores reales', () => {
  const { dir, file } = tmpLedger();
  try {
    const pick = dispatchedPick({
      oddsSource: 'market', oddsProvider: 'Pinnacle',
      sharpBookmaker: 'Pinnacle', isPinnacle: true,
    });
    recordPickToLedger(pick, 1.0, { ledgerFile: file });
    recordPickToLedger(pick, 1.0, { ledgerFile: file }); // duplicado: no se re-escribe
    const rows = readLedger(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].oddsSource, 'market');
    assert.equal(rows[0].oddsProvider, 'Pinnacle');
    assert.equal(rows[0].sharpBook, 'Pinnacle');
    assert.equal(rows[0].isPinnacle, true);
    assert.equal(rows[0].prob, 72.9);
    assert.equal(rows[0].rawProb, 86.2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R7: un pick sin procedencia queda en null, nunca con market inventado', () => {
  const { dir, file } = tmpLedger();
  try {
    // Forma de un pick del portal (registerPortalUnanimousPicks): sin
    // oddsSource, sin sharpBookmaker y sin isPinnacle.
    const pick = dispatchedPick();
    delete pick.oddsSource;
    recordPickToLedger(pick, 1.0, { ledgerFile: file });
    const rows = readLedger(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].oddsSource, null);
    assert.equal(rows[0].oddsProvider, null);
    assert.equal(rows[0].sharpBook, null);
    assert.equal(rows[0].isPinnacle, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R7: attachSharpBookmaker deriva Pinnacle del nombre aunque falte el flag', () => {
  const opp = {
    oddsSource: 'market',
    match: { market: { sharpBookmaker: 'Pinnacle' } },
  };
  attachSharpBookmaker(opp);
  assert.equal(opp.sharpBookmaker, 'Pinnacle');
  assert.equal(opp.isPinnacle, true);
});

test('R7: attachSharpBookmaker distingue Bet365 de Pinnacle y copia sharpBook', () => {
  const opp = {
    oddsSource: 'market',
    match: { market: { sharpBookmaker: 'Bet365', isPinnacle: false } },
  };
  attachSharpBookmaker(opp);
  assert.equal(opp.sharpBookmaker, 'Bet365');
  assert.equal(opp.isPinnacle, false);
});

test('R7: attachSharpBookmaker no afirma precio sharp cuando el tier no es market', () => {
  const espn = {
    oddsSource: 'espn',
    match: { market: { sharpBookmaker: 'Pinnacle', isPinnacle: true } },
  };
  attachSharpBookmaker(espn);
  assert.equal(espn.sharpBookmaker, null);
  assert.equal(espn.isPinnacle, false);

  const assumed = {
    oddsSource: 'assumed', sharpBookmaker: 'Pinnacle', isPinnacle: true,
    match: { market: { sharpBookmaker: 'Pinnacle', isPinnacle: true } },
  };
  attachSharpBookmaker(assumed);
  assert.equal(assumed.sharpBookmaker, null);
  assert.equal(assumed.isPinnacle, false);

  const model = { oddsSource: 'model' };
  attachSharpBookmaker(model);
  assert.equal(model.sharpBookmaker, null);
  assert.equal(model.isPinnacle, false);
});

test('R7: la cadena attach -> ledger lleva la procedencia del match al registro', () => {
  const { dir, file } = tmpLedger();
  try {
    const opp = dispatchedPick({
      oddsSource: 'market', oddsProvider: 'Pinnacle',
      match: { market: { sharpBookmaker: 'Pinnacle', isPinnacle: true } },
    });
    delete opp.sharpBookmaker;
    delete opp.isPinnacle;
    attachSharpBookmaker(opp);
    recordPickToLedger(opp, 1.0, { ledgerFile: file });
    const rows = readLedger(file);
    assert.equal(rows[0].oddsSource, 'market');
    assert.equal(rows[0].sharpBook, 'Pinnacle');
    assert.equal(rows[0].isPinnacle, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R7: la entrada paper traslada la procedencia y no inventa market', () => {
  const withProv = buildPaperEntry(
    { ...dispatchedPick(), oddsSource: 'market', sharpBookmaker: 'Pinnacle', isPinnacle: true },
    { vetoReason: 'spread_paused', shift: 'matutino' },
  );
  assert.equal(withProv.oddsSource, 'market');
  assert.equal(withProv.sharpBook, 'Pinnacle');
  assert.equal(withProv.isPinnacle, true);

  const withoutProv = buildPaperEntry(dispatchedPick(), { shift: 'matutino' });
  assert.equal(withoutProv.oddsSource, null);
  assert.equal(withoutProv.sharpBook, null);
  assert.equal(withoutProv.isPinnacle, false);
});
