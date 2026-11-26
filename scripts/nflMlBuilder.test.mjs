import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunitiesAndTopSlate, classifyOpportunity } from './alertEngine.js';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';
import { applyPlattCalibration } from '../src/utils/calibration.js';

// WORK B (2026-11-24): NFL/NCAAF no tenían constructor de ML — los ML de
// Jets @2.44 (modelo 57.8%) y Raiders @5.56 (modelo 34.7%) del 2026-11-22
// fueron solo análisis manual. El builder nuevo (sección C NFL tras
// totales, C.2 NCAAF tras totales) es el espejo del ML de NBA (Gap 1):
// mismos pisos (prob cruda >= 62.0, EV >= 3.0, favorito <= 2.05 /
// visitante > 2.05, sin bajarlos), prob de victoria del Gridiron
// (calculateNflProbabilities: NFL σ 13.45, NCAAF σ 16.5 con
// isCollege=true) y precio REAL en m.market.homeOdds/awayOdds (Pinnacle
// si hubo enriquecimiento sharp, DraftKings/ESPN si no; no hay campo ML
// en m.vegas). Sin precio real no se genera nada (fail-closed, Gap 3).
//
// Las YPP de los fixtures se calibraron contra calculateNflProbabilities
// para dar exactamente las probs del modelo que se citan en cada test.

function gridironMatch({
  id = 'nfl-wb-1',
  sport = 'NFL',
  league = 'NFL',
  homeName = 'Kansas City Chiefs',
  awayName = 'New York Jets',
  homeYpp = 5.0,
  awayYpp = 5.76,
  homeMl = 1.60,
  awayMl = 2.44,
  spread = 2.5,
  totalLine = 44.5,
  hasRealOdds = true,
} = {}) {
  return {
    id,
    sport,
    league,
    home: { name: homeName, baseName: homeName, ypp: homeYpp, turnoverDiff: 0, epaNet: null },
    away: { name: awayName, baseName: awayName, ypp: awayYpp, turnoverDiff: 0, epaNet: null },
    gameDate: '2026-11-25T18:00:00Z',
    vegas: { spread, overUnder: totalLine },
    market: {
      homeOdds: homeMl != null ? String(homeMl) : null,
      awayOdds: awayMl != null ? String(awayMl) : null,
      hasRealOdds,
      provider: 'DraftKings',
    },
    oddsFetchedAt: new Date().toISOString(),
    weather: { windMph: 0 },
  };
}

function runBuilder({ nflMatches = [], ncaafMatches = [] } = {}) {
  return buildOpportunitiesAndTopSlate({
    soccerMatches: [],
    mlbMatches: [],
    nflMatches,
    ncaafMatches,
    nbaMatches: [],
    maxPicksToSend: 6,
    sentCache: {},
    isForce: true,
  });
}

const mlOpps = (out, prefix) => out.rawOpportunities.filter((o) => o.id.startsWith(prefix));

test('WORK B (a): underdog visitante NFL con prob suficiente + precio real genera la oportunidad con los campos del ML NBA', () => {
  // Visitante 67.8% (homeYpp 4.8 / awayYpp 6.2, spread +3.5) @ 2.44:
  // EV crudo 67.8 - 41.0 = +26.8 >= 3.0.
  const match = gridironMatch({ id: 'nfl-wb-away', homeYpp: 4.8, awayYpp: 6.2, spread: 3.5, homeMl: 1.60, awayMl: 2.44 });
  const out = runBuilder({ nflMatches: [match] });
  const opps = mlOpps(out, 'nfl-ml-a-');
  assert.equal(opps.length, 1, `se esperaba 1 oportunidad nfl-ml-a-, hay ${opps.length}: ${JSON.stringify(out.rawOpportunities.map((o) => o.id))}`);
  const opp = opps[0];
  assert.equal(opp.id, 'nfl-ml-a-nfl-wb-away');
  assert.equal(opp.game, 'Kansas City Chiefs vs New York Jets');
  assert.equal(opp.sport, 'NFL');
  assert.equal(opp.league, 'NFL');
  assert.equal(opp.type, '🏈 VISITANTE DIRECTO (NFL)');
  assert.equal(opp.pick, 'Victoria New York Jets');
  // La prob que lleva la oportunidad es la CALIBRADA (Platt par viejo
  // A=0.65/B=-0.20, reversión completa 2026-11-25); la cruda queda en
  // rawProb, igual que en el ML NBA.
  assert.equal(opp.prob, `${applyPlattCalibration(67.8, 'NFL')}%`);
  assert.equal(opp.rawProb, '67.8%');
  assert.equal(opp.odds, '2.44');
  // Precio real DraftKings con hasRealOdds: tier 'espn', no 'model'.
  assert.equal(opp.oddsSource, 'espn');
  assert.equal(opp.oddsProvider, 'DraftKings');
  assert.equal(opp.match, match, 'la oportunidad debe llevar el partido completo');
  assert.ok(Number.isFinite(opp.edgeVal), `edgeVal debe ser numérico, es ${opp.edgeVal}`);
  // El Voto 1 ML debe poder leer las probs reales (A1, igual que el ML NBA).
  assert.equal(opp.probs.homeWinProb, 32.2);
  assert.equal(opp.probs.awayWinProb, 67.8);
  assert.equal(opp.probs.f5.homeMl, 32.2);
  assert.equal(opp.probs.f5.awayMl, 67.8);
  assert.ok(opp.mcStats && opp.mcStats.iterations === 10000, 'el ML NFL lleva el MC real de la sección');
  // El type no lleva UNDERDOG ('UNDERDOG' contiene 'UNDER' y ensemble lo
  // leería como total).
  assert.ok(!opp.type.includes('UNDERDOG'), 'el type no debe llevar UNDERDOG');
});

test('WORK B (a2): caso Jets (57.8% @ 2.44) NO genera — por debajo del piso 62.0; caso Raiders (34.7% @ 5.56) tampoco', () => {
  // Jets 2026-11-22: modelo 57.8% @ 2.44. Pasa el piso de aprobación (54%)
  // pero NO el piso del builder ML (62.0, el mismo del favorito NBA, sin
  // bajar): sigue sin generar oportunidad.
  const jets = gridironMatch({ id: 'nfl-wb-jets', homeYpp: 5.0, awayYpp: 5.76, spread: 2.5, homeMl: 1.60, awayMl: 2.44 });
  const outJets = runBuilder({ nflMatches: [jets] });
  assert.equal(mlOpps(outJets, 'nfl-ml-a-').length, 0, `con 57.8% no debe generarse ML visitante: ${JSON.stringify(outJets.rawOpportunities.map((o) => o.id))}`);
  // Raiders 2026-11-22: modelo 34.7% @ 5.56, muy por debajo del piso. El
  // local (65.3% @ 1.22) tampoco genera: su EV es negativo (65.3 - 82.0).
  const raiders = gridironMatch({ id: 'nfl-wb-raiders', homeName: 'Denver Broncos', awayName: 'Las Vegas Raiders', homeYpp: 5.66, awayYpp: 5.0, spread: -3.5, homeMl: 1.22, awayMl: 5.56 });
  const outRaiders = runBuilder({ nflMatches: [raiders] });
  assert.equal(mlOpps(outRaiders, 'nfl-ml-').length, 0, `con 34.7% no debe generarse ningún ML: ${JSON.stringify(outRaiders.rawOpportunities.map((o) => o.id))}`);
});

test('WORK B (b): favorito local NFL con prob suficiente + precio real <= 2.05 genera', () => {
  // Local 68.9% (homeYpp 5.8 / awayYpp 5.0, spread -3.5) @ 1.60:
  // EV crudo 68.9 - 62.5 = +6.4 >= 3.0.
  const match = gridironMatch({ id: 'nfl-wb-home', homeYpp: 5.8, awayYpp: 5.0, spread: -3.5, homeMl: 1.60, awayMl: 2.44 });
  const out = runBuilder({ nflMatches: [match] });
  const opps = mlOpps(out, 'nfl-ml-h-');
  assert.equal(opps.length, 1, `se esperaba 1 oportunidad nfl-ml-h-, hay ${opps.length}: ${JSON.stringify(out.rawOpportunities.map((o) => o.id))}`);
  const opp = opps[0];
  assert.equal(opp.type, '🏈 FAVORITO DIRECTO (NFL)');
  assert.equal(opp.pick, 'Victoria Kansas City Chiefs');
  assert.equal(opp.rawProb, '68.9%');
  assert.equal(opp.odds, '1.60');
  assert.equal(opp.oddsSource, 'espn');
  assert.equal(opp.probs.homeWinProb, 68.9);
  assert.equal(opp.probs.awayWinProb, 31.1);
  assert.equal(mlOpps(out, 'nfl-ml-a-').length, 0, 'con el visitante a 31.1% no debe generarse ML visitante');
});

test('WORK B (c): ML NFL con prob suficiente pero SIN precio real no genera oportunidad con precio de modelo', () => {
  const noPrice = gridironMatch({ id: 'nfl-wb-noprice', homeYpp: 4.8, awayYpp: 6.2, spread: 3.5, homeMl: null, awayMl: null });
  const out = runBuilder({ nflMatches: [noPrice] });
  assert.equal(mlOpps(out, 'nfl-ml-').length, 0, 'sin precio real no debe generarse ningún ML');
  assert.equal(
    out.rawOpportunities.filter((o) => o.pick === 'Victoria New York Jets').length,
    0,
    'no debe existir ninguna oportunidad del visitante con precio inventado'
  );
  // Con precio en market pero sin hasRealOdds, la procedencia es 'model' y
  // el splice Gap 3 la descarta (igual que el ML NBA en GAP1 c2).
  const noProof = gridironMatch({ id: 'nfl-wb-noproof', homeYpp: 4.8, awayYpp: 6.2, spread: 3.5, hasRealOdds: false });
  const out2 = runBuilder({ nflMatches: [noProof] });
  assert.equal(mlOpps(out2, 'nfl-ml-').length, 0, 'sin precio real verificable no debe generarse ML');
  assert.equal(out2.approvedOpps.filter((o) => o.id.startsWith('nfl-ml-')).length, 0);
});

test('WORK B (d): ML NCAAF genera con los mismos pisos (visitante y local)', () => {
  // Visitante colegial 64.7% (σ 16.5; homeYpp 4.8 / awayYpp 6.2, spread
  // +3.5) @ 2.44: EV crudo 64.7 - 41.0 = +23.7 >= 3.0.
  const away = gridironMatch({
    id: 'ncaaf-wb-away', sport: 'NCAAF', league: 'NCAAF Colegial FBS',
    homeName: 'Alabama Crimson Tide', awayName: 'Auburn Tigers',
    homeYpp: 4.8, awayYpp: 6.2, spread: 3.5, totalLine: 52.5, homeMl: 1.60, awayMl: 2.44,
  });
  const outAway = runBuilder({ ncaafMatches: [away] });
  const awayOpps = mlOpps(outAway, 'ncaaf-ml-a-');
  assert.equal(awayOpps.length, 1, `se esperaba 1 oportunidad ncaaf-ml-a-, hay ${awayOpps.length}: ${JSON.stringify(outAway.rawOpportunities.map((o) => o.id))}`);
  assert.equal(awayOpps[0].type, '🏈 VISITANTE DIRECTO (NCAAF)');
  assert.equal(awayOpps[0].pick, 'Victoria Auburn Tigers');
  assert.equal(awayOpps[0].rawProb, '64.7%');
  assert.equal(awayOpps[0].odds, '2.44');
  assert.equal(awayOpps[0].oddsSource, 'espn');
  assert.equal(awayOpps[0].probs.awayWinProb, 64.7);
  // Local colegial 68.3% (homeYpp 5.8 / awayYpp 5.0, spread -3.5) @ 1.60.
  const home = gridironMatch({
    id: 'ncaaf-wb-home', sport: 'NCAAF', league: 'NCAAF Colegial FBS',
    homeName: 'Alabama Crimson Tide', awayName: 'Auburn Tigers',
    homeYpp: 5.8, awayYpp: 5.0, spread: -3.5, totalLine: 52.5, homeMl: 1.60, awayMl: 2.44,
  });
  const outHome = runBuilder({ ncaafMatches: [home] });
  const homeOpps = mlOpps(outHome, 'ncaaf-ml-h-');
  assert.equal(homeOpps.length, 1, 'el ML local colegial debe generarse');
  assert.equal(homeOpps[0].type, '🏈 FAVORITO DIRECTO (NCAAF)');
  assert.equal(homeOpps[0].rawProb, '68.3%');
  assert.equal(homeOpps[0].odds, '1.60');
});

function vote1ForMl({
  sport = 'NFL',
  spread = 2.5,
  pickType = '🏈 VISITANTE DIRECTO (NFL)',
  pick = 'Victoria New York Jets',
  odds = '2.44',
  prob = '67.8%',
  homeWinProb = 32.2,
  awayWinProb = 67.8,
  homeYpp = 5.0,
  awayYpp = 5.0,
} = {}) {
  const result = evaluateEnsembleConsensus({
    sport,
    match: {
      home: { name: 'Kansas City Chiefs', ypp: homeYpp },
      away: { name: 'New York Jets', ypp: awayYpp },
      market: {},
      vegas: { spread },
    },
    probs: { homeCoverProb: 40, awayCoverProb: 60, homeWinProb, awayWinProb, keyEvaluation: {} },
    mcStats: { stability: 80, risk: 'Bajo' },
    pickType,
    pick,
    edgeVal: 10,
    prob,
    odds,
  });
  return result.breakdown[0];
}

test('WORK B (e): Voto 1 ML no lo vetan Sucker Line ni Heavy Spread, pero el underdog incompetente sí cae por Blowout Risk', () => {
  // Sucker Line: spread ±2.5. El propio texto del veto dice "o Moneyline
  // directo": el ML es la alternativa recomendada, no el spread vetado.
  // (La prob pasada es la cruda para aislar el enrutado de vetos: en
  // producción el chequeo matemático universal usa la prob CALIBRADA.)
  const sucker = vote1ForMl({ spread: 2.5 });
  assert.equal(sucker.passed, true, `el ML con spread 2.5 no debe vetarlo Sucker Line: ${sucker.reason}`);
  assert.ok(!sucker.reason.includes('Sucker Line'), 'la razón no debe mencionar Sucker Line');
  // Heavy Spread + Disparidad Extrema: spread -10 con favorito local.
  const heavy = vote1ForMl({
    spread: -10,
    pickType: '🏈 FAVORITO DIRECTO (NFL)',
    pick: 'Victoria Kansas City Chiefs',
    odds: '1.60',
    prob: '70%',
    homeWinProb: 70,
    awayWinProb: 30,
    homeYpp: 5.8,
  });
  assert.equal(heavy.passed, true, `el ML favorito con spread -10 no debe vetarlo Heavy Spread: ${heavy.reason}`);
  assert.ok(!heavy.reason.includes('Spread pesado') && !heavy.reason.includes('Disparidad'), 'la razón no debe mencionar Heavy/Disparidad');
  // Blowout Risk (Candado 3): underdog visitante con YPP 4.5 < 4.65.
  const blowout = vote1ForMl({ spread: 2.5, awayYpp: 4.5 });
  assert.equal(blowout.passed, false, 'el underdog incompetente debe fallar el Voto 1');
  assert.match(blowout.reason, /Blowout Risk/, `la razón debe ser Blowout Risk: ${blowout.reason}`);
  // Regresión: un SPREAD a ±2.5 sigue vetado por Sucker Line (sin cambios).
  const spreadPick = evaluateEnsembleConsensus({
    sport: 'NFL',
    match: {
      home: { name: 'Kansas City Chiefs', ypp: 5.8 },
      away: { name: 'New York Jets', ypp: 5.0 },
      market: {},
      vegas: { spread: 2.5 },
    },
    probs: { homeCoverProb: 40, awayCoverProb: 60, keyEvaluation: {} },
    mcStats: { stability: 80, risk: 'Bajo' },
    pickType: '🏈 VENTAJA CONTRA EL SPREAD (NFL)',
    pick: 'New York Jets +2.5 (Cubre Línea)',
    edgeVal: 10,
    prob: '60%',
    odds: '1.91',
  });
  assert.equal(spreadPick.breakdown[0].passed, false, 'el spread +2.5 sigue vetado');
  assert.match(spreadPick.breakdown[0].reason, /Sucker Line/);
});

test('WORK B (e2): Voto 1 ML NCAAF enruta (antes nunca pasaba) y el spread NCAAF conserva su comportamiento', () => {
  // 'ncaaf' no contiene 'nfl': sin el enrutado ML-only, la NCAAF no
  // entraba a la rama NFL y su Voto 1 nunca pasaba.
  const ml = vote1ForMl({
    sport: 'NCAAF',
    spread: -3.5,
    pickType: '🏈 FAVORITO DIRECTO (NCAAF)',
    pick: 'Victoria Kansas City Chiefs',
    odds: '1.60',
    prob: '68.3%',
    homeWinProb: 68.3,
    awayWinProb: 31.7,
    homeYpp: 5.8,
  });
  assert.equal(ml.passed, true, `el ML NCAAF debe pasar el Voto 1: ${ml.reason}`);
  assert.match(ml.reason, /NCAAF/);
  // El spread NCAAF NO se enruta (decisión deliberada: meterlo cambiaría
  // sus vetos, calibrados para spreads NFL). Su Voto 1 sigue sin rama,
  // como antes de este cambio.
  const spread = evaluateEnsembleConsensus({
    sport: 'NCAAF',
    match: {
      home: { name: 'Alabama Crimson Tide', ypp: 5.8 },
      away: { name: 'Auburn Tigers', ypp: 5.0 },
      market: {},
      vegas: { spread: -3.5 },
    },
    probs: { homeCoverProb: 70, awayCoverProb: 30, keyEvaluation: {} },
    mcStats: { stability: 80, risk: 'Bajo' },
    pickType: '🎓 VENTAJA SPREAD COLEGIAL (NCAAF)',
    pick: 'Alabama Crimson Tide -3.5 (Cubre Línea)',
    edgeVal: 10,
    prob: '70%',
    odds: '1.91',
  });
  assert.equal(spread.breakdown[0].passed, false, 'el spread NCAAF conserva su Voto 1 sin rama');
  assert.equal(spread.breakdown[0].reason, '', 'sin rama, el motivo queda vacío como antes');
});

test('WORK B (f): estado honesto en el flujo completo — el ML generado queda vetado por market_outlier, no por falta de precio', () => {
  // Con el par viejo (A=0.65/B=-0.20, reversión completa 2026-11-25), una
  // cruda 67.8% calibra 57.1% ≥ 54% (piso ML de classifyOpportunity): la
  // oportunidad EXISTE (cierra el hueco de generación) y pasa el Voto 1,
  // pero el tope market_outlier (12 pp) la veta: 57.1% vs mercado sin vig
  // (~44%) supera 12 pp. Con el refit (48.1%) el veto era prob_below_min.
  // El despacho exigiría cruda >= ~81% con el refit; con el par viejo el
  // piso se pasa pero el mercado frena. Lo que se afirma aquí: el veto es
  // por el gate de seguridad, no por precio ni por consenso.
  const match = gridironMatch({ id: 'nfl-wb-away', homeYpp: 4.8, awayYpp: 6.2, spread: 3.5, homeMl: 1.60, awayMl: 2.44 });
  const out = runBuilder({ nflMatches: [match] });
  const opp = mlOpps(out, 'nfl-ml-a-')[0];
  assert.ok(opp, 'la oportunidad debe existir en rawOpportunities');
  // Voto 1 ✅ (camino ML, con la prob calibrada en el chequeo matemático),
  // Voto 3 ✅. Voto 2 ❌ por un hueco PREEXISTENTE del MC (estabilidad 67
  // con riesgo 'Bajo': el umbral exige >= 68 para 'Bajo' y >= 58 para
  // 'Medio', así que 67/'Bajo' cae entre ambos; afecta igual a los spreads
  // con este mismo mcNfl, no es del ML). 2/3 votos bastan para classify.
  assert.equal(opp.consensus.breakdown[0].passed, true, 'el Voto 1 ML debe pasar');
  assert.equal(opp.consensus.votesPassed, 2, '2/3 votos (Voto 2 cae por el hueco preexistente del MC)');
  const verdict = classifyOpportunity(opp);
  assert.equal(verdict.approved, false);
  assert.equal(verdict.vetoReason, 'market_outlier', `el veto debe ser market_outlier, es ${verdict.vetoReason}: ${verdict.vetoDetail}`);
  assert.equal(out.approvedOpps.filter((o) => o.id.startsWith('nfl-ml-')).length, 0);
  assert.equal(out.vetoedOpps.filter((o) => o.id.startsWith('nfl-ml-')).length, 1, 'queda registrada en vetados (modo paper la califica)');
});
