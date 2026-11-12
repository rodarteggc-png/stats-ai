// scripts/learnFromLedger.test.mjs — el loop de aprendizaje propone, nunca aplica:
// el prompt lleva los números reales y la respuesta se parsea sin romperse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLearningPrompt, parseAiResponse, summarizeForAi, callGeminiLearning } from './learnFromLedger.mjs';

const fakeReport = {
  overall: { n: 37, wins: 17, losses: 20, pushes: 0, hitRate: 45.95, netUnits: -7.11, roiPct: -21.35, avgProbPct: 68.83, calibrationGapPts: 22.88 },
  clv: { n: 0, beatRatePct: null, avgClvPct: null },
  drawdown: { maxDrawdownUnits: 9.21, currentDrawdownUnits: 9.12, peakUnits: 2.01 },
  bySport: [{ key: 'Baloncesto', n: 10, wins: 3, losses: 7, hitRate: 30, roiPct: -58.49, avgProbPct: 70, calibrationGapPts: 40 }],
  byMarket: [{ key: 'Spread/Hándicap', n: 10, wins: 1, losses: 9, hitRate: 10, roiPct: -86.32, avgProbPct: 65, calibrationGapPts: 55 }],
  byProbBucket: [{ key: '80%+', n: 8, wins: 3, losses: 5, hitRate: 37.5, roiPct: -34.72, avgProbPct: 85.65, calibrationGapPts: 48.15 }],
  recentForm: [{ result: 'WON', game: 'A vs B', pick: 'A ML', pnlUnits: 0.9 }],
  streaks: { current: { type: 'L', count: 1 }, longestWin: 3, longestLoss: 4 },
  warnings: []
};
const tuning = { platt: { nba: { A: 0.65, B: -0.2 } }, nbaSigma: 14.7, spreadsPaused: true, drawdownStopUnits: 15, maxDailyExposureUnits: 6, internalQualityTargetUnits30d: 6 };

test('learn: el resumen lleva los números que importan', () => {
  const s = summarizeForAi(fakeReport);
  assert.equal(s.overall.n, 37);
  assert.equal(s.bySport.length, 1);
  assert.match(s.bySport[0], /Baloncesto/);
  assert.match(s.recentForm[0], /^W /);
});

test('learn: el prompt incluye afinación vigente y las reglas de no tocar', () => {
  const p = buildLearningPrompt(summarizeForAi(fakeReport), tuning);
  assert.match(p, /0\.65/);
  assert.match(p, /Spreads en pausa: true/);
  assert.match(p, /Nunca propongas tocar los 5 candados/);
  assert.match(p, /muestra es insuficiente/);
  assert.match(p, /-7\.11/);
});

test('learn: parsea JSON válido y rescata JSON envuelto en texto', () => {
  const good = parseAiResponse('{"verdict":"seguir midiendo","criteria":[],"proposals":[]}');
  assert.equal(good.ok, true);
  assert.equal(good.verdict, 'seguir midiendo');
  const wrapped = parseAiResponse('Claro, aquí va:\n{"verdict":"x","criteria":[],"proposals":[]}\nEso es todo.');
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.verdict, 'x');
});

test('learn: si la IA no devuelve JSON, no se pierde el análisis', () => {
  const bad = parseAiResponse('No sé qué decir, todo mal.');
  assert.equal(bad.ok, false);
  assert.match(bad.raw, /todo mal/);
});

test('learn: sin llave no falla, reporta no disponible', async () => {
  const res = await callGeminiLearning('hola', { apiKey: '' });
  assert.equal(res.available, false);
  assert.match(res.reason, /GEMINI_API_KEY/);
});

test('learn: con fetch simulado devuelve el análisis parseado', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ verdict: 'pausar spreads', criteria: [{ rule: 'No spreads NBA', evidence: '1W-9L', appliesTo: 'NBA' }], proposals: [] }) }] } }]
    })
  });
  const res = await callGeminiLearning('hola', { apiKey: 'test-key', fetchImpl: fakeFetch });
  assert.equal(res.available, true);
  assert.equal(res.verdict, 'pausar spreads');
  assert.equal(res.criteria[0].rule, 'No spreads NBA');
});
