// scripts/tuningPhase4.test.mjs — Fase 4 del plan de afinación (2026-11-24).
// R6: subir la dispersión asumida de totales en deportes americanos (NO la
// media). Evidencia (§2.1 del informe forense): media actual−línea ≈ 0 en
// los tres deportes, pero DE observada 16.03 (NBA) y 21.43 (NCAAF) con colas
// pesadas (|dev|>30 en 3/33). El modelo subestimaba la dispersión y por
// tanto sobreestimaba la probabilidad de cubrir totales lejos de la línea.
//
// PARÁMETROS VERIFICADOS EN CÓDIGO (el informe no los fijaba):
// - Despacho NFL/NCAAF: src/utils/gridiron.js calculateTotalOverUnderProbability,
//   sigmaTotal = isCollege ? 15.20 : 13.80  →  NCAAF 21.0, NFL 13.80 (sin cambio).
// - Simulador Monte Carlo: src/utils/monteCarlo.js simulateNflMatch,
//   sigmaTot = isCol ? 14.5 : 9.8  →  colegial 21.0, NFL 9.8 (sin cambio).
//   (Su overProb no se lee en el despacho — solo cubre spreads con
//   calibratedHomeCover — pero es el mismo parámetro R6 en el simulador web.)
// - Despacho NBA: src/utils/hoops.js calculateNbaProbabilities, totalStdDev
//   17.5 — SIN CAMBIO (desviación del objetivo literal del informe, con
//   evidencia): ya está por encima de la DE observada (16.03). El "σ=14.7"
//   del informe es la σ de MARGEN (spreadStdDev), no la de totales; bajar
//   el total a ~16 aumentaría la sobreconfianza, lo contrario de R6.
//   Monte Carlo NBA (sigmaTotal 17.5, solo simulador) tampoco cambia.
// - Fútbol: totales por Poisson (simulateSoccerMatch), sin parámetro σ:
//   SIN CAMBIO. R9 no bloquea el cambio NCAAF: es la única excepción
//   explícita autorizada (dispersión de totales, no refit ni umbrales).
// No toca el ledger real, la media de ningún total, ningún umbral, el tope
// market_outlier (12 pp) ni el gate MC riskLevel 'Alto'.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateTotalOverUnderProbability } from '../src/utils/gridiron.js';
import { calculateNbaProbabilities } from '../src/utils/hoops.js';
import { simulateNflMatch, simulateSoccerMatch } from '../src/utils/monteCarlo.js';

const NCAAF = true;
const NFL = false;

// ---------------- R6: gridiron (despacho NFL/NCAAF, determinista) ----------------

test('R6: NCAAF σ=21 — un total lejos de la línea se acerca a 50% (menos extremo)', () => {
  // Con σ=15.20 (vieja): pred 70 → over 87.5; pred 60 → 68.9; pred 40 → 20.5.
  // Con σ=21.0 (nueva): los tres se acercan a 50%.
  const farOver = calculateTotalOverUnderProbability(70, 52.5, 0, NCAAF);
  assert.equal(farOver.overProb, '79.8');
  assert.ok(Math.abs(79.8 - 50) < Math.abs(87.5 - 50), '70 vs 52.5: 79.8 está más cerca de 50 que 87.5');

  const midOver = calculateTotalOverUnderProbability(60, 52.5, 0, NCAAF);
  assert.equal(midOver.overProb, '64.0');
  assert.ok(Math.abs(64.0 - 50) < Math.abs(68.9 - 50), '60 vs 52.5: 64.0 está más cerca de 50 que 68.9');

  const farUnder = calculateTotalOverUnderProbability(40, 52.5, 0, NCAAF);
  assert.equal(farUnder.overProb, '27.6');
  assert.ok(Math.abs(27.6 - 50) < Math.abs(20.5 - 50), '40 vs 52.5: 27.6 está más cerca de 50 que 20.5');
});

test('R6: NCAAF — un total pegado a la línea apenas se mueve', () => {
  // pred 53 vs línea 52.5: 51.3 (σ=15.20) → 50.9 (σ=21.0): Δ 0.4 pp.
  const near = calculateTotalOverUnderProbability(53, 52.5, 0, NCAAF);
  assert.equal(near.overProb, '50.9');
  assert.ok(Math.abs(50.9 - 51.3) <= 0.5, 'cerca de la línea el cambio es ≤0.5 pp');
  // En la línea exacta sigue siendo 50/50 con cualquier σ.
  const onLine = calculateTotalOverUnderProbability(52.5, 52.5, 0, NCAAF);
  assert.equal(onLine.overProb, '50.0');
  assert.equal(onLine.underProb, '50.0');
});

test('R6: (a) la media del total NO cambia — effectiveTotal idéntico antes/después', () => {
  // effectiveTotal solo depende del total proyectado y del viento, nunca de σ.
  for (const pred of [40, 52.5, 53, 60, 70]) {
    const r = calculateTotalOverUnderProbability(pred, 52.5, 0, NCAAF);
    assert.equal(r.effectiveTotal, pred.toFixed(1), `pred ${pred}: la media sigue siendo ${pred}`);
  }
  // Con viento la media es pred − penalización, igual que antes del cambio.
  const windy20 = calculateTotalOverUnderProbability(60, 52.5, 20, NCAAF);
  assert.equal(windy20.windPenalty, '2.8');
  assert.equal(windy20.effectiveTotal, '57.2');
  const windy30 = calculateTotalOverUnderProbability(60, 52.5, 30, NCAAF);
  assert.equal(windy30.windPenalty, '6.3');
  assert.equal(windy30.effectiveTotal, '53.7');
  // NFL: la media tampoco cambia (σ NFL intacta).
  assert.equal(calculateTotalOverUnderProbability(70, 52.5, 0, NFL).effectiveTotal, '70.0');
});

test('R6: NFL SIN cambio — σ sigue en 13.80 (n=0 picks, sin evidencia propia)', () => {
  // Valores exactos con σ=13.80, idénticos a los medidos antes del cambio.
  assert.equal(calculateTotalOverUnderProbability(70, 52.5, 0, NFL).overProb, '89.8');
  assert.equal(calculateTotalOverUnderProbability(60, 52.5, 0, NFL).overProb, '70.7');
  assert.equal(calculateTotalOverUnderProbability(70, 52.5, 0, NFL).underProb, '10.2');
});

// ---------------- R6: NBA sin cambio (σ totales 17.5 ya cubre DE 16.03) ----------------

test('R6: NBA SIN cambio — totalStdDev sigue en 17.5 (no en ~16)', () => {
  // Equipos desconocidos → promedio de liga: proyectado 227.2 pts.
  const far = calculateNbaProbabilities({
    home: { name: 'Equipo X' }, away: { name: 'Equipo Y' }, spread: -4.5, total: 245,
  });
  assert.equal(far.projectedTotal, 227.2);
  // Con σ=17.5: over 15.4. Con σ=16 daría 13.3: este test lo distinguiría.
  assert.equal(far.overProb, 15.4);
  assert.equal(far.underProb, 84.6);

  const near = calculateNbaProbabilities({
    home: { name: 'Equipo X' }, away: { name: 'Equipo Y' }, spread: -4.5, total: 228,
  });
  assert.equal(near.overProb, 48.1);
  assert.equal(near.underProb, 51.9);
});

test('R6: NBA — la σ de MARGEN (14.7) tampoco se tocó', () => {
  const p = calculateNbaProbabilities({
    home: { name: 'Equipo X' }, away: { name: 'Equipo Y' }, spread: -4.5, total: 227.5,
  });
  // homeWinProb y homeCoverProb dependen de spreadStdDev=14.7, no de totales.
  assert.equal(p.homeWinProb, 56.5);
  assert.equal(p.homeCoverProb, 44.3);
  assert.equal(p.awayCoverProb, 55.7);
});

// ---------------- R6: Monte Carlo (simulador; σTot colegial 14.5 → 21.0) ----------------

test('R6: Monte Carlo colegial — con viento el over se acerca a 50% (σTot 21.0)', () => {
  // En simulateNflMatch el total simulado es N(línea − penalización, σTot):
  // sin viento el over es ~50% con cualquier σ; con viento 30 mph la
  // penalización es 5.6 pts y el over es 1−Φ(5.6/σ): 35.0% con σ=14.5,
  // 39.5% con σ=21.0. 50.000 iteraciones: SE ≈ 0.22 pp.
  const windy = simulateNflMatch(0, -3.5, 52.5, 30, 50000, true);
  assert.ok(Math.abs(windy.overProb - 39.5) <= 2.0, `colegial viento 30: over ${windy.overProb}, esperado ~39.5`);
  assert.ok(Math.abs(windy.overProb - 50) < Math.abs(35.0 - 50), 'menos extremo que con σ=14.5');
  // Sin viento la media no cambia: over ≈ 50%.
  const calm = simulateNflMatch(0, -3.5, 52.5, 0, 50000, true);
  assert.ok(Math.abs(calm.overProb - 50) <= 2.0, `colegial sin viento: over ${calm.overProb}, esperado ~50`);
});

test('R6: Monte Carlo NFL SIN cambio — σTot sigue en 9.8', () => {
  // Con viento 30 mph: 1−Φ(5.6/9.8) = 28.4%. Con σ=21 daría 39.5.
  const windy = simulateNflMatch(0, -3.5, 52.5, 30, 50000, false);
  assert.ok(Math.abs(windy.overProb - 28.4) <= 2.0, `NFL viento 30: over ${windy.overProb}, esperado ~28.4`);
  const calm = simulateNflMatch(0, -3.5, 52.5, 0, 50000, false);
  assert.ok(Math.abs(calm.overProb - 50) <= 2.0, `NFL sin viento: over ${calm.overProb}, esperado ~50`);
});

// ---------------- R6: fútbol sin cambio (Poisson, sin parámetro σ) ----------------

test('R6: (c) fútbol SIN cambio — totales por Poisson, misma distribución', () => {
  // λ total 2.4 (1.35 + 1.05): P(≥2)=~72%, P(≥3)=~46%, P(≥4)=~24%.
  // Orden estricto y rangos sanos; dos corridas independientes estables.
  const run1 = simulateSoccerMatch(1.35, 1.05, 20000);
  assert.ok(run1.over15Prob > run1.over25Prob, 'over 1.5 > over 2.5');
  assert.ok(run1.over25Prob > run1.over35Prob, 'over 2.5 > over 3.5');
  assert.ok(run1.over35Prob > run1.over45Prob, 'over 3.5 > over 4.5');
  assert.ok(run1.over25Prob >= 42 && run1.over25Prob <= 50, `over 2.5 ${run1.over25Prob} en [42, 50]`);
  assert.ok(run1.over15Prob >= 68 && run1.over15Prob <= 78, `over 1.5 ${run1.over15Prob} en [68, 78]`);
  const run2 = simulateSoccerMatch(1.35, 1.05, 20000);
  assert.ok(
    Math.abs(run2.over25Prob - run1.over25Prob) <= 3,
    `dos corridas estables: ${run1.over25Prob} vs ${run2.over25Prob}`,
  );
});
