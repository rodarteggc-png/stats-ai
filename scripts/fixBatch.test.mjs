// scripts/fixBatch.test.mjs — Lote de arreglos 2026-11-16 (C2, C3, C4, C5, P1–P4).
// Cada test apunta a un gate/veto nuevo. Los tests de userFlows.test.mjs que
// dependían del comportamiento viejo se actualizaron deliberadamente ahí
// (bases NBA con ratingsSource 'live'; motivos de veto NBA en /futuro).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyOpportunity,
  resolveOddsProvenance,
  kellyCapForPick,
  calculatePickEffectiveStake,
  cloudCacheToBankrollRows,
  readBankrollState,
  recordShiftExecution,
  notifyShiftFailure,
  runAlertEngine,
} from './alertEngine.js';
import { setLiveNbaRatings, clearLiveNbaRatings } from '../src/utils/hoops.js';
import { clearNbaRatingsCache } from '../src/services/nbaRatings.js';
import scanHandler from '../api/scan.js';
import { getVipScanWindow } from '../api/webhook.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------- helpers
function withEnv(patch, fn) {
  const prev = {};
  for (const k of Object.keys(patch)) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(patch)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
}

function withMockFetch(handler, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = prev; });
}

function snapshotFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
function restoreFile(file, content) {
  if (content === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
  else fs.writeFileSync(file, content);
}

const okJson = (body = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// ------------------------------------------------------- base de classify
function nflTotalBase(overrides = {}) {
  return {
    sport: 'NFL', league: 'NFL', game: 'Kansas City Chiefs vs Las Vegas Raiders',
    pick: 'OVER 44.5 Pts', type: '🏈 TOTALES NFL (OVER)', odds: 1.91, prob: '60',
    evPct: 5, match: { isPostponed: false }, oddsSource: 'market',
    consensus: { votesPassed: 3 }, tipsterAudit: { isApproved: true },
    ...overrides,
  };
}

function nbaTotalBase(overrides = {}) {
  return {
    sport: 'Baloncesto', league: 'NBA', game: 'Boston Celtics vs Washington Wizards',
    pick: 'UNDER 240.5 Pts', type: '🏀 TOTALES NBA (UNDER)', odds: 1.91, prob: '60',
    evPct: 5, match: { isPostponed: false }, oddsSource: 'market',
    consensus: { votesPassed: 3 }, tipsterAudit: { isApproved: true },
    ...overrides,
  };
}

// ------------------------------------------------- C3 + P4: procedencia
test('C3/P4: classifyOpportunity veta oddsSource model, assumed, proxy y derived', () => {
  assert.equal(classifyOpportunity(nflTotalBase()).vetoReason, null);
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'model' })).vetoReason, 'odds_model');
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'assumed' })).vetoReason, 'odds_assumed');
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'proxy' })).vetoReason, 'odds_proxy');
  assert.equal(classifyOpportunity(nflTotalBase({ oddsSource: 'derived' })).vetoReason, 'no_market_odds');
  // Sin procedencia (fail-closed): no se despacha.
  const noSource = nflTotalBase();
  delete noSource.oddsSource;
  assert.equal(classifyOpportunity(noSource).vetoReason, 'no_market_odds');
});

test('C3: resolveOddsProvenance ya no marca los player props como market', () => {
  const prop = {
    isProp: true, id: 'prop-soc-1', pick: 'Nikola Krstovic Más de 1.5 Tiros a Puerta',
    sport: 'Fútbol', league: 'Serie A', odds: 1.65,
  };
  resolveOddsProvenance(prop);
  assert.equal(prop.oddsSource, 'model');
  assert.equal(classifyOpportunity({ ...nflTotalBase(), isProp: true, oddsSource: prop.oddsSource }).vetoReason, 'odds_model');
});

// ------------------------------------------------------- P1: gate NBA
test('P1: sin ratingsSource live no se despacha ningún pick NBA', () => {
  // Fail-closed: campo ausente = estático.
  const noField = nbaTotalBase();
  delete noField.ratingsSource;
  assert.equal(classifyOpportunity(noField).vetoReason, 'nba_static_ratings');
  assert.equal(classifyOpportunity(nbaTotalBase({ ratingsSource: 'static' })).vetoReason, 'nba_static_ratings');
  assert.equal(classifyOpportunity(nbaTotalBase({ ratingsSource: 'live' })).vetoReason, null);
  // El gate solo aplica a NBA: un total NFL sin ratingsSource pasa.
  assert.equal(classifyOpportunity(nflTotalBase()).vetoReason, null);
});

// --------------------------------------------------- P2: marketOutlier
test('P2: marketOutlier true veta con market_outlier', () => {
  assert.equal(classifyOpportunity(nflTotalBase()).vetoReason, null);
  assert.equal(classifyOpportunity(nflTotalBase({ marketOutlier: true })).vetoReason, 'market_outlier');
});

// --------------------------------------------------- P3: EV + Kelly 0
test('P3a: Base de Confianza con EV negativo ya no salta el piso de EV', () => {
  // 70% @1.25 = EV -12.5%: antes pasaba por el bypass; ahora se veta.
  const base = nflTotalBase({
    type: '⭐ BASE DE CONFIANZA (FAVORITO SÓLIDO)',
    pick: 'Kansas City Chiefs ML', odds: 1.25, prob: '70', evPct: -12.5,
  });
  assert.equal(classifyOpportunity(base).vetoReason, 'ev_below_min');
  // La misma Base con EV positivo sigue aprobando.
  const okBase = nflTotalBase({
    type: '⭐ BASE DE CONFIANZA (FAVORITO SÓLIDO)',
    pick: 'Kansas City Chiefs ML', odds: 1.91, prob: '70', evPct: 33,
  });
  assert.equal(classifyOpportunity(okBase).vetoReason, null);
});

test('P3b: kellyCap 0 ya no da 0.5u fijas: veto kelly_zero y stake 0', () => {
  // Probabilidad 100% -> Kelly 0 (fórmula intacta; solo se quita el fallback).
  const opp = nflTotalBase({ prob: '100', odds: 1.91, evPct: 90 });
  assert.equal(kellyCapForPick(opp), 0);
  assert.equal(classifyOpportunity(opp).vetoReason, 'kelly_zero');
  // Caso exacto con multiplicador explícito: p=80% @2.00, fracción 0.10,
  // tope 2.0u -> Kelly fraccionado 6.0u sin tope (0.6 * 0.10 * 100), con
  // tope 2.0u; cap = 2.0 * 1 = 2.0.
  assert.equal(kellyCapForPick({ prob: '80', odds: 2.0, consensus: { votesPassed: 3 }, confidence: { kellyMultiplier: 1 } }), 2);
  // La base NFL (prob 60 @1.91, EV 5%, 3 votos) tiene cap 0.8 > 0 y aprueba.
  assert.equal(kellyCapForPick(nflTotalBase()), 0.8);
  const stake = calculatePickEffectiveStake({
    prob: '100', odds: 1.91, confidence: { kellyMultiplier: 0.5 },
    consensus: { votesPassed: 3, recommendedStake: '1.5 Unidades' },
  });
  assert.equal(stake.effectiveStake, 0);
  assert.match(stake.stakeLabel, /Kelly 0/);
});

// ------------------------------------------------------- C2: freno cloud
test('C2: cloudCacheToBankrollRows mapea auditados y excluye no despachados', () => {
  const now = Date.now();
  // El cloud guarda timestamps en ms de epoch (Number), no ISO.
  const cache = {
    _meta: { some: 'meta' },
    'win-1': { id: 'win-1', dispatchedToTelegram: true, status: 'won', netUnits: 0.9, audited: true, auditedAt: new Date(now - 86400000).toISOString(), timestamp: now - 86400000, stakeUnits: 1 },
    'loss-1': { id: 'loss-1', dispatchedToTelegram: true, status: 'lost', netUnits: -1.5, audited: true, auditedAt: new Date(now - 2 * 86400000).toISOString(), timestamp: now - 2 * 86400000, stakeUnits: 1.5 },
    'void-1': { id: 'void-1', dispatchedToTelegram: true, status: 'void', netUnits: 0, audited: true, auditedAt: new Date(now - 86400000).toISOString(), timestamp: now - 86400000 },
    'pending-1': { id: 'pending-1', dispatchedToTelegram: true, status: 'pending', netUnits: null, timestamp: now - 86400000, stakeUnits: 1 },
    'portal-1': { id: 'portal-1', dispatchedToTelegram: false, status: 'won', netUnits: 2, audited: true, auditedAt: new Date(now - 86400000).toISOString(), timestamp: now - 86400000 },
    'no-ts': { id: 'no-ts', dispatchedToTelegram: true, status: 'pending' },
  };
  const { closedRows, allRows } = cloudCacheToBankrollRows(cache);
  assert.equal(closedRows.length, 2);
  assert.deepEqual(closedRows.map(r => r.result).sort(), ['LOST', 'WON']);
  assert.equal(closedRows.find(r => r.id === 'win-1').pnlUnits, 0.9);
  assert.equal(closedRows.find(r => r.id === 'loss-1').pnlUnits, -1.5);
  // void no cierra (no entra en closedRows) pero sí está en allRows; el
  // drawdown lo ignora porque settledDrawdown solo cuenta result WON/LOST.
  // Portal (no despachado) y sin timestamp no entran en ningún lado.
  assert.equal(allRows.length, 4);
  assert.ok(allRows.every(r => ['win-1', 'loss-1', 'void-1', 'pending-1'].includes(r.id)));
});

test('C2: readBankrollState fusiona cloud+file y el cloud gana por id', async () => {
  const nowMs = Date.parse('2026-11-16T12:00:00Z');
  const fileRows = fs.readFileSync(path.join(DATA_DIR, 'pick_ledger.jsonl'), 'utf-8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const base = await withEnv({ TELEGRAM_BOT_TOKEN: undefined }, () =>
    readBankrollState({ nowMs, sentCache: {} }));
  assert.equal(base.source, 'cloud+file');
  assert.equal(base.unreliable, false);
  assert.equal(base.totalKnownPicks, fileRows.length);

  // Una pérdida auditada reciente SOLO en el cloud aumenta la ventana.
  const recentMs = nowMs - 86400000;
  const recent = new Date(recentMs).toISOString();
  const cloudLoss = { id: 'test-cloud-loss-1', dispatchedToTelegram: true, status: 'lost', netUnits: -2, audited: true, auditedAt: recent, timestamp: recentMs, stakeUnits: 2 };
  const merged = await withEnv({ TELEGRAM_BOT_TOKEN: undefined }, () =>
    readBankrollState({ nowMs, sentCache: { 'test-cloud-loss-1': cloudLoss } }));
  assert.equal(merged.settledInWindow, base.settledInWindow + 1);
  assert.equal(merged.totalKnownPicks, fileRows.length + 1);

  // Dedupe: el cloud con el mismo id de una fila del archivo la sustituye,
  // no la duplica.
  const firstId = fileRows[0].id;
  const dupe = { id: firstId, dispatchedToTelegram: true, status: 'won', netUnits: 5, audited: true, auditedAt: recent, timestamp: recentMs, stakeUnits: 1 };
  const deduped = await withEnv({ TELEGRAM_BOT_TOKEN: undefined }, () =>
    readBankrollState({ nowMs, sentCache: { [firstId]: dupe } }));
  assert.equal(deduped.totalKnownPicks, fileRows.length);
});

test('C2: fail-closed sin registro (con token) y solo aviso sin token', async () => {
  const ledgerFile = path.join(DATA_DIR, 'pick_ledger.jsonl');
  const resetFile = path.join(DATA_DIR, 'bankroll_reset.json');
  const ledgerBackup = snapshotFile(ledgerFile);
  const resetBackup = snapshotFile(resetFile);
  try {
    // Cloud vacío + token + archivo CON picks: NO bloquea (bloquear crearía
    // un punto muerto tras 8 días sin despachos, porque pruneCache vacía
    // el cloud), pero marca no fiable y deja el motivo en reasons.
    const warnOnly = await withEnv({ TELEGRAM_BOT_TOKEN: 'test-bot-token' }, () =>
      readBankrollState({ nowMs: Date.parse('2026-11-16T12:00:00Z'), sentCache: {} }));
    assert.equal(warnOnly.blocked, false);
    assert.equal(warnOnly.unreliable, true);
    assert.match(warnOnly.reasons.join(' '), /no fiable/);
    assert.match(warnOnly.reasons.join(' '), /ledger local/);

    if (fs.existsSync(ledgerFile)) fs.unlinkSync(ledgerFile);
    if (fs.existsSync(resetFile)) fs.unlinkSync(resetFile);
    const withToken = await withEnv({ TELEGRAM_BOT_TOKEN: 'test-bot-token' }, () =>
      readBankrollState({ nowMs: Date.parse('2026-11-16T12:00:00Z'), sentCache: {} }));
    assert.equal(withToken.blocked, true);
    assert.equal(withToken.unreliable, true);
    assert.equal(withToken.source, 'cloud+file');
    assert.match(withToken.reasons.join(' '), /no fiable/);
    const localOnly = await withEnv({ TELEGRAM_BOT_TOKEN: undefined }, () =>
      readBankrollState({ nowMs: Date.parse('2026-11-16T12:00:00Z'), sentCache: {} }));
    assert.equal(localOnly.blocked, false);
    assert.equal(localOnly.unreliable, true);
  } finally {
    restoreFile(ledgerFile, ledgerBackup);
    restoreFile(resetFile, resetBackup);
  }
});

// ------------------------------------------------------- C5: alertado
test('C5: api/scan responde 503 (no 200) cuando faltan variables de entorno', async () => {
  await withEnv({
    CRON_SECRET: undefined, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined,
    TELEGRAM_VIP_CHAT_ID: undefined, TELEGRAM_LEDGER_CHAT_ID: undefined,
  }, async () => {
    const req = { method: 'GET', query: {}, headers: {} };
    const res = {
      statusCode: null, body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await scanHandler(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.match(res.body.warning, /Faltan configurar/);
  });
});

test('C5: recordShiftExecution escribe una línea JSON; notifyShiftFailure avisa al VIP', async () => {
  const tmpLog = path.join(os.tmpdir(), `shift-log-${Date.now()}.jsonl`);
  try {
    assert.equal(recordShiftExecution({ outcome: 'test', reason: 'unit' }, { logPath: tmpLog }), true);
    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, 'test');
    assert.ok(lines[0].timestamp);
    // Ruta de fallo: directorio inexistente -> false, sin excepción.
    assert.equal(recordShiftExecution({ outcome: 'test' }, { logPath: path.join(os.tmpdir(), 'no-existe', 'x.jsonl') }), false);

    const calls = [];
    await withEnv({ TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_VIP_CHAT_ID: 'vip-test-chat' }, () =>
      withMockFetch(async (url, opts) => {
        calls.push({ url: String(url), body: JSON.parse(opts.body) });
        return okJson({ ok: true, result: {} });
      }, () => notifyShiftFailure({ reason: 'test_reason', detail: 'detalle de prueba' })));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.chat_id, 'vip-test-chat');
    assert.match(calls[0].body.text, /TURNO FALLIDO/);
    assert.match(calls[0].body.text, /test_reason/);
  } finally {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  }
});

test('C5: turno con candado activo se registra, avisa al VIP y no despacha', async () => {
  // El caché vive en scripts/.sent_alerts.json (cacheDir = __dirname), no en data/.
  const cacheFile = path.join(ROOT, 'scripts', '.sent_alerts.json');
  const shiftLog = path.join(DATA_DIR, 'shift_log.jsonl');
  const cacheBackup = snapshotFile(cacheFile);
  const logBackup = snapshotFile(shiftLog);
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      _meta: { scanLock: { expiresAt: Date.now() + 60000, startedAt: new Date().toISOString() } },
    }));
    const calls = [];
    const result = await withEnv({ TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_VIP_CHAT_ID: 'vip-test-chat' }, () =>
      withMockFetch(async (url, opts) => {
        calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
        return okJson({ ok: true, result: {} });
      }, () => runAlertEngine({})));
    assert.equal(result.skipped, 'locked');
    assert.equal(result.sentCount, 0);
    const vipAlert = calls.find(c => c.body?.chat_id === 'vip-test-chat' && /TURNO FALLIDO/.test(c.body.text || ''));
    assert.ok(vipAlert, 'el VIP debe recibir el aviso de turno fallido');
    assert.match(vipAlert.body.text, /locked/);
    const logLines = fs.readFileSync(shiftLog, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(logLines.some(l => l.outcome === 'skipped' && l.reason === 'locked'));
  } finally {
    restoreFile(cacheFile, cacheBackup);
    restoreFile(shiftLog, logBackup);
  }
});

// ------------------------------------------------------- C4: dry-run
function nbaScoreboardMock(gameDate) {
  return {
    events: [{
      id: 'nba-test-1', date: gameDate,
      status: { type: { state: 'pre' } },
      competitions: [{
        competitors: [
          { homeAway: 'home', team: { id: 1, displayName: 'Boston Celtics' }, score: null },
          { homeAway: 'away', team: { id: 2, displayName: 'Washington Wizards' }, score: null },
        ],
        odds: [{ spread: -18.5, overUnder: 222, homeTeamOdds: { moneyLine: -105 }, awayTeamOdds: { moneyLine: 115 } }],
      }],
    }],
  };
}

async function runNbaDryRun({ withAi, gameDate = new Date(Date.now() + 2 * 3600000).toISOString(), scanWindow = { maxHoursAhead: 48 } }) {
  const calls = [];
  const handler = async (input, opts) => {
    const url = String(input);
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url.includes('generativelanguage.googleapis.com')) {
      return okJson({ candidates: [{ content: { parts: [{ text: '🧠 *DICTAMEN DEL ANALISTA IA — STATS-AI PRO*\nReporte de prueba.' }] } }] });
    }
    if (url.includes('site.api.espn.com') && url.includes('scoreboard')) return okJson(nbaScoreboardMock(gameDate));
    if (url.includes('site.api.espn.com')) return new Response('error', { status: 500 });
    if (url.includes('api.telegram.org')) return okJson({ ok: true, result: {} });
    return okJson({});
  };
  const ledgerFile = path.join(DATA_DIR, 'pick_ledger.jsonl');
  const cacheFile = path.join(ROOT, 'scripts', '.sent_alerts.json');
  const shiftLog = path.join(DATA_DIR, 'shift_log.jsonl');
  const ledgerBefore = snapshotFile(ledgerFile);
  const cacheBackup = snapshotFile(cacheFile);
  const logBackup = snapshotFile(shiftLog);
  try {
    setLiveNbaRatings({
      // Favorito claro (margen proyectado +22.3, cruda ML 93.5% → cal 58.9%
      // con el par NBA Fase 3, R3): el ML local pasa los gates y el dry-run
      // tiene algo que "enviar". Con los ratings viejos (114/112 vs 110/113)
      // la cruda era ~70.7% y el refit la dejaba en cal ~43% (EV negativo).
      'boston celtics': { pace: 99, ortg: 119, drtg: 109, games: 10, source: 'live' },
      'washington wizards': { pace: 101, ortg: 107, drtg: 117, games: 10, source: 'live' },
    });
    clearNbaRatingsCache();
    const envPatch = {
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_LEDGER_CHAT_ID: 'test-ledger-chat',
      TELEGRAM_VIP_CHAT_ID: 'vip-test-chat',
      GEMINI_API_KEY: withAi ? 'test-gemini-key' : undefined,
    };
    const result = await withEnv(envPatch, () =>
      withMockFetch(handler, () =>
        runAlertEngine({ force: true, vip: true, sport: 'nba', skipAudit: true, dryRun: true, ...scanWindow })));
    return { result, calls, ledgerBefore, ledgerFile };
  } finally {
    clearLiveNbaRatings();
    restoreFile(cacheFile, cacheBackup);
    restoreFile(shiftLog, logBackup);
  }
}

test('solo el VIP privado usa 12 horas sin ampliar el turno matutino', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T18:48:00Z') });
  assert.deepEqual(getVipScanWindow(false), {});
  const gameDate = '2026-11-19T00:00:00Z';
  const scheduled = await runNbaDryRun({ withAi: false, gameDate, scanWindow: { shift: 'matutino' } });
  assert.equal(scheduled.result.sentCount, 0);
  const manual = await runNbaDryRun({ withAi: false, gameDate, scanWindow: getVipScanWindow(true) });
  assert.equal(manual.result.sentCount, 1);
  assert.equal(Date.parse(manual.result.toSend[0].gameDate), Date.parse(gameDate));
  context.mock.timers.setTime(Date.parse('2026-11-18T19:04:00Z'));
  const tooLate = await runNbaDryRun({ withAi: false, gameDate: '2026-11-19T07:05:00Z', scanWindow: getVipScanWindow(true) });
  assert.equal(tooLate.result.sentCount, 0);
});

test('C4: dry-run clásico no registra en el ledger ni espeja LEDGER al canal', async () => {
  const { result, calls, ledgerBefore, ledgerFile } = await runNbaDryRun({ withAi: false });
  // El único pick que pasa todos los gates es el ML local (ratings live,
  // EV +12.5%, gap mercado 6.5pp < 12pp, 2/3 votos). En dry-run se "envía".
  // Lote 2: su precio es ESPN/DraftKings, así que el tier es 'espn' (no
  // 'market'); P4 variante B lo admite como segundo nivel.
  assert.equal(result.sentCount, 1);
  assert.equal(result.toSend.length, 1);
  assert.match(result.toSend[0].id, /^nba-ml-h-/);
  assert.equal(result.toSend[0].ratingsSource, 'live');
  assert.equal(result.toSend[0].oddsSource, 'espn');
  // El mock usa el formato plano sin provider; parseEspnNbaOdds usa el
  // default 'DraftKings' (en vivo ESPN siempre trae provider Draft Kings).
  assert.equal(result.toSend[0].oddsProvider, 'DraftKings');
  // E3: el EV del pick ESPN se mide contra la cuota justa sin vig.
  // Mock ML -105/+115 (1.95/2.15): removeVig → home sin vig 52.44% →
  // fairOdds 1.91. (El mock es underround —1.95/2.15 suman 0.978— así que la
  // cuota justa queda POR DEBAJO del precio retail; en vivo DK siempre es
  // overround y fairOdds > odds.)
  assert.equal(result.toSend[0].evNoVig, true);
  assert.equal(result.toSend[0].fairOdds, 1.91);
  // El ledger en disco no cambia...
  assert.deepEqual(snapshotFile(ledgerFile), ledgerBefore);
  // ...y ningún fetch a Telegram lleva un espejo LEDGER.
  const ledgerMirrors = calls.filter(c => /LEDGER /.test(c.body?.text || ''));
  assert.equal(ledgerMirrors.length, 0);
});

test('C4: dry-run con ruta IA tampoco registra ni espeja LEDGER', async () => {
  const { result, calls, ledgerBefore, ledgerFile } = await runNbaDryRun({ withAi: true });
  assert.equal(result.sentCount, 1);
  assert.equal(result.toSend.length, 1);
  assert.deepEqual(snapshotFile(ledgerFile), ledgerBefore);
  const ledgerMirrors = calls.filter(c => /LEDGER /.test(c.body?.text || ''));
  assert.equal(ledgerMirrors.length, 0);
});
