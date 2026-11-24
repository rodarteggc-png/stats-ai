// scripts/tuningPhase3.test.mjs — Fase 3 del plan de afinación (2026-11-24).
// R2: refit global de Platt — todos los deportes a A=0.34, B=-0.33; el piso
// del candado en recalibrateFromAudit baja de A≥0.40 a A≥0.25.
// R3: NBA interina (hasta n=30 cerrados) a A=0.36, B=-0.60 — el par honesto
// de despacho (refit con candado 0.40/-0.60 compuesto con el coeficiente NBA
// viejo 0.90), NO el 0.40/-0.60 sin componer del informe.
// R4: fútbol SIN refit propio — cubierto por el par global; el refit suave
// opcional (A≈0.36/B≈-0.03) NO se aplica.
// No toca el ledger real ni los umbrales del tier Seguro ni de /futuro.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPlattCalibration,
  recalibrateFromAudit,
  getPlattCoefficients,
} from '../src/utils/calibration.js';

const GLOBAL = { A: 0.34, B: -0.33 };
const NBA = { A: 0.36, B: -0.60 };

// ---------------- R2 ----------------

test('R2: los defaults globales son A=0.34/B=-0.33 para todos los deportes', () => {
  const coefs = getPlattCoefficients();
  assert.deepEqual(coefs.futbol, GLOBAL);
  assert.deepEqual(coefs.nfl, GLOBAL);
  assert.deepEqual(coefs.ncaaf, GLOBAL);
  assert.deepEqual(coefs.mlb, GLOBAL);
});

test('R2: el par parcial viejo (A=0.65/B=-0.20) ya no está en ningún deporte', () => {
  const coefs = getPlattCoefficients();
  for (const [sport, pair] of Object.entries(coefs)) {
    assert.notDeepEqual(pair, { A: 0.65, B: -0.20 }, sport);
  }
});

test('R2: los mapeos compuestos — cruda 70% → ~49%, cruda 85% → ~57% (56.5)', () => {
  // El informe dice "~57%" para la cruda 85%: el valor exacto es 56.5.
  assert.equal(applyPlattCalibration(70, 'futbol'), 49);
  assert.equal(applyPlattCalibration(85, 'futbol'), 56.5);
  assert.equal(applyPlattCalibration(85, 'nfl'), 56.5);
  assert.equal(applyPlattCalibration(85, 'ncaaf'), 56.5);
  assert.equal(applyPlattCalibration(85, 'mlb'), 56.5);
  assert.equal(applyPlattCalibration(70, 'nfl'), 49);
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

test('R3: NBA es A=0.36/B=-0.60 (par compuesto, no el 0.40/-0.60 sin componer)', () => {
  assert.deepEqual(getPlattCoefficients().nba, NBA);
  assert.notDeepEqual(getPlattCoefficients().nba, { A: 0.40, B: -0.60 });
});

test('R3: cross-check — un pick NBA guardado como 80% con los coeficientes viejos (cruda ≈82.4%) ahora calibra ~49%', () => {
  // Con los coeficientes NBA viejos (A=0.90/B=0.00) la cruda 82.4 se
  // guardaba como 80.0%; con el par R3 esa misma cruda calibra 48.9.
  assert.equal(applyPlattCalibration(82.4, 'Baloncesto'), 48.9);
  assert.equal(applyPlattCalibration(82.4, 'nba'), 48.9);
  // Y la NBA ya no comparte el par global: cruda 85% da 50.6, no 56.5.
  assert.equal(applyPlattCalibration(85, 'Baloncesto'), 50.6);
  assert.notEqual(applyPlattCalibration(85, 'Baloncesto'), applyPlattCalibration(85, 'futbol'));
});

// ---------------- R4 ----------------

test('R4: fútbol NO tiene refit propio — es el par global, no el suave opcional', () => {
  const coefs = getPlattCoefficients();
  assert.deepEqual(coefs.futbol, GLOBAL);
  assert.deepEqual(coefs.futbol, coefs.nfl);
  assert.deepEqual(coefs.futbol, coefs.ncaaf);
  assert.deepEqual(coefs.futbol, coefs.mlb);
  // El refit suave opcional del informe (A≈0.36/B≈-0.03) NO se aplicó.
  assert.notDeepEqual(coefs.futbol, { A: 0.36, B: -0.03 });
});
