// scripts/captureClosingOdds.test.mjs
// Pruebas de la captura de cierre con ESPN (fetch simulado, $0 de cuota).
// Corre con: node --test scripts/captureClosingOdds.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  americanToDecimal, namesMatch, espnLeagueFor, extractClosing,
  findEvent, duePicks, devigDecimal, clvPct, captureForPick,
} from './captureClosingOdds.mjs';

// Fixture realista: Wizards @ Pacers, 2026-11-12T00:00Z (verificado en ESPN).
const NBA_ODDS = {
  provider: { name: 'DraftKings' },
  moneyline: {
    home: { open: { odds: '-161' }, close: { odds: '-166' } },
    away: { open: { odds: '+135' }, close: { odds: '+139' } },
  },
  pointSpread: {
    home: { open: { line: '-4.5', odds: '-105' }, close: { line: '-3.5', odds: '-112' } },
    away: { open: { line: '+4.5', odds: '-115' }, close: { line: '+3.5', odds: '-108' } },
  },
  total: {
    over: { open: { line: 'o228.5', odds: '-110' }, close: { line: 'o225.5', odds: '-110' } },
    under: { open: { line: 'u228.5', odds: '-110' }, close: { line: 'u225.5', odds: '-110' } },
  },
};

const NBA_EVENT = {
  id: '401909966', date: '2026-11-12T00:00Z',
  competitions: [{
    status: { type: { state: 'pre' } },
    competitors: [
      { homeAway: 'home', team: { displayName: 'Indiana Pacers' } },
      { homeAway: 'away', team: { displayName: 'Washington Wizards' } },
    ],
    odds: [NBA_ODDS],
  }],
};

const SOCCER_ODDS = {
  provider: { name: 'DraftKings' },
  moneyline: {
    home: { open: { odds: '+100' }, close: { odds: '-125' } },
    away: { open: { odds: '+240' }, close: { odds: '+320' } },
    draw: { open: { odds: '+260' }, close: { odds: '+290' } },
  },
  pointSpread: {
    home: { open: { line: '-0.5', odds: '-110' }, close: { line: '-0.5', odds: '-135' } },
    away: { open: { line: '+0.5', odds: '-135' }, close: { line: '+0.5', odds: '-105' } },
  },
  total: {
    over: { open: { line: 'o2.5', odds: '-155' }, close: { line: 'o2.5', odds: '-145' } },
    under: { open: { line: 'u2.5', odds: '+115' }, close: { line: 'u2.5', odds: '+120' } },
  },
};

test('americanToDecimal convierte ambos signos y rechaza 0', () => {
  assert.equal(americanToDecimal('-110'), 1.909);
  assert.equal(americanToDecimal('+320'), 4.2);
  assert.equal(americanToDecimal('-166'), 1.602);
  assert.equal(americanToDecimal('+139'), 2.39);
  assert.equal(americanToDecimal(0), null);
  assert.equal(americanToDecimal(null), null);
});

test('namesMatch tolera acentos, sufijos y orden', () => {
  assert.equal(namesMatch('Fútbol Club Barcelona', 'Barcelona'), true);
  assert.equal(namesMatch('Indiana Pacers', 'Indiana Pacers'), true);
  assert.equal(namesMatch('Los Angeles Lakers', 'Boston Celtics'), false);
  assert.equal(namesMatch('St. Louis CITY SC', 'St Louis City SC'), true);
});

test('espnLeagueFor mapea las ligas del ledger y rechaza lo desconocido', () => {
  assert.deepEqual(espnLeagueFor({ sport: 'Baloncesto', league: 'NBA' }), { sport: 'basketball', league: 'nba', kind: 'us' });
  assert.deepEqual(espnLeagueFor({ sport: 'NCAAF', league: 'NCAAF Colegial FBS (Semana 7)' }), { sport: 'football', league: 'college-football', kind: 'us' });
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: 'LaLiga' }).league, 'esp.1');
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: 'Champions League' }).league, 'uefa.champions');
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: 'MLS (EE.UU.)' }).league, 'usa.1');
  assert.equal(espnLeagueFor({ sport: 'Fútbol', league: 'Copa del Rey' }), null);
});

test('devigDecimal usa ambos lados y marca el supuesto cuando solo hay uno', () => {
  const both = devigDecimal(1.909, [1.909]);
  assert.equal(both.noVig, 2);
  assert.equal(both.vigFactor, 1.0477); // 2/1.909 con decimales a 3 cifras
  assert.equal(both.assumed, false);
  const one = devigDecimal(1.909, []);
  assert.equal(one.assumed, true);
  assert.equal(one.noVig, 1.82);
});

test('clvPct positivo cuando la cuota publicada supera el cierre', () => {
  assert.equal(clvPct(2.0, 1.909), 4.8);
  assert.equal(clvPct(1.8, 1.909), -5.7);
  assert.equal(clvPct(1.91, 1.91), 0);
  assert.equal(clvPct(null, 1.91), null);
});

test('total: línea movida se reporta sin inventar CLV', () => {
  const pick = { pick: 'OVER 228.5 Pts', placedOdds: 1.91 };
  const r = extractClosing(pick, NBA_ODDS, 'Indiana Pacers', 'Washington Wizards');
  assert.equal(r.ok, true);
  assert.equal(r.lineMoved, true);
  assert.equal(r.closingLine, 225.5);
  assert.equal(r.closingOdds, null);
  assert.equal(r.clvPct, null);
  assert.match(r.reason, /Línea movida/);
});

test('total: línea exacta da cierre, de-vig y CLV', () => {
  const pick = { pick: 'OVER 225.5 Pts', placedOdds: 2.0 };
  const r = extractClosing(pick, NBA_ODDS, 'Indiana Pacers', 'Washington Wizards');
  assert.equal(r.ok, true);
  assert.equal(r.lineMoved, false);
  assert.equal(r.closingOdds, 1.909);
  assert.equal(r.closingOddsNoVig, 2);
  assert.equal(r.clvPct, 4.8);
  assert.equal(r.lineMovement.hasMovement, true); // total 228.5 -> 225.5
});

test('spread: lado local con línea exacta y movimiento registrado', () => {
  const pick = { pick: 'Indiana Pacers -3.5 (Cubre Línea)', placedOdds: 1.91 };
  const r = extractClosing(pick, NBA_ODDS, 'Indiana Pacers', 'Washington Wizards');
  assert.equal(r.ok, true);
  assert.equal(r.closingOdds, 1.893); // -112
  assert.equal(r.openOdds, 1.952); // -105
  assert.equal(r.clvPct, 0.9);
  // El movimiento es de todo el partido: el spread se movió 1.0 (no steam),
  // pero el total se movió 3.0 (228.5 -> 225.5) y eso sí es steam.
  const spreadMove = r.lineMovement.movements.find(m => m.market === 'SPREAD');
  assert.equal(spreadMove.isSteam, false);
  assert.equal(spreadMove.delta, 1);
  assert.equal(r.lineMovement.isSharpSteam, true);
});

test('moneyline fútbol: empate usa el tercer resultado para de-vig', () => {
  const pick = { pick: 'Empate', placedOdds: 3.5 };
  const r = extractClosing(pick, SOCCER_ODDS, 'Brighton & Hove Albion', 'Brentford');
  assert.equal(r.ok, true);
  assert.equal(r.closingOdds, 3.9); // +290
  assert.equal(r.openOdds, 3.6); // +260
  assert.equal(r.clvPct, -10.3);
});

test('BTTS y props quedan null con motivo, nunca con cuota inventada', () => {
  const btts = extractClosing({ pick: 'Ambos Equipos Anotan: Sí (BTTS)', placedOdds: 1.62 }, SOCCER_ODDS, 'Brighton & Hove Albion', 'Brentford');
  assert.equal(btts.ok, false);
  assert.match(btts.reason, /BTTS/);
  const prop = extractClosing({ pick: 'Nikola Krstovic Más de 1.5 Tiros a Puerta', placedOdds: 1.85 }, SOCCER_ODDS, 'Atalanta', 'Parma');
  assert.equal(prop.ok, false);
});

test('findEvent casa por nombres aunque ESPN liste visitante primero', () => {
  const found = findEvent([NBA_EVENT], 'Indiana Pacers', 'Washington Wizards', Date.parse('2026-11-12T00:00Z'));
  assert.equal(found?.id, '401909966');
  const notFound = findEvent([NBA_EVENT], 'Indiana Pacers', 'Washington Wizards', Date.parse('2026-11-13T00:00Z'));
  assert.equal(notFound, null);
});

test('duePicks solo toma PENDING dentro de la ventana', () => {
  const now = Date.parse('2026-11-11T23:00:00Z');
  const rows = [
    { id: 'a', status: 'PENDING', gameDate: '2026-11-12T00:00:00Z' },
    { id: 'b', status: 'PENDING', gameDate: '2026-11-12T05:00:00Z' },
    { id: 'c', status: 'PENDING', gameDate: '2026-11-11T22:00:00Z' },
    { id: 'd', status: 'CLOSED', gameDate: '2026-11-12T00:00:00Z' },
  ];
  assert.deepEqual(duePicks(rows, now, 90).map(r => r.id), ['a']);
});

test('captureForPick de punta a punta con ESPN simulado (NBA total)', async () => {
  const mockFetch = async (url) => {
    if (String(url).includes('/basketball/nba/scoreboard')) {
      return Response.json({ events: [NBA_EVENT] });
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  const pick = {
    id: 'test-nba-under', status: 'PENDING', sport: 'Baloncesto', league: 'NBA',
    game: 'Indiana Pacers vs Washington Wizards', gameDate: '2026-11-12T00:00Z',
    pick: 'UNDER 225.5 Pts', placedOdds: 1.91,
  };
  const r = await captureForPick(pick, mockFetch, new Map());
  assert.equal(r.ok, true);
  assert.equal(r.record.closingOdds, 1.909);
  assert.equal(r.record.source, 'espn_draftkings');
  assert.equal(r.record.lineMovement.hasMovement, true);
  assert.equal(r.record.clvPct, 0.1); // 1.91 publicada vs 1.909 de cierre
  assert.equal(r.record.beatClosingLine, true);
});

test('captureForPick fútbol usa summary cuando el scoreboard trae odds null', async () => {
  const mockFetch = async (url) => {
    if (String(url).includes('/soccer/eng.1/scoreboard')) {
      return Response.json({ events: [{
        id: '704000', date: '2026-11-08T15:00Z',
        competitions: [{
          status: { type: { state: 'pre' } },
          competitors: [
            { homeAway: 'home', team: { displayName: 'Brighton & Hove Albion' } },
            { homeAway: 'away', team: { displayName: 'Brentford' } },
          ],
          odds: [null],
        }],
      }] });
    }
    if (String(url).includes('/soccer/eng.1/summary')) {
      return Response.json({ odds: [SOCCER_ODDS] });
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  const pick = {
    id: 'test-soc-ml', status: 'PENDING', sport: 'Fútbol', league: 'Premier League',
    game: 'Brighton & Hove Albion vs Brentford', gameDate: '2026-11-08T15:00Z',
    pick: 'Victoria Brighton & Hove Albion (1X2)', placedOdds: 1.8,
  };
  const r = await captureForPick(pick, mockFetch, new Map());
  assert.equal(r.ok, true);
  assert.equal(r.record.closingOdds, 1.8); // -125
  assert.equal(r.record.clvPct, 0);
});
