import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunitiesAndTopSlate } from './alertEngine.js';
import { calculateMatchProbabilities } from '../src/utils/poisson.js';
import { simulateSoccerMatch } from '../src/utils/monteCarlo.js';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';

// Totales fútbol en la línea del mercado (Fase 1 + Fase 2, 2026-11-19).
// Antes el builder solo evaluaba la línea 2.5 y solo usaba cuota real si la
// línea era exactamente 2.5, así que los partidos con total 3.5/4.5/6.5
// (UWCL 19 nov: Paris FC 3.5, Arsenal 3.5, Austria-Bayern 4.5, Barcelona 6.5)
// generaban picks con cuota inventada y se vetaban por odds_model. Ahora el
// builder evalúa la línea que realmente ofrece el mercado (Pinnacle primero,
// ESPN/DraftKings de respaldo) y la probabilidad del modelo para ESA línea.

function soccerMatch({ id, home, away, line, overOdds, underOdds, provider = 'DraftKings' }) {
  return {
    id,
    sport: 'futbol',
    league: 'Premier League',
    leagueCode: 'eng.1',
    gameDate: '2026-11-19T20:00:00Z',
    home: { name: home.name, xG: home.xG, elo: 1500, daysRest: 7 },
    away: { name: away.name, xG: away.xG, elo: 1450, daysRest: 7 },
    market: { totalClose: line, overOdds, underOdds, provider },
  };
}

function runBuilder(matches) {
  return buildOpportunitiesAndTopSlate({
    soccerMatches: matches,
    mlbMatches: [], nflMatches: [], ncaafMatches: [], nbaMatches: [],
    maxPicksToSend: 6, sentCache: {}, isForce: true,
  });
}

test('Fase 2: Poisson calcula líneas 4.5/5.5/6.5 y no cambia 2.5/3.5', () => {
  const p = calculateMatchProbabilities(1.61, 0.78, 1500, 1450, 7, 7, 0, 0, 6, false, -0.13, 'Premier League');
  for (const key of ['over45', 'under45', 'over55', 'under55', 'over65', 'under65']) {
    assert.ok(p[key] !== undefined, `falta ${key} en calculateMatchProbabilities`);
    assert.ok(!Number.isNaN(parseFloat(p[key])), `${key} no es número: ${p[key]}`);
  }
  // Cada par suma ~100 y la prob de over decrece con la línea (monótona).
  for (const [o, u] of [['over15', 'under15'], ['over25', 'under25'], ['over35', 'under35'], ['over45', 'under45'], ['over55', 'under55'], ['over65', 'under65']]) {
    const s = parseFloat(p[o]) + parseFloat(p[u]);
    assert.ok(Math.abs(s - 100) < 0.6, `${o}+${u} = ${s}, se esperaba ~100`);
  }
  assert.ok(parseFloat(p.over65) < parseFloat(p.over55), 'over65 debe ser < over55');
  assert.ok(parseFloat(p.over55) < parseFloat(p.over45), 'over55 debe ser < over45');
  assert.ok(parseFloat(p.over45) < parseFloat(p.over35), 'over45 debe ser < over35');
  assert.ok(parseFloat(p.over35) < parseFloat(p.over25), 'over35 debe ser < over25');
  // 2.5/3.5 no cambian: son los valores que el modelo ya daba antes
  // (Poisson es determinista; para xG 1.61/0.78 en Premier League).
  assert.equal(p.over25, '43.0', `over25 cambió (era 43.0): ${p.over25}`);
  assert.equal(p.over35, '22.0', `over35 cambió (era 22.0): ${p.over35}`);
});

test('Fase 2: Monte Carlo calcula over45/55/65', () => {
  const mc = simulateSoccerMatch(1.61, 0.78, 10000);
  for (const key of ['over45Prob', 'over55Prob', 'over65Prob']) {
    assert.ok(typeof mc[key] === 'number', `falta ${key} en simulateSoccerMatch`);
    assert.ok(mc[key] >= 0 && mc[key] <= 100, `${key} fuera de rango: ${mc[key]}`);
  }
  assert.ok(mc.over65Prob <= mc.over35Prob, 'MC over65 debe ser <= over35');
  assert.ok(typeof mc.over25Prob === 'number' && typeof mc.over35Prob === 'number', 'MC debe seguir devolviendo over25/over35');
});

test('Fase 1: línea 3.5 (ESPN) genera UNDER 3.5 con cuota real', () => {
  // Fixture con riskLevel estable (no 'Alto'): xG 1.80/0.30, estabilidad 70-72.
  const out = runBuilder([soccerMatch({
    id: 'soccer-ml-35',
    home: { name: 'Team A', xG: '1.80' },
    away: { name: 'Team B', xG: '0.30' },
    line: 3.5, overOdds: '2.20', underOdds: '1.63',
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'tot-u-soccer-ml-35');
  assert.equal(raw.length, 1, `se esperaba 1 pick UNDER 3.5, hay ${raw.length}: ${JSON.stringify(out.rawOpportunities.map(o => o.pick))}`);
  assert.equal(raw[0].pick, 'UNDER 3.5 Goles');
  assert.equal(raw[0].odds, '1.63');
  assert.equal(raw[0].oddsSource, 'espn', 'la cuota 3.5 es real (ESPN, tier espn), no model');
  // Reversión fútbol 2026-11-25: la cruda del UNDER 3.5 es 84% y con el
  // par viejo A=0.65/B=-0.20 calibra 70.6% (con el refit A=0.34/B=-0.33
  // era 55.8%).
  assert.equal(parseFloat(raw[0].prob), 70.6, `prob UNDER 3.5 ${raw[0].prob}, se esperaba 70.6`);
});

test('Fase 1: línea 4.5 genera UNDER 4.5 con cuota real', () => {
  const out = runBuilder([soccerMatch({
    id: 'soccer-ml-45',
    home: { name: 'Austria Vienna', xG: '0.78' },
    away: { name: 'Bayern Munich', xG: '1.77' },
    line: 4.5, overOdds: '2.20', underOdds: '1.63',
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'tot-u-soccer-ml-45');
  assert.equal(raw.length, 1, `se esperaba 1 pick UNDER 4.5, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'UNDER 4.5 Goles');
  assert.equal(raw[0].odds, '1.63');
  assert.equal(raw[0].oddsSource, 'espn', 'la cuota 4.5 es real (ESPN, tier espn), no model');
});

test('Fase 1: línea 6.5 genera UNDER 6.5 con cuota real', () => {
  const out = runBuilder([soccerMatch({
    id: 'soccer-ml-65',
    home: { name: 'Barcelona', xG: '3.97' },
    away: { name: 'Servette', xG: '0.84' },
    line: 6.5, overOdds: '1.83', underOdds: '1.91',
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'tot-u-soccer-ml-65');
  assert.equal(raw.length, 1, `se esperaba 1 pick UNDER 6.5, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'UNDER 6.5 Goles');
  assert.equal(raw[0].odds, '1.91');
  assert.equal(raw[0].oddsSource, 'espn', 'la cuota 6.5 es real (ESPN, tier espn), no model');
});

test('Fase 1: línea 2.5 sigue igual (regresión)', () => {
  // Fixture con riskLevel estable: xG 3.50/0.50, estabilidad 85-86.
  const out = runBuilder([soccerMatch({
    id: 'soccer-ml-25',
    home: { name: 'Team A', xG: '3.50' },
    away: { name: 'Team B', xG: '0.50' },
    line: 2.5, overOdds: '1.90', underOdds: '1.90',
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'tot-o-soccer-ml-25');
  assert.equal(raw.length, 1, `se esperaba 1 pick OVER 2.5, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'OVER 2.5 Goles');
  assert.equal(raw[0].odds, '1.90');
  assert.equal(raw[0].oddsSource, 'espn', 'la cuota 2.5 sigue siendo real (ESPN, tier espn)');
});

test('Fase 1 + GAP 3: línea no soportada (2.75) no genera oportunidad (fail-closed en el builder)', () => {
  // GAP 3 (2026-11-24): antes se generaba la oportunidad con cuota inventada
  // (oddsSource 'model') y se vetaba después; ahora no se genera nada.
  const out = runBuilder([soccerMatch({
    id: 'soccer-ml-275',
    home: { name: 'Team A', xG: '3.50' },
    away: { name: 'Team B', xG: '0.50' },
    line: 2.75, overOdds: '1.90', underOdds: '1.90',
  })]);
  assert.equal(out.rawOpportunities.length, 0,
    `línea 2.75 sin precio real: no debe generar oportunidades, hay ${JSON.stringify(out.rawOpportunities.map(o => o.id))}`);
  assert.equal(out.approvedOpps.length, 0);
});

test('Fase 1: línea Pinnacle (m.vegas) tiene prioridad sobre ESPN', () => {
  const m = soccerMatch({
    id: 'soccer-ml-sharp',
    home: { name: 'Team A', xG: '1.80' },
    away: { name: 'Team B', xG: '0.30' },
    line: 3.5, overOdds: '2.20', underOdds: '1.63',
  });
  // Pinnacle trae la misma línea 3.5 pero con cuotas distintas.
  m.vegas = { overUnder: 3.5, overOdds: '2.30', underOdds: '1.70' };
  m.sharpValidated = true;
  const out = runBuilder([m]);
  const raw = out.rawOpportunities.filter(o => o.id === 'tot-u-soccer-ml-sharp');
  assert.equal(raw.length, 1, `se esperaba 1 pick UNDER 3.5, hay ${raw.length}`);
  assert.equal(raw[0].odds, '1.70', 'la cuota debe ser la de Pinnacle, no la de ESPN');
});

test('Candado 2: el veto de derbi cubre OVER 3.5, no solo 2.5', () => {
  function totalsPick(pick, home, away) {
    return {
      sport: 'futbol',
      pickType: '🔥 TOTALES FÚTBOL (VALOR OVER)',
      pick,
      match: { home: { name: home, xG: '2.00' }, away: { name: away, xG: '1.50' }, league: 'LaLiga', market: {} },
      probs: { over35: 65, under35: 35 },
      mcStats: { stability: 80, risk: 'Bajo', iterations: 10000 },
      edgeVal: 5.0, prob: 65, odds: 1.90,
    };
  }
  const derby35 = evaluateEnsembleConsensus(totalsPick('OVER 3.5 Goles', 'Real Madrid', 'Barcelona'));
  const v1d35 = derby35.breakdown.find(b => b.name === 'Modelo Estructural (+EV)');
  assert.equal(v1d35.passed, false, 'OVER 3.5 en derbi debe vetarse (Candado 2)');
  assert.match(v1d35.reason, /Derbi|Clásico/, `el motivo debe ser el veto de derbi, es: ${v1d35.reason}`);
  // Regresión: OVER 2.5 en derbi sigue vetado.
  const derby25 = evaluateEnsembleConsensus(totalsPick('OVER 2.5 Goles', 'Real Madrid', 'Barcelona'));
  const v1d25 = derby25.breakdown.find(b => b.name === 'Modelo Estructural (+EV)');
  assert.equal(v1d25.passed, false, 'OVER 2.5 en derbi debe seguir vetado');
  // Control: OVER 3.5 sin derbi pasa el Voto 1 (prob 65 >= 54).
  const noDerby = evaluateEnsembleConsensus(totalsPick('OVER 3.5 Goles', 'Team A', 'Team B'));
  const v1nd = noDerby.breakdown.find(b => b.name === 'Modelo Estructural (+EV)');
  assert.equal(v1nd.passed, true, `OVER 3.5 sin derbi debe pasar Voto 1, motivo: ${v1nd.reason}`);
});
