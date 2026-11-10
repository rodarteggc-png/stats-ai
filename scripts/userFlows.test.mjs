import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getContextForPrompt } from '../src/services/history.js';
import { createTicketClient, auditTicketLive, formatLiveTicketReport, extractTicketSelections } from '../api/_lib/parlayLive.js';
import { scanFuture72Hours, formatFutureScan } from '../api/_lib/futureScan.js';
import { fetchNbaSchedule } from '../src/services/nbaService.js';
import { selectHighProbabilityCandidates, buildConservativeCombination, scanFutureMultiSport, formatFutureMultiSport, evaluateFutureModels } from '../api/_lib/futureMultiSport.js';
import { loadFutureModelData, pickSoccerFixtures } from '../api/_lib/futureData.js';
import { fetchClosingOddsForPick } from '../src/services/sportsApi.js';
import { calculatePickEffectiveStake, generateAiExecutiveReport } from './alertEngine.js';

test('el CLV usa solo mercado y linea exactos antes del inicio, nunca un cero inventado', async () => {
  const originalFetch = globalThis.fetch;
  const previousKeys = process.env.ODDS_API_KEYS;
  process.env.ODDS_API_KEYS = 'test-clv-key-1';
  let commence = new Date(Date.now() + 3600000).toISOString();
  globalThis.fetch = async () => Response.json([{
    home_team: 'Boston Celtics', away_team: 'Washington Wizards', commence_time: commence, bookmakers: [{
      key: 'pinnacle', title: 'Pinnacle', markets: [
        { key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: 1.4 }, { name: 'Washington Wizards', price: 3.1 }] },
        { key: 'totals', outcomes: [{ name: 'Over', point: 230.5, price: 1.95 }, { name: 'Under', point: 230.5, price: 1.87 }] }
      ]
    }]
  }]);
  try {
    const base = { sport: 'Baloncesto', league: 'NBA', game: 'Boston Celtics vs Washington Wizards', homeName: 'Boston Celtics', awayName: 'Washington Wizards' };
    const under = await fetchClosingOddsForPick({ ...base, pick: 'UNDER 230.5 Pts', placedOdds: 1.91 });
    assert.equal(under.closingOdds, 1.87);
    assert.equal(under.beatClosingLine, true);
    assert.equal(await fetchClosingOddsForPick({ ...base, pick: 'UNDER 231.5 Pts', placedOdds: 1.91 }), null);
    assert.equal(await fetchClosingOddsForPick({ ...base, pick: 'Boston Celtics -5.5 (Cubre Línea)', placedOdds: 1.91 }), null);
    assert.equal(await fetchClosingOddsForPick({ ...base, sport: 'Fútbol', league: 'Liga Profesional Argentina', pick: 'Boston Celtics o Empate (1X)', placedOdds: 1.3 }), null);
    const winner = await fetchClosingOddsForPick({ ...base, pick: 'Victoria Boston Celtics', placedOdds: 1.35 });
    assert.equal(winner.closingOdds, 1.4);
    assert.equal(winner.beatClosingLine, false);
    commence = new Date(Date.now() - 60000).toISOString();
    assert.equal(await fetchClosingOddsForPick({ ...base, pick: 'UNDER 230.5 Pts', placedOdds: 1.91, league: 'NBA', sport: 'nba' }), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKeys === undefined) delete process.env.ODDS_API_KEYS;
    else process.env.ODDS_API_KEYS = previousKeys;
  }
});

test('NBA consulta la ventana futura explicita en vez de reutilizar la jornada actual', async () => {
  const originalFetch = globalThis.fetch;
  let observedDates;
  globalThis.fetch = async input => {
    const url = new URL(input);
    observedDates = url.searchParams.get('dates');
    return Response.json({ events: [] });
  };
  try {
    assert.deepEqual(await fetchNbaSchedule('20261102-20261105'), []);
    assert.equal(observedDates, '20261102-20261105');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el contexto del simulador acepta lecciones resueltas sin leer una Promise', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null };

  try {
    const emptyContext = getContextForPrompt('America', 'Cruz Azul');
    assert.match(emptyContext, /Contexto Hist/);
    assert.doesNotMatch(emptyContext, /MEMORIA ACTIVA/);

    const learnedAdjustments = {
      lessons: [{
        team: 'America',
        opponent: 'Cruz Azul',
        actualResult: '0-1',
        diagnosisText: 'Leccion de prueba'
      }]
    };
    const context = getContextForPrompt('America', 'Cruz Azul', learnedAdjustments);
    assert.match(context, /MEMORIA ACTIVA/);
    assert.match(context, /Leccion de prueba/);
    assert.match(context, /Cruz Azul/);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('API-Sports conserva la reserva diaria y no reintenta errores', async () => {
  const paths = [];
  const client = createTicketClient({
    apiKey: 'test-reserve',
    fetchImpl: async url => {
      paths.push(url.pathname);
      return Response.json({ response: { requests: { current: 90, limit_day: 100 } } });
    }
  });
  await client.request('/status');
  await assert.rejects(client.request('/fixtures', { date: '2026-11-02' }), /reservan 10/);
  assert.deepEqual(paths, ['/status']);

  let attempts = 0;
  const broken = createTicketClient({
    apiKey: 'test-errors', fetchImpl: async () => {
      attempts++;
      return Response.json({ errors: { plan: 'Plan sin acceso' } });
    }
  });
  await assert.rejects(broken.request('/status'), /Plan sin acceso/);
  assert.equal(attempts, 1);
});

test('API-Sports reutiliza datos recientes y respeta parametros estructurados', async () => {
  let calls = 0;
  const client = createTicketClient({
    apiKey: 'test-cache', fetchImpl: async url => {
      calls++;
      if (url.pathname === '/status') return Response.json({ response: { requests: { current: 4, limit_day: 100 } } });
      assert.equal(url.searchParams.get('fixture'), '123');
      assert.equal(url.searchParams.get('bookmaker'), '4');
      return Response.json({ response: [] }, { headers: { 'x-ratelimit-requests-remaining': '95' } });
    }
  });
  await client.request('/status');
  await client.request('/odds', { fixture: '123', bookmaker: '4' });
  await client.request('/odds', { fixture: '123', bookmaker: '4' });
  assert.equal(calls, 2);
  assert.equal(client.usage().remaining, 95);
});

const ticketLeg = { homeTeam: 'America', awayTeam: 'Cruz Azul', sport: 'football', date: '2026-11-02', market: 'match_winner', selection: 'home', line: null, ticketOdds: '+150' };
const fixture = { fixture: { id: 501, date: '2026-11-02T23:00:00Z', status: { short: 'NS' } }, teams: { home: { name: 'Club America' }, away: { name: 'Cruz Azul' } } };

function ticketFetch(handler) {
  return async url => {
    if (url.pathname === '/status') return Response.json({ response: { requests: { current: 5, limit_day: 100 } } });
    if (url.pathname === '/fixtures') return Response.json({ response: [fixture] });
    return Response.json({ response: handler(url).map(item => ({ update: new Date().toISOString(), ...item })) });
  };
}

test('el boleto cruza equipos y cuotas reales sin inventar ventaja ni cuotas faltantes', async () => {
  const odds = [{
    fixture: { id: 501 }, update: new Date().toISOString(), bookmakers: [{
      id: 4, name: 'Pinnacle', bets: [{
        name: 'Match Winner', values: [
          { value: 'Home', odd: '2.40' }, { value: 'Draw', odd: '3.20' }, { value: 'Away', odd: '2.90' }
        ]
      }]
    }]
  }];
  const audit = await auditTicketLive([ticketLeg, { ...ticketLeg, ticketOdds: null }], { apiKey: 'test-live', fetchImpl: ticketFetch(() => odds) });
  assert.equal(audit.results[0].verified, true);
  assert.equal(audit.results[0].ticketOdds, 2.5);
  assert.equal(audit.results[0].quote.odds, 2.4);
  assert.equal(audit.results[1].ticketOdds, null);
  assert.equal(audit.usage.requests, 3);
  const report = formatLiveTicketReport(audit);
  assert.match(report, /no legible; no se inventa/);
  assert.match(report, /referencia de mercado, no prediccion/);
  assert.doesNotMatch(report, /APROBADA|Real Calculada|1\.85/);
});

test('el boleto no acepta otro rival, deportes sin cobertura o mercados diferentes', async () => {
  let oddsCalls = 0;
  const audit = await auditTicketLive([
    { ...ticketLeg, awayTeam: 'Monterrey' },
    { ...ticketLeg, sport: 'tennis' },
    { ...ticketLeg, market: 'unknown' }
  ], { apiKey: 'test-unmatched', fetchImpl: ticketFetch(() => { oddsCalls++; return []; }) });
  assert.equal(oddsCalls, 0);
  assert.ok(audit.results.every(result => !result.verified));
  assert.match(audit.results[0].reason, /No se encontro ese partido/);
  assert.match(audit.results[1].reason, /sin cobertura/);
});

test('un boleto ilegible no se reporta como deporte sin cobertura y sugiere enviarlo como archivo', async () => {
  const audit = await auditTicketLive([{ homeTeam: null, awayTeam: null, eventText: null, selectionText: null, sport: 'unknown', market: 'unknown', selection: 'unknown', line: null, ticketOdds: '1.56', date: null }],
    { apiKey: 'test-unreadable', fetchImpl: async () => { throw new Error('No debe consultar proveedores.'); } });
  assert.match(audit.results[0].reason, /No se leyeron los equipos/);
  const report = formatLiveTicketReport(audit);
  assert.match(report, /Partido no legible/);
  assert.match(report, /como Archivo/);
  assert.doesNotMatch(report, /\? vs \?|sin cobertura/);
});

test('el boleto con un solo equipo y deporte no identificado se cruza con futbol y orienta la seleccion', async () => {
  const odds = [{
    fixture: { id: 501 }, bookmakers: [{
      id: 4, name: 'Pinnacle', bets: [{
        name: 'Match Winner', values: [
          { value: 'Home', odd: '2.40' }, { value: 'Draw', odd: '3.20' }, { value: 'Away', odd: '2.90' }
        ]
      }]
    }]
  }];
  const audit = await auditTicketLive([{ homeTeam: null, awayTeam: null, eventText: null, selectionText: 'Cruz Azul', sport: 'unknown', market: 'match_winner', selection: 'unknown', line: null, ticketOdds: '2.85', date: '2026-11-02' }],
    { apiKey: 'test-single-team', fetchImpl: ticketFetch(() => odds) });
  assert.equal(audit.results[0].verified, true);
  assert.equal(audit.results[0].resolvedSelection, 'away');
  assert.equal(audit.results[0].quote.odds, 2.9);
});

test('NBA y NFL se verifican con The Odds API usando linea exacta y formato visitante @ local', async () => {
  const kickoff = new Date(Date.now() + 3 * 3600000).toISOString();
  const updated = new Date().toISOString();
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname.includes('basketball_nba')) return Response.json([{
      home_team: 'Boston Celtics', away_team: 'Washington Wizards', commence_time: kickoff, bookmakers: [{
        key: 'pinnacle', title: 'Pinnacle', last_update: updated, markets: [
          { key: 'spreads', last_update: updated, outcomes: [{ name: 'Boston Celtics', point: -4.5, price: 1.95 }, { name: 'Washington Wizards', point: 4.5, price: 1.87 }] }
        ]
      }]
    }]);
    return Response.json([{
      home_team: 'Las Vegas Raiders', away_team: 'Kansas City Chiefs', commence_time: kickoff, bookmakers: [{
        key: 'pinnacle', title: 'Pinnacle', last_update: updated, markets: [
          { key: 'h2h', last_update: updated, outcomes: [{ name: 'Kansas City Chiefs', price: 1.52 }, { name: 'Las Vegas Raiders', price: 2.6 }] }
        ]
      }]
    }]);
  };
  const audit = await auditTicketLive([
    { eventText: 'WAS Wizards @ BOS Celtics', selectionText: 'Boston Celtics -4.5', homeTeam: null, awayTeam: null, sport: 'nba', market: 'spread', selection: 'unknown', line: -4.5, ticketOdds: '1.91', date: null },
    { eventText: 'KC Chiefs @ LV Raiders', selectionText: 'Kansas City Chiefs', homeTeam: null, awayTeam: null, sport: 'nfl', market: 'match_winner', selection: 'unknown', line: null, ticketOdds: '1.56', date: null },
    { eventText: 'WAS Wizards @ BOS Celtics', selectionText: 'Boston Celtics -5.5', homeTeam: null, awayTeam: null, sport: 'nba', market: 'spread', selection: 'unknown', line: -5.5, ticketOdds: '1.91', date: null }
  ], { apiKey: 'test-us', oddsKeys: ['test-us-key-1'], fetchImpl });
  assert.equal(audit.results[0].verified, true);
  assert.equal(audit.results[0].quote.odds, 1.95);
  assert.equal(audit.results[1].verified, true);
  assert.equal(audit.results[1].resolvedSelection, 'away');
  assert.equal(audit.results[1].quote.odds, 1.52);
  assert.equal(audit.results[2].verified, false);
  assert.equal(audit.usage.oddsApiRequests, 2);
  assert.equal(calls.filter(path => path.includes('basketball_nba')).length, 1);
});

test('la lectura reintenta con el modelo de respaldo cuando Gemini responde 503', async () => {
  const models = [];
  const legs = await extractTicketSelections({ text: 'KC Chiefs @ LV Raiders, Chiefs ML 1.56' }, 'test-key', async url => {
    models.push(String(url).match(/models\/([^:]+)/)[1]);
    if (models.length === 1) return new Response('{}', { status: 503 });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tooMany: false, selections: [{ eventText: 'KC Chiefs @ LV Raiders', selectionText: 'Chiefs', homeTeam: null, awayTeam: null, sport: 'nfl', market: 'match_winner', selection: 'unknown', line: null, ticketOdds: '1.56', date: null }] }) }] } }] });
  });
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.5-flash']);
  assert.equal(legs[0].homeTeam, 'LV Raiders');
  assert.equal(legs[0].awayTeam, 'KC Chiefs');
});

test('el mercado de totales exige linea exacta y permite respaldo Bet365', async () => {
  const calls = [];
  const audit = await auditTicketLive([{ ...ticketLeg, market: 'goals_over_under', selection: 'over', line: 2.5 }], {
    apiKey: 'test-lines', fetchImpl: ticketFetch(url => {
      const bookmaker = Number(url.searchParams.get('bookmaker'));
      calls.push(bookmaker);
      return [{
        fixture: { id: 501 }, bookmakers: [{
          id: bookmaker, name: bookmaker === 4 ? 'Pinnacle' : 'Bet365', bets: [{
            name: 'Goals Over/Under', values: bookmaker === 4
              ? [{ value: 'Over 3.5', odd: '2.40' }]
              : [{ value: 'Over 2.5', odd: '1.95' }, { value: 'Under 2.5', odd: '1.85' }]
          }]
        }]
      }];
    })
  });
  assert.deepEqual(calls, [4, 8]);
  assert.equal(audit.results[0].quote.bookmaker, 'Bet365');
  assert.equal(audit.results[0].quote.odds, 1.95);
});

test('la lectura estructurada conserva campos ausentes y envia la imagen al modelo', async () => {
  const legs = await extractTicketSelections({ imageBase64: 'test-image' }, 'test-key', async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.contents[0].parts[1].inline_data.data, 'test-image');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tooMany: false, selections: [{ ...ticketLeg, ticketOdds: null }] }) }] } }] });
  });
  assert.equal(legs[0].ticketOdds, null);
});

test('una cuota vieja o sin hora no se presenta como precio actual', async () => {
  const audit = await auditTicketLive([ticketLeg], {
    apiKey: 'test-stale', fetchImpl: ticketFetch(url => [{
      fixture: { id: 501 }, update: url.searchParams.get('bookmaker') === '4' ? '2020-01-01T00:00:00Z' : null,
      bookmakers: [{ id: Number(url.searchParams.get('bookmaker')), name: 'Casa', bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2.40' }] }] }]
    }])
  });
  assert.equal(audit.results[0].verified, false);
  const report = formatLiveTicketReport(audit);
  assert.match(report, /SIN VERIFICAR/);
  assert.match(report, /Antiguedad/);
  assert.doesNotMatch(report, /Diferencia de precio/);
});

test('un fallo de saldo no dispara consultas de estado por cada seleccion', async () => {
  let calls = 0;
  const audit = await auditTicketLive([ticketLeg, ticketLeg, ticketLeg], {
    apiKey: 'test-status-failure', fetchImpl: async () => {
      calls++;
      return Response.json({ errors: { requests: 'Saldo agotado' } });
    }
  });
  assert.equal(calls, 1);
  assert.ok(audit.results.every(result => !result.verified));
});

test('cada boleto tiene un maximo de 10 consultas aunque haya saldo diario', async () => {
  let calls = 0;
  const client = createTicketClient({
    apiKey: 'test-max-requests', fetchImpl: async url => {
      calls++;
      return Response.json({ response: url.pathname === '/status' ? { requests: { current: 1, limit_day: 100 } } : [] });
    }
  });
  await client.request('/status');
  for (let index = 0; index < 9; index++) await client.request('/fixtures', { date: String(index) });
  await assert.rejects(client.request('/fixtures', { date: 'extra' }), /por boleto/);
  assert.equal(calls, 10);
});

test('el analisis bajo pedido tiene presupuesto independiente sin cambiar los valores de boletos', async () => {
  const client = createTicketClient({
    apiKey: 'test-horizon-reserve', maxRequests: 13, reserveRequests: 30, fetchImpl: async () =>
      Response.json({ response: { requests: { current: 70, limit_day: 100 } } })
  });
  await client.request('/status');
  await assert.rejects(client.request('/fixtures', { date: '2026-11-02' }), /reservan 30/);
  assert.equal(client.usage().requests, 1);
  assert.equal(client.usage().reserve, 30);
});

test('no se usan cuotas prepartido para un partido en juego', async () => {
  let oddsCalls = 0;
  const audit = await auditTicketLive([ticketLeg], {
    apiKey: 'test-inplay', fetchImpl: async url => {
      if (url.pathname === '/status') return Response.json({ response: { requests: { current: 5, limit_day: 100 } } });
      if (url.pathname === '/fixtures') return Response.json({ response: [{ ...fixture, fixture: { ...fixture.fixture, status: { short: '1H' } } }] });
      oddsCalls++;
      return Response.json({ response: [] });
    }
  });
  assert.equal(oddsCalls, 0);
  assert.equal(audit.results[0].verified, false);
  assert.match(audit.results[0].reason, /1H/);
});

test('una cuota vieja de Pinnacle puede sustituirse por Bet365 actualizado', async () => {
  const audit = await auditTicketLive([ticketLeg], {
    apiKey: 'test-fresh-fallback', fetchImpl: ticketFetch(url => {
      const bookmaker = Number(url.searchParams.get('bookmaker'));
      return [{ fixture: { id: 501 }, update: bookmaker === 4 ? '2020-01-01T00:00:00Z' : new Date().toISOString(), bookmakers: [{ id: bookmaker, name: bookmaker === 4 ? 'Pinnacle' : 'Bet365', bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2.40' }] }] }] }];
    })
  });
  assert.equal(audit.results[0].verified, true);
  assert.equal(audit.results[0].quote.bookmaker, 'Bet365');
});

const futureNow = Date.parse('2026-11-02T18:00:00Z');

function futureFetch({ old = false, paginated = false, used = 5, fixtures = null, timestamp = futureNow } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.pathname === '/status') return Response.json({ response: { requests: { current: used, limit_day: 100 } } });
    const date = url.searchParams.get('date');
    const fixtureId = Number(date.slice(-2));
    if (url.pathname === '/fixtures') return Response.json({
      response: fixtures || [{
        fixture: { id: fixtureId, date: `${date}T19:00:00Z`, status: { short: 'NS' } },
        teams: { home: { name: `Local ${fixtureId}` }, away: { name: `Visita ${fixtureId}` } }, league: { name: 'Liga de prueba' }
      }]
    });
    const bookmaker = Number(url.searchParams.get('bookmaker'));
    return Response.json({
      paging: { current: 1, total: paginated ? 4 : 1 }, response: [{
        fixture: { id: fixtureId }, update: new Date(timestamp - (old ? 2 * 60 * 60 * 1000 : 1000)).toISOString(),
        bookmakers: [{
          id: bookmaker, name: bookmaker === 4 ? 'Pinnacle' : 'Bet365', bets: [{
            name: 'Match Winner', values: [
              { value: 'Home', odd: bookmaker === 4 ? '2.00' : '2.40' }, { value: 'Draw', odd: '3.50' }, { value: 'Away', odd: '4.00' }
            ]
          }]
        }]
      }]
    });
  };
  return { calls, fetchImpl };
}

test('el escaner VIP cubre 72 horas exactas sin registrar picks y declara paginacion', async () => {
  const mock = futureFetch({ paginated: true });
  const report = await scanFuture72Hours({ apiKey: 'test-future-window', now: () => futureNow, fetchImpl: mock.fetchImpl, snapshots: new Map() });
  assert.equal(report.dates, 4);
  assert.equal(report.datesLoaded, 4);
  assert.equal(Date.parse(report.end) - Date.parse(report.start), 72 * 60 * 60 * 1000);
  assert.equal(report.fixtures, 3);
  assert.equal(report.compared, 3);
  assert.equal(report.candidates.length, 3);
  assert.ok(report.candidates.every(candidate => Date.parse(candidate.kickoff) < Date.parse(report.end)));
  assert.ok(mock.calls.length <= 13);
  assert.ok(report.partial);
  const text = formatFutureScan(report);
  assert.match(text, /Cobertura parcial/);
  assert.match(text, /no picks oficiales/);
  assert.match(text, /No se confirma RLM/);
});

test('el escaner futuro conserva saldo y descarta pares de cuotas antiguas', async () => {
  const limited = futureFetch({ used: 70 });
  const blocked = await scanFuture72Hours({ apiKey: 'test-future-low', now: () => futureNow, fetchImpl: limited.fetchImpl });
  assert.equal(limited.calls.length, 1);
  assert.equal(blocked.candidates.length, 0);
  assert.ok(blocked.partial);
  const old = futureFetch({ old: true });
  const stale = await scanFuture72Hours({ apiKey: 'test-future-old', now: () => futureNow, fetchImpl: old.fetchImpl });
  assert.equal(stale.candidates.length, 0);
  assert.equal(stale.stale, 3);
});

test('los movimientos futuros requieren una observacion anterior y no se confunden con apertura', async () => {
  const observations = new Map();
  const mock = futureFetch();
  const options = { apiKey: 'test-future-history', now: () => futureNow, fetchImpl: mock.fetchImpl, snapshots: observations };
  const first = await scanFuture72Hours(options);
  assert.equal(first.candidates[0].previous, null);
  const second = await scanFuture72Hours(options);
  assert.equal(second.candidates[0].previous.odds, 2.4);
  assert.equal(second.candidates[0].previous.changePct, 0);
});

test('el peor caso de cuatro fechas UTC no supera 13 consultas', async () => {
  const mock = futureFetch();
  const requests = [];
  const report = await scanFuture72Hours({
    apiKey: 'test-future-cap', now: () => futureNow, snapshots: new Map(), fetchImpl: async url => {
      requests.push(url);
      if (url.pathname !== '/fixtures') return mock.fetchImpl(url);
      const date = url.searchParams.get('date');
      return Response.json({
        response: [{
          fixture: { id: Number(date.slice(-2)), date: `${date}T${date.endsWith('02') ? '19' : '17'}:00:00Z`, status: { short: 'NS' } },
          teams: { home: { name: 'Local' }, away: { name: 'Visitante' } }
        }]
      });
    }
  });
  assert.equal(report.fixtures, 4);
  assert.equal(report.compared, 4);
  assert.equal(report.usage.requests, 13);
  assert.equal(requests.length, 13);
  assert.equal(report.candidates.length, 4);
});

test('el escaner no compara cuotas de totales con lineas distintas', async () => {
  const mock = futureFetch();
  const report = await scanFuture72Hours({
    apiKey: 'test-future-different-lines', now: () => futureNow, snapshots: new Map(), fetchImpl: async url => {
      const response = await mock.fetchImpl(url);
      if (url.pathname !== '/odds') return response;
      const data = await response.json();
      const line = url.searchParams.get('bookmaker') === '4' ? '2.5' : '3.5';
      data.response[0].bookmakers[0].bets = [{
        name: 'Goals Over/Under', values: [
          { value: `Over ${line}`, odd: '2.40' }, { value: `Under ${line}`, odd: '1.70' }
        ]
      }];
      return Response.json(data);
    }
  });
  assert.equal(report.compared, 3);
  assert.equal(report.candidates.length, 0);
});

test('Telegram procesa foto y archivo de imagen hasta el reporte de cuotas', async () => {
  const originalFetch = globalThis.fetch;
  const variables = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_VIP_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'APISPORTS_KEY', 'GEMINI_API_KEY'];
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_VIP_CHAT_ID: '123', TELEGRAM_WEBHOOK_SECRET: 'test-secret', APISPORTS_KEY: 'test-webhook', GEMINI_API_KEY: 'test-gemini' });
  const sent = [];
  const images = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.telegram.org') {
      if (url.pathname.endsWith('/sendMessage')) { sent.push(JSON.parse(options.body).text); return Response.json({ ok: true }); }
      if (url.pathname.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/test.jpg' } });
      if (url.pathname.includes('/file/')) return new Response(new Uint8Array([255, 216, 255]));
    }
    if (url.hostname === 'generativelanguage.googleapis.com') {
      images.push(JSON.parse(options.body).contents[0].parts[1].inline_data.mime_type);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tooMany: false, selections: [ticketLeg] }) }] } }] });
    }
    if (url.hostname === 'v3.football.api-sports.io') return ticketFetch(() => [{
      fixture: { id: 501 }, bookmakers: [{
        id: 4, name: 'Pinnacle', bets: [{
          name: 'Match Winner', values: [
            { value: 'Home', odd: '2.40' }, { value: 'Draw', odd: '3.20' }, { value: 'Away', odd: '2.90' }
          ]
        }]
      }]
    }])(url);
    throw new Error('La prueba no permite otras peticiones de red.');
  };
  try {
    const { default: handler } = await import('../api/webhook.js');
    for (const attachment of [{ photo: [{ file_id: 'photo-test' }] }, { document: { file_id: 'document-test', mime_type: 'image/png' } }]) {
      const response = { statusCode: 0, status(code) { this.statusCode = code; return this; }, send(text) { this.text = text; return this; } };
      await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' }, body: { message: { from: { id: 123 }, chat: { id: 123 }, ...attachment } } }, response);
      assert.equal(response.statusCode, 200);
    }
    assert.deepEqual(images, ['image/jpeg', 'image/png']);
    assert.equal(sent.filter(text => text.includes('Ultima cuota publicada: *2.40*')).length, 2);
    assert.ok(sent.every(text => text.length < 4096));
    assert.ok(sent.every(text => !text.includes('APROBADO CON VALOR')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('el boton de 72 horas solo se muestra y ejecuta en el chat privado VIP', async () => {
  const originalFetch = globalThis.fetch;
  const variables = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_VIP_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'APISPORTS_KEY'];
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_VIP_CHAT_ID: '123', TELEGRAM_WEBHOOK_SECRET: 'test-secret', APISPORTS_KEY: 'test-future-webhook' });
  const sent = [];
  const mock = futureFetch({ timestamp: Date.now() });
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.telegram.org' && url.pathname.endsWith('/sendMessage')) {
      sent.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    }
    if (url.hostname === 'v3.football.api-sports.io') return mock.fetchImpl(url);
    throw new Error('No se permiten escaneos actuales, auditorias ni otras peticiones en esta prueba.');
  };
  try {
    const { default: handler } = await import('../api/webhook.js');
    const deliver = async (text, chatId = 123, type = 'private', senderId = 123) => {
      const response = { statusCode: 0, status(code) { this.statusCode = code; return this; }, send() { return this; } };
      await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' }, body: { message: { text, from: { id: senderId }, chat: { id: chatId, type } } } }, response);
      assert.equal(response.statusCode, 200);
    };
    await deliver('/start');
    assert.ok(sent.at(-1).reply_markup.keyboard.flat().some(button => button.text === '🔭 Próximas 72 h'));
    await deliver('/start', -100, 'group');
    assert.ok(!sent.at(-1).reply_markup.keyboard.flat().some(button => button.text === '🔭 Próximas 72 h'));
    await deliver('/futuro', -100, 'group');
    assert.equal(mock.calls.length, 0);
    assert.match(sent.at(-1).text, /chat privado VIP/);
    await deliver('/futuro', 456, 'private', 456);
    assert.equal(mock.calls.length, 0);
    const firstReport = sent.length;
    await deliver('🔭 Próximas 72 h');
    assert.ok(mock.calls.length > 0 && mock.calls.length <= 30);
    const privateReports = sent.slice(firstReport);
    assert.ok(privateReports.every(payload => payload.chat_id === 123 && payload.text.length < 4096));
    assert.ok(privateReports.some(payload => payload.text.includes('VIP | PROXIMAS 72 HORAS')));
    assert.ok(privateReports.some(payload => payload.text.includes('MULTIDEPORTE')));
    assert.ok(privateReports.some(payload => payload.text.includes('no picks oficiales')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('el futuro multideporte exige probabilidad calibrada, cuota real y un candidato por partido', () => {
  const start = Date.parse('2026-11-02T18:00:00Z');
  const good = { sport: 'NFL', game: 'A vs B', gameDate: '2026-11-03T18:00:00Z', prob: '82%', odds: 1.5, oddsSource: 'market', evPct: 20, consensus: { votesPassed: 3 }, match: { home: { name: 'A' }, away: { name: 'B' } } };
  const candidates = selectHighProbabilityCandidates([good, { ...good, prob: '80%' }, { ...good, game: 'C vs D', prob: '64%' }, { ...good, game: 'E vs F', oddsSource: 'model' }], start, start + 72 * 3600000);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].prob, '82%');
  const second = { ...good, game: 'C vs D', prob: '80%', match: { home: { name: 'C' }, away: { name: 'D' } } };
  const combo = buildConservativeCombination([good, second]);
  assert.equal(combo.legs.length, 2);
  assert.ok(Math.abs(combo.probability - 65.6) < 0.001);
  assert.equal(buildConservativeCombination([good, { ...second, prob: '65%' }, { ...good, prob: '90%' }]), null);
});

test('las fuentes futuras cargan cinco deportes sin inventar precios ni estadisticas', async () => {
  const timestamp = Date.parse('2026-11-02T18:00:00Z');
  const kickoff = '2026-11-03T18:00:00Z';
  const teams = {
    basketball_nba: ['Boston Celtics', 'Washington Wizards'],
    americanfootball_nfl: ['Kansas City Chiefs', 'Las Vegas Raiders'],
    americanfootball_ncaaf: ['Michigan Wolverines', 'Rutgers Scarlet Knights'],
    baseball_mlb: ['New York Yankees', 'Boston Red Sox']
  };
  const requests = [];
  const data = await loadFutureModelData({
    now: () => timestamp, apiKey: 'test-multi-football', oddsKeys: ['test-multi-odds'], fetchImpl: async input => {
      const url = new URL(input);
      requests.push(url);
      if (url.hostname === 'v3.football.api-sports.io') {
        if (url.pathname === '/status') return Response.json({ response: { requests: { current: 5, limit_day: 100 } } });
        if (url.pathname === '/fixtures') return Response.json({ response: [{ fixture: { id: 901, date: kickoff, status: { short: 'NS' } }, league: { id: 135, name: 'Serie A', season: 2026 }, teams: { home: { id: 1, name: 'Atalanta' }, away: { id: 2, name: 'Parma' } } }] });
        if (url.pathname === '/teams/statistics') return Response.json({ response: { fixtures: { played: { total: 10 } }, goals: { for: { average: { total: '1.8' } } } } });
        return Response.json({
          response: [{
            fixture: { id: 901 }, update: new Date(timestamp).toISOString(), bookmakers: [{
              id: 4, name: 'Pinnacle', bets: [{
                name: 'Match Winner', values: [
                  { value: 'Home', odd: '1.50' }, { value: 'Draw', odd: '4.00' }, { value: 'Away', odd: '6.00' }
                ]
              }]
            }]
          }]
        });
      }
      if (url.hostname === 'api.the-odds-api.com') {
        const sport = url.pathname.split('/')[3];
        const [home, away] = teams[sport];
        const spread = sport === 'basketball_nba' ? -18.5 : -3.5;
        const total = sport === 'basketball_nba' ? 236.5 : sport === 'baseball_mlb' ? 8.5 : 44.5;
        return Response.json([{
          id: sport, home_team: home, away_team: away, commence_time: kickoff, bookmakers: [{
            key: 'pinnacle', title: 'Pinnacle', last_update: new Date(timestamp).toISOString(), markets: [
              { key: 'h2h', outcomes: [{ name: home, price: sport === 'basketball_nba' ? 1.12 : 1.5 }, { name: away, price: sport === 'basketball_nba' ? 8 : 2.8 }] },
              { key: 'spreads', outcomes: [{ name: home, point: spread, price: 1.91 }, { name: away, point: -spread, price: 1.91 }] },
              { key: 'totals', outcomes: [{ name: 'Over', point: total, price: 1.91 }, { name: 'Under', point: total, price: 1.91 }] }
            ]
          }]
        }], { headers: { 'x-requests-last': '3' } });
      }
      if (url.hostname === 'statsapi.mlb.com') {
        if (url.pathname.endsWith('/schedule')) return Response.json({
          dates: [{
            games: [{
              gamePk: 1, gameDate: kickoff, status: { detailedState: 'Scheduled' }, teams: {
                home: { team: { id: 147, name: 'New York Yankees' }, probablePitcher: { id: 99, fullName: 'Pitcher H' } },
                away: { team: { id: 111, name: 'Boston Red Sox' }, probablePitcher: { id: 88, fullName: 'Pitcher A' } }
              }
            }]
          }]
        });
        return Response.json({ stats: [{ splits: [{ stat: { ops: '.800', whip: '1.10' } }] }] });
      }
      if (url.hostname === 'site.api.espn.com') {
        if (url.pathname.endsWith('/statistics')) return Response.json({
          results: {
            stats: {
              categories: [{
                stats: [
                  { name: 'totalYards', value: 2500 }, { name: 'totalOffensivePlays', value: 400 }, { name: 'turnOverDifferential', value: 4 }
                ]
              }]
            }
          }
        });
        const sport = url.pathname.includes('/basketball/') ? 'basketball_nba' : url.pathname.includes('/college-football/') ? 'americanfootball_ncaaf' : 'americanfootball_nfl';
        const [home, away] = teams[sport];
        return Response.json({
          events: [{
            id: sport, date: kickoff, status: { type: { state: 'pre' } }, competitions: [{
              competitors: [
                { homeAway: 'home', team: { id: 1, displayName: home } }, { homeAway: 'away', team: { id: 2, displayName: away } }
              ]
            }]
          }]
        });
      }
      throw new Error('Fuente no autorizada en la prueba.');
    }
  });
  for (const key of ['soccerMatches', 'nbaMatches', 'nflMatches', 'ncaafMatches', 'mlbMatches']) assert.equal(data.matches[key].length, 1, key);
  assert.ok(requests.length <= 60);
  assert.ok(data.usage.apiFootball.requests <= 30);
  assert.equal(data.usage.oddsCalls, 4);
  assert.equal(data.usage.oddsCredits, 12);
  assert.equal(data.matches.mlbMatches[0].home.pitcher.whip, 1.1);
  assert.equal(data.matches.nflMatches[0].home.ypp, 6.25);
  assert.ok(requests.filter(url => url.pathname.endsWith('/scoreboard')).every(url => url.searchParams.get('dates') === '20261102-20261105'));
  const modeled = evaluateFutureModels(data.matches, timestamp, timestamp + 72 * 3600000);
  assert.ok(modeled.candidates.some(pick => pick.sport === 'Baloncesto'), 'El modelo existente debe producir un candidato NBA en este caso favorable.');
});

test('el analisis multideporte ordena candidatos sin enviar alertas ni forzar una combinada', async () => {
  const timestamp = Date.parse('2026-11-02T18:00:00Z');
  const candidate = {
    id: 'nba-test', sport: 'Baloncesto', game: 'A vs B', gameDate: '2026-11-03T18:00:00Z', pick: 'Victoria A', prob: '70%', odds: 1.8,
    oddsSource: 'market', evPct: 26, consensus: { votesPassed: 3 }, match: { home: { name: 'A' }, away: { name: 'B' }, market: { sharpBookmaker: 'Pinnacle' } }
  };
  const result = await scanFutureMultiSport({
    now: () => timestamp, loadData: async () => ({
      matches: { nbaMatches: [{}], nflMatches: [{}] },
      coverage: { nba: { scheduled: 1, evaluated: 1 }, nfl: { scheduled: 1, evaluated: 1 } }, notices: [], usage: { requests: 2, oddsCalls: 1, oddsCredits: 3 }
    }),
    evaluate: input => ({ approvedOpps: input.nbaMatches ? [candidate] : [{ ...candidate, id: 'nfl-test', sport: 'NFL', game: 'C vs D', prob: '68%', match: { home: { name: 'C' }, away: { name: 'D' } } }] })
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].sport, 'Baloncesto');
  assert.equal(result.combination, null);
  const text = formatFutureMultiSport(result);
  assert.match(text, /MULTIDEPORTE/);
  assert.match(text, /No se construye combinada/);
  assert.match(text, /no picks oficiales/);
});

test('una cuota vieja y un abridor no anunciado quedan fuera del analisis multideporte', async () => {
  const timestamp = Date.parse('2026-11-04T18:00:00Z');
  const kickoff = '2026-11-05T18:00:00Z';
  const data = await loadFutureModelData({
    now: () => timestamp, apiKey: 'test-multi-missing', oddsKeys: ['test-multi-missing-odds'], fetchImpl: async input => {
      const url = new URL(input);
      if (url.hostname === 'v3.football.api-sports.io') return Response.json({ response: { requests: { current: 90, limit_day: 100 } } });
      if (url.hostname === 'api.the-odds-api.com') {
        const nba = url.pathname.includes('basketball_nba');
        const mlb = url.pathname.includes('baseball_mlb');
        if (!nba && !mlb) return Response.json([]);
        const home = nba ? 'Boston Celtics' : 'New York Yankees';
        const away = nba ? 'Washington Wizards' : 'Boston Red Sox';
        return Response.json([{
          home_team: home, away_team: away, commence_time: kickoff, bookmakers: [{
            key: 'pinnacle', title: 'Pinnacle',
            last_update: nba ? '2020-01-01T00:00:00Z' : new Date(timestamp).toISOString(), markets: [{ key: 'h2h', outcomes: [{ name: home, price: 1.5 }, { name: away, price: 2.8 }] }]
          }]
        }]);
      }
      if (url.hostname === 'statsapi.mlb.com') return Response.json({
        dates: [{
          games: [{
            gamePk: 1, gameDate: kickoff, status: { detailedState: 'Scheduled' }, teams: {
              home: { team: { id: 147, name: 'New York Yankees' } }, away: { team: { id: 111, name: 'Boston Red Sox' } }
            }
          }]
        }]
      });
      if (url.hostname === 'site.api.espn.com') return Response.json({
        events: url.pathname.includes('/basketball/') ? [{
          id: 'nba-missing', date: kickoff, status: { type: { state: 'pre' } }, competitions: [{
            competitors: [
              { homeAway: 'home', team: { id: 1, displayName: 'Boston Celtics' } }, { homeAway: 'away', team: { id: 2, displayName: 'Washington Wizards' } }
            ]
          }]
        }] : []
      });
      throw new Error('No se permiten peticiones de red externas en esta prueba.');
    }
  });
  assert.ok(Object.values(data.matches).every(matches => matches.length === 0));
  assert.ok(data.notices.some(notice => notice.includes('actualizada')));
  assert.ok(data.notices.some(notice => notice.includes('Abridor no anunciado')));
  assert.equal(data.usage.apiFootball.requests, 1);
  assert.ok(data.usage.requests <= 60);
});

test('el cálculo institucional de stake protege banca y respeta techos de Kelly y Player Props', () => {
  const regularWithRlm = {
    prob: '65%',
    odds: 1.85,
    isProp: false,
    confidence: { label: 'ALTA', kellyMultiplier: 0.8 },
    consensus: {
      votesPassed: 3,
      recommendedStake: '1.5 Unidades',
      rlmInfo: { isRlmDetected: true, rlmType: 'FAVORABLE' }
    },
    mcStats: { stability: 80 }
  };
  const rlmStake = calculatePickEffectiveStake(regularWithRlm);
  assert.equal(rlmStake.effectiveStake, 1.5);

  const regularNoRlmLowStability = {
    prob: '58%',
    odds: 1.95,
    isProp: false,
    confidence: { label: 'MEDIA', kellyMultiplier: 0.5 },
    consensus: {
      votesPassed: 2,
      recommendedStake: '1.5 Unidades',
      rlmInfo: null
    },
    mcStats: { stability: 65 }
  };
  const protectedStake = calculatePickEffectiveStake(regularNoRlmLowStability);
  assert.equal(protectedStake.effectiveStake, 0.3);
  assert.ok(protectedStake.stakeLabel.includes('Kelly'));

  const playerProp = {
    id: 'prop-player-1',
    isProp: true,
    prob: '70%',
    odds: 1.70,
    confidence: { label: 'ALTA', kellyMultiplier: 0.8 },
    consensus: {
      votesPassed: 3,
      recommendedStake: '2.5 Unidades'
    }
  };
  const propStake = calculatePickEffectiveStake(playerProp);
  assert.ok(propStake.effectiveStake <= 1.5);
});

test('el reporte ejecutivo IA sintetiza picks consolidados con fallback en caso de indisponibilidad', async () => {
  const originalFetch = globalThis.fetch;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key'; // La llave ya no vive en el codigo: el test la aporta por entorno.
  const samplePicks = [
    {
      sport: 'Fútbol',
      league: 'UEFA Champions League',
      game: 'Borussia Dortmund vs Sturm Graz',
      pick: 'Victoria Borussia Dortmund',
      odds: '1.38',
      prob: '76%',
      isBaseConfianza: true,
      consensus: { recommendedStake: '2.0 Unidades' }
    }
  ];

  // 1. Simulación exitosa con Gemini Flash
  globalThis.fetch = async () => Response.json({
    candidates: [{
      content: {
        parts: [{ text: '🧠 *DICTAMEN DEL ANALISTA IA — STATS-AI PRO*\nBase de confianza confirmada con Dortmund.' }]
      }
    }]
  });

  try {
    const report = await generateAiExecutiveReport(samplePicks, 'EDICIÓN MATUTINA', 'Miércoles 4 de Noviembre');
    assert.ok(report.includes('DICTAMEN DEL ANALISTA IA'));
    assert.ok(report.includes('Dortmund'));

    // 2. Simulación de fallo en upstream (debe retornar null para activar fallback resiliente)
    globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });
    const fallbackReport = await generateAiExecutiveReport(samplePicks, 'EDICIÓN MATUTINA', 'Miércoles 4 de Noviembre');
    assert.equal(fallbackReport, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }
});

test('el escaneo futuro usa el fallback dia por dia de ESPN para NFL y no tumba el deporte si no hay cuotas', async () => {
  const timestamp = Date.parse('2026-11-10T06:00:00Z');
  const kickoff = '2026-11-12T01:00:00Z';
  const data = await loadFutureModelData({
    now: () => timestamp, apiKey: 'test-nfl-400', oddsKeys: [], fetchImpl: async input => {
      const url = new URL(input);
      if (url.hostname === 'v3.football.api-sports.io') {
        if (url.pathname === '/status') return Response.json({ response: { requests: { current: 2, limit_day: 100 } } });
        return Response.json({ response: [] });
      }
      if (url.hostname === 'site.api.espn.com') {
        const dates = url.searchParams.get('dates') || '';
        if (dates.includes('-')) return new Response('Bad Request', { status: 400 });
        const isNfl = url.pathname.includes('/football/nfl/') && dates === '20261112';
        return Response.json({ events: isNfl ? [{
          id: 'nfl-400', date: kickoff, status: { type: { state: 'pre' } }, competitions: [{
            competitors: [
              { homeAway: 'home', team: { id: 1, displayName: 'Kansas City Chiefs' } },
              { homeAway: 'away', team: { id: 2, displayName: 'Denver Broncos' } }
            ]
          }]
        }] : [] });
      }
      if (url.hostname === 'statsapi.mlb.com') return Response.json({ dates: [] });
      if (url.hostname === 'api.the-odds-api.com') return Response.json([]);
      throw new Error('No se permiten peticiones de red externas en esta prueba.');
    }
  });
  assert.equal(data.coverage.nfl.scheduled, 1);
  assert.equal(data.coverage.nfl.evaluated, 0);
  assert.equal(data.matches.nflMatches.length, 0);
  assert.ok(data.notices.some(notice => notice.includes('NFL: Sin cuotas disponibles en el pool The Odds API.')));
  assert.ok(!data.notices.some(notice => notice.includes('NFL: Fuente HTTP 400')), 'El rango 400 de ESPN ya no debe tumbar a la NFL.');
});

test('el futbol de 72h completa con ligas de segundo nivel cuando las principales no juegan', () => {
  const fixtures = [
    { fixture: { id: 1, date: '2026-11-10T20:00:00Z' }, league: { id: 143, name: 'Copa del Rey' } },
    { fixture: { id: 2, date: '2026-11-10T18:00:00Z' }, league: { id: 999, name: 'Liga Oscura' } },
    { fixture: { id: 3, date: '2026-11-11T20:00:00Z' }, league: { id: 39, name: 'Premier League' } }
  ];
  const { picked, usedTier2 } = pickSoccerFixtures(fixtures);
  assert.deepEqual(picked.map(fixture => fixture.fixture.id), [3, 1]);
  assert.equal(usedTier2, true);
  const onlyTop = pickSoccerFixtures([fixtures[2]]);
  assert.deepEqual(onlyTop.picked.map(fixture => fixture.fixture.id), [3]);
  assert.equal(onlyTop.usedTier2, false);
});

import { parsePickMarket, gradePick, computePnl, findGame, gradePendingPicks } from './gradeLedger.mjs';

test('gradeLedger: interpreta BTTS, totales, spreads, doble oportunidad y runline', () => {
  assert.deepEqual(parsePickMarket('Ambos Equipos Anotan: Sí (BTTS)'), { kind: 'btts', value: 'yes' });
  assert.deepEqual(parsePickMarket('OVER 54.5 Pts'), { kind: 'total', side: 'over', line: 54.5 });
  assert.deepEqual(parsePickMarket('UNDER 240.5 Pts'), { kind: 'total', side: 'under', line: 240.5 });
  assert.deepEqual(parsePickMarket('OVER 2.5 Goles'), { kind: 'total', side: 'over', line: 2.5 });
  assert.deepEqual(parsePickMarket('Milwaukee Bucks +4.5 (Cubre Línea)'), { kind: 'spread', team: 'Milwaukee Bucks', line: 4.5 });
  assert.deepEqual(parsePickMarket('South Alabama Jaguars -2.5 (Cubre Línea)'), { kind: 'spread', team: 'South Alabama Jaguars', line: -2.5 });
  assert.deepEqual(parsePickMarket('Milwaukee Brewers +1.5 Carreras (Runline)'), { kind: 'spread', team: 'Milwaukee Brewers', line: 1.5 });
  assert.deepEqual(parsePickMarket('Lorient o Empate (1X)'), { kind: 'doubleChance', team: 'Lorient', side: '1X' });
  assert.equal(parsePickMarket('Nikola Krstovic Más de 1.5 Tiros a Puerta', '⚽ PLAYER PROP (TIROS A PUERTA)').kind, 'prop');
  assert.equal(parsePickMarket('Algo raro sin mercado').kind, 'unknown');
});

test('gradeLedger: califica con el marcador real y nunca califica props', () => {
  const btts = { kind: 'btts', value: 'yes' };
  assert.equal(gradePick(btts, 'Chicago Fire FC', 'Philadelphia Union', 2, 1), 'WON');
  assert.equal(gradePick(btts, 'Chicago Fire FC', 'Philadelphia Union', 2, 0), 'LOST');
  assert.equal(gradePick({ kind: 'total', side: 'over', line: 54.5 }, 'A', 'B', 30, 25), 'WON');
  assert.equal(gradePick({ kind: 'total', side: 'under', line: 240.5 }, 'A', 'B', 110, 105), 'WON');
  assert.equal(gradePick({ kind: 'total', side: 'over', line: 55 }, 'A', 'B', 28, 27), 'PUSH');
  assert.equal(gradePick({ kind: 'spread', team: 'Milwaukee Bucks', line: 4.5 }, 'Washington Wizards', 'Milwaukee Bucks', 110, 108), 'WON');
  assert.equal(gradePick({ kind: 'spread', team: 'South Alabama Jaguars', line: -2.5 }, 'Marshall Thundering Herd', 'South Alabama Jaguars', 20, 24), 'WON');
  assert.equal(gradePick({ kind: 'spread', team: 'South Alabama Jaguars', line: -2.5 }, 'Marshall Thundering Herd', 'South Alabama Jaguars', 20, 22), 'LOST');
  assert.equal(gradePick({ kind: 'doubleChance', team: 'Lorient', side: '1X' }, 'Lorient', 'Brest', 1, 1), 'WON');
  assert.equal(gradePick({ kind: 'doubleChance', team: 'Lorient', side: '1X' }, 'Lorient', 'Brest', 0, 2), 'LOST');
  assert.equal(gradePick({ kind: 'prop' }, 'Atalanta', 'Parma', 2, 0), null);
  assert.equal(gradePick({ kind: 'unknown' }, 'A', 'B', 1, 0), null);
  assert.equal(computePnl('WON', 1.62, 1.1), 0.68);
  assert.equal(computePnl('LOST', 1.7, 0.7), -0.7);
  assert.equal(computePnl('PUSH', 1.9, 1.0), 0);
});

test('gradeLedger: empareja equipos por nombre aunque ESPN abrevie o añada sufijos', () => {
  const games = [
    { home: 'Servette FC', away: 'Oud-Heverlee Leuven', homeScore: 2, awayScore: 2, score: '2-2' },
    { home: 'Chicago Fire', away: 'Philadelphia Union', homeScore: 2, awayScore: 1, score: '2-1' },
  ];
  const g1 = findGame(games, 'Servette', 'OH Leuven');
  assert.equal(g1.score, '2-2');
  assert.equal(g1.swapped, false);
  const g2 = findGame(games, 'Philadelphia Union', 'Chicago Fire FC');
  assert.equal(g2.score, '2-1');
  assert.equal(g2.swapped, true);
  assert.equal(findGame(games, 'Real Madrid', 'Barcelona'), null);
});

test('gradeLedger: califica picks de un ledger temporal con ESPN simulado, sin tocar el real', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grade-ledger-'));
  const tmpLedger = path.join(tmpDir, 'pick_ledger.jsonl');
  const picks = [
    { id: 'test-nba-under', status: 'PENDING', sport: 'Baloncesto', league: 'NBA', game: 'Miami Heat vs Minnesota Timberwolves', gameDate: '2026-10-21T23:30Z', pick: 'UNDER 240.5 Pts', type: '🏀 TOTALES NBA (UNDER)', placedOdds: 1.91, stakeUnits: 1, result: null, score: null, pnlUnits: null, closingOdds: null, clvPct: null },
    { id: 'test-btts', status: 'PENDING', sport: 'Fútbol', league: 'MLS (EE.UU.)', game: 'Chicago Fire FC vs Philadelphia Union', gameDate: '2026-10-15T00:30Z', pick: 'Ambos Equipos Anotan: Sí (BTTS)', type: '⚽ AMBOS EQUIPOS ANOTAN (TIER 1 ÉLITE)', placedOdds: 1.62, stakeUnits: 1.1, result: null, score: null, pnlUnits: null, closingOdds: null, clvPct: null },
    { id: 'test-prop', status: 'PENDING', sport: 'Fútbol', league: 'Serie A', game: 'Atalanta vs Parma', gameDate: '2026-11-02T19:45Z', pick: 'Nikola Krstovic Más de 1.5 Tiros a Puerta', type: '⚽ PLAYER PROP (TIROS A PUERTA)', placedOdds: 1.85, stakeUnits: 1, result: null, score: null, pnlUnits: null, closingOdds: null, clvPct: null },
  ];
  fs.writeFileSync(tmpLedger, picks.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
  const mockFetch = async (url) => {
    const body = String(url).includes('basketball/nba')
      ? { events: [{ competitions: [{ status: { type: { state: 'post' } }, competitors: [
        { homeAway: 'home', score: '110', team: { displayName: 'Miami Heat' } },
        { homeAway: 'away', score: '105', team: { displayName: 'Minnesota Timberwolves' } }] }] }] }
      : { events: [{ competitions: [{ status: { type: { state: 'post' } }, competitors: [
        { homeAway: 'home', score: '2', team: { displayName: 'Chicago Fire FC' } },
        { homeAway: 'away', score: '1', team: { displayName: 'Philadelphia Union' } }] }] }] };
    return { ok: true, json: async () => body };
  };
  const dry = await gradePendingPicks({ fetchImpl: mockFetch, ledgerPath: tmpLedger });
  assert.equal(dry.graded.length, 2);
  assert.equal(dry.graded.find(g => g.id === 'test-nba-under').result, 'WON');
  assert.equal(dry.graded.find(g => g.id === 'test-btts').result, 'WON');
  assert.equal(dry.skipped.length, 1);
  assert.equal(dry.skipped[0].id, 'test-prop');
  const applied = await gradePendingPicks({ fetchImpl: mockFetch, ledgerPath: tmpLedger, apply: true });
  assert.equal(applied.graded.length, 2);
  const after = fs.readFileSync(tmpLedger, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(after.find(p => p.id === 'test-nba-under').status, 'CLOSED');
  assert.equal(after.find(p => p.id === 'test-nba-under').clvPct, null);
  assert.equal(after.find(p => p.id === 'test-prop').status, 'PENDING');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

import { computeLedgerReport } from './ledgerReport.mjs';

test('ledgerReport: ROI, calibración y drawdown salen del ledger, sin inventar CLV', () => {
  const rows = [
    { id: '1', status: 'CLOSED', result: 'WON', sport: 'Fútbol', league: 'LaLiga', pick: 'OVER 2.5 Goles', type: 'x', placedOdds: 2.0, prob: 60, stakeUnits: 1, pnlUnits: 1, timestamp: '2026-10-20T00:00:00Z', closedAt: '2026-10-21T00:00:00Z', clvPct: null, closingOdds: null },
    { id: '2', status: 'CLOSED', result: 'LOST', sport: 'Fútbol', league: 'LaLiga', pick: 'Ambos Equipos Anotan: Sí (BTTS)', type: 'x', placedOdds: 1.8, prob: 65, stakeUnits: 1, pnlUnits: -1, timestamp: '2026-10-21T00:00:00Z', closedAt: '2026-10-22T00:00:00Z', clvPct: null, closingOdds: null },
    { id: '3', status: 'CLOSED', result: 'WON', sport: 'Baloncesto', league: 'NBA', pick: 'UNDER 240.5 Pts', type: 'x', placedOdds: 1.91, prob: 70, stakeUnits: 2, pnlUnits: 1.82, timestamp: '2026-10-22T00:00:00Z', closedAt: '2026-10-23T00:00:00Z', clvPct: 2.5, closingOdds: 1.86 },
    { id: '4', status: 'PENDING', result: null, sport: 'Fútbol', league: 'LaLiga', pick: 'OVER 2.5 Goles', type: 'x', placedOdds: 1.9, prob: 62, stakeUnits: 1, pnlUnits: null, timestamp: '2026-11-02T00:00:00Z', clvPct: null, closingOdds: null },
  ];
  const r = computeLedgerReport(rows);
  assert.equal(r.closed, 3);
  assert.equal(r.pending, 1);
  assert.deepEqual(r.pendingIds, ['4']);
  assert.equal(r.overall.wins, 2);
  assert.equal(r.overall.netUnits, 1.82);
  assert.equal(r.overall.roiPct, 45.5);
  assert.equal(r.overall.hitRate, 66.67);
  assert.equal(r.clv.n, 1);
  assert.equal(r.clv.beatRatePct, 100);
  assert.equal(r.drawdown.maxDrawdownUnits, 1);
  assert.equal(r.drawdown.currentDrawdownUnits, 0);
  const futbol = r.bySport.find(g => g.key === 'Fútbol');
  assert.equal(futbol.n, 2);
  assert.equal(futbol.roiPct, 0);
  const totals = r.byMarket.find(g => g.key === 'Totales');
  assert.equal(totals.n, 2);
  assert.ok(r.warnings.some(w => w.includes('Muestra insuficiente')));
});

test('ledgerReport: sin cierres con CLV, lo dice en vez de reportar 0%', () => {
  const rows = [
    { id: '1', status: 'CLOSED', result: 'WON', sport: 'Fútbol', league: 'LaLiga', pick: 'OVER 2.5 Goles', type: 'x', placedOdds: 2.0, prob: 60, stakeUnits: 1, pnlUnits: 1, timestamp: '2026-10-20T00:00:00Z', closedAt: '2026-10-21T00:00:00Z', clvPct: null, closingOdds: null },
  ];
  const r = computeLedgerReport(rows);
  assert.equal(r.clv.n, 0);
  assert.equal(r.clv.beatRatePct, null);
  assert.ok(r.clv.note.includes('Sin datos'));
});

import { createProviderGuard, isSuspendedError } from '../src/services/providerGuard.js';

test('providerGuard: serializa peticiones, degrada con 429 y detecta suspensión', async () => {
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let slept = 0;
  const guard = createProviderGuard({ now, sleep: async (ms) => { slept += ms; nowMs += ms; }, minIntervalMs: 100, cooldownMs: 60_000 });
  await guard.acquire();
  await guard.acquire();
  assert.ok(slept >= 100, 'la segunda petición espera el ritmo mínimo');
  assert.equal(guard.noteFailure({ status: 429 }).degraded, true);
  assert.equal(guard.isDegraded(), true);
  await assert.rejects(guard.acquire(), /degradado/);
  nowMs += 61_000;
  assert.equal(guard.isDegraded(), false);
  await guard.acquire();
  assert.equal(isSuspendedError('Your account is suspended, check on https://dashboard.api-football.com.'), true);
  assert.equal(isSuspendedError('API-Sports HTTP 429.'), false);
});

test('ticketClient: un 429 degrada el proveedor y la siguiente petición no toca la red', async () => {
  let calls = 0;
  const fetch429 = async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  const client = createTicketClient({ fetchImpl: fetch429, apiKey: 'test-key', guardMinIntervalMs: 0 });
  await assert.rejects(client.request('/status'), /429.*respaldo/);
  await assert.rejects(client.request('/status'), /degradado/);
  assert.equal(calls, 1);
});

test('ticketClient: una cuenta suspendida se reporta como tal, no como error genérico', async () => {
  const fetchSuspended = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ response: {}, errors: { access: 'Your account is suspended, check on https://dashboard.api-football.com.' } }),
  });
  const client = createTicketClient({ fetchImpl: fetchSuspended, apiKey: 'test-key', guardMinIntervalMs: 0 });
  await assert.rejects(client.request('/status'), /suspendida/);
});

test('futuro: si API-Sports cae, el fútbol usa el respaldo ESPN + The Odds API', async () => {
  const fixedNow = Date.parse('2026-11-10T12:00:00Z');
  const now = () => fixedNow;
  const scoreboard = (home, away) => {
    const competitors = [
      { homeAway: 'home', team: { id: '359', displayName: home } },
      { homeAway: 'away', team: { id: '363', displayName: away } },
    ];
    return {
      events: [{
        id: '9001',
        date: '2026-11-11T19:45:00Z',
        competitions: [{ status: { type: { state: 'pre' } }, competitors }],
      }],
    };
  };
  const teamStats = {
    results: {
      stats: {
        categories: [{ stats: [
          { name: 'goals', value: '45' },
          { name: 'gamesPlayed', value: '12' },
        ] }],
      },
    },
  };
  const mockFetch = async (input) => {
    const url = String(input);
    if (url.includes('v3.football.api-sports.io')) throw new Error('API-Sports: Your account is suspended, check on https://dashboard.api-football.com.');
    if (url.includes('soccer/eng.1/scoreboard')) return { ok: true, headers: { get: () => null }, json: async () => scoreboard('Arsenal', 'Chelsea') };
    if (url.includes('/teams/') && url.includes('/statistics')) return { ok: true, headers: { get: () => null }, json: async () => teamStats };
    if (url.includes('soccer_epl/odds')) {
      return { ok: true, headers: { get: (h) => (h === 'x-requests-last' ? '3' : null) }, json: async () => [{
        home_team: 'Arsenal', away_team: 'Chelsea', commence_time: '2026-11-11T19:45:00Z',
        bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', last_update: '2026-11-10T11:00:00Z', markets: [
          { key: 'h2h', last_update: '2026-11-10T11:00:00Z', outcomes: [
            { name: 'Arsenal', price: 2.1 }, { name: 'Chelsea', price: 3.4 }, { name: 'Draw', price: 3.6 }] },
          { key: 'totals', last_update: '2026-11-10T11:00:00Z', outcomes: [
            { name: 'Over', point: 2.5, price: 1.95 }, { name: 'Under', point: 2.5, price: 1.87 }] },
          { key: 'btts', last_update: '2026-11-10T11:00:00Z', outcomes: [
            { name: 'Yes', price: 1.75 }, { name: 'No', price: 2.05 }] },
        ] }],
      }] };
    }
    if (url.includes('scoreboard')) return { ok: true, headers: { get: () => null }, json: async () => ({ events: [] }) };
    if (url.includes('statsapi.mlb.com')) return { ok: true, headers: { get: () => null }, json: async () => ({ dates: [] }) };
    return { ok: true, headers: { get: () => null }, json: async () => ({ events: [] }) };
  };
  const data = await loadFutureModelData({ fetchImpl: mockFetch, now, oddsKeys: ['test-odds-key'] });
  assert.equal(data.matches.soccerMatches.length, 1);
  const match = data.matches.soccerMatches[0];
  assert.equal(match.league, 'Premier League');
  assert.equal(match.market.hasRealOdds, true);
  assert.equal(match.market.homeOdds, 2.1);
  assert.equal(match.home.xG, 3.75);
  assert.ok(data.notices.some(n => n.includes('respaldo ESPN + The Odds API')));
  assert.ok(data.coverage.futbol.evaluated >= 1);
});

import { evaluateBankroll, trimSlateToExposure, capStake, settledDrawdown, BANKROLL } from '../src/utils/bankroll.js';

test('bankroll: el freno se activa con drawdown de 8u en 30 días y no con 7u', () => {
  const day = 86400000;
  const nowMs = Date.parse('2026-11-10T12:00:00Z');
  const mk = (daysAgo, pnl) => ({ result: pnl > 0 ? 'WON' : 'LOST', pnlUnits: pnl, timestamp: new Date(nowMs - daysAgo * day).toISOString(), closedAt: new Date(nowMs - daysAgo * day).toISOString() });
  const bad = [mk(1, 1), mk(2, -3), mk(3, -6)];
  const dd = settledDrawdown(bad, nowMs);
  // Orden cronológico: -6, -3, +1. Pico 0u, cierre -8u → drawdown actual 8u;
  // la caída máxima intra-ventana fue 9u.
  assert.equal(dd.drawdownUnits, 8);
  assert.equal(dd.maxDrawdownUnits, 9);
  assert.equal(evaluateBankroll({ closedRows: bad, allRows: bad, nowMs }).blocked, true);
  const ok = [mk(1, 1), mk(2, -3), mk(3, -5)];
  assert.equal(evaluateBankroll({ closedRows: ok, allRows: ok, nowMs }).blocked, false);
});

test('bankroll: las pérdidas viejas fuera de la ventana no cuentan y el reinicio pone la base en cero', () => {
  const day = 86400000;
  const nowMs = Date.parse('2026-11-10T12:00:00Z');
  const mk = (daysAgo, pnl) => ({ result: pnl > 0 ? 'WON' : 'LOST', pnlUnits: pnl, timestamp: new Date(nowMs - daysAgo * day).toISOString(), closedAt: new Date(nowMs - daysAgo * day).toISOString() });
  const old = [mk(40, -20)];
  assert.equal(settledDrawdown(old, nowMs).drawdownUnits, 0);
  const recent = [mk(5, -9), mk(1, 1)];
  assert.equal(evaluateBankroll({ closedRows: recent, allRows: recent, nowMs }).blocked, true);
  const resetAt = new Date(nowMs - 2 * day).toISOString();
  assert.equal(evaluateBankroll({ closedRows: recent, allRows: recent, nowMs, resetAt }).blocked, false);
});

test('bankroll: la exposición diaria recorta la cartelera por edge y el stake nunca pasa de 2u', () => {
  assert.equal(capStake(3.5), 2.0);
  assert.equal(capStake(1.2), 1.2);
  const picks = [
    { pick: 'a', stake: 2, edge: 12 },
    { pick: 'b', stake: 2, edge: 8 },
    { pick: 'c', stake: 2, edge: 3 },
  ];
  const trimmed = trimSlateToExposure(picks, 4.5);
  assert.deepEqual(trimmed.kept.map(p => p.pick), ['a', 'b']);
  assert.deepEqual(trimmed.dropped.map(p => p.pick), ['c']);
  assert.equal(trimmed.usedUnits, 4);
  assert.ok(BANKROLL.maxDailyExposureUnits === 6.0);
});

import { computeNbaRatingsFromTeamStats, shrinkTowardLeague, fetchLiveNbaRatings, ensureLiveNbaRatings, clearNbaRatingsCache, NBA_RATINGS_SHRINK_K } from '../src/services/nbaRatings.js';
import { calculateNbaProbabilities, getNbaTeamBaseline, getNbaBaselineSource, setLiveNbaRatings, clearLiveNbaRatings } from '../src/utils/hoops.js';

test('nbaRatings: computeNbaRatingsFromTeamStats calcula pace/ORtg/DRtg con la fórmula de Dean Oliver', () => {
  // Milwaukee real (ESPN, 10 partidos, nov 2026): FGA 90.6, FTA 20.4, ORB 13.9, TOV 16.1, PTS 108.4, OppPTS 121.6
  const r = computeNbaRatingsFromTeamStats({ fga: 90.6, fta: 20.4, orb: 13.9, tov: 16.1, ppg: 108.4, oppPpg: 121.6, games: 10 });
  assert.equal(r.pace, 101.8); // 90.6 + 0.44*20.4 - 13.9 + 16.1
  assert.equal(r.ortg, 106.5); // 100*108.4/101.776
  assert.equal(r.drtg, 119.5); // 100*121.6/101.776
  assert.equal(r.games, 10);
  assert.equal(computeNbaRatingsFromTeamStats({ fga: 90, fta: 20, orb: 10, tov: 14, ppg: 110, oppPpg: null, games: 10 }), null);
  assert.equal(computeNbaRatingsFromTeamStats({ fga: 90, fta: 20, orb: 10, tov: 14, ppg: 110, oppPpg: 110, games: 0 }), null);
});

test('nbaRatings: el encogimiento acerca a la liga con pocos partidos y casi no mueve con muchos', () => {
  assert.equal(shrinkTowardLeague(120, 0, 111), 111); // sin partidos: promedio de liga
  const few = shrinkTowardLeague(120, 2, 111, NBA_RATINGS_SHRINK_K);
  assert.ok(few > 111 && few < 115); // 2 partidos: peso real 25%
  const many = shrinkTowardLeague(120, 100, 111, NBA_RATINGS_SHRINK_K);
  assert.ok(many > 119); // 100 partidos: casi crudo
  assert.equal(NBA_RATINGS_SHRINK_K, 6);
});

test('nbaRatings: los ratings en vivo tienen prioridad sobre la tabla fósil y se pueden limpiar', () => {
  try {
    setLiveNbaRatings({ 'milwaukee bucks': { pace: 105, ortg: 100, drtg: 130, games: 10, source: 'live-espn' } });
    assert.equal(getNbaTeamBaseline('Milwaukee Bucks').ortg, 100);
    assert.equal(getNbaBaselineSource('Milwaukee Bucks'), 'live');
    assert.equal(getNbaBaselineSource('Boston Celtics'), 'static');
    const probs = calculateNbaProbabilities({ home: { name: 'Milwaukee Bucks' }, away: { name: 'Boston Celtics' }, spread: -1.5 });
    assert.equal(probs.ratingsSource, 'static'); // solo un equipo en vivo: no es 'live'
    setLiveNbaRatings({
      'milwaukee bucks': { pace: 105, ortg: 100, drtg: 130, games: 10, source: 'live-espn' },
      'boston celtics': { pace: 100, ortg: 120, drtg: 100, games: 10, source: 'live-espn' }
    });
    const probsLive = calculateNbaProbabilities({ home: { name: 'Milwaukee Bucks' }, away: { name: 'Boston Celtics' }, spread: -1.5 });
    assert.equal(probsLive.ratingsSource, 'live');
    assert.ok(probsLive.projectedSpread < 0); // con ratings en vivo, Boston (mejor) gana de visita
  } finally {
    clearLiveNbaRatings();
  }
  assert.equal(getNbaTeamBaseline('Milwaukee Bucks').ortg, 117.6); // vuelve la tabla fósil
  assert.equal(getNbaBaselineSource('Milwaukee Bucks'), 'static');
});

test('nbaRatings: fetchLiveNbaRatings arma ratings desde standings + stats con fetch simulado', async () => {
  const originalFetch = globalThis.fetch;
  const standings = { children: [{ standings: { entries: [
    { team: { id: '15', displayName: 'Milwaukee Bucks' }, stats: [{ name: 'avgPointsFor', value: 108.4 }, { name: 'avgPointsAgainst', value: 121.6 }] },
    { team: { id: '2', displayName: 'Boston Celtics' }, stats: [{ name: 'avgPointsFor', value: 115.0 }, { name: 'avgPointsAgainst', value: 104.3 }] }
  ] } }] };
  const statsById = {
    15: { results: { stats: { categories: [{ name: 'offensive', stats: [
      { name: 'avgFieldGoalsAttempted', value: 90.6 }, { name: 'avgFreeThrowsAttempted', value: 20.4 },
      { name: 'avgOffensiveRebounds', value: 13.9 }, { name: 'avgTurnovers', value: 16.1 },
      { name: 'avgPoints', value: 108.4 }, { name: 'gamesPlayed', value: 10 } ] }] } } },
    2: { results: { stats: { categories: [{ name: 'offensive', stats: [
      { name: 'avgFieldGoalsAttempted', value: 88 }, { name: 'avgFreeThrowsAttempted', value: 22 },
      { name: 'avgOffensiveRebounds', value: 10 }, { name: 'avgTurnovers', value: 13 },
      { name: 'avgPoints', value: 115 }, { name: 'gamesPlayed', value: 10 } ] }] } } }
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes('standings')) return Response.json(standings);
    const m = String(url).match(/teams\/(\d+)\/statistics/);
    if (m && statsById[m[1]]) return Response.json(statsById[m[1]]);
    return new Response('Not found', { status: 404 });
  };
  try {
    clearNbaRatingsCache();
    const payload = await fetchLiveNbaRatings();
    assert.equal(payload.teams, 2);
    assert.deepEqual(payload.notices, []);
    const mil = payload.ratings['milwaukee bucks'];
    assert.equal(mil.games, 10);
    assert.equal(mil.source, 'live-espn');
    // Crudo ORtg 106.5, encogido hacia la liga (~110.4) con 10 partidos: queda entre ambos.
    assert.ok(mil.ortg > 106.5 && mil.ortg < 110.4);
    assert.ok(mil.drtg > 111 && mil.drtg < 119.5);
    const bos = payload.ratings['boston celtics'];
    assert.ok(bos.ortg > 110.4 && bos.ortg < 114.2);
    assert.ok(Math.abs(payload.leagueAvg.ortg - 110.35) < 0.15);
  } finally {
    globalThis.fetch = originalFetch;
    clearNbaRatingsCache();
  }
});

test('nbaRatings: si ESPN cae, ensureLiveNbaRatings devuelve null y el modelo sigue con la tabla', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ESPN caído'); };
  try {
    clearNbaRatingsCache();
    clearLiveNbaRatings();
    assert.equal(await ensureLiveNbaRatings(), null);
    assert.equal(getNbaTeamBaseline('Milwaukee Bucks').ortg, 117.6);
    assert.equal(getNbaBaselineSource('Milwaukee Bucks'), 'static');
  } finally {
    globalThis.fetch = originalFetch;
    clearNbaRatingsCache();
    clearLiveNbaRatings();
  }
});

test('nbaRatings: sin línea publicada, calculateNbaProbabilities nunca devuelve NaN', () => {
  try {
    clearLiveNbaRatings();
    const probs = calculateNbaProbabilities({ home: { name: 'Milwaukee Bucks' }, away: { name: 'Boston Celtics' }, spread: null, total: null, odds: { spread: null, overUnder: null } });
    assert.equal(probs.marketSpread, 0);
    assert.equal(probs.marketTotal, Math.round(probs.projectedTotal)); // el fallback redondea
    assert.ok(Number.isFinite(probs.homeCoverProb));
    assert.ok(Number.isFinite(probs.awayCoverProb));
    assert.ok(Number.isFinite(probs.overProb));
    assert.ok(Number.isFinite(probs.underProb));
    assert.equal(probs.homeCoverProb, probs.homeWinProb); // con spread 0, cubrir = ganar
    const withLine = calculateNbaProbabilities({ home: { name: 'Milwaukee Bucks' }, away: { name: 'Boston Celtics' }, spread: -4.5, total: 220.5 });
    assert.equal(withLine.marketSpread, -4.5);
    assert.equal(withLine.marketTotal, 220.5);
  } finally {
    clearLiveNbaRatings();
  }
});

import { getApiSportsKeys, getApiSportsKeyEntry, markApiSportsKeyUnhealthy, resetApiSportsKeyHealth, getApiSportsPoolState, getApiSportsStatusAll } from '../src/services/apiSports.js';

function setApiSportsEnv(plural, singular) {
  const prev = { plural: process.env.APISPORTS_KEYS, singular: process.env.APISPORTS_KEY, alt: process.env.API_SPORTS_KEY };
  if (plural === undefined) delete process.env.APISPORTS_KEYS; else process.env.APISPORTS_KEYS = plural;
  if (singular === undefined) delete process.env.APISPORTS_KEY; else process.env.APISPORTS_KEY = singular;
  delete process.env.API_SPORTS_KEY;
  return prev;
}

function restoreApiSportsEnv(prev) {
  if (prev.plural === undefined) delete process.env.APISPORTS_KEYS; else process.env.APISPORTS_KEYS = prev.plural;
  if (prev.singular === undefined) delete process.env.APISPORTS_KEY; else process.env.APISPORTS_KEY = prev.singular;
  if (prev.alt === undefined) delete process.env.API_SPORTS_KEY; else process.env.API_SPORTS_KEY = prev.alt;
  resetApiSportsKeyHealth();
}

test('apiSports pool: APISPORTS_KEYS separa por coma, deduplica y APISPORTS_KEY singular sigue funcionando', () => {
  const prev = setApiSportsEnv(undefined, undefined);
  try {
    assert.deepEqual(getApiSportsKeys(), []);
    setApiSportsEnv(undefined, 'singular-key-123456');
    assert.deepEqual(getApiSportsKeys(), ['singular-key-123456']);
    setApiSportsEnv('key-aaaaaaaaaaaa, key-bbbbbbbbbbbb ,key-aaaaaaaaaaaa', 'singular-key-123456');
    assert.deepEqual(getApiSportsKeys(), ['key-aaaaaaaaaaaa', 'key-bbbbbbbbbbbb']); // la plural tiene precedencia exclusiva: la singular se ignora
    setApiSportsEnv('corta, key-bbbbbbbbbbbb', undefined);
    assert.deepEqual(getApiSportsKeys(), ['key-bbbbbbbbbbbb']); // 'corta' se filtra por longitud
  } finally {
    restoreApiSportsEnv(prev);
  }
});

test('apiSports pool: la rotación alterna llaves y salta la marcada como no saludable', () => {
  const prev = setApiSportsEnv('key-aaaaaaaaaaaa,key-bbbbbbbbbbbb', undefined);
  try {
    resetApiSportsKeyHealth();
    assert.equal(getApiSportsKeyEntry().key, 'key-aaaaaaaaaaaa');
    assert.equal(getApiSportsKeyEntry().key, 'key-bbbbbbbbbbbb');
    assert.equal(getApiSportsKeyEntry().key, 'key-aaaaaaaaaaaa');
    markApiSportsKeyUnhealthy('key-aaaaaaaaaaaa', '429');
    assert.equal(getApiSportsPoolState().unhealthy, 1);
    assert.equal(getApiSportsPoolState().healthy, 1);
    assert.equal(getApiSportsKeyEntry().key, 'key-bbbbbbbbbbbb');
    assert.equal(getApiSportsKeyEntry().key, 'key-bbbbbbbbbbbb');
    markApiSportsKeyUnhealthy('key-bbbbbbbbbbbb', 'suspended');
    assert.equal(getApiSportsPoolState().healthy, 0);
    // Todas marcadas: no se rompe, usa una del pool y el llamador degrada como antes.
    assert.ok(['key-aaaaaaaaaaaa', 'key-bbbbbbbbbbbb'].includes(getApiSportsKeyEntry().key));
  } finally {
    restoreApiSportsEnv(prev);
  }
});

test('apiSports pool: un 429 marca la llave y el siguiente cliente usa la otra', async () => {
  const prev = setApiSportsEnv('key-aaaaaaaaaaaa,key-bbbbbbbbbbbb', undefined);
  try {
    resetApiSportsKeyHealth();
    const seen = [];
    let calls = 0;
    const fetch429thenOk = async (url, options) => {
      seen.push(options?.headers?.['x-apisports-key']);
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: { requests: { current: 10, limit_day: 100 } }, errors: {} }) };
    };
    const client1 = createTicketClient({ fetchImpl: fetch429thenOk, guardMinIntervalMs: 0 });
    await assert.rejects(client1.request('/status'), /429.*respaldo/);
    assert.equal(getApiSportsPoolState().unhealthy, 1);
    const client2 = createTicketClient({ fetchImpl: fetch429thenOk, guardMinIntervalMs: 0 });
    const status = await client2.request('/status');
    assert.equal(status.data.requests.current, 10);
    assert.equal(seen[0], 'key-aaaaaaaaaaaa');
    assert.equal(seen[1], 'key-bbbbbbbbbbbb');
  } finally {
    restoreApiSportsEnv(prev);
  }
});

test('apiSports pool: una suspensión marca la llave y el siguiente cliente usa la otra', async () => {
  const prev = setApiSportsEnv('key-aaaaaaaaaaaa,key-bbbbbbbbbbbb', undefined);
  try {
    resetApiSportsKeyHealth();
    const seen = [];
    const fetchSuspended = async (url, options) => {
      seen.push(options?.headers?.['x-apisports-key']);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ response: {}, errors: { access: 'Your account is suspended, check on https://dashboard.api-football.com.' } }) };
    };
    const client1 = createTicketClient({ fetchImpl: fetchSuspended, guardMinIntervalMs: 0 });
    await assert.rejects(client1.request('/status'), /suspendida/);
    assert.equal(getApiSportsPoolState().unhealthy, 1);
    const client2 = createTicketClient({ fetchImpl: fetchSuspended, guardMinIntervalMs: 0 });
    await assert.rejects(client2.request('/status'), /suspendida/);
    assert.equal(seen[0], 'key-aaaaaaaaaaaa');
    assert.equal(seen[1], 'key-bbbbbbbbbbbb');
  } finally {
    restoreApiSportsEnv(prev);
  }
});

test('apiSports pool: getApiSportsStatusAll reporta cada llave enmascarada con su saldo', async () => {
  const prev = setApiSportsEnv('key-aaaaaaaaaaaa,key-bbbbbbbbbbbb', undefined);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const key = options?.headers?.['x-apisports-key'];
    if (key === 'key-aaaaaaaaaaaa') {
      return { ok: true, status: 200, json: async () => ({ response: { account: { firstname: 'Gustavo', lastname: 'R' }, subscription: { plan: 'Free', active: true, end: '2027-01-01' }, requests: { current: 30, limit_day: 100 } }, errors: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ response: {}, errors: { access: 'Your account is suspended, check on https://dashboard.api-football.com.' } }) };
  };
  try {
    const all = await getApiSportsStatusAll();
    assert.equal(all.keys.length, 2);
    assert.equal(all.keys[0].key, '****aaaa');
    assert.equal(all.keys[1].key, '****bbbb');
    assert.equal(all.keys[0].remainingToday, 70);
    assert.equal(all.keys[0].suspended, false);
    assert.equal(all.keys[1].suspended, true);
    assert.equal(all.keys[1].success, false);
    assert.equal(all.poolSummary.totalKeys, 2);
    assert.equal(all.poolSummary.healthyKeys, 1);
    assert.equal(all.poolSummary.suspendedKeys, 1);
    assert.equal(all.poolSummary.totalCapacity, 200);
    assert.equal(all.poolSummary.totalUsed, 30);
    assert.equal(all.poolSummary.totalRemaining, 70);
    assert.equal(all.poolSummary.usagePercentage, '15.0%');
    // Ningún valor de llave aparece en el reporte.
    assert.ok(!JSON.stringify(all).includes('key-aaaaaaaaaaaa'));
    assert.ok(!JSON.stringify(all).includes('key-bbbbbbbbbbbb'));
  } finally {
    globalThis.fetch = originalFetch;
    restoreApiSportsEnv(prev);
  }
});
