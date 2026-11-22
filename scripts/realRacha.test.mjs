import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateHitRateAndMatchup, loadRecentLedgerResults, clearRecentResultsCache, buildTeamStreakLine, getSystemStreakLine, generateCheatsheetReport } from './alertEngine.js';
import { setLiveNbaRatings, clearLiveNbaRatings } from '../src/utils/hoops.js';
import { streakFromForm, fetchLiveNflStandings, fetchLiveNcaafStandings } from '../src/services/sportsApi.js';
import { parseNbaStandingsEntries, fetchNbaStandingsMap, clearNbaStandingsCache } from '../src/services/nbaService.js';

// La racha fabricada anterior (tabla fija por probabilidad) se eliminó
// 2026-11-17: ahora la racha es el récord real del ledger.

test('loadRecentLedgerResults: últimos 10 cerrados en orden cronológico, pick + hits', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'racha-'));
  try {
    const ledgerPath = path.join(tmpDir, 'pick_ledger.jsonl');
    const hitsPath = path.join(tmpDir, 'hits_ledger.jsonl');
    const ledger = [
      { id: 'a', gameDate: '2026-11-09', result: 'WON' },
      { id: 'b', gameDate: '2026-11-10', result: 'LOST' },
      { id: 'c', gameDate: '2026-11-11', result: 'PENDING' }, // no cuenta
      { id: 'd', gameDate: '2026-11-12', result: 'WON' },
    ];
    const hits = [
      { id: 'h1', gameDate: '2026-11-13', result: 'LOST' },
      { id: 'h2', gameDate: '2026-11-14', result: 'WON' },
    ];
    fs.writeFileSync(ledgerPath, ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(hitsPath, hits.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const res = loadRecentLedgerResults(10, { ledgerPath, hitsPath });
    assert.deepEqual(res, ['WON', 'LOST', 'WON', 'LOST', 'WON']);
    assert.deepEqual(loadRecentLedgerResults(3, { ledgerPath, hitsPath }), ['WON', 'LOST', 'WON']);
    assert.deepEqual(loadRecentLedgerResults(10, { ledgerPath: '/no/existe.jsonl', hitsPath: '/no/existe.jsonl' }), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('racha real: los últimos 10 del ledger+hits son 4W-6L, no 7/10', () => {
  clearRecentResultsCache();
  const res = loadRecentLedgerResults(10);
  // Últimos 10 por fecha de juego: 4 del ledger (12-13 nov, todos L) + 6 de
  // hits (16 nov, 4W-2L). Los puntos salen mezclados, como pidió Tavo.
  assert.deepEqual(res, ['LOST', 'LOST', 'LOST', 'LOST', 'WON', 'LOST', 'LOST', 'WON', 'WON', 'WON']);
  const hr = generateHitRateAndMatchup({ prob: '59.1%', sport: 'Baloncesto' }, res);
  // El pick de Lakers (prob 59.1%) antes mostraba "7/10 L10 (70%)" inventado.
  assert.equal(hr.hitRateStr, '4/10 L10 (40%)');
  assert.equal(hr.hitsL10, 4);
  assert.equal(hr.hitsL5, 3);
  assert.equal(hr.hitRateDots, '🔴🔴🟢🟢🟢');
});

test('los puntos salen en orden cronológico y pueden mezclarse', () => {
  const hr = generateHitRateAndMatchup(
    { prob: '80%', sport: 'Fútbol' },
    ['WON', 'LOST', 'WON', 'LOST', 'WON', 'WON', 'LOST', 'WON', 'LOST', 'WON'],
  );
  assert.equal(hr.hitRateStr, '6/10 L10 (60%)');
  assert.equal(hr.hitRateDots, '🟢🔴🟢🔴🟢');
  assert.equal(hr.hitRateSummary, 'El sistema acertó 3 de sus últimos 5 picks.');
});

test('sin datos reales no hay racha (fail-closed)', () => {
  const hr = generateHitRateAndMatchup({ prob: '90%', sport: 'Fútbol' }, []);
  assert.equal(hr.hitRateStr, null);
  assert.equal(hr.hitRateDots, '');
  assert.equal(hr.hitRateSummary, null);
});

// --- Matchup: NBA por DRtg en vivo ---
function liveRatingsFixture() {
  const teams = {};
  const names = [
    'boston celtics', 'oklahoma city thunder', 'denver nuggets', 'minnesota timberwolves',
    'dallas mavericks', 'new york knicks', 'milwaukee bucks', 'indiana pacers',
    'philadelphia 76ers', 'cleveland cavaliers', 'phoenix suns', 'miami heat',
    'los angeles clippers', 'golden state warriors', 'memphis grizzlies', 'sacramento kings',
    'new orleans pelicans', 'portland trail blazers', 'san antonio spurs', 'detroit pistons',
    'orlando magic', 'atlanta hawks', 'chicago bulls', 'toronto raptors',
    'brooklyn nets', 'utah jazz', 'washington wizards', 'los angeles lakers',
    'houston rockets', 'charlotte hornets',
  ];
  // DRtg 108..120: los 5 peores (mayor DRtg) son hornets 120, rockets 119,
  // lakers 118, wizards 117, jazz 116.
  names.forEach((name, i) => {
    const drtg = name === 'charlotte hornets' ? 120
      : name === 'houston rockets' ? 119
      : name === 'los angeles lakers' ? 118
      : name === 'washington wizards' ? 117
      : name === 'utah jazz' ? 116
      : 108 + (i % 8);
    teams[name] = { pace: 99, ortg: 114, drtg, games: 10, source: 'live' };
  });
  return teams;
}

function nbaPick({ id, home, away }) {
  return {
    id,
    sport: 'Baloncesto',
    league: 'NBA',
    type: '🏀 VENTAJA SPREAD (NBA)',
    pick: `${home} -7.5 (Cubre Línea)`,
    prob: '59.1%',
    match: { home: { name: home }, away: { name: away } },
  };
}

test('Matchup NBA: sello solo si el rival es Bottom 5 real por DRtg en vivo', () => {
  try {
    setLiveNbaRatings(liveRatingsFixture());
    const recent = ['WON', 'WON', 'LOST', 'WON', 'LOST'];
    // Lakers (local) vs Hornets (DRtg 120, peor defensa): sí hay sello.
    const withBadge = generateHitRateAndMatchup(
      nbaPick({ id: 'nba-spread-h-x', home: 'Los Angeles Lakers', away: 'Charlotte Hornets' }),
      recent,
    );
    assert.ok(withBadge.matchupBadge && withBadge.matchupBadge.includes('Bottom 5'));
    // Lakers vs Celtics (DRtg 108, buena defensa): no hay sello.
    const noBadge = generateHitRateAndMatchup(
      nbaPick({ id: 'nba-spread-h-y', home: 'Los Angeles Lakers', away: 'Boston Celtics' }),
      recent,
    );
    assert.equal(noBadge.matchupBadge, null);
  } finally {
    clearLiveNbaRatings();
  }
});

test('Matchup NBA: sin ratings en vivo no hay sello; UNDER nunca lleva sello', () => {
  clearLiveNbaRatings();
  const recent = ['WON', 'WON', 'LOST', 'WON', 'LOST'];
  const noLive = generateHitRateAndMatchup(
    nbaPick({ id: 'nba-spread-h-x', home: 'Los Angeles Lakers', away: 'Charlotte Hornets' }),
    recent,
  );
  assert.equal(noLive.matchupBadge, null);
  try {
    setLiveNbaRatings(liveRatingsFixture());
    const under = generateHitRateAndMatchup(
      { ...nbaPick({ id: 'nba-under-x', home: 'Los Angeles Lakers', away: 'Charlotte Hornets' }), type: '🏀 TOTALES NBA (UNDER)' },
      recent,
    );
    assert.equal(under.matchupBadge, null);
  } finally {
    clearLiveNbaRatings();
  }
});

test('Matchup fútbol: el sello ya no sale por ser OVER; solo por xG/Elo real', () => {
  const recent = ['WON', 'WON', 'LOST', 'WON', 'LOST'];
  const soccerPick = (match, type) => ({
    id: 'soc-over-x', sport: 'Fútbol', league: 'LaLiga', type, pick: 'OVER 2.5 Goles',
    prob: '60%', match,
  });
  // OVER sin dato real de defensa: sin sello (antes salía siempre).
  const noData = generateHitRateAndMatchup(
    soccerPick({ home: { defXg: 0, elo: 1500 }, away: { defXg: 0, elo: 1500 } }, 'OVER 2.5'),
    recent,
  );
  assert.equal(noData.matchupBadge, null);
  // OVER con rival que concede xG alto: sí hay sello.
  const withXg = generateHitRateAndMatchup(
    soccerPick({ home: { defXg: 1.6, elo: 1500 }, away: { defXg: 1.6, elo: 1500 } }, 'OVER 2.5'),
    recent,
  );
  assert.ok(withXg.matchupBadge && withXg.matchupBadge.includes('Bottom 5'));
});

test('Matchup MLB/NFL: sin dato real, no hay sello', () => {
  const recent = ['WON', 'WON', 'LOST', 'WON', 'LOST'];
  const mlb = generateHitRateAndMatchup(
    { id: 'mlb-x', sport: 'MLB', league: 'MLB', type: 'ML', pick: 'Yankees ML', prob: '60%', match: {} },
    recent,
  );
  assert.equal(mlb.matchupBadge, null);
  const nfl = generateHitRateAndMatchup(
    { id: 'nfl-x', sport: 'NFL', league: 'NFL', type: 'SPREAD', pick: 'Chiefs -3', prob: '60%', match: {} },
    recent,
  );
  assert.equal(nfl.matchupBadge, null);
});

// --- Racha REAL DEL EQUIPO (2026-11-22, Tavo): la tarjeta muestra la
// racha de los equipos del partido (ESPN standings), no la global del
// sistema. La del sistema queda una sola vez por turno (ver abajo).

test('racha del equipo: NFL con streak+record reales en ambos equipos', () => {
  const pick = {
    id: 'nfl-x', sport: 'NFL', league: 'NFL', type: 'SPREAD', pick: 'Bulls -3', prob: '60%',
    match: {
      home: { name: 'Denver Nuggets', streak: 'W3', record: '12-5' },
      away: { name: 'Chicago Bulls', streak: 'L2', record: '8-9' },
    },
  };
  assert.equal(buildTeamStreakLine(pick), 'Bulls L2 (8-9) · Nuggets W3 (12-5)');
  const hr = generateHitRateAndMatchup(pick, ['WON', 'LOST', 'WON']);
  assert.equal(hr.teamStreakStr, 'Bulls L2 (8-9) · Nuggets W3 (12-5)');
  // La racha del ledger sigue calculándose (para el encabezado del turno),
  // pero ya no es lo que se muestra en la tarjeta.
  assert.equal(hr.hitRateStr, '2/3 L3 (67%)');
});

test('racha del equipo: MLB con streak+record+lastTen; N/A no cuenta', () => {
  const withData = {
    id: 'mlb-x', sport: 'MLB', league: 'MLB', type: 'ML', pick: 'Yankees ML', prob: '60%',
    match: {
      home: { name: 'New York Yankees', streak: 'W3', record: '95-67', lastTen: '7-3' },
      away: { name: 'Boston Red Sox', streak: 'L2', record: '88-74', lastTen: '4-6' },
    },
  };
  assert.equal(buildTeamStreakLine(withData), 'Sox L2 (88-74, L10 4-6) · Yankees W3 (95-67, L10 7-3)');
  const na = {
    id: 'mlb-y', sport: 'MLB', league: 'MLB', type: 'ML', pick: 'Yankees ML', prob: '60%',
    match: {
      home: { name: 'New York Yankees', streak: 'N/A', record: '95-67', lastTen: 'N/A' },
      away: { name: 'Boston Red Sox', streak: 'N/A', record: '88-74', lastTen: 'N/A' },
    },
  };
  assert.equal(buildTeamStreakLine(na), null);
});

test('racha del equipo: fail-closed sin streak real en el pick', () => {
  // Sin campos de streak en el pick, no hay línea (el comportamiento de
  // buildTeamStreakLine no cambió: solo usa streak/record/lastTen reales).
  // Desde 2026-11-22 los constructores de NBA y fútbol SÍ adjuntan esos
  // campos (ver tests de constructores abajo); este test cubre el caso en
  // que el dato no existe (fail-closed), no la ausencia del constructor.
  const nba = {
    id: 'nba-x', sport: 'Baloncesto', league: 'NBA', type: 'SPREAD', pick: 'Lakers -7.5', prob: '59%',
    match: { home: { name: 'Los Angeles Lakers' }, away: { name: 'Charlotte Hornets' } },
  };
  assert.equal(buildTeamStreakLine(nba), null);
  // Fútbol: solo recentForm (con fallback fabricado) → NUNCA se usa.
  const soccer = {
    id: 'soc-x', sport: 'Fútbol', league: 'LaLiga', type: 'OVER 2.5', pick: 'OVER 2.5 Goles', prob: '60%',
    match: {
      home: { name: 'Real Madrid', recentForm: 'W W L W W', elo: 1700 },
      away: { name: 'FC Barcelona', recentForm: 'L W L L W', elo: 1680 },
    },
  };
  assert.equal(buildTeamStreakLine(soccer), null);
  // Solo un equipo con streak: se muestra solo ese.
  const oneSided = {
    id: 'nfl-y', sport: 'NFL', league: 'NFL', type: 'SPREAD', pick: 'Chiefs -3', prob: '60%',
    match: { home: { name: 'Kansas City Chiefs', streak: 'W5', record: '11-2' }, away: { name: 'Las Vegas Raiders' } },
  };
  assert.equal(buildTeamStreakLine(oneSided), 'Chiefs W5 (11-2)');
});

test('racha del sistema: una sola vez por turno, etiquetada; cheatsheet la lleva en el header', () => {
  clearRecentResultsCache();
  // Últimos 10 del ledger real del clon: 4W-6L (mismo dato del test de arriba).
  assert.equal(getSystemStreakLine(), '🔥 *Racha del sistema:* `4/10 L10 (40%)` 🔴🔴🟢🟢🟢');
  const cs = generateCheatsheetReport([
    {
      id: 'nfl-x', sport: 'NFL', league: 'NFL', type: 'SPREAD', game: 'Chicago Bulls vs Denver Nuggets',
      pick: 'Bulls -3', odds: '1.91', edgeStr: '+10.0 pp', prob: '60%',
      match: {
        home: { name: 'Denver Nuggets', streak: 'W3', record: '12-5' },
        away: { name: 'Chicago Bulls', streak: 'L2', record: '8-9' },
      },
    },
    {
      id: 'nba-x', sport: 'Baloncesto', league: 'NBA', type: 'SPREAD', game: 'Charlotte Hornets vs Los Angeles Lakers',
      pick: 'Lakers -7.5', odds: '1.85', edgeStr: '+4.4 pp', prob: '55.9%',
      match: { home: { name: 'Los Angeles Lakers' }, away: { name: 'Charlotte Hornets' } },
    },
  ], 'DOM 22 NOV');
  // Sistema una sola vez, en el header.
  assert.equal(cs.split('Racha del sistema').length - 1, 1);
  // La tarjeta NFL lleva la racha del equipo; la NBA no lleva línea de Racha.
  assert.ok(cs.includes('🔥 *Racha:* `Bulls L2 (8-9) · Nuggets W3 (12-5)`'));
  assert.equal(cs.split('🔥 *Racha:*').length - 1, 1);
  // La racha vieja del ledger ya no aparece en ninguna tarjeta.
  assert.ok(!/Racha:.*4\/10 L10/.test(cs));
});

// ---- Constructores de racha del equipo (2026-11-22) ----
// Fútbol y NBA ya adjuntan streak/record/lastTen reales desde ESPN.
// NFL/NCAAF ya no sintetizan 'W1'/'L1' sin stat de racha.

test('streakFromForm: corrida final del form real de ESPN; sin form no hay streak', () => {
  assert.equal(streakFromForm('WDWWW'), 'W3');
  assert.equal(streakFromForm('WDLWD'), 'D1');
  assert.equal(streakFromForm('WWDLW'), 'W1');
  assert.equal(streakFromForm('WWWWW'), 'W5');
  assert.equal(streakFromForm('LLLLL'), 'L5');
  assert.equal(streakFromForm('W D L W W'), 'W2'); // con espacios, igual
  assert.equal(streakFromForm('wdwww'), 'W3'); // minúsculas
  assert.equal(streakFromForm(undefined), undefined);
  assert.equal(streakFromForm(''), undefined);
  assert.equal(streakFromForm('-----'), undefined);
  // El fallback fabricado "WDLWD" NUNCA se pasa como form real: si ESPN no
  // trae form, el constructor deja streak ausente (esto se verifica en vivo,
  // no aquí: streakFromForm solo recibe lo que ESPN devuelve).
  assert.equal(streakFromForm(null), undefined);
});

test('racha del equipo: fútbol y NBA con streak real ahora muestran línea', () => {
  // Fútbol: streak derivado del form + récord de standings (sin lastTen).
  const soccer = {
    id: 'soc-y', sport: 'Fútbol', league: 'LaLiga', type: 'OVER 2.5', pick: 'OVER 2.5 Goles', prob: '60%',
    match: {
      home: { name: 'Real Madrid', streak: 'W3', record: '9-1-1' },
      away: { name: 'FC Barcelona', streak: 'L1', record: '7-1-3' },
    },
  };
  assert.equal(buildTeamStreakLine(soccer), 'Barcelona L1 (7-1-3) · Madrid W3 (9-1-1)');
  // NBA: streak + récord + L10 de standings.
  const nba = {
    id: 'nba-y', sport: 'Baloncesto', league: 'NBA', type: 'SPREAD', pick: 'Celtics -4.5', prob: '60%',
    match: {
      home: { name: 'Boston Celtics', streak: 'W2', record: '10-6', lastTen: '7-3' },
      away: { name: 'Detroit Pistons', streak: 'W5', record: '10-5', lastTen: '8-2' },
    },
  };
  assert.equal(buildTeamStreakLine(nba), 'Pistons W5 (10-5, L10 8-2) · Celtics W2 (10-6, L10 7-3)');
});

test('parseNbaStandingsEntries: extrae streak/record/L10 reales por id de equipo', () => {
  const json = {
    children: [{
      standings: {
        entries: [
          { team: { id: 2, displayName: 'Boston Celtics' }, stats: [
            { name: 'streak', displayValue: 'W2' },
            { name: 'overall', displayValue: '10-6' },
            { name: 'Last Ten Games', displayValue: '7-3' },
            { name: 'wins', displayValue: '10' },
          ] },
          { team: { id: 8, displayName: 'Detroit Pistons' }, stats: [
            { name: 'streak', displayValue: 'W5' },
            { name: 'overall', displayValue: '10-5' },
            { name: 'Last Ten Games', displayValue: '8-2' },
          ] },
          // Sin stats de racha: no entra al mapa (fail-closed).
          { team: { id: 99, displayName: 'Sin Datos FC' }, stats: [
            { name: 'wins', displayValue: '0' },
          ] },
          // Sin id: se ignora.
          { team: {}, stats: [{ name: 'streak', displayValue: 'W9' }] },
        ],
      },
    }],
  };
  assert.deepEqual(parseNbaStandingsEntries(json), {
    2: { streak: 'W2', record: '10-6', lastTen: '7-3' },
    8: { streak: 'W5', record: '10-5', lastTen: '8-2' },
  });
  assert.deepEqual(parseNbaStandingsEntries({}), {});
  assert.deepEqual(parseNbaStandingsEntries(null), {});
});

test('fetchNbaStandingsMap: usa el endpoint de standings de ESPN (mock)', async () => {
  clearNbaStandingsCache();
  const originalFetch = globalThis.fetch;
  const fixture = {
    children: [{ standings: { entries: [
      { team: { id: 2, displayName: 'Boston Celtics' }, stats: [
        { name: 'streak', displayValue: 'W2' },
        { name: 'overall', displayValue: '10-6' },
        { name: 'Last Ten Games', displayValue: '7-3' },
      ] },
    ] } }],
  };
  let observedUrl = '';
  globalThis.fetch = async (input) => {
    observedUrl = String(input);
    return Response.json(fixture);
  };
  try {
    const map = await fetchNbaStandingsMap();
    assert.equal(observedUrl, 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings');
    assert.deepEqual(map, { 2: { streak: 'W2', record: '10-6', lastTen: '7-3' } });
    // Segunda llamada usa caché (no vuelve a pedir).
    observedUrl = '';
    assert.deepEqual(await fetchNbaStandingsMap(), { 2: { streak: 'W2', record: '10-6', lastTen: '7-3' } });
    assert.equal(observedUrl, '');
  } finally {
    globalThis.fetch = originalFetch;
    clearNbaStandingsCache();
  }
});

test('fetchNbaStandingsMap: si ESPN falla, devuelve {} (fail-closed, sin romper)', async () => {
  clearNbaStandingsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('red caída'); };
  try {
    assert.deepEqual(await fetchNbaStandingsMap(), {});
  } finally {
    globalThis.fetch = originalFetch;
    clearNbaStandingsCache();
  }
});

// Fixture de standings NFL/NCAAF: un equipo CON stat de racha y otro SIN él.
// fetchLiveNflStandings exige >=28 equipos y fetchLiveNcaafStandings >=20
// para considerar la tabla completa, así que se rellena con 28 equipos extra.
function footballStandingsFixture() {
  const entry = (name, withStreak) => ({
    team: { id: 1, displayName: name },
    stats: [
      { name: 'pointsFor', displayValue: '250' },
      { name: 'pointsAgainst', displayValue: '200' },
      { name: 'wins', displayValue: '8' },
      { name: 'losses', displayValue: '3' },
      { name: 'ties', displayValue: '0' },
      ...(withStreak ? [{ name: 'streak', displayValue: 'W3' }] : []),
    ],
  });
  const entries = [entry('Con Racha', true), entry('Sin Racha', false)];
  for (let i = 0; i < 28; i++) entries.push(entry(`Relleno ${i}`, true));
  return { children: [{ standings: { entries } }] };
}

test('fetchLiveNflStandings: sin stat de racha queda \'\' (ya no sintetiza W1/L1)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(footballStandingsFixture());
  try {
    const map = await fetchLiveNflStandings();
    assert.equal(map['Con Racha'].streak, 'W3');
    assert.equal(map['Con Racha'].record, '8-3');
    // Sin stat de racha: '' (la tarjeta hace fail-closed), NO 'W1' inventado.
    assert.equal(map['Sin Racha'].streak, '');
    assert.equal(map['Sin Racha'].record, '8-3');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLiveNcaafStandings: sin stat de racha queda \'\' (ya no sintetiza W1/L1)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(footballStandingsFixture());
  try {
    const map = await fetchLiveNcaafStandings();
    assert.equal(map['Con Racha'].streak, 'W3');
    assert.equal(map['Sin Racha'].streak, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
