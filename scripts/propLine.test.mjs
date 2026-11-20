import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPropLineEvents,
  fetchPropLineOdds,
  parsePropLineProps,
  findPropLinePrice,
  americanToDecimal,
} from '../src/services/propLine.js';
import { resolveOddsProvenance, buildOpportunitiesAndTopSlate } from './alertEngine.js';

// Integración PropLine (2026-11-20): precios reales DraftKings para player
// props y totales de equipo. Fixtures tomados de las respuestas reales de
// api.prop-line.com verificadas en vivo el 20 nov 2026 (sin llamadas a la
// red en los tests).

// Fernando Mendoza, Raiders @ Broncos (evento 723936): la línea principal
// viene en formato Over/Under (169.5) y ADEMÁS en escalera para el mismo
// jugador. El formato Over/Under manda (tiene ambos lados y la línea exacta).
const MENDOZA_ODDS = {
  id: '723936',
  sport_key: 'football_nfl',
  home_team: 'Denver Broncos',
  away_team: 'Las Vegas Raiders',
  bookmakers: [{
    key: 'draftkings',
    title: 'DraftKings',
    markets: [
      {
        key: 'player_pass_yds',
        description: 'Fernando Mendoza Passing Yards',
        outcomes: [
          { name: 'Over', description: 'Fernando Mendoza', point: 169.5, price: -111 },
          { name: 'Under', description: 'Fernando Mendoza', point: 169.5, price: -113 },
        ],
      },
      {
        key: 'player_pass_yds',
        description: 'Fernando Mendoza Passing Yards',
        outcomes: [
          { name: '150+ Passing Yards', description: 'Fernando Mendoza', point: null, price: -200 },
          { name: '160+ Passing Yards', description: 'Fernando Mendoza', point: null, price: -149 },
          { name: '170+ Passing Yards', description: 'Fernando Mendoza', point: null, price: -112 },
          { name: '180+ Passing Yards', description: 'Fernando Mendoza', point: null, price: 117 },
        ],
      },
    ],
  }],
};

// Joe Burrow, Bengals @ Washington (evento 726376): SOLO escalera
// (210+ ... 390+) y totales (juego, equipos y alternos).
const BURROW_ODDS = {
  id: '726376',
  sport_key: 'football_nfl',
  home_team: 'Washington Commanders',
  away_team: 'Cincinnati Bengals',
  bookmakers: [{
    key: 'draftkings',
    title: 'DraftKings',
    markets: [
      {
        key: 'player_pass_yds',
        description: 'Joe Burrow Passing Yards',
        outcomes: [
          { name: '290+ Passing Yards', description: 'Joe Burrow', point: null, price: -151 },
          { name: '300+ Passing Yards', description: 'Joe Burrow', point: null, price: -122 },
          { name: '310+ Passing Yards', description: 'Joe Burrow', point: null, price: 103 },
          { name: '320+ Passing Yards', description: 'Joe Burrow', point: null, price: 129 },
        ],
      },
      {
        key: 'totals',
        description: 'Total',
        outcomes: [
          { name: 'Over', description: '', point: 53.5, price: -116 },
          { name: 'Under', description: '', point: 53.5, price: -103 },
        ],
      },
      {
        key: 'totals',
        description: 'Team Total Points - CIN Bengals',
        outcomes: [
          { name: 'Over', description: '', point: 30.5, price: -110 },
          { name: 'Under', description: '', point: 30.5, price: -120 },
        ],
      },
      {
        key: 'totals',
        description: 'Team Total Points - WAS Commanders',
        outcomes: [
          { name: 'Over', description: '', point: 23.5, price: -120 },
          { name: 'Under', description: '', point: 23.5, price: -110 },
        ],
      },
      {
        key: 'totals',
        description: 'Total Alternate (line 31.5)',
        outcomes: [
          { name: 'Over', description: '', point: 31.5, price: -10000 },
          { name: 'Under', description: '', point: 31.5, price: 1260 },
        ],
      },
    ],
  }],
};

// Jalen Johnson, Hawks vs Hornets (NBA): puntos en formato Over/Under.
const JOHNSON_ODDS = {
  id: '718963',
  sport_key: 'basketball_nba',
  home_team: 'Atlanta Hawks',
  away_team: 'Charlotte Hornets',
  bookmakers: [{
    key: 'draftkings',
    title: 'DraftKings',
    markets: [{
      key: 'player_points',
      description: 'Jalen Johnson Points',
      outcomes: [
        { name: 'Over', description: 'Jalen Johnson', point: 21.5, price: -104 },
        { name: 'Under', description: 'Jalen Johnson', point: 21.5, price: -122 },
      ],
    }],
  }],
};

test('americanToDecimal: convierte momios americanos a decimal', () => {
  assert.equal(americanToDecimal(-111), 1.9);
  assert.equal(americanToDecimal(-122), 1.82);
  assert.equal(americanToDecimal(103), 2.03);
  assert.equal(americanToDecimal(-10000), 1.01);
  assert.equal(americanToDecimal(0), null);
  assert.equal(americanToDecimal('nope'), null);
  assert.equal(americanToDecimal(null), null);
});

test('parse: formato Over/Under (Mendoza 169.5) con escalera presente', () => {
  const { props, teamTotals, gameTotal } = parsePropLineProps(MENDOZA_ODDS);
  assert.equal(props.length, 1);
  const p = props[0];
  assert.equal(p.player, 'Fernando Mendoza');
  assert.equal(p.market, 'player_pass_yds');
  assert.equal(p.format, 'over_under');
  assert.equal(p.line, 169.5);
  assert.equal(p.overPrice, -111);
  assert.equal(p.underPrice, -113);
  assert.equal(p.overDecimal, 1.9);
  assert.equal(p.underDecimal, 1.88);
  assert.ok(Array.isArray(p.ladder) && p.ladder.length === 4, 'la escalera se conserva como referencia');
  assert.equal(teamTotals, null);
  assert.equal(gameTotal, null);
});

test('parse: formato escalera (Burrow) deriva la línea principal cercana a -110', () => {
  const { props, teamTotals, gameTotal } = parsePropLineProps(BURROW_ODDS);
  assert.equal(props.length, 1);
  const p = props[0];
  assert.equal(p.player, 'Joe Burrow');
  assert.equal(p.market, 'player_pass_yds');
  assert.equal(p.format, 'milestone');
  // 300+ @ -122 (implícita 54.95%) es la fila más cercana a -110 (52.38%):
  // 290+ @ -151 = 60.16%, 310+ @ +103 = 49.28%, 320+ @ +129 = 43.67%.
  // "300+" equivale a Más de 299.5.
  assert.equal(p.line, 299.5);
  assert.equal(p.overPrice, -122);
  assert.equal(p.overDecimal, 1.82);
  assert.equal(p.underPrice, null);
  assert.equal(p.underDecimal, null);
  assert.equal(p.ladder.length, 4);
  // Totales de equipo asignados por nombre (CIN = visitante, WAS = local);
  // el total alterno se ignora.
  assert.ok(teamTotals);
  assert.equal(teamTotals.away.line, 30.5);
  assert.equal(teamTotals.away.overDecimal, 1.91);
  assert.equal(teamTotals.home.line, 23.5);
  assert.equal(teamTotals.home.underDecimal, 1.91);
  assert.equal(gameTotal.line, 53.5);
});

test('parse: props NBA (Jalen Johnson puntos 21.5)', () => {
  const { props } = parsePropLineProps(JOHNSON_ODDS);
  assert.equal(props.length, 1);
  assert.equal(props[0].player, 'Jalen Johnson');
  assert.equal(props[0].market, 'player_points');
  assert.equal(props[0].line, 21.5);
  assert.equal(props[0].overDecimal, 1.96);
  assert.equal(props[0].underDecimal, 1.82);
});

test('parse: respuesta malformada devuelve vacío sin lanzar', () => {
  const empty = { props: [], teamTotals: null, gameTotal: null };
  assert.deepEqual(parsePropLineProps(null), empty);
  assert.deepEqual(parsePropLineProps(undefined), empty);
  assert.deepEqual(parsePropLineProps({}), empty);
  assert.deepEqual(parsePropLineProps({ bookmakers: 'nope' }), empty);
  assert.deepEqual(parsePropLineProps({ bookmakers: [] }), empty);
  assert.deepEqual(parsePropLineProps({ bookmakers: [{ key: 'draftkings', markets: null }] }), empty);
  assert.deepEqual(parsePropLineProps({ bookmakers: [{ key: 'fanduel', markets: [] }] }), empty);
  assert.deepEqual(parsePropLineProps({ bookmakers: [{ key: 'draftkings', markets: [{ key: 'player_pass_yds', outcomes: null }] }] }), empty);
});

test('sin llave: los fetchers devuelven vacío sin llamar a la red', async () => {
  const prev = process.env.PROPLINE_API_KEY;
  delete process.env.PROPLINE_API_KEY;
  try {
    assert.deepEqual(await fetchPropLineEvents('nfl'), []);
    assert.deepEqual(await fetchPropLineEvents('football_nfl'), []);
    assert.equal(await fetchPropLineOdds('football_nfl', '723936', ['player_pass_yds']), null);
    assert.equal(await fetchPropLineOdds('nfl', '723936', 'player_pass_yds'), null);
  } finally {
    if (prev !== undefined) process.env.PROPLINE_API_KEY = prev;
  }
});

test('findPropLinePrice: coincide jugador+mercado+línea+lado (insensible a mayúsculas)', () => {
  const mendoza = parsePropLineProps(MENDOZA_ODDS).props;
  assert.deepEqual(
    findPropLinePrice(mendoza, { player: 'Fernando Mendoza', market: 'player_pass_yds', line: 169.5, side: 'over' }),
    { decimal: 1.9, american: -111 }
  );
  assert.deepEqual(
    findPropLinePrice(mendoza, { player: 'fernando mendoza', market: 'player_pass_yds', line: 169.5, side: 'under' }),
    { decimal: 1.88, american: -113 }
  );
  // La línea debe coincidir: un precio de otra línea no aplica.
  assert.equal(findPropLinePrice(mendoza, { player: 'Fernando Mendoza', market: 'player_pass_yds', line: 170.5, side: 'over' }), null);
  // Otro jugador u otro mercado no coincide.
  assert.equal(findPropLinePrice(mendoza, { player: 'Joe Burrow', market: 'player_pass_yds', line: 169.5, side: 'over' }), null);
  assert.equal(findPropLinePrice(mendoza, { player: 'Fernando Mendoza', market: 'player_points', line: 169.5, side: 'over' }), null);
  // Escalera: el lado under no existe (solo se vende el Over de la escalera).
  const burrow = parsePropLineProps(BURROW_ODDS).props;
  assert.equal(findPropLinePrice(burrow, { player: 'Joe Burrow', market: 'player_pass_yds', line: 299.5, side: 'under' }), null);
  assert.deepEqual(
    findPropLinePrice(burrow, { player: 'Joe Burrow', market: 'player_pass_yds', line: 299.5, side: 'over' }),
    { decimal: 1.82, american: -122 }
  );
  // Sin props o con entrada inválida: null, sin lanzar.
  assert.equal(findPropLinePrice([], { player: 'X', market: 'player_pass_yds', line: 1, side: 'over' }), null);
  assert.equal(findPropLinePrice(null, { player: 'X', market: 'player_pass_yds', line: 1, side: 'over' }), null);
});

test('resolveOddsProvenance: prop con precio PropLine queda propline; sin precio queda model', () => {
  const props = parsePropLineProps(MENDOZA_ODDS).props;
  const match = { id: 'nfl-401873075', propLineProps: props, propLineFetchedAt: new Date().toISOString() };
  const oppWithPrice = {
    id: 'prop-nfl-nfl-401873075-FernandoMendoza',
    isProp: true,
    sport: 'NFL',
    pick: 'Fernando Mendoza Más de 169.5 yardas por pase',
    odds: '1.90',
    match,
    propMeta: { player: 'Fernando Mendoza', market: 'player_pass_yds', line: 169.5, side: 'over' },
  };
  resolveOddsProvenance(oppWithPrice);
  assert.equal(oppWithPrice.oddsSource, 'propline');
  assert.equal(oppWithPrice.odds, '1.90');
  assert.equal(oppWithPrice.oddsProvider, 'DraftKings (PropLine)');

  // Mismo prop pero sin precio PropLine (partido sin enriquecer): 'model'.
  const oppNoPrice = {
    id: 'prop-soc-123-JugadorX',
    isProp: true,
    sport: 'Fútbol',
    pick: 'Jugador X Más de 0.5 Tiros a Puerta',
    odds: '1.65',
    match: { id: 'soccer-123', propLineProps: [] },
    propMeta: { player: 'Jugador X', market: 'player_shots_on_target', line: 0.5, side: 'over' },
  };
  resolveOddsProvenance(oppNoPrice);
  assert.equal(oppNoPrice.oddsSource, 'model');
  assert.equal(oppNoPrice.odds, '1.65');

  // Un no-prop no se toca por la rama PropLine.
  const nonProp = {
    id: 'nfl-spread-h-nfl-401873075',
    sport: 'NFL',
    pick: 'Denver Broncos -10.5 (Cubre Línea)',
    odds: '1.91',
    oddsSource: 'market',
    match: { sharpValidated: true, market: { sharpBookmaker: 'Pinnacle' } },
  };
  resolveOddsProvenance(nonProp);
  assert.equal(nonProp.oddsSource, 'market');
});

test('builder NFL: genera el prop QB con precio PropLine y procedencia propline', () => {
  const match = {
    id: 'nfl-401873075',
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
    propLineProps: parsePropLineProps(MENDOZA_ODDS).props,
    propLineFetchedAt: new Date().toISOString(),
  };
  const out = buildOpportunitiesAndTopSlate({
    soccerMatches: [], mlbMatches: [], nflMatches: [match], ncaafMatches: [], nbaMatches: [],
    maxPicksToSend: 6, sentCache: {}, isForce: true,
  });
  const prop = out.rawOpportunities.find(o => String(o.id || '').startsWith('prop-nfl-'));
  assert.ok(prop, 'debe generar el prop QB de Mendoza');
  assert.equal(prop.oddsSource, 'propline');
  assert.equal(prop.odds, '1.90');
  assert.ok(String(prop.pick).includes('Fernando Mendoza Más de 169.5 yardas por pase'), `pick: ${prop.pick}`);
  // Bo Nix no tiene precio PropLine en el fixture: no se genera prop para él.
  assert.equal(out.rawOpportunities.filter(o => String(o.id || '').startsWith('prop-nfl-')).length, 1);
});

test('builder NFL: sin precio PropLine o sin media del equipo no genera prop QB', () => {
  const base = {
    id: 'nfl-401873075',
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
    propLineFetchedAt: new Date().toISOString(),
  };
  const run = (nflMatches) => buildOpportunitiesAndTopSlate({
    soccerMatches: [], mlbMatches: [], nflMatches, ncaafMatches: [], nbaMatches: [],
    maxPicksToSend: 6, sentCache: {}, isForce: true,
  });
  // Sin propLineProps: fail-closed, cero props NFL.
  const noPrice = run([{ ...base, propLineProps: [] }]);
  assert.equal(noPrice.rawOpportunities.filter(o => String(o.id || '').startsWith('prop-nfl-')).length, 0);
  // Sin media del equipo (teamStats sin passYardsPerGame): cero props NFL.
  const noMean = run([{
    ...base,
    propLineProps: parsePropLineProps(MENDOZA_ODDS).props,
    away: { ...base.away, teamStats: {} },
  }]);
  assert.equal(noMean.rawOpportunities.filter(o => String(o.id || '').startsWith('prop-nfl-')).length, 0);
});
