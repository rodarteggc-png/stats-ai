import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunitiesAndTopSlate } from './alertEngine.js';
import { calculateMatchProbabilities } from '../src/utils/poisson.js';

// Hándicap asiático en la línea del mercado (Gap 2, 2026-11-24).
// Mirror del fix de totales (bd1e617): antes el builder solo evaluaba -1.5
// y solo usaba cuota real si la línea publicada era exactamente -1.5, así que
// un mercado en -2.5 generaba picks con cuota inventada (y se vetaban por
// odds_model) o no generaba nada. Ahora el builder evalúa la línea que
// realmente ofrece el mercado (-1.5/-2.5, o +1.5/+2.5 del local cuando el
// favorito es visitante) y la probabilidad del modelo para ESA línea
// (homeMinus25/awayMinus25 ya existen en Poisson), con cuota real de la
// misma fuente que la línea (Pinnacle primero, ESPN/DraftKings de respaldo).
// Sin línea soportada (p. ej. -2.75 asiática) no se usa cuota real.

function soccerMatch({ id, home, away, homeOdds, awayOdds, vegas, marketExtra = {}, sharpValidated = false }) {
  return {
    id,
    sport: 'futbol',
    league: 'Premier League',
    leagueCode: 'eng.1',
    gameDate: '2026-11-19T20:00:00Z',
    home: { name: home.name, xG: home.xG, elo: 1500, daysRest: 7 },
    away: { name: away.name, xG: away.xG, elo: 1450, daysRest: 7 },
    market: { homeOdds, awayOdds, provider: 'DraftKings', hasRealOdds: true, ...marketExtra },
    ...(vegas ? { vegas } : {}),
    ...(sharpValidated ? { sharpValidated: true } : {}),
    oddsFetchedAt: new Date().toISOString(),
  };
}

function runBuilder(matches) {
  return buildOpportunitiesAndTopSlate({
    soccerMatches: matches,
    mlbMatches: [], nflMatches: [], ncaafMatches: [], nbaMatches: [],
    maxPicksToSend: 6, sentCache: {}, isForce: true,
  });
}

test('Gap 2: Poisson ya calcula -2.5 (homeMinus25/awayMinus25) sin cambiar -1.5', () => {
  const p = calculateMatchProbabilities(1.61, 0.78, 1500, 1450, 7, 7, 0, 0, 6, false, -0.13, 'Premier League');
  for (const key of ['homeMinus15', 'awayMinus15', 'homeMinus25', 'awayMinus25']) {
    assert.ok(p.spreads[key] !== undefined, `falta ${key} en spreads`);
    const v = parseFloat(p.spreads[key]);
    assert.ok(!Number.isNaN(v) && v >= 0 && v <= 100, `${key} fuera de rango: ${p.spreads[key]}`);
  }
  // Ganar por 3+ es un subconjunto de ganar por 2+.
  assert.ok(parseFloat(p.spreads.homeMinus25) <= parseFloat(p.spreads.homeMinus15), 'homeMinus25 debe ser <= homeMinus15');
  assert.ok(parseFloat(p.spreads.awayMinus25) <= parseFloat(p.spreads.awayMinus15), 'awayMinus25 debe ser <= awayMinus15');
});

test('Gap 2: línea -2.5 (ESPN) genera AH -2.5 con cuota real', () => {
  const out = runBuilder([soccerMatch({
    id: 'soccer-ah-25',
    home: { name: 'Team A', xG: '5.00' },
    away: { name: 'Team B', xG: '0.25' },
    homeOdds: '1.30', awayOdds: '8.00',
    marketExtra: { spreadHomeClose: -2.5, homeSpreadOdds: '2.10', awaySpreadOdds: '1.75' },
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'ah-home-soccer-ah-25');
  assert.equal(raw.length, 1, `se esperaba 1 pick AH -2.5, hay ${raw.length}: ${JSON.stringify(out.rawOpportunities.filter(o => o.id.startsWith('ah-')).map(o => o.pick))}`);
  assert.equal(raw[0].pick, 'Team A -2.5 (Gana por 3+ goles)');
  assert.equal(raw[0].type, '⚡ HÁNDICAP ASIÁTICO (-2.5)');
  assert.equal(raw[0].odds, '2.10');
  assert.equal(raw[0].oddsSource, 'espn', 'la cuota -2.5 es real (ESPN, tier espn), no model');
  // Cruda Poisson homeMinus25 = 81.2% → Platt global A=0.34/B=-0.33 sobre
  // el 81% redondeado del builder = 54.1%.
  assert.equal(parseFloat(raw[0].prob), 54.1, `prob AH -2.5 ${raw[0].prob}, se esperaba 54.1`);
  // El pick pasa todos los candados vigentes (3 votos, EV, sin outlier):
  // no se veta por odds_model ni por ningún otro motivo.
  assert.equal(out.vetoedOpps.filter(o => o.id === 'ah-home-soccer-ah-25').length, 0,
    `el AH -2.5 no debe vetarse: ${JSON.stringify(out.vetoedOpps.filter(o => o.id.startsWith('ah-')).map(o => o.vetoReason))}`);
  assert.equal(out.approvedOpps.filter(o => o.id === 'ah-home-soccer-ah-25').length, 1,
    'el AH -2.5 con cuota real debe quedar aprobado');
});

test('Gap 2: línea +2.5 del local (favorito visitante) genera AH -2.5 con cuota real', () => {
  const out = runBuilder([soccerMatch({
    id: 'soccer-ah-away25',
    home: { name: 'Team B', xG: '0.25' },
    away: { name: 'Team A', xG: '5.00' },
    homeOdds: '8.00', awayOdds: '1.30',
    marketExtra: { spreadHomeClose: 2.5, homeSpreadOdds: '1.75', awaySpreadOdds: '2.10' },
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'ah-away-soccer-ah-away25');
  assert.equal(raw.length, 1, `se esperaba 1 pick AH -2.5 visitante, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'Team A -2.5 (Gana por 3+ goles)');
  assert.equal(raw[0].odds, '2.10');
  assert.equal(raw[0].oddsSource, 'espn', 'la cuota -2.5 visitante es real (ESPN), no model');
  assert.equal(parseFloat(raw[0].prob), 53.5, `prob AH -2.5 visitante ${raw[0].prob}, se esperaba 53.5`);
  assert.equal(out.approvedOpps.filter(o => o.id === 'ah-away-soccer-ah-away25').length, 1,
    'el AH -2.5 visitante con cuota real debe quedar aprobado');
});

test('Gap 2: línea Pinnacle (m.vegas) tiene prioridad sobre ESPN en -2.5', () => {
  const m = soccerMatch({
    id: 'soccer-ah-sharp25',
    home: { name: 'Team A', xG: '5.00' },
    away: { name: 'Team B', xG: '0.25' },
    homeOdds: '1.30', awayOdds: '8.00',
    marketExtra: { spreadHomeClose: -2.5, homeSpreadOdds: '2.10', awaySpreadOdds: '1.75' },
  });
  // Pinnacle trae la misma línea -2.5 pero con cuota distinta.
  m.vegas = { spread: -2.5, spreadHomeOdds: '2.05', spreadAwayOdds: '1.80', provider: 'Pinnacle' };
  m.sharpValidated = true;
  const out = runBuilder([m]);
  const raw = out.rawOpportunities.filter(o => o.id === 'ah-home-soccer-ah-sharp25');
  assert.equal(raw.length, 1, `se esperaba 1 pick AH -2.5, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'Team A -2.5 (Gana por 3+ goles)');
  assert.equal(raw[0].odds, '2.05', 'la cuota debe ser la de Pinnacle, no la de ESPN');
  assert.equal(raw[0].oddsSource, 'market', 'con enriquecimiento sharp la procedencia es market');
});

test('Gap 2: línea no soportada (-2.75) no usa cuota real (fail-closed)', () => {
  const out = runBuilder([soccerMatch({
    id: 'soccer-ah-275',
    home: { name: 'Team A', xG: '2.50' },
    away: { name: 'Team B', xG: '0.50' },
    homeOdds: '1.30', awayOdds: '8.00',
    marketExtra: { spreadHomeClose: -2.75, homeSpreadOdds: '2.10', awaySpreadOdds: '1.75' },
  })]);
  const raw = out.rawOpportunities.filter(o => o.id.startsWith('ah-'));
  // El builder cae al fallback -1.5 con cuota del modelo (1.74 justa),
  // pero el fail-closed del GAP3 elimina las oportunidades de solo-modelo:
  // no se genera ninguna oportunidad AH. El 2.10 real de la línea -2.75
  // nunca se usa (es de otra línea y no se puede usar).
  assert.equal(raw.length, 0, `línea -2.75 no soportada: no debe generarse oportunidad AH, hay ${raw.length}`);
  const anyWithRealPrice = out.rawOpportunities.filter(o => o.odds === '2.10' || o.odds === 2.10);
  assert.equal(anyWithRealPrice.length, 0, 'el precio real 2.10 de la línea -2.75 no debe aparecer en ninguna oportunidad');
  assert.equal(out.approvedOpps.filter(o => o.id.startsWith('ah-')).length, 0, 'nada aprobado para la línea no soportada');
});

test('Gap 2: línea -1.5 sigue igual (regresión)', () => {
  // Fixture con el comportamiento pre-cambio verificado: vegas -1.5 @ 1.85
  // (Pinnacle) y ESPN -1.5 @ 1.90; el builder usaba el precio sharp y la
  // procedencia quedaba 'espn' por el proveedor DraftKings del market.
  const out = runBuilder([soccerMatch({
    id: 'soccer-ah-base15',
    home: { name: 'Team A', xG: '3.50' },
    away: { name: 'Team B', xG: '0.50' },
    homeOdds: '1.30', awayOdds: '8.00',
    vegas: { spread: -1.5, spreadHomeOdds: '1.85', spreadAwayOdds: '1.95', provider: 'Pinnacle' },
    marketExtra: { spreadHomeClose: -1.5, homeSpreadOdds: '1.90', awaySpreadOdds: '1.90' },
  })]);
  const raw = out.rawOpportunities.filter(o => o.id === 'ah-home-soccer-ah-base15');
  assert.equal(raw.length, 1, `se esperaba 1 pick AH -1.5, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'Team A -1.5 (Gana por 2+ goles)');
  assert.equal(raw[0].type, '⚡ HÁNDICAP ASIÁTICO (-1.5)');
  assert.equal(raw[0].odds, '1.85');
  assert.equal(raw[0].oddsSource, 'espn');
  assert.equal(parseFloat(raw[0].prob), 52.5, `prob AH -1.5 ${raw[0].prob}, se esperaba 52.5`);
  const vetoed = out.vetoedOpps.filter(o => o.id === 'ah-home-soccer-ah-base15');
  assert.equal(vetoed.length, 1, 'el AH -1.5 de referencia sigue vetado como antes');
  assert.equal(vetoed[0].vetoReason, 'ev_below_min', `el veto debe seguir siendo ev_below_min, es: ${vetoed[0].vetoReason}`);
});
