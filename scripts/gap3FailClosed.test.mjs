import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunitiesAndTopSlate, hasRealPrice, REAL_ODDS_SOURCES } from './alertEngine.js';
import { selectHighProbabilityCandidates } from '../api/_lib/futureMultiSport.js';
import { parsePropLineProps } from '../src/services/propLine.js';

// GAP 3 (2026-11-24): fail-closed en el builder. Una oportunidad sin precio
// real ('market' | 'espn' | 'propline') NO se genera: antes se generaba con
// cuota inventada (oddsSource 'model') y se vetaba después en C3/P4. C3, P4
// y market_outlier NO se tocan: quedan como red de seguridad.

function runBuilder({ soccerMatches = [], nflMatches = [] }) {
  return buildOpportunitiesAndTopSlate({
    soccerMatches, mlbMatches: [], nflMatches, ncaafMatches: [], nbaMatches: [],
    maxPicksToSend: 6, sentCache: {}, isForce: true,
  });
}

// Mismo partido en dos versiones: sin precio real y con precio ESPN. El
// modelo es idéntico (xG 3.50/0.50): la única diferencia es el precio.
function soccerTotalsMatch(withPrice) {
  return {
    id: 'soccer-gap3-tot',
    sport: 'futbol',
    league: 'Premier League',
    leagueCode: 'eng.1',
    gameDate: '2026-11-19T20:00:00Z',
    home: { name: 'Team A', xG: '3.50', elo: 1500, daysRest: 7 },
    away: { name: 'Team B', xG: '0.50', elo: 1450, daysRest: 7 },
    ...(withPrice
      ? { market: { totalClose: 2.5, overOdds: '1.90', underOdds: '1.90', provider: 'DraftKings' } }
      : { market: {} }),
  };
}

function soccerMarketMatch() {
  return {
    id: 'soccer-gap3-mkt',
    sport: 'futbol',
    league: 'Premier League',
    leagueCode: 'eng.1',
    gameDate: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
    home: { name: 'Team A', xG: '1.80', elo: 1500, daysRest: 7 },
    away: { name: 'Team B', xG: '0.30', elo: 1450, daysRest: 7 },
    market: {
      hasRealOdds: true, homeOdds: '1.70', drawOdds: '3.80', awayOdds: '5.00',
      sharpBookmaker: 'Pinnacle', provider: 'Pinnacle',
    },
    sharpValidated: true,
  };
}

// Fernando Mendoza, Raiders @ Broncos — precio real DraftKings vía PropLine
// (fixture mínimo tomado de propLine.test.mjs, respuesta real 20 nov 2026).
const MENDOZA_ODDS = {
  id: '723936', sport_key: 'football_nfl', home_team: 'Denver Broncos', away_team: 'Las Vegas Raiders',
  bookmakers: [{
    key: 'draftkings', title: 'DraftKings',
    markets: [{
      key: 'player_pass_yds', description: 'Fernando Mendoza Passing Yards',
      outcomes: [
        { name: 'Over', description: 'Fernando Mendoza', point: 169.5, price: -111 },
        { name: 'Under', description: 'Fernando Mendoza', point: 169.5, price: -113 },
      ],
    }],
  }],
};

function nflPropMatch(withPrice) {
  return {
    id: 'nfl-gap3-prop',
    gameDate: '2026-11-22T21:25:00Z',
    home: {
      name: 'Denver Broncos', abbr: 'DEN', qb: 'Bo Nix', ypp: 5.6, turnoverDiff: 2, epaNet: 0.05,
      teamStats: { passYardsPerGame: 235.4, statsSource: 'espn' },
    },
    away: {
      name: 'Las Vegas Raiders', abbr: 'LV', qb: 'Fernando Mendoza', ypp: 5.1, turnoverDiff: -3, epaNet: -0.08,
      teamStats: { passYardsPerGame: 198.2, statsSource: 'espn' },
    },
    vegas: { spread: -10.5, overUnder: 44.5 },
    market: {},
    propLineProps: withPrice ? parsePropLineProps(MENDOZA_ODDS).props : [],
    propLineFetchedAt: new Date().toISOString(),
  };
}

// (a) Sin precio real no se genera NADA en el path de despacho.
test('GAP 3 (a): totales de fútbol sin precio real no generan oportunidad', () => {
  const out = runBuilder({ soccerMatches: [soccerTotalsMatch(false)] });
  assert.equal(out.rawOpportunities.length, 0,
    `sin precio no debe haber oportunidades, hay: ${JSON.stringify(out.rawOpportunities.map(o => o.id))}`);
  assert.equal(out.approvedOpps.length, 0);
  assert.equal(out.vetoedOpps.length, 0, 'sin oportunidad generada tampoco hay veto que registrar');
  assert.equal(out.topSlate.length, 0);
});

test('GAP 3 (a): 1X2 de fútbol sin precio real no genera oportunidad', () => {
  const noPrice = { ...soccerMarketMatch(), market: {} };
  delete noPrice.sharpValidated;
  const out = runBuilder({ soccerMatches: [noPrice] });
  assert.equal(out.rawOpportunities.length, 0,
    `sin precio no debe haber oportunidades, hay: ${JSON.stringify(out.rawOpportunities.map(o => o.id))}`);
});

test('GAP 3 (a): prop NFL sin precio PropLine no genera oportunidad', () => {
  const out = runBuilder({ nflMatches: [nflPropMatch(false)] });
  assert.equal(out.rawOpportunities.filter(o => String(o.id || '').startsWith('prop-nfl-')).length, 0);
});

// (b) Con precio real la oportunidad se genera exactamente como antes.
test('GAP 3 (b): con precio ESPN la oportunidad se genera igual que antes', () => {
  const out = runBuilder({ soccerMatches: [soccerTotalsMatch(true)] });
  const raw = out.rawOpportunities.filter(o => o.id === 'tot-o-soccer-gap3-tot');
  assert.equal(raw.length, 1, `se esperaba 1 OVER 2.5, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'OVER 2.5 Goles');
  assert.equal(raw[0].odds, '1.90');
  assert.equal(raw[0].oddsSource, 'espn');
  assert.ok(hasRealPrice(raw[0]));
});

test('GAP 3 (b): con precio sharp (market) la oportunidad se genera igual que antes', () => {
  const out = runBuilder({ soccerMatches: [soccerMarketMatch()] });
  const raw = out.rawOpportunities.filter(o => o.id === 'ev-home-soccer-gap3-mkt');
  assert.equal(raw.length, 1, `se esperaba 1 favorito local, hay ${raw.length}`);
  assert.equal(raw[0].pick, 'Victoria Team A (1X2)');
  assert.equal(raw[0].odds, '1.70');
  assert.equal(raw[0].oddsSource, 'market');
  assert.ok(hasRealPrice(raw[0]));
});

test('GAP 3 (b): con precio PropLine el prop NFL se genera igual que antes', () => {
  const out = runBuilder({ nflMatches: [nflPropMatch(true)] });
  const props = out.rawOpportunities.filter(o => String(o.id || '').startsWith('prop-nfl-'));
  assert.equal(props.length, 1, `se esperaba 1 prop QB, hay ${props.length}`);
  assert.equal(props[0].oddsSource, 'propline');
  assert.equal(props[0].odds, '1.90');
  assert.ok(String(props[0].pick).includes('Fernando Mendoza Más de 169.5 yardas por pase'));
});

test('GAP 3 (b): hasRealPrice admite solo market/espn/propline', () => {
  assert.deepEqual([...REAL_ODDS_SOURCES].sort(), ['espn', 'market', 'propline']);
  for (const source of ['market', 'espn', 'propline']) {
    assert.equal(hasRealPrice({ oddsSource: source }), true, source);
  }
  for (const source of ['model', 'assumed', 'proxy', 'derived', undefined, null, '']) {
    assert.equal(hasRealPrice({ oddsSource: source }), false, String(source));
  }
  assert.equal(hasRealPrice(null), false);
  assert.equal(hasRealPrice({}), false);
});

// (c) Display: ningún path de visualización puede mostrar una candidata
// model-only, porque el builder ya no las genera Y el selector de /futuro
// las excluye por su cuenta. /futuro (futureMultiSport.js) y /cheatsheet
// (webhook.js:334, result.toSend || result.approvedOpps) solo leen
// approvedOpps, así que no se dejó ningún display con model-only que
// conservar: no hay path que mostrar etiquetado, hay ausencia total.
test('GAP 3 (c): /futuro no muestra candidatas model-only aunque lleguen al selector', () => {
  const start = Date.parse('2026-11-19T12:00:00Z');
  const end = start + 48 * 3600000;
  const base = {
    sport: 'Fútbol', game: 'Team A vs Team B', gameDate: '2026-11-19T20:00:00Z',
    pick: 'OVER 2.5 Goles', prob: '70%', odds: 1.9, evPct: 10,
    consensus: { votesPassed: 3 }, match: { home: { name: 'Team A' }, away: { name: 'Team B' } },
  };
  const candidates = selectHighProbabilityCandidates(
    [{ ...base, oddsSource: 'model' }, { ...base, game: 'Team C vs Team D', oddsSource: 'espn' },
     { ...base, game: 'Team E vs Team F', oddsSource: 'market' }],
    start, end);
  assert.equal(candidates.length, 2, 'solo las dos con precio real pasan el selector de /futuro');
  assert.ok(candidates.every(c => ['espn', 'market'].includes(c.oddsSource)));
  assert.ok(!candidates.some(c => c.oddsSource === 'model'));
});

test('GAP 3 (c): el builder no entrega nada model-only a /futuro ni a /cheatsheet', () => {
  const out = runBuilder({
    soccerMatches: [soccerTotalsMatch(false), soccerTotalsMatch(true), soccerMarketMatch()],
    nflMatches: [nflPropMatch(true)],
  });
  // Todo lo que sale del builder (crudo, aprobado o slate) tiene precio real.
  for (const opp of [...out.rawOpportunities, ...out.approvedOpps, ...out.topSlate]) {
    assert.ok(hasRealPrice(opp), `${opp.id} salió del builder con oddsSource ${opp.oddsSource}`);
  }
  // Y la candidata sin precio no está en ninguna lista.
  assert.ok(!out.rawOpportunities.some(o => o.id === 'tot-o-soccer-gap3-tot' && o.oddsSource === 'model'));
  const start = Date.parse('2026-11-19T12:00:00Z');
  const futuro = selectHighProbabilityCandidates(out.approvedOpps, start, start + 48 * 3600000);
  assert.ok(futuro.every(c => hasRealPrice(c)));
});
