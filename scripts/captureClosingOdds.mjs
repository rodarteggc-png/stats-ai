// scripts/captureClosingOdds.mjs
// Captura de cuota de cierre con ESPN (DraftKings), GRATIS, sin llave ni cuota.
// Uso: node scripts/captureClosingOdds.mjs [--dry-run] [--window-mins 90] [--paper] [--test-event nba:401909966]
//
// Por qué existe: la auditoría pedía el cierre DESPUÉS del partido, y tanto
// ESPN como The Odds API solo lo dan ANTES del inicio (tras el final ESPN
// devuelve odds=null). Este script corre 10-15 min antes de cada partido,
// captura la línea actual de ESPN (su campo "close") y la guarda como cierre.
//
// Qué guarda por pick (en data/pick_ledger.jsonl y en data/closing_ledger.jsonl):
//   closingOdds / closingOddsNoVig / clvPct / beatClosingLine (vs DraftKings)
//   openOdds / openLine / closingLine + lineMovement (análisis Machina abierto)
//   closingSource='espn_draftkings', closingCapturedAt (ISO).
// Si la línea se movió a otro número (ej. total 228.5 -> 225.5), no hay cuota
// exacta para la línea del pick: se guarda el movimiento y CLV queda null,
// nunca inventado. BTTS y props no tienen mercado en ESPN: quedan null con motivo.
//
// No toca: despacho, 5 candados, Kelly, stakes, resultados ni P&L. Solo añade
// campos de cierre a picks PENDING cuyo partido aún no empezó.
// Requiere Node 18+ (fetch global). Sin dependencias.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLineMovement } from '../src/services/lineMovementService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, 'data', 'pick_ledger.jsonl');
const PAPER_LEDGER = path.join(ROOT, 'data', 'paper_ledger.jsonl');
const CLOSING_LEDGER = path.join(ROOT, 'data', 'closing_ledger.jsonl');
const PAPER_CLOSING_LEDGER = path.join(ROOT, 'data', 'paper_closing_ledger.jsonl');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const FETCH_TIMEOUT_MS = 8000;
const VIG_FALLBACK = 1.0476; // -110/-110 estándar, solo si no hay ambos lados para de-vig.

// ---------------------------------------------------------------------------
// Utilidades puras (exportadas para las pruebas)
// ---------------------------------------------------------------------------
export function normalizeName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function namesMatch(a, b) {
  const na = normalizeName(a); const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Nombres con sufijos (FC, SC, City...) o abreviaturas: basta con que uno
  // contenga al otro y compartan al menos 2 palabras significativas.
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  const common = wa.filter(w => wb.includes(w));
  return common.length >= 2;
}

export function americanToDecimal(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0) return Number((1 + n / 100).toFixed(3));
  return Number((1 + 100 / Math.abs(n)).toFixed(3));
}

export function parseLineNumber(s) {
  if (s === null || s === undefined) return null;
  const n = Number(String(s).replace(/[ou]/gi, '').trim());
  return Number.isFinite(n) ? n : null;
}

function impliedProb(decimal) {
  return decimal > 1 ? 1 / decimal : null;
}

// De-vig con los lados disponibles del mercado (Machina devig). Si solo hay
// un lado, se usa el vig estándar como supuesto explícito.
export function devigDecimal(closingDecimal, otherDecimals = []) {
  const probs = [impliedProb(closingDecimal), ...otherDecimals.map(impliedProb)]
    .filter(p => p !== null);
  if (probs.length < 2) {
    return { noVig: Number((closingDecimal / VIG_FALLBACK).toFixed(2)), vigFactor: VIG_FALLBACK, assumed: true };
  }
  const overround = probs.reduce((a, b) => a + b, 0);
  const fair = probs[0] / overround;
  return { noVig: Number((1 / fair).toFixed(2)), vigFactor: Number(overround.toFixed(4)), assumed: false };
}

export function clvPct(placed, closing) {
  if (!(placed > 1) || !(closing > 1)) return null;
  return Number((((placed / closing) - 1) * 100).toFixed(1));
}

// ---------------------------------------------------------------------------
// Mapeo liga del ledger -> ESPN (slug) + tipo de endpoint
// ---------------------------------------------------------------------------
const SOCCER_LEAGUES = [
  { match: ['premier'], espn: 'eng.1', name: 'Premier League' },
  { match: ['laliga', 'la liga'], espn: 'esp.1', name: 'LaLiga' },
  { match: ['serie a'], espn: 'ita.1', name: 'Serie A' },
  { match: ['bundesliga'], espn: 'ger.1', name: 'Bundesliga' },
  { match: ['ligue 1'], espn: 'fra.1', name: 'Ligue 1' },
  { match: ['eredivisie'], espn: 'ned.1', name: 'Eredivisie' },
  { match: ['liga portugal', 'primeira'], espn: 'por.1', name: 'Liga Portugal' },
  { match: ['championship'], espn: 'eng.2', name: 'Championship' },
  { match: ['champions league'], espn: 'uefa.champions', name: 'Champions League' },
  { match: ["women's champions", 'womens champions', 'uefa women'], espn: 'uefa.wchampions', name: "UEFA Women's Champions League" },
  { match: ['mls'], espn: 'usa.1', name: 'MLS' },
  { match: ['liga mx femenil'], espn: 'mex.w.1', name: 'Liga MX Femenil' },
  { match: ['liga mx'], espn: 'mex.1', name: 'Liga MX' },
];

export function espnLeagueFor(pick) {
  const sport = normalizeName(pick.sport || '');
  const league = normalizeName(pick.league || '');
  if (sport.includes('baloncesto') || league === 'nba') return { sport: 'basketball', league: 'nba', kind: 'us' };
  if (league.includes('nfl') || sport.includes('nfl')) return { sport: 'football', league: 'nfl', kind: 'us' };
  if (league.includes('ncaaf') || league.includes('colegial')) return { sport: 'football', league: 'college-football', kind: 'us' };
  if (sport.includes('mlb') || sport.includes('beisbol') || league.includes('major league baseball')) return { sport: 'baseball', league: 'mlb', kind: 'us' };
  if (sport.includes('futbol') || sport.includes('fútbol') || sport.includes('soccer')) {
    for (const l of SOCCER_LEAGUES) {
      if (l.match.some(m => league.includes(m))) return { sport: 'soccer', league: l.espn, kind: 'soccer', name: l.name };
    }
  }
  return null;
}

function yyyymmdd(d) {
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

// ---------------------------------------------------------------------------
// Cliente ESPN (inyectable para pruebas)
// ---------------------------------------------------------------------------
export async function espnJson(url, fetchFn = globalThis.fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Stats-AI Pro closing capture)' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function competitorsOf(comp) {
  const list = comp?.competitors || [];
  const home = list.find(c => c.homeAway === 'home')?.team;
  const away = list.find(c => c.homeAway === 'away')?.team;
  return { home, away };
}

export function findEvent(events, homeName, awayName, gameDateMs, toleranceMs = 30 * 60000) {
  for (const ev of events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const { home, away } = competitorsOf(comp);
    const hn = home?.displayName || home?.name || '';
    const an = away?.displayName || away?.name || '';
    const dateMs = Date.parse(ev.date || comp.date);
    if (!Number.isFinite(dateMs)) continue;
    if (Math.abs(dateMs - gameDateMs) > toleranceMs) continue;
    if (namesMatch(hn, homeName) && namesMatch(an, awayName)) return ev;
    if (namesMatch(hn, awayName) && namesMatch(an, homeName)) return ev; // orientación invertida
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extracción del cierre para el mercado del pick
// ---------------------------------------------------------------------------
function pickMarket(pick) {
  const p = String(pick.pick || '').toLowerCase();
  // Primero lo no cubierto: los props ("Más de 1.5 Tiros") contienen "más de"
  // y un número, y sin este orden se confundirían con un total.
  if (/doble|o empate| 1x| x2|ambos|btts|tiros|prop|f5|innings|corners|tarjetas|ponches/.test(p)) {
    return { market: 'unsupported', reason: 'BTTS/props/doble oportunidad no tienen mercado en ESPN' };
  }
  const total = p.match(/(?:over|under|más de|menos de)\s*(\d+(?:\.\d+)?)/);
  if (total) return { market: 'total', isOver: /over|más de/.test(p), line: Number(total[1]) };
  const spread = p.match(/(?:^|\s)([+-]\d+(?:\.\d+)?)(?:\s|$)/);
  if (spread && /(spread|hándicap|handicap|runline|cubre|\+1\.5|-1\.5|\+2\.5)/.test(p)) {
    return { market: 'spread', line: Number(spread[1]) };
  }
  if (/\bempate\b|\bdraw\b/.test(p)) return { market: 'moneyline', side: 'draw' };
  return { market: 'moneyline', side: null }; // equipo por nombre
}

function sideOfPick(pick, homeName, awayName) {
  const p = String(pick.pick || '').toLowerCase();
  if (namesMatch(p.split(/ [+-]?\d/)[0], homeName) || normalizeName(p).includes(normalizeName(homeName))) return 'home';
  if (namesMatch(p.split(/ [+-]?\d/)[0], awayName) || normalizeName(p).includes(normalizeName(awayName))) return 'away';
  // El texto del pick a veces trae solo el nombre del equipo al inicio.
  const first = normalizeName(p).split(' ').slice(0, 3).join(' ');
  if (namesMatch(first, homeName)) return 'home';
  if (namesMatch(first, awayName)) return 'away';
  return null;
}

export function extractClosing(pick, espnOdds, homeName, awayName) {
  if (!espnOdds || typeof espnOdds !== 'object') return { ok: false, reason: 'ESPN sin cuotas para este partido' };
  const mkt = pickMarket(pick);
  if (mkt.market === 'unsupported') return { ok: false, reason: mkt.reason };
  const placed = Number(pick.placedOdds || pick.odds);
  const lineMovement = analyzeLineMovement(espnOdds);
  const base = { source: 'espn_draftkings', lineMovement };

  if (mkt.market === 'total') {
    const side = mkt.isOver ? espnOdds.total?.over : espnOdds.total?.under;
    const other = mkt.isOver ? espnOdds.total?.under : espnOdds.total?.over;
    const closeLine = parseLineNumber(side?.close?.line);
    const openLine = parseLineNumber(side?.open?.line);
    if (closeLine === null) return { ok: false, reason: 'ESPN sin total de cierre', ...base };
    if (closeLine !== mkt.line) {
      return { ok: true, lineMoved: true, openLine, closingLine: closeLine, openOdds: americanToDecimal(side?.open?.odds), closingOdds: null, clvPct: null, reason: `Línea movida: pick ${mkt.isOver ? 'OVER' : 'UNDER'} ${mkt.line}, cierre ${closeLine}`, ...base };
    }
    const closing = americanToDecimal(side?.close?.odds);
    const open = americanToDecimal(side?.open?.odds);
    if (!closing) return { ok: false, reason: 'ESPN sin cuota de cierre para el total', ...base };
    const dv = devigDecimal(closing, [americanToDecimal(other?.close?.odds)].filter(Boolean));
    return { ok: true, lineMoved: false, openLine, closingLine: closeLine, openOdds: open, closingOdds: closing, closingOddsNoVig: dv.noVig, vigFactor: dv.vigFactor, clvPct: clvPct(placed, closing), ...base };
  }

  if (mkt.market === 'spread') {
    const side = sideOfPick(pick, homeName, awayName);
    if (!side) return { ok: false, reason: 'No se pudo identificar el lado del spread en el pick', ...base };
    const ps = espnOdds.pointSpread?.[side];
    const other = espnOdds.pointSpread?.[side === 'home' ? 'away' : 'home'];
    const closeLine = parseLineNumber(ps?.close?.line);
    const openLine = parseLineNumber(ps?.open?.line);
    if (closeLine === null) return { ok: false, reason: 'ESPN sin spread de cierre', ...base };
    if (closeLine !== mkt.line) {
      return { ok: true, lineMoved: true, openLine, closingLine: closeLine, openOdds: americanToDecimal(ps?.open?.odds), closingOdds: null, clvPct: null, reason: `Línea movida: pick spread ${mkt.line}, cierre ${closeLine}`, ...base };
    }
    const closing = americanToDecimal(ps?.close?.odds);
    const open = americanToDecimal(ps?.open?.odds);
    if (!closing) return { ok: false, reason: 'ESPN sin cuota de cierre para el spread', ...base };
    const dv = devigDecimal(closing, [americanToDecimal(other?.close?.odds)].filter(Boolean));
    return { ok: true, lineMoved: false, openLine, closingLine: closeLine, openOdds: open, closingOdds: closing, closingOddsNoVig: dv.noVig, vigFactor: dv.vigFactor, clvPct: clvPct(placed, closing), ...base };
  }

  // moneyline / 1X2
  const side = mkt.side || sideOfPick(pick, homeName, awayName);
  if (!side) return { ok: false, reason: 'No se pudo identificar el lado del moneyline en el pick', ...base };
  const ml = espnOdds.moneyline?.[side];
  const closing = americanToDecimal(ml?.close?.odds);
  const open = americanToDecimal(ml?.open?.odds);
  if (!closing) return { ok: false, reason: 'ESPN sin moneyline de cierre', ...base };
  const others = ['home', 'away', 'draw'].filter(s => s !== side)
    .map(s => americanToDecimal(espnOdds.moneyline?.[s]?.close?.odds)).filter(Boolean);
  const dv = devigDecimal(closing, others);
  return { ok: true, lineMoved: false, openLine: null, closingLine: null, openOdds: open, closingOdds: closing, closingOddsNoVig: dv.noVig, vigFactor: dv.vigFactor, clvPct: clvPct(placed, closing), ...base };
}

// ---------------------------------------------------------------------------
// Búsqueda del partido en ESPN + obtención de cuotas
// ---------------------------------------------------------------------------
export async function fetchEspnOdds(pick, fetchFn = globalThis.fetch, cache = new Map()) {
  const mapping = espnLeagueFor(pick);
  if (!mapping) return { ok: false, reason: `Liga sin mapeo ESPN: ${pick.league || pick.sport}` };
  const [homeName, awayName] = String(pick.game || '').split(' vs ').map(s => s.trim());
  if (!homeName || !awayName) return { ok: false, reason: `Formato de juego inesperado: ${pick.game}` };
  const gameDateMs = Date.parse(pick.gameDate);
  if (!Number.isFinite(gameDateMs)) return { ok: false, reason: `gameDate inválido: ${pick.gameDate}` };

  // Scoreboard del día UTC y del día anterior (los partidos de las 18:00 CST
  // son 00:00Z del día siguiente; ESPN los lista en la fecha ET anterior).
  const days = [...new Set([yyyymmdd(new Date(gameDateMs)), yyyymmdd(new Date(gameDateMs - 86400000))])];
  let events = [];
  for (const day of days) {
    const key = `${mapping.sport}/${mapping.league}/${day}`;
    if (!cache.has(key)) {
      const url = `${ESPN_BASE}/${mapping.sport}/${mapping.league}/scoreboard?dates=${day}&limit=100`;
      try { cache.set(key, (await espnJson(url, fetchFn)).events || []); }
      catch (e) { cache.set(key, []); }
    }
    events = events.concat(cache.get(key));
  }
  const ev = findEvent(events, homeName, awayName, gameDateMs);
  if (!ev) return { ok: false, reason: `Partido no encontrado en ESPN (${mapping.league}, ${String(pick.gameDate).slice(0, 10)})` };
  const state = ev.competitions?.[0]?.status?.type?.state;
  if (state && state !== 'pre') return { ok: false, reason: `Partido ya no está pre-juego (estado ${state}); ESPN ya no publica cuotas` };

  if (mapping.kind === 'soccer') {
    // El scoreboard de fútbol trae odds=[null]; el resumen por evento sí.
    const url = `${ESPN_BASE}/soccer/${mapping.league}/summary?event=${ev.id}`;
    try {
      const summary = await espnJson(url, fetchFn);
      const odds = (summary.odds || []).find(o => o && typeof o === 'object');
      if (!odds) return { ok: false, reason: 'Resumen ESPN sin cuotas para este partido' };
      return { ok: true, odds, event: ev };
    } catch (e) { return { ok: false, reason: `Resumen ESPN falló: ${e.message}` }; }
  }
  const oddsArr = ev.competitions?.[0]?.odds || [];
  const odds = oddsArr.find(o => o && typeof o === 'object');
  if (!odds) return { ok: false, reason: 'Scoreboard ESPN sin cuotas para este partido' };
  return { ok: true, odds, event: ev };
}

// ---------------------------------------------------------------------------
// Persistencia (nunca toca status/result/pnl)
// ---------------------------------------------------------------------------
function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function writeRows(file, rows) {
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

export function duePicks(rows, nowMs, windowMins) {
  const until = nowMs + windowMins * 60000;
  return rows.filter(r => r.status === 'PENDING' && Number.isFinite(Date.parse(r.gameDate))
    && Date.parse(r.gameDate) > nowMs && Date.parse(r.gameDate) <= until);
}

export async function captureForPick(pick, fetchFn = globalThis.fetch, cache = new Map()) {
  const [homeName, awayName] = String(pick.game || '').split(' vs ').map(s => s.trim());
  const fetched = await fetchEspnOdds(pick, fetchFn, cache);
  if (!fetched.ok) return { id: pick.id, ok: false, reason: fetched.reason };
  const ext = extractClosing(pick, fetched.odds, homeName, awayName);
  if (!ext.ok) return { id: pick.id, ok: false, reason: ext.reason };
  const capturedAt = new Date().toISOString();
  const record = {
    pickId: pick.id, capturedAt, source: 'espn_draftkings',
    game: pick.game, gameDate: pick.gameDate, pick: pick.pick,
    placedOdds: Number(pick.placedOdds || pick.odds),
    openOdds: ext.openOdds ?? null, openLine: ext.openLine ?? null,
    closingLine: ext.closingLine ?? null, closingOdds: ext.closingOdds ?? null,
    closingOddsNoVig: ext.closingOddsNoVig ?? null, vigFactor: ext.vigFactor ?? null,
    clvPct: ext.clvPct ?? null, beatClosingLine: ext.clvPct !== null ? ext.clvPct > 0 : null,
    lineMoved: Boolean(ext.lineMoved), reason: ext.reason || null,
    lineMovement: ext.lineMovement || null,
  };
  return { id: pick.id, ok: true, record };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { dryRun: false, paper: false, windowMins: 90, testEvent: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--paper') a.paper = true;
    else if (argv[i] === '--window-mins') a.windowMins = Number(argv[++i]) || 90;
    else if (argv[i] === '--test-event') a.testEvent = argv[++i];
  }
  return a;
}

async function testEvent(spec) {
  // --test-event nba:401909966 | soccer:eng.1:704000
  const [sport, league, eventId] = spec.split(':');
  if (sport === 'soccer') {
    const summary = await espnJson(`${ESPN_BASE}/soccer/${league}/summary?event=${eventId}`);
    console.log(JSON.stringify({ eventId, oddsKeys: Object.keys((summary.odds || [])[0] || {}) }, null, 2));
    const odds = (summary.odds || [])[0];
    console.log('moneyline:', JSON.stringify(odds?.moneyline));
    console.log('pointSpread home:', JSON.stringify(odds?.pointSpread?.home));
    console.log('total over:', JSON.stringify(odds?.total?.over));
    return;
  }
  const data = await espnJson(`${ESPN_BASE}/${sport}/${league}/scoreboard?dates=20261111&limit=100`);
  const ev = (data.events || []).find(e => String(e.id) === String(eventId));
  if (!ev) { console.log('Evento no encontrado en scoreboard 2026-11-11'); return; }
  const odds = ev.competitions?.[0]?.odds?.[0];
  console.log(ev.name, '|', ev.date);
  console.log('moneyline:', JSON.stringify(odds?.moneyline));
  console.log('pointSpread home:', JSON.stringify(odds?.pointSpread?.home));
  console.log('total over:', JSON.stringify(odds?.total?.over));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.testEvent) { await testEvent(args.testEvent); return; }

  const ledgerFile = args.paper ? PAPER_LEDGER : LEDGER;
  const closingFile = args.paper ? PAPER_CLOSING_LEDGER : CLOSING_LEDGER;
  if (!fs.existsSync(ledgerFile)) {
    console.log(`Sin ledger en ${ledgerFile}; nada que capturar.`);
    return;
  }
  const rows = readRows(ledgerFile);
  const now = Date.now();
  const due = duePicks(rows, now, args.windowMins);
  console.log(`Ledger: ${rows.length} picks, ${due.length} PENDING con inicio en los próximos ${args.windowMins} min (ahora ${new Date(now).toISOString()}).`);
  if (!due.length) return;

  const cache = new Map();
  const results = [];
  for (const pick of due) {
    const r = await captureForPick(pick, globalThis.fetch, cache);
    results.push(r);
    if (r.ok) {
      const rec = r.record;
      console.log(`✅ ${pick.id} | ${pick.game} | ${pick.pick} | abierto ${rec.openOdds ?? '-'} -> cierre ${rec.closingOdds ?? 'sin cuota exacta'} | CLV ${rec.clvPct !== null ? rec.clvPct + '%' : 'n/a'}${rec.lineMoved ? ' | LÍNEA MOVIDA' : ''}`);
    } else {
      console.log(`⚠️ ${pick.id} | ${pick.game} | ${r.reason}`);
    }
  }

  const captured = results.filter(r => r.ok);
  if (args.dryRun) { console.log(`DRY-RUN: ${captured.length} capturas, sin escribir nada.`); return; }
  if (!captured.length) return;

  // 1. Historial de cierres (append-only).
  const closingLines = captured.map(r => JSON.stringify(r.record)).join('\n') + '\n';
  fs.appendFileSync(closingFile, closingLines, 'utf-8');
  // 2. Ledger: solo campos de cierre; status/result/pnl intactos.
  const byId = new Map(captured.map(r => [r.id, r.record]));
  const updated = rows.map(row => {
    const rec = byId.get(row.id);
    if (!rec) return row;
    return {
      ...row,
      closingOdds: rec.closingOdds, closingOddsNoVig: rec.closingOddsNoVig,
      clvPct: rec.clvPct, beatClosingLine: rec.beatClosingLine,
      closingSource: rec.source, closingCapturedAt: rec.capturedAt,
      closingLine: rec.closingLine, openOdds: rec.openOdds,
      lineMovement: rec.lineMovement,
    };
  });
  writeRows(ledgerFile, updated);
  console.log(`Guardado: ${captured.length} cierre(s) en ${closingFile} y actualizados en ${ledgerFile}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Error en captureClosingOdds:', e.message); process.exitCode = 1; });
}
