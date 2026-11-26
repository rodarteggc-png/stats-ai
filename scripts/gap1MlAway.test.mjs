import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunitiesAndTopSlate, classifyOpportunity } from './alertEngine.js';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';
import { applyPlattCalibration } from '../src/utils/calibration.js';

// GAP1 (2026-11-24): el builder ML de NBA solo generaba el Moneyline del
// favorito LOCAL (nba-ml-h-). El lado visitante nunca aparecía como
// oportunidad del sistema, aunque el modelo lo favoreciera (ej. Jets ML
// @2.44 con 57.8% y Raiders ML @5.56 con 34.7% el 2026-11-22 fueron solo
// análisis manual). El espejo del lado visitante (nba-ml-a-) usa los
// MISMOS pisos de prob/EV del favorito local (prob cruda >= 62.0,
// EV >= 3.0, sin bajarlos) y exige precio REAL del lado visitante
// (m.odds.awayMl); sin precio no se genera nada (fail-closed).

function nbaMatch({
  id = 'nba-gap1-1',
  homeWinProb = 35,
  awayWinProb = 65,
  homeMl = 1.95,
  awayMl = 2.44,
  hasRealOdds = true,
} = {}) {
  return {
    id,
    sport: 'Baloncesto',
    league: 'NBA',
    home: { name: 'Boston Celtics' },
    away: { name: 'Washington Wizards' },
    gameDate: '2026-11-25T00:30:00Z',
    date: '2026-11-25T00:30:00Z',
    spread: null,
    total: null,
    oddsFetchedAt: new Date().toISOString(),
    market: {
      homeOdds: homeMl != null ? String(homeMl) : null,
      awayOdds: awayMl != null ? String(awayMl) : null,
      hasRealOdds,
      provider: 'DraftKings',
    },
    odds: {
      homeMl: homeMl ?? null,
      awayMl: awayMl ?? null,
    },
    probabilities: {
      homeWinProb,
      awayWinProb,
      homeCoverProb: 50,
      awayCoverProb: 50,
      underProb: 50,
      overProb: 50,
      ratingsSource: 'live',
      projectedSpread: 0,
      projectedPace: 100,
      projectedTotal: 220,
      homeExpectedScore: 108,
      awayExpectedScore: 112,
    },
  };
}

function runBuilder(nbaMatches) {
  return buildOpportunitiesAndTopSlate({
    soccerMatches: [],
    mlbMatches: [],
    nflMatches: [],
    ncaafMatches: [],
    nbaMatches,
    maxPicksToSend: 6,
    sentCache: {},
    isForce: true,
  });
}

function awayMlOpps(out) {
  return out.rawOpportunities.filter((o) => o.id.startsWith('nba-ml-a-'));
}

test('GAP1 (a): underdog visitante con prob suficiente + precio real genera la oportunidad con los campos del ML local', () => {
  const match = nbaMatch({ awayWinProb: 65, awayMl: 2.44 });
  const out = runBuilder([match]);
  const opps = awayMlOpps(out);
  assert.equal(opps.length, 1, `se esperaba 1 oportunidad nba-ml-a-, hay ${opps.length}: ${JSON.stringify(out.rawOpportunities.map((o) => o.id))}`);
  const opp = opps[0];
  assert.equal(opp.id, 'nba-ml-a-nba-gap1-1');
  assert.equal(opp.game, 'Boston Celtics vs Washington Wizards');
  assert.equal(opp.sport, 'Baloncesto');
  assert.equal(opp.league, 'NBA');
  assert.equal(opp.type, '🏀 VISITANTE DIRECTO (NBA)');
  assert.equal(opp.pick, 'Victoria Washington Wizards');
  // La prob que lleva la oportunidad es la CALIBRADA (Platt par viejo
  // A=0.65/B=-0.20, reversión completa 2026-11-25); la cruda queda en
  // rawProb, igual que en el ML local.
  assert.equal(opp.prob, `${applyPlattCalibration(65, 'Baloncesto')}%`);
  assert.equal(opp.rawProb, '65%');
  assert.equal(opp.odds, '2.44');
  // Precio real ESPN/DraftKings con hasRealOdds: tier 'espn', no 'model'.
  assert.equal(opp.oddsSource, 'espn');
  assert.equal(opp.oddsProvider, 'DraftKings');
  assert.match(opp.edgeStr, /Edge .* pp \| EV/);
  assert.equal(opp.match, match, 'la oportunidad debe llevar el partido completo');
  // El edge crudo del builder (prob cruda vs implícita) es +24.0; tras la
  // calibración el forEach lo reescribe con la prob calibrada, así que aquí
  // solo se exige que sea un número finito (el valor exacto lo fija la
  // calibración vigente, no el builder).
  assert.ok(Number.isFinite(opp.edgeVal), `edgeVal debe ser numérico, es ${opp.edgeVal}`);
  // El Voto 1 ML debe poder leer las probs reales (A1, igual que el ML local).
  assert.equal(opp.probs.homeWinProb, 35);
  assert.equal(opp.probs.awayWinProb, 65);
  assert.equal(opp.ratingsSource, 'live');
});

test('GAP1 (b): underdog visitante con prob insuficiente NO genera oportunidad (caso Jets: 57.8% < 62%)', () => {
  // Jets ML @2.44 el 2026-11-22: modelo 57.8%. Pasa el piso de aprobación
  // (54%) pero NO el piso del builder ML (62%, el mismo del favorito local,
  // sin bajar): sigue sin generar oportunidad.
  const out = runBuilder([nbaMatch({ homeWinProb: 42.2, awayWinProb: 57.8, awayMl: 2.44 })]);
  assert.equal(awayMlOpps(out).length, 0, `con 57.8% no debe generarse ML visitante: ${JSON.stringify(out.rawOpportunities.map((o) => o.id))}`);
  // Tampoco el caso Raiders (34.7% @5.56): muy por debajo del piso.
  const out2 = runBuilder([nbaMatch({ id: 'nba-gap1-raiders', homeWinProb: 65.3, awayWinProb: 34.7, homeMl: 1.22, awayMl: 5.56 })]);
  assert.equal(awayMlOpps(out2).length, 0, 'con 34.7% no debe generarse ML visitante');
});

test('GAP1 (c): underdog visitante con prob suficiente pero SIN precio real no genera oportunidad con precio de modelo', () => {
  // Sin m.odds.awayMl no hay nada que publicar: el builder no inventa cuota.
  const noPrice = nbaMatch({ awayWinProb: 65, awayMl: null, hasRealOdds: false });
  const out = runBuilder([noPrice]);
  assert.equal(awayMlOpps(out).length, 0, 'sin precio real del lado visitante no debe generarse ML visitante');
  assert.equal(
    out.rawOpportunities.filter((o) => o.pick === 'Victoria Washington Wizards').length,
    0,
    'no debe existir ninguna oportunidad del visitante con precio inventado'
  );
  // Sin objeto odds en absoluto, tampoco.
  const matchNoOdds = nbaMatch({ id: 'nba-gap1-noprice2', awayWinProb: 65 });
  delete matchNoOdds.odds;
  const out2 = runBuilder([matchNoOdds]);
  assert.equal(awayMlOpps(out2).length, 0, 'sin objeto odds no debe generarse ML visitante');
});

test('GAP1 (c2): con precio en odds pero sin hasRealOdds, no se genera oportunidad (fail-closed GAP3)', () => {
  // El precio existe en odds pero sin hasRealOdds la procedencia es model.
  // Con el fail-closed del GAP3, la oportunidad de solo-modelo ni siquiera
  // se genera en el despacho (antes se generaba y la vetaba odds_model).
  // El resultado es el mismo — nunca llega a aprobado con cuota inventada —
  // pero el filtro está en el constructor, no en el veto.
  const match = nbaMatch({ awayWinProb: 65, awayMl: 2.44, hasRealOdds: false });
  const out = runBuilder([match]);
  const opps = awayMlOpps(out);
  assert.equal(opps.length, 0, 'sin precio real verificable no debe generarse ML visitante');
  assert.equal(out.approvedOpps.filter((o) => o.id.startsWith('nba-ml-a-')).length, 0);
});

test('GAP1 regresión: el ML del favorito local sigue generándose y el visitante no cuando el local es favorito', () => {
  const out = runBuilder([nbaMatch({ homeWinProb: 69.1, awayWinProb: 30.9, homeMl: 1.95, awayMl: 2.15 })]);
  const home = out.rawOpportunities.filter((o) => o.id === 'nba-ml-h-nba-gap1-1');
  assert.equal(home.length, 1, 'el ML local debe seguir generándose');
  assert.equal(home[0].pick, 'Victoria Boston Celtics');
  assert.equal(awayMlOpps(out).length, 0, 'con el visitante a 30.9% no debe generarse ML visitante');
});

test('GAP1 límite (WORK A): con el Voto 1 relajado, el underdog visitante fuerte pasa el consenso pero lo frena market_outlier (reversión 2026-11-25)', () => {
  // Antes de WORK A este fixture se vetaba en consenso (Candado
  // Anti-Underdog NBA del Voto 1). Con la excepción GAP1 (prob cruda del
  // visitante 90% >= 62.0%, precio real @2.44): Voto 1 pasa, Voto 2 se
  // abstiene (sin Monte Carlo NBA) y Voto 3 pasa → 2/2 UNANIMIDAD_ELITE.
  // CONSECUENCIA DE LA REVERSIÓN COMPLETA (2026-11-25): la calibrada NBA
  // con el par viejo es 77.4% (con el refit era 54.8%) y supera el mercado
  // sin vig (~39% para @2.44) por >12 pp, así que el tope market_outlier
  // (12 pp, fijado por Tavo, NO se toca) veta el pick en classify. La
  // relajación del Voto 1 sigue funcionando (el consenso pasa); lo que lo
  // frena es el gate de seguridad, no el consenso.
  const match = nbaMatch({ homeWinProb: 10, awayWinProb: 90, homeMl: 1.95, awayMl: 2.44 });
  const out = runBuilder([match]);
  const opps = awayMlOpps(out);
  assert.equal(opps.length, 1, 'con 90% cruda debe generarse la oportunidad');
  assert.equal(opps[0].consensus.verdict, 'UNANIMIDAD_ELITE');
  assert.equal(opps[0].consensus.votesPassed, 2);
  const verdict = classifyOpportunity(opps[0]);
  assert.equal(verdict.approved, false);
  assert.equal(verdict.vetoReason, 'market_outlier', `el veto debe ser market_outlier, es ${verdict.vetoReason}`);
  assert.equal(out.vetoedOpps.filter((o) => o.id.startsWith('nba-ml-a-')).length, 1, 'queda en vetados por market_outlier');
  assert.equal(out.approvedOpps.filter((o) => o.id.startsWith('nba-ml-a-')).length, 0, 'ya no llega a aprobados tras la reversión');
  assert.equal(out.topSlate.filter((o) => o.id.startsWith('nba-ml-a-')).length, 0, 'no entra al slate');
});

test('WORK A (a): Voto 1 pasa para ML visitante NBA fuerte (prob cruda 90%, cuota 2.44, precio real)', () => {
  const match = nbaMatch({ homeWinProb: 10, awayWinProb: 90, homeMl: 1.95, awayMl: 2.44 });
  const res = evaluateEnsembleConsensus({
    sport: 'Baloncesto',
    match,
    probs: { homeWinProb: 10, awayWinProb: 90 },
    pickType: '🏀 VISITANTE DIRECTO (NBA)',
    pick: 'Victoria Washington Wizards',
    edgeVal: 24.0,
    prob: '54.8%',
    odds: '2.44',
  });
  const vote1 = res.breakdown[0];
  assert.equal(vote1.passed, true, `Voto 1 debe pasar, razón: ${vote1.reason}`);
  assert.match(vote1.reason, /Underdog visitante NBA validado/);
  assert.match(vote1.reason, /90\.0% >= 62\.0%/);
});

test('WORK A (b): Voto 1 sigue vetando el ML visitante NBA débil (prob cruda 50% < 62%)', () => {
  const match = nbaMatch({ homeWinProb: 50, awayWinProb: 50, homeMl: 1.95, awayMl: 2.44 });
  const res = evaluateEnsembleConsensus({
    sport: 'Baloncesto',
    match,
    probs: { homeWinProb: 50, awayWinProb: 50 },
    pickType: '🏀 VISITANTE DIRECTO (NBA)',
    pick: 'Victoria Washington Wizards',
    edgeVal: 9.0,
    prob: '50%',
    odds: '2.44',
  });
  const vote1 = res.breakdown[0];
  assert.equal(vote1.passed, false, 'Voto 1 debe vetar al underdog débil');
  assert.match(vote1.reason, /Candado Anti-Underdog NBA/);
});

test('WORK A (b2): Voto 1 sigue vetando por EV negativo aunque la prob cruda sea fuerte (red del Candado Matemático Universal)', () => {
  // Prob cruda 90% >= 62% supera la excepción GAP1, pero la prob
  // (calibrada) 40.0% no supera la implícita de 2.44 (41.0%) por >= 1.5 pp:
  // el Candado Matemático Universal veta. La excepción no abre la puerta
  // a picks sin +EV real.
  const match = nbaMatch({ homeWinProb: 10, awayWinProb: 90, homeMl: 1.95, awayMl: 2.44 });
  const res = evaluateEnsembleConsensus({
    sport: 'Baloncesto',
    match,
    probs: { homeWinProb: 10, awayWinProb: 90 },
    pickType: '🏀 VISITANTE DIRECTO (NBA)',
    pick: 'Victoria Washington Wizards',
    edgeVal: -1.0,
    prob: '40%',
    odds: '2.44',
  });
  const vote1 = res.breakdown[0];
  assert.equal(vote1.passed, false, 'el veto matemático debe seguir frenando el pick sin +EV');
  assert.match(vote1.reason, /Veto Matemático/);
});

test('WORK A (b3): la excepción es solo para VISITANTE DIRECTO — otro ML NBA a 2.44 sigue vetado', () => {
  const match = nbaMatch({ homeWinProb: 10, awayWinProb: 90, homeMl: 1.95, awayMl: 2.44 });
  const res = evaluateEnsembleConsensus({
    sport: 'Baloncesto',
    match,
    probs: { homeWinProb: 10, awayWinProb: 90 },
    pickType: '🏀 MONEYLINE (NBA)',
    pick: 'Victoria Washington Wizards',
    edgeVal: 24.0,
    prob: '54.8%',
    odds: '2.44',
  });
  const vote1 = res.breakdown[0];
  assert.equal(vote1.passed, false, 'un ML NBA genérico > 2.05 debe seguir vetado');
  assert.match(vote1.reason, /Candado Anti-Underdog NBA/);
});
