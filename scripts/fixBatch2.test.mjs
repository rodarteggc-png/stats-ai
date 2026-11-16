// scripts/fixBatch2.test.mjs — Lote 2 (2026-11-16): precio real ESPN + tier 'espn' + de-vigging + frescura.
// Fixtures reales: scoreboard ESPN descargado por curl el 2026-11-16
// (NBA 20261116 BOS vs ORL, NFL MNF 20261116 BAL vs LAC, NCAAF 20261121 KU vs BYU).
// Solo se incrustan los campos que lee el código (provider, moneyline,
// pointSpread, total close/open); los links de DraftKings se omiten.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOpportunity,
  resolveOddsProvenance,
  espnNoVigProb,
} from './alertEngine.js';
import { parseEspnNbaOdds } from '../src/services/nbaService.js';
import { extractEspnSharpMarket } from '../src/services/sportsApi.js';

// ------------------------------------------------------- fixtures reales
const NBA_REAL_ODDS = {
  provider: { name: 'Draft Kings', displayName: 'Draft Kings' },
  details: 'BOS -8.5', overUnder: 212.5, spread: -8.5,
  moneyline: {
    home: { close: { odds: '-360' }, open: { odds: '-426' } },
    away: { close: { odds: '+287' }, open: { odds: '+333' } },
  },
  pointSpread: {
    home: { close: { line: '-8.5', odds: '-113' }, open: { line: '-9.5', odds: '-105' } },
    away: { close: { line: '+8.5', odds: '-107' }, open: { line: '+9.5', odds: '-115' } },
  },
  total: {
    over: { close: { line: 'o212.5', odds: '-110' }, open: { line: 'o211.5', odds: '-110' } },
    under: { close: { line: 'u212.5', odds: '-110' }, open: { line: 'u211.5', odds: '-110' } },
  },
};

const NFL_REAL_ODDS = {
  provider: { name: 'Draft Kings', displayName: 'Draft Kings' },
  details: 'BAL -4.5', overUnder: 39.5, spread: -4.5,
  moneyline: {
    home: { close: { odds: '-225' }, open: { odds: '-142' } },
    away: { close: { odds: '+185' }, open: { odds: '+120' } },
  },
  pointSpread: {
    home: { close: { line: '-4.5', odds: '-112' }, open: { line: '-2.5', odds: '-110' } },
    away: { close: { line: '+4.5', odds: '-108' }, open: { line: '+2.5', odds: '-110' } },
  },
  total: {
    over: { close: { line: 'o39.5', odds: '-108' }, open: { line: 'o48.5', odds: '-110' } },
    under: { close: { line: 'u39.5', odds: '-112' }, open: { line: 'u48.5', odds: '-110' } },
  },
};

const NCAAF_REAL_ODDS = {
  provider: { name: 'Draft Kings', displayName: 'Draft Kings' },
  details: 'BYU -5.5', overUnder: 47.5, spread: 5.5,
  moneyline: {
    home: { close: { odds: '+185' }, open: { odds: '+210' } },
    away: { close: { odds: '-225' }, open: { odds: '-258' } },
  },
  pointSpread: {
    home: { close: { line: '+5.5', odds: '-112' }, open: { line: '+7', odds: '-110' } },
    away: { close: { line: '-5.5', odds: '-108' }, open: { line: '-7', odds: '-110' } },
  },
  total: {
    over: { close: { line: 'o47.5', odds: '-118' }, open: { line: 'o50.5', odds: '-110' } },
    under: { close: { line: 'u47.5', odds: '-102' }, open: { line: 'u50.5', odds: '-110' } },
  },
};

// ------------------------------------------------------- base classify
function nflTotalBase(overrides = {}) {
  return {
    sport: 'NFL', league: 'NFL', game: 'Baltimore Ravens vs Los Angeles Chargers',
    pick: 'OVER 39.5 Pts', type: '🏈 TOTALES NFL (OVER)', odds: 1.93, prob: '60',
    evPct: 5, match: { isPostponed: false, oddsFetchedAt: new Date().toISOString() },
    oddsSource: 'espn', oddsProvider: 'Draft Kings',
    consensus: { votesPassed: 3 }, tipsterAudit: { isApproved: true },
    ...overrides,
  };
}

// ------------------------------------------------------- E1: parse NBA
test('E1: parseEspnNbaOdds con fixture real BOS vs ORL (20261116)', () => {
  const r = parseEspnNbaOdds(NBA_REAL_ODDS);
  assert.equal(r.provider, 'Draft Kings');
  assert.equal(r.homeMl, 1.28); // -360
  assert.equal(r.awayMl, 3.87); // +287
  assert.equal(r.spreadHomeOdds, 1.88); // -113
  assert.equal(r.spreadAwayOdds, 1.93); // -107
  assert.equal(r.overOdds, 1.91); // -110
  assert.equal(r.underOdds, 1.91); // -110
});

test('E1: formato plano legacy (homeTeamOdds.moneyLine) sigue dando ML real', () => {
  const r = parseEspnNbaOdds({ homeTeamOdds: { moneyLine: -105 }, awayTeamOdds: { moneyLine: 115 } });
  assert.equal(r.homeMl, 1.95);
  assert.equal(r.awayMl, 2.15);
  assert.equal(r.spreadHomeOdds, null);
  // Sin provider en el objeto, el default es DraftKings (ESPN solo publica DK).
  assert.equal(r.provider, 'DraftKings');
});

test('E1: sin odds no se inventa precio (todo null)', () => {
  const r = parseEspnNbaOdds({});
  assert.equal(r.homeMl, null);
  assert.equal(r.awayMl, null);
  assert.equal(r.spreadHomeOdds, null);
  assert.equal(r.spreadAwayOdds, null);
  assert.equal(r.overOdds, null);
  assert.equal(r.underOdds, null);
});

// ------------------------------------------------------- E1+E2: overwrite
test('E1+E2: resolveOddsProvenance sobrescribe el 1.91 fijo con el precio real ESPN en spread NBA', () => {
  const opp = {
    id: 'nba-spread-h-test', sport: 'Baloncesto', league: 'NBA',
    game: 'Boston Celtics vs Orlando Magic', pick: 'Boston Celtics -8.5',
    type: '🏀 SPREAD NBA', odds: 1.91, prob: '60',
    match: {
      home: { name: 'Boston Celtics' }, away: { name: 'Orlando Magic' },
      spread: -8.5,
      vegas: { spreadHomeOdds: 1.88, spreadAwayOdds: 1.93, provider: 'Draft Kings' },
      market: { provider: 'Draft Kings', hasRealOdds: true },
    },
  };
  resolveOddsProvenance(opp);
  assert.equal(opp.odds, '1.88');
  assert.equal(opp.oddsSource, 'espn');
  assert.equal(opp.oddsProvider, 'Draft Kings');
});

// ------------------------------------------------------- E2: tiers
test('E2: enriquecimiento sharp (Pinnacle) sigue siendo market', () => {
  const opp = {
    id: 'nfl-tot-test', sport: 'NFL', pick: 'OVER 39.5 Pts', odds: 1.93,
    match: {
      home: { name: 'Baltimore Ravens' }, away: { name: 'Los Angeles Chargers' },
      total: 39.5, hasRealTotal: true,
      vegas: { overOdds: 1.93, underOdds: 1.89 },
      market: { sharpBookmaker: 'Pinnacle', provider: 'Pinnacle' },
    },
  };
  resolveOddsProvenance(opp);
  assert.equal(opp.oddsSource, 'market');
  assert.equal(opp.oddsProvider, 'Pinnacle');
});

test('E2: market pre-fijado con proveedor ESPN baja a espn (caso fútbol 1X2)', () => {
  const opp = {
    id: '1x2-h-test', sport: 'Fútbol', pick: 'Victoria Real Madrid (1X2)', odds: 1.65,
    oddsSource: 'market',
    match: {
      home: { name: 'Real Madrid' }, away: { name: 'Osasuna' },
      market: { provider: 'Draft Kings', homeOdds: 1.65, drawOdds: 4.2, awayOdds: 5.5 },
    },
  };
  resolveOddsProvenance(opp);
  assert.equal(opp.oddsSource, 'espn');
  assert.equal(opp.oddsProvider, 'Draft Kings');
});

test('E2: market pre-fijado sin procedencia demostrable baja a model (fail-closed)', () => {
  const opp = {
    id: '1x2-h-test', sport: 'Fútbol', pick: 'Victoria Real Madrid (1X2)', odds: 1.65,
    oddsSource: 'market',
    match: {
      home: { name: 'Real Madrid' }, away: { name: 'Osasuna' },
      market: { homeOdds: 1.65, drawOdds: 4.2, awayOdds: 5.5 },
    },
  };
  resolveOddsProvenance(opp);
  assert.equal(opp.oddsSource, 'model');
});

test('E2+P4: classifyOpportunity admite espn fresco y sigue vetando derived', () => {
  assert.equal(classifyOpportunity(nflTotalBase()).vetoReason, null);
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'derived' })).vetoReason, 'no_market_odds');
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'market' })).vetoReason, null);
});

// ------------------------------------------------------- E4: frescura
test('E4: cuota ESPN con más de 15 min o sin fecha se veta con odds_stale', () => {
  const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const staleOpp = nflTotalBase({ match: { isPostponed: false, oddsFetchedAt: stale } });
  assert.equal(classifyOpportunity(staleOpp).vetoReason, 'odds_stale');
  const noDateOpp = nflTotalBase({ match: { isPostponed: false } });
  assert.equal(classifyOpportunity(noDateOpp).vetoReason, 'odds_stale');
  // Fresca (ahora) pasa el gate.
  assert.equal(classifyOpportunity(nflTotalBase()).vetoReason, null);
  // El gate solo aplica a espn: un pick market sin fetchedAt pasa.
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'market', match: { isPostponed: false } })).vetoReason, null);
});

// ------------------------------------------------------- E3: de-vigging
test('E3: espnNoVigProb con ambos lados reales (spread NBA -113/-107)', () => {
  const opp = {
    id: 'nba-spread-h-test', sport: 'Baloncesto', pick: 'Boston Celtics -8.5',
    match: {
      home: { name: 'Boston Celtics' }, away: { name: 'Orlando Magic' },
      vegas: { spreadHomeOdds: 1.88, spreadAwayOdds: 1.93 },
      market: { provider: 'Draft Kings' },
    },
  };
  const nv = espnNoVigProb(opp);
  // removeVig usa el método power (no la normalización multiplicativa
  // simple): [1.88, 1.93] → home sin vig 50.71%.
  assert.ok(Math.abs(nv - 50.71) < 0.05, `esperado ~50.71, got ${nv}`);
  // Total -110/-110 → 50.0 exacto.
  const tot = {
    id: 'nba-tot-test', sport: 'Baloncesto', pick: 'OVER 212.5 Pts',
    match: {
      home: { name: 'Boston Celtics' }, away: { name: 'Orlando Magic' },
      vegas: { overOdds: 1.91, underOdds: 1.91 },
      market: { provider: 'Draft Kings' },
    },
  };
  assert.ok(Math.abs(espnNoVigProb(tot) - 50.0) < 0.01);
  // ML 1.28/3.87 → home sin vig 76.68% (método power).
  const ml = {
    id: 'nba-ml-h-test', sport: 'Baloncesto', pick: 'Victoria Boston Celtics',
    match: {
      home: { name: 'Boston Celtics' }, away: { name: 'Orlando Magic' },
      market: { homeOdds: 1.28, awayOdds: 3.87, provider: 'Draft Kings' },
    },
  };
  assert.ok(Math.abs(espnNoVigProb(ml) - 76.68) < 0.05, `ML esperado ~76.68, got ${espnNoVigProb(ml)}`);
});

test('E3: espnNoVigProb sin un lado devuelve NaN (el llamador usa single-side)', () => {
  const opp = {
    id: 'nba-spread-h-test', sport: 'Baloncesto', pick: 'Boston Celtics -8.5',
    match: {
      home: { name: 'Boston Celtics' }, away: { name: 'Orlando Magic' },
      vegas: { spreadHomeOdds: 1.88 },
      market: { provider: 'Draft Kings' },
    },
  };
  assert.ok(Number.isNaN(espnNoVigProb(opp)));
});

// ------------------------------------------------------- E5: NFL/NCAAF
test('E5: extractEspnSharpMarket con fixture real MNF BAL vs LAC', () => {
  const r = extractEspnSharpMarket(NFL_REAL_ODDS, 'Baltimore Ravens', 'Los Angeles Chargers');
  assert.equal(r.provider, 'Draft Kings');
  assert.equal(r.hasRealML, true);
  assert.equal(r.homeOdds, '1.44'); // -225
  assert.equal(r.awayOdds, '2.85'); // +185
  assert.equal(r.homeSpreadOdds, '1.89'); // -112
  assert.equal(r.awaySpreadOdds, '1.93'); // -108
  assert.equal(r.overOdds, '1.93'); // -108
  assert.equal(r.underOdds, '1.89'); // -112
  assert.equal(r.spreadHomeClose, -4.5);
  assert.equal(r.totalClose, 39.5);
});

test('E5: extractEspnSharpMarket con fixture real NCAAF KU vs BYU', () => {
  const r = extractEspnSharpMarket(NCAAF_REAL_ODDS, 'Kansas Jayhawks', 'BYU Cougars');
  assert.equal(r.provider, 'Draft Kings');
  assert.equal(r.hasRealML, true);
  assert.equal(r.homeOdds, '2.85'); // +185
  assert.equal(r.awayOdds, '1.44'); // -225
  assert.equal(r.homeSpreadOdds, '1.89'); // -112
  assert.equal(r.awaySpreadOdds, '1.93'); // -108
  assert.equal(r.overOdds, '1.85'); // -118
  assert.equal(r.underOdds, '1.98'); // -102
  assert.equal(r.spreadHomeClose, 5.5);
  assert.equal(r.totalClose, 47.5);
});

test('E5+E2: un pick NFL con market ESPN real se marca espn y sobrescribe el 1.91', () => {
  const sharp = extractEspnSharpMarket(NFL_REAL_ODDS, 'Baltimore Ravens', 'Los Angeles Chargers');
  const opp = {
    id: 'nfl-spread-h-test', sport: 'NFL', pick: 'Baltimore Ravens -4.5',
    type: '🏈 SPREAD NFL', odds: 1.91, prob: '60',
    match: {
      home: { name: 'Baltimore Ravens' }, away: { name: 'Los Angeles Chargers' },
      spread: -4.5, hasRealSpread: true, hasRealTotal: true,
      market: { ...sharp, provider: 'Draft Kings' },
    },
  };
  resolveOddsProvenance(opp);
  assert.equal(opp.odds, '1.89');
  assert.equal(opp.oddsSource, 'espn');
  assert.equal(opp.oddsProvider, 'Draft Kings');
});
