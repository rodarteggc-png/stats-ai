import test from 'node:test';
import assert from 'node:assert/strict';
import { isTier1League, buildOpportunitiesAndTopSlate } from './alertEngine.js';
import { espnSoccerLeagueForName } from '../src/services/history.js';
import { espnLeagueFor } from './captureClosingOdds.mjs';

// Champions League femenil (UWCL) — 2026-11-18.
// Partido real del 19 nov, xG/Elo de standings en vivo verificados ese día:
// Barcelona xG 2.45 Elo 1553, Servette xG 1.53 Elo 1496.
// Sin cuotas de mercado en el fixture: el builder usa fair odds y el veto
// esperado es 'odds_model' (C3), NO 'league_not_tier1'.
function uwclMatch() {
  return {
    id: 'soccer-uwcl-test-1',
    sport: 'futbol',
    league: "UEFA Women's Champions League",
    leagueCode: 'uefa.wchampions',
    gameDate: '2026-11-19T20:00:00Z',
    home: { name: 'Barcelona', xG: '2.45', elo: 1553, daysRest: 4 },
    away: { name: 'Servette', xG: '1.53', elo: 1496, daysRest: 4 },
    vegas: { overUnder: 2.5 },
  };
}

test('UWCL: la liga pasa el filtro Tier 1 (como la varonil)', () => {
  assert.equal(isTier1League("UEFA Women's Champions League", 'futbol'), true);
  assert.equal(isTier1League('UEFA Champions League', 'futbol'), true);
});

test('UWCL: el partido se evalúa (genera oportunidades) y no se veta por liga', () => {
  const out = buildOpportunitiesAndTopSlate({
    soccerMatches: [uwclMatch()],
    mlbMatches: [], nflMatches: [], ncaafMatches: [], nbaMatches: [],
    maxPicksToSend: 6, sentCache: {}, isForce: true,
  });
  const uwclRaw = out.rawOpportunities.filter(o => o.league === "UEFA Women's Champions League");
  assert.ok(uwclRaw.length >= 1, `se esperaba al menos 1 oportunidad UWCL, hay ${uwclRaw.length}`);
  const uwclVetoed = out.vetoedOpps.filter(v => v.league === "UEFA Women's Champions League");
  assert.ok(!uwclVetoed.some(v => v.vetoReason === 'league_not_tier1'),
    'un pick UWCL no debe vetarse por liga');
  // Sin cuota real en el fixture, el veto esperado es odds_model (C3), no liga.
  assert.ok(uwclVetoed.length > 0, 'sin cuota real el pick UWCL debe vetarse (odds_model)');
  assert.ok(uwclVetoed.every(v => v.vetoReason === 'odds_model'),
    `vetos UWCL esperados 'odds_model', hay: ${uwclVetoed.map(v => v.vetoReason).join(',')}`);
});

test('UWCL: history.js califica contra uefa.wchampions, no contra la varonil', () => {
  assert.equal(espnSoccerLeagueForName("UEFA Women's Champions League"), 'uefa.wchampions');
  assert.equal(espnSoccerLeagueForName('UEFA Champions League'), 'uefa.champions');
  // El resto del mapeo no cambia.
  assert.equal(espnSoccerLeagueForName('LaLiga'), 'esp.1');
  assert.equal(espnSoccerLeagueForName('Liga MX'), 'mex.1');
  assert.equal(espnSoccerLeagueForName('Premier League'), 'eng.1');
  assert.equal(espnSoccerLeagueForName('Copa del Rey'), null);
});

test('UWCL: la captura de cierre también usa uefa.wchampions (no la varonil)', () => {
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: "UEFA Women's Champions League" }).league, 'uefa.wchampions');
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: 'Champions League' }).league, 'uefa.champions');
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: 'LaLiga' }).league, 'esp.1');
});
