// scripts/tuningPhase3.test.mjs — Fase 3 del plan de afinación (2026-11-24).
// R2: refit global de Platt — NFL/NCAAF/MLB a A=0.34, B=-0.33; el piso
// del candado en recalibrateFromAudit baja de A≥0.40 a A≥0.25.
// R3: NBA interina (hasta n=30 cerrados) a A=0.36, B=-0.60 — el par honesto
// de despacho (refit con candado 0.40/-0.60 compuesto con el coeficiente NBA
// viejo 0.90), NO el 0.40/-0.60 sin componer del informe.
// R4: fútbol SIN refit propio — cubierto por el par global; el refit suave
// opcional (A≈0.36/B≈-0.03) NO se aplica.
// 2026-11-25 (REVERSIÓN COMPLETA, decisión de Tavo): TODOS los deportes
// vuelven al par parcial viejo A=0.65/B=-0.20 (el refit R2/R3 queda
// revertido; /cheatsheet equilibrado entre deportes). Los tests de esta
// fase quedan como registro histórico del refit: se actualizan para fijar
// el estado vigente (par viejo en todos los deportes).
// No toca el ledger real ni los umbrales del tier Seguro ni de /futuro.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPlattCalibration,
  recalibrateFromAudit,
  getPlattCoefficients,
} from '../src/utils/calibration.js';

const OLD = { A: 0.65, B: -0.20 }; // par vigente en todos los deportes (revertido 2026-11-25)
const NBA = { A: 0.65, B: -0.20 }; // NBA también revertida al par viejo

// ---------------- R2 ----------------

test('R2: revertido 2026-11-25 — todos los deportes vuelven al par viejo A=0.65/B=-0.20', () => {
  const coefs = getPlattCoefficients();
  assert.deepEqual(coefs.futbol, OLD);
  assert.deepEqual(coefs.nfl, OLD);
  assert.deepEqual(coefs.ncaaf, OLD);
  assert.deepEqual(coefs.mlb, OLD);
  assert.deepEqual(coefs.nba, OLD);
});

test('R2: el par del refit (A=0.34/B=-0.33) ya no está en ningún deporte', () => {
  const coefs = getPlattCoefficients();
  for (const [sport, pair] of Object.entries(coefs)) {
    assert.notDeepEqual(pair, { A: 0.34, B: -0.33 }, sport);
  }
});

test('R2: los mapeos con el par viejo — cruda 70% → 58.7%, cruda 85% → 71.7% en todos los deportes', () => {
  // Par viejo A=0.65/B=-0.20 en todos los deportes (revertido 2026-11-25).
  assert.equal(applyPlattCalibration(70, 'futbol'), 58.7);
  assert.equal(applyPlattCalibration(85, 'futbol'), 71.7);
  assert.equal(applyPlattCalibration(85, 'nfl'), 71.7);
  assert.equal(applyPlattCalibration(85, 'ncaaf'), 71.7);
  assert.equal(applyPlattCalibration(85, 'mlb'), 71.7);
  assert.equal(applyPlattCalibration(70, 'nfl'), 58.7);
  assert.equal(applyPlattCalibration(70, 'nba'), 58.7);
});

test('R2: el piso del candado permite expresar A=0.34 (refit por debajo de 0.40)', () => {
  // 30 picks de fútbol sistemáticamente sobreestimados (prob 85%, 5W-25L):
  // el refit quiere irse por debajo del piso viejo (A≥0.40) y con el piso
  // nuevo (A≥0.25) lo expresa: la sugerencia toca el piso nuevo, 0.25.
  const picks = Array.from({ length: 30 }, (_, i) => ({
    sport: 'Fútbol', status: i < 5 ? 'won' : 'lost', prob: 85,
  }));
  const before = getPlattCoefficients();
  const suggested = recalibrateFromAudit(picks, 'futbol', { persist: false });
  assert.equal(suggested.A, 0.25);
  assert.ok(suggested.A < 0.40, 'el refit ya no queda atrapado en el piso viejo');
  // La sugerencia no muta la calibración del despacho (R8).
  assert.deepEqual(getPlattCoefficients(), before);
});

test('R2: los demás topes del candado no cambiaron (A≤1.80, B∈[-0.60, 0.60])', () => {
  // Un set que empuja A hacia arriba y B hacia arriba no debe superarlos.
  const picks = Array.from({ length: 30 }, (_, i) => ({
    sport: 'Fútbol', status: i < 28 ? 'won' : 'lost', prob: 95,
  }));
  const suggested = recalibrateFromAudit(picks, 'futbol', { persist: false });
  assert.ok(suggested.A <= 1.80);
  assert.ok(suggested.B >= -0.60 && suggested.B <= 0.60);
});

// ---------------- R3 ----------------

test('R3: NBA revertida 2026-11-25 — vuelve al par viejo A=0.65/B=-0.20 (el par compuesto 0.36/-0.60 queda revertido)', () => {
  assert.deepEqual(getPlattCoefficients().nba, NBA);
  assert.notDeepEqual(getPlattCoefficients().nba, { A: 0.36, B: -0.60 });
  assert.notDeepEqual(getPlattCoefficients().nba, { A: 0.40, B: -0.60 });
});

test('R3: cross-check — un pick NBA guardado como 80% con los coeficientes viejos (cruda ≈82.4%) calibra 69.1% con el par viejo', () => {
  // Con los coeficientes NBA viejos (A=0.90/B=0.00) la cruda 82.4 se
  // guardaba como 80.0%; con el par viejo A=0.65/B=-0.20 (revertido
  // 2026-11-25) esa misma cruda calibra 69.1.
  assert.equal(applyPlattCalibration(82.4, 'Baloncesto'), 69.1);
  assert.equal(applyPlattCalibration(82.4, 'nba'), 69.1);
  // Tras la reversión completa, NBA y fútbol comparten el par viejo:
  // cruda 85% da 71.7 en ambos.
  assert.equal(applyPlattCalibration(85, 'Baloncesto'), 71.7);
  assert.deepEqual(applyPlattCalibration(85, 'Baloncesto'), applyPlattCalibration(85, 'futbol'));
});

// ---------------- R4 ----------------

test('R4: revertido 2026-11-25 — todos los deportes comparten el par viejo, incluido fútbol (no es el par global del refit ni el suave opcional)', () => {
  const coefs = getPlattCoefficients();
  assert.deepEqual(coefs.futbol, OLD);
  assert.deepEqual(coefs.futbol, coefs.nfl);
  assert.deepEqual(coefs.futbol, coefs.ncaaf);
  assert.deepEqual(coefs.futbol, coefs.mlb);
  assert.deepEqual(coefs.futbol, coefs.nba);
  // El refit suave opcional del informe (A≈0.36/B≈-0.03) tampoco se aplicó
  // al despacho (solo existe en el tier Seguro, applySoccerSafeCalibration).
  assert.notDeepEqual(coefs.futbol, { A: 0.36, B: -0.03 });
  // Y el par global del refit (A=0.34/B=-0.33) ya no está en ningún deporte.
  assert.notDeepEqual(coefs.futbol, { A: 0.34, B: -0.33 });
});
