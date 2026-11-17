import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateHitRateAndMatchup, loadRecentLedgerResults, clearRecentResultsCache } from './alertEngine.js';
import { setLiveNbaRatings, clearLiveNbaRatings } from '../src/utils/hoops.js';

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
