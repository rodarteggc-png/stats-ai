import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';

// A1 (2026-11-18): la "estabilidad Monte Carlo" de NBA era un número fijo
// (80 moneyline, 82 spreads, 85 totales, "10k partidos") sin ninguna simulación
// detrás: hoops.js solo tiene calculateNbaProbabilities, un modelo determinista
// de posesiones, sin Math.random ni bucle de simulación. Ese número fijo VOTABA
// (Voto 2 pasaba siempre con estabilidad >= 68 y riesgo 'Bajo') y SUBÍA STAKES
// (estabilidad >= 75 con 3/3 votos levantaba el stake de protección de 0.7u).
// La corrección, sin tocar la matemática del modelo: los builders NBA ponen
// mcStats: null y el Voto 2 se abstiene explícitamente (vote2Passed = null);
// con 2/2 de los Votos 1+3 el pick igual puede pasar, el slate no se vacía.

const ALERT_ENGINE_PATH = new URL('./alertEngine.js', import.meta.url);
const NO_DATA = 'Sin dato — Monte Carlo no ejecutado para NBA';

function nbaTotalsPick(mcStats) {
  return {
    sport: 'nba',
    pickType: 'Totales',
    pick: 'OVER 228.5 Pts',
    match: {
      home: { name: 'Los Angeles Lakers' },
      away: { name: 'Utah Jazz' },
      market: {}
    },
    probs: { overProb: 60, underProb: 40, projectedPace: 100 },
    mcStats,
    edgeVal: 5.0,
    prob: 60,
    odds: 1.95
  };
}

function vote2(result) {
  const entry = result.breakdown.find((b) => b.name === 'Monte Carlo (10,000 Sims)');
  assert.ok(entry, 'el desglose debe incluir el Voto 2 (Monte Carlo)');
  return entry;
}

test('A1: los 5 sitios NBA llevan mcStats: null y no queda ningún fijo 80/82/85', () => {
  const src = fs.readFileSync(ALERT_ENGINE_PATH, 'utf8');
  const nullCount = (src.match(/mcStats: null/g) || []).length;
  assert.equal(nullCount, 5, `se esperaban 5x mcStats: null (spreads x2, totales x2, ML x1), hay ${nullCount}`);
  for (const fixed of ['stability: 80', 'stability: 82', 'stability: 85']) {
    assert.ok(!src.includes(`mcStats: { ${fixed}`), `sigue el fijo NBA mcStats: { ${fixed} — A1 no aplicado`);
  }
});

test('A1: los 2 fallbacks ya no inventan estabilidad (sin "Alta")', () => {
  const src = fs.readFileSync(ALERT_ENGINE_PATH, 'utf8');
  const noDataCount = src.split(NO_DATA).length - 1;
  assert.equal(noDataCount, 2, `se esperaban 2x "${NO_DATA}" (prompt Gemini + mensaje Telegram), hay ${noDataCount}`);
  assert.ok(!src.includes(": 'Alta'"), 'el prompt de Gemini sigue usando el fallback Alta');
  assert.ok(!src.includes('Alta (Calibrada)'), 'el mensaje de Telegram sigue usando el fallback Alta (Calibrada)');
});

test('A1: con mcStats null el Voto 2 se abstiene y el pick sigue pasando 2/2', () => {
  const result = evaluateEnsembleConsensus(nbaTotalsPick(null));
  const v2 = vote2(result);
  assert.equal(v2.passed, null, 'el Voto 2 debe abstenerse (passed === null), no votar');
  assert.match(v2.reason, /abstención/, 'la razón debe decir que es una abstención');
  assert.equal(result.votesPassed, 2, 'con Votos 1+3 a favor, votesPassed debe ser 2');
  assert.equal(result.verdict, 'UNANIMIDAD_ELITE', '2/2 entre votos activos sigue siendo unanimidad élite');
  assert.match(result.badgeText, /2\/2 Votos \(Unanimidad Élite\)/, 'el sello debe leer 2/2');
});

test('A1 control: con mcStats real el Voto 2 sí vota (no es un veto encubierto)', () => {
  const result = evaluateEnsembleConsensus(
    nbaTotalsPick({ stability: 82, risk: 'Bajo', iterations: 10000 })
  );
  const v2 = vote2(result);
  assert.equal(v2.passed, true, 'con mcStats real el Voto 2 debe pasar');
  assert.match(v2.reason, /Resistencia de Roca/, 'la razón debe ser la de estabilidad real');
  assert.equal(result.votesPassed, 3, 'con los 3 votos a favor, votesPassed debe ser 3');
});

// A1 expuso un bug previo del builder ML de NBA: pasaba probs: { f5: {...} }
// (copiado de MLB) sin homeWinProb/awayWinProb en el nivel superior, así que
// el Voto 1 ML siempre leía maxWin = 50 < 55 y NUNCA pasaba; el pick ML solo
// despachaba porque el Voto 2 fabricado le daba el segundo voto. Con A1 (Voto 2
// en abstención) el ML quedaba 1/2 y se vetaba. La corrección expone las probs
// reales en el nivel superior (manteniendo f5) para que el Voto 1 evalúe el pick.

test('A1 (ML): el builder ML expone homeWinProb/awayWinProb para el Voto 1', () => {
  const src = fs.readFileSync(ALERT_ENGINE_PATH, 'utf8');
  // La línea probs del builder ML es la única con homeWinProb/awayWinProb en el
  // nivel superior (tras cerrar f5); los spreads/totales solo llevan { f5: ... }.
  const mlProbsLines = src.split('\n').filter((l) =>
    l.includes('probs: { f5:') && l.includes('}, homeWinProb: probs.homeWinProb')
  );
  assert.equal(mlProbsLines.length, 1, `se esperaba exactamente 1 línea probs de ML con homeWinProb top-level, hay ${mlProbsLines.length}`);
  const probsLine = mlProbsLines[0];
  assert.ok(probsLine.includes('awayWinProb: probs.awayWinProb'), 'el probs del ML debe exponer awayWinProb en el nivel superior');
  assert.ok(probsLine.includes('f5:'), 'el probs del ML debe mantener f5 (lo usa effectiveProb)');
});

test('A1 (ML): un ML con homeWinProb real pasa el Voto 1 y despacha 2/2 sin mcStats', () => {
  const result = evaluateEnsembleConsensus({
    sport: 'nba',
    pickType: 'Moneyline',
    pick: 'Victoria Boston Celtics',
    match: { home: { name: 'Boston Celtics' }, away: { name: 'Washington Wizards' }, market: {} },
    // Así queda el probs del builder tras la corrección: f5 + top-level real.
    probs: { f5: { homeMl: 69.1, awayMl: 30.9 }, homeWinProb: 69.1, awayWinProb: 30.9 },
    mcStats: null,
    edgeVal: 13.1,
    prob: 58,
    odds: 1.95
  });
  const v1 = result.breakdown.find((b) => b.name === 'Modelo Estructural (+EV)');
  assert.equal(v1.passed, true, 'el Voto 1 ML debe pasar con homeWinProb 69.1% real');
  assert.equal(vote2(result).passed, null, 'el Voto 2 debe abstenerse');
  assert.equal(result.votesPassed, 2, 'ML con Votos 1+3 debe quedar 2/2');
  assert.equal(result.verdict, 'UNANIMIDAD_ELITE', '2/2 sigue siendo unanimidad élite');
});
