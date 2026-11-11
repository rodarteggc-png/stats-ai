#!/usr/bin/env node
// scripts/gradeLedger.mjs
// CALIFICACIÓN AUDITADA DEL PICK LEDGER CON RESULTADOS REALES (ESPN, sin llave).
//
// Mejora 1 del plan 2026-11-10: cerrar los picks PENDING del ledger con el
// marcador final real, sin inventar resultados y sin tocar la matemática ni
// los 5 candados. Respeta las reglas del repo:
//  - Los Player Props NUNCA se califican contra el marcador del partido
//    (necesitan boxscore por jugador; quedan PENDING con motivo).
//  - Sin cuota de cierre capturada, closingOdds y clvPct quedan en null
//    (nunca se copia la cuota publicada ni se inventa un CLV 0; ver
//    auditoría 2026-11-02 en AGENTS.md).
//  - Cada cierre queda registrado en data/pick_ledger_closures.jsonl como
//    rastro forense (pick, marcador, fuente, fecha).
//
// Uso:
//   node scripts/gradeLedger.mjs               (dry-run: solo muestra qué cerraría)
//   node scripts/gradeLedger.mjs --apply       (escribe los cierres)
//   node scripts/gradeLedger.mjs --id <id>     (solo ese pick)
//   node scripts/gradeLedger.mjs --limit 5     (máximo N picks)
//
// Fuentes de resultados (gratuitas, sin llave, ya usadas por el proyecto):
//   ESPN Scoreboard: NBA, NCAAF (groups=80), MLB y fútbol (usa.1, uefa.champions,
//   uefa.wchampions, esp.1, ita.1, fra.1). Una consulta por (deporte, liga, fecha).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEDGER_PATH = path.join(__dirname, '..', 'data', 'pick_ledger.jsonl');
const CLOSURES_PATH = path.join(__dirname, '..', 'data', 'pick_ledger_closures.jsonl');

// ---------------------------------------------------------------------------
// Normalización y emparejamiento de equipos (mismo criterio que history.js)
// ---------------------------------------------------------------------------
export function normalizeTeamName(str) {
  if (!str) return '';
  return String(str)
    .replace(/^#\d+\s+/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamTokens(name) {
  return normalizeTeamName(name).split(' ').filter(Boolean);
}

// Puntuación de emparejamiento entre dos nombres de equipo: 2 = idénticos,
// 1 = un nombre está contenido en el otro (ej. "Servette" en "Servette FC"),
// 0 = sin coincidencia. Para un partido se exige que AMBOS equipos sumen
// al menos 2 puntos en total y que ninguno sea 0 salvo que el otro sea exacto.
export function teamMatchScore(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 2;
  if (na.includes(nb) || nb.includes(na)) return 1;
  const ta = new Set(teamTokens(a));
  const tb = new Set(teamTokens(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= 1 ? 1 : 0;
}

export function isTeamMatch(a, b) {
  return teamMatchScore(a, b) >= 1;
}

// ---------------------------------------------------------------------------
// Interpretación del mercado del pick (texto libre en español)
// ---------------------------------------------------------------------------
const PROP_KEYWORDS = ['tiros a puerta', 'remate', 'remates', 'tiros', 'goles de', 'asistencia',
  'tarjeta', 'córner', 'corner', 'esquina', 'rebotes', 'asistencias', 'puntos de',
  'yardas', 'touchdown', 'pases de', 'recepciones', 'ponches', 'bases', 'strikeout'];

export function parsePickMarket(pick, type = '') {
  const raw = String(pick || '');
  const text = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if ((type || '').toLowerCase().includes('prop') || PROP_KEYWORDS.some(k => text.includes(k))) {
    return { kind: 'prop', reason: 'Player/stat prop: requiere boxscore por jugador, no se califica con el marcador.' };
  }
  if (text.includes('ambos equipos anotan') || text.includes('btts')) {
    const no = text.includes(': no') || text.includes(' no (') || /\bno\b.*btts/.test(text);
    return { kind: 'btts', value: no ? 'no' : 'yes' };
  }
  const dc = raw.match(/^(.*?)\s+o\s+empate\s*\((1x|x2|12)\)/i);
  if (dc) {
    return { kind: 'doubleChance', team: dc[1].trim(), side: dc[2].toUpperCase() };
  }
  const total = text.match(/(over|under)\s+(\d+(?:\.\d+)?)/);
  if (total) {
    return { kind: 'total', side: total[1], line: Number(total[2]) };
  }
  const spread = raw.match(/^(.*?)\s*([+-]\d+(?:\.\d+)?)\b/);
  if (spread && /(cubre linea|handicap|runline|carreras)/.test(text)) {
    return { kind: 'spread', team: spread[1].trim(), line: Number(spread[2]) };
  }
  const ml = raw.match(/^victoria\s+(.+)$/i) || raw.match(/^(.+?)\s+(moneyline|ml)\b/i);
  if (ml) return { kind: 'moneyline', team: ml[1].trim() };
  return { kind: 'unknown', reason: `Mercado no reconocido en: "${raw}"` };
}

// ---------------------------------------------------------------------------
// Calificación pura (sin red): devuelve 'WON' | 'LOST' | 'PUSH' | null
// ---------------------------------------------------------------------------
export function gradePick(market, homeName, awayName, homeScore, awayScore) {
  if (!market || market.kind === 'prop' || market.kind === 'unknown') return null;
  const hs = Number(homeScore);
  const as = Number(awayScore);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  const teamScore = (team) => {
    if (isTeamMatch(team, homeName)) return hs;
    if (isTeamMatch(team, awayName)) return as;
    return null;
  };
  switch (market.kind) {
    case 'btts': {
      const both = hs > 0 && as > 0;
      return market.value === 'yes' ? (both ? 'WON' : 'LOST') : (both ? 'LOST' : 'WON');
    }
    case 'total': {
      const total = hs + as;
      if (total === market.line) return 'PUSH';
      return market.side === 'over' ? (total > market.line ? 'WON' : 'LOST') : (total < market.line ? 'WON' : 'LOST');
    }
    case 'spread': {
      const mine = teamScore(market.team);
      if (mine === null) return null;
      const opp = isTeamMatch(market.team, homeName) ? as : hs;
      const adjusted = mine + market.line;
      if (adjusted === opp) return 'PUSH';
      return adjusted > opp ? 'WON' : 'LOST';
    }
    case 'doubleChance': {
      if (market.side === '1X') return hs >= as ? 'WON' : 'LOST';
      if (market.side === 'X2') return as >= hs ? 'WON' : 'LOST';
      return hs !== as ? 'WON' : 'LOST';
    }
    case 'moneyline': {
      const mine = teamScore(market.team);
      if (mine === null) return null;
      const opp = isTeamMatch(market.team, homeName) ? as : hs;
      if (mine === opp) return 'PUSH';
      return mine > opp ? 'WON' : 'LOST';
    }
    default:
      return null;
  }
}

export function computePnl(result, placedOdds, stake) {
  const odds = Number(placedOdds);
  const st = Number(stake) || 1.0;
  if (result === 'WON') return Number(((odds - 1) * st).toFixed(2));
  if (result === 'LOST') return -st;
  return 0;
}

// ---------------------------------------------------------------------------
// Resultados reales vía ESPN Scoreboard (gratis, sin llave)
// ---------------------------------------------------------------------------
const SOCCER_LEAGUE_SLUGS = {
  'MLS (EE.UU.)': 'usa.1',
  'Champions League': 'uefa.champions',
  "UEFA Women's Champions League": 'uefa.wchampions',
  'LaLiga': 'esp.1',
  'Serie A': 'ita.1',
  'Ligue 1 (Francia)': 'fra.1',
};

function espnEndpointsFor(pick) {
  // ESPN agrupa por fecha local de EE. UU.: un partido de las 19:00 CDT
  // queda en la fecha UTC del día siguiente. Se consultan el día del
  // partido y el anterior y se fusionan los eventos.
  const raw = String(pick.gameDate || '').slice(0, 10);
  if (!raw) return [];
  const day = new Date(`${raw}T12:00:00Z`);
  const prev = new Date(day.getTime() - 86400000).toISOString().slice(0, 10).replaceAll('-', '');
  const dates = [...new Set([raw.replaceAll('-', ''), prev])];
  const build = (path) => dates.map(d => ({
    key: `${path}|${d}`,
    url: `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}${path === 'football/college-football' ? '&groups=80' : ''}`,
  }));
  switch (pick.sport) {
    case 'Baloncesto': return build('basketball/nba');
    case 'NCAAF': return build('football/college-football');
    case 'MLB': return build('baseball/mlb');
    case 'Fútbol': {
      const slug = SOCCER_LEAGUE_SLUGS[pick.league];
      if (!slug) return [];
      return build(`soccer/${slug}`);
    }
    default: return [];
  }
}

function parseEspnEvents(data) {
  const games = [];
  for (const ev of data?.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp || comp.status?.type?.state !== 'post') continue;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const hs = Number(home.score);
    const as = Number(away.score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    games.push({
      home: home.team?.displayName || '',
      away: away.team?.displayName || '',
      homeScore: hs,
      awayScore: as,
      score: `${hs}-${as}`,
    });
  }
  return games;
}

export function findGame(games, homeName, awayName) {
  let best = null;
  let bestScore = 0;
  for (const g of games) {
    const direct = teamMatchScore(homeName, g.home) + teamMatchScore(awayName, g.away);
    const swapped = teamMatchScore(homeName, g.away) + teamMatchScore(awayName, g.home);
    const score = Math.max(direct, swapped);
    // Exige ambos equipos reconocidos (al menos un token compartido cada uno)
    // y al menos 2 puntos en total: un exacto (2) o dos contenidos (1+1).
    // El mejor puntaje gana, así que si el partido real está en la lista,
    // un parecido (ej. Real Sociedad vs Real Madrid) nunca lo desplaza.
    const minSide = Math.min(
      Math.max(teamMatchScore(homeName, g.home), teamMatchScore(homeName, g.away)),
      Math.max(teamMatchScore(awayName, g.home), teamMatchScore(awayName, g.away)),
    );
    if (score >= 2 && minSide >= 1 && score > bestScore) {
      best = { ...g, swapped: swapped > direct };
      bestScore = score;
    }
  }
  return best;
}

function splitGame(game) {
  const parts = String(game || '').split(/\s+vs\s+/i);
  if (parts.length !== 2) return { home: '', away: '' };
  return { home: parts[0].trim(), away: parts[1].trim() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function gradePendingPicks({ fetchImpl = fetch, apply = false, onlyId = null, limit = Infinity, ledgerPath = LEDGER_PATH, closuresPath = null } = {}) {
  // closuresPath separado para el ledger paper (gradePaper): las clausuras
  // paper nunca deben mezclarse con pick_ledger_closures.jsonl del récord real.
  const closuresFile = closuresPath || path.join(path.dirname(ledgerPath), 'pick_ledger_closures.jsonl');
  if (!fs.existsSync(ledgerPath)) return { graded: [], skipped: [], error: 'Ledger no encontrado.' };
  const picks = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const pending = picks.filter(p => p.status === 'PENDING' && (!onlyId || p.id === onlyId)).slice(0, limit);
  const cache = new Map();
  const graded = [];
  const skipped = [];
  for (const pick of pending) {
    const market = parsePickMarket(pick.pick, pick.type);
    if (market.kind === 'prop' || market.kind === 'unknown') {
      skipped.push({ id: pick.id, reason: market.reason || 'Mercado no calificable.' });
      continue;
    }
    const endpoints = espnEndpointsFor(pick);
    if (!endpoints.length) {
      skipped.push({ id: pick.id, reason: `Sin fuente de resultados para ${pick.sport} / ${pick.league}.` });
      continue;
    }
    const games = [];
    let fetchError = null;
    for (const endpoint of endpoints) {
      if (!cache.has(endpoint.key)) {
        try {
          const res = await fetchImpl(endpoint.url, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
          cache.set(endpoint.key, parseEspnEvents(await res.json()));
        } catch (e) {
          cache.set(endpoint.key, { __error: e.message });
        }
        await sleep(300);
      }
      const cached = cache.get(endpoint.key);
      if (cached?.__error) fetchError = cached.__error;
      else games.push(...cached);
    }
    if (fetchError && !games.length) {
      skipped.push({ id: pick.id, reason: `Fuente de resultados falló: ${fetchError}` });
      continue;
    }
    const { home, away } = splitGame(pick.game);
    const game = findGame(games, home, away);
    if (!game) {
      skipped.push({ id: pick.id, reason: `Partido no encontrado en ESPN (${pick.league}, ${String(pick.gameDate).slice(0, 10)}).` });
      continue;
    }
    const homeScore = game.swapped ? game.awayScore : game.homeScore;
    const awayScore = game.swapped ? game.homeScore : game.awayScore;
    const result = gradePick(market, home, away, homeScore, awayScore);
    if (!result) {
      skipped.push({ id: pick.id, reason: 'No se pudo calificar con el marcador encontrado.' });
      continue;
    }
    graded.push({
      id: pick.id, pick, market, game,
      result,
      score: game.score,
      pnlUnits: computePnl(result, pick.placedOdds, pick.stakeUnits),
    });
  }
  if (apply && graded.length) {
    const byId = new Map(graded.map(g => [g.id, g]));
    const updated = picks.map(p => {
      const g = byId.get(p.id);
      if (!g) return p;
      return {
        ...p,
        status: 'CLOSED',
        result: g.result,
        score: g.score,
        // Sin captura de cierre no hay CLV: null, nunca 0 inventado.
        // Si captureClosingOdds.mjs ya capturó el cierre (ESPN/DraftKings),
        // se conserva: borrarlo aquí era lo que dejaba el CLV en 0 siempre.
        closingOdds: p.closingOdds ?? null,
        clvPct: p.clvPct ?? null,
        pnlUnits: g.pnlUnits,
        closedAt: new Date().toISOString(),
        closedBy: 'gradeLedger.mjs (ESPN Scoreboard)',
      };
    });
    fs.writeFileSync(ledgerPath, updated.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
    const lines = graded.map(g => JSON.stringify({
      pickId: g.id, closedAt: new Date().toISOString(), source: 'espn-scoreboard',
      game: g.pick.game, pick: g.pick.pick, score: g.score,
      result: g.result, pnlUnits: g.pnlUnits,
      closingOdds: g.pick.closingOdds ?? null, clvPct: g.pick.clvPct ?? null,
      closingSource: g.pick.closingSource ?? null, beatClosingLine: g.pick.beatClosingLine ?? null,
    })).join('\n') + '\n';
    fs.appendFileSync(closuresFile, lines, 'utf-8');
  }
  return { graded, skipped, total: pending.length };
}

// Corrección del bug de CLV en cierres viejos: los 7 picks cerrados con
// closingOdds == placedOdds y clvPct == 0 son el síntoma del bug documentado
// en la auditoría 2026-11-02 (se copiaba la cuota publicada como cierre).
// Sin captura real de cierre, el CLV correcto es desconocido (null).
export function fixLegacyClvZeros({ apply = false } = {}) {
  if (!fs.existsSync(LEDGER_PATH)) return { fixed: [] };
  const picks = fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const fixed = picks.filter(p => p.status === 'CLOSED' && Number(p.clvPct) === 0
    && p.closingOdds !== null && Number(p.closingOdds) === Number(p.placedOdds));
  if (apply && fixed.length) {
    const ids = new Set(fixed.map(p => p.id));
    const updated = picks.map(p => (ids.has(p.id)
      ? { ...p, closingOdds: null, clvPct: null, clvFixedAt: new Date().toISOString() }
      : p));
    fs.writeFileSync(LEDGER_PATH, updated.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
    const lines = fixed.map(p => JSON.stringify({
      pickId: p.id, closedAt: new Date().toISOString(), source: 'clv-bug-correction',
      game: p.game, pick: p.pick, result: p.result, pnlUnits: p.pnlUnits,
      note: 'CLV 0 era el bug de closePick (cierre = cuota publicada); sin captura real el CLV es desconocido (null).',
    })).join('\n') + '\n';
    fs.appendFileSync(CLOSURES_PATH, lines, 'utf-8');
  }
  return { fixed: fixed.map(p => p.id) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fixClv = args.includes('--fix-clv');
  const idIdx = args.indexOf('--id');
  const onlyId = idIdx !== -1 ? args[idIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
  const { graded, skipped, total } = await gradePendingPicks({ apply, onlyId, limit });
  const wins = graded.filter(g => g.result === 'WON').length;
  const losses = graded.filter(g => g.result === 'LOST').length;
  const pushes = graded.filter(g => g.result === 'PUSH').length;
  const net = graded.reduce((a, g) => a + g.pnlUnits, 0);
  console.log(`\n${apply ? '✅ CIERRES APLICADOS' : '🔍 DRY-RUN (sin escribir, usa --apply para guardar)'}`);
  console.log(`Pendientes revisados: ${total} | Calificables: ${graded.length} (${wins}W-${losses}L-${pushes}P, ${net >= 0 ? '+' : ''}${net.toFixed(2)}u) | Sin calificar: ${skipped.length}`);
  for (const g of graded) {
    console.log(` • [${g.id}] ${g.result} ${g.score} (${g.pnlUnits >= 0 ? '+' : ''}${g.pnlUnits}u) — ${g.pick.game} → ${g.pick.pick}`);
  }
  for (const s of skipped) {
    console.log(` • [${s.id}] SIN CALIFICAR: ${s.reason}`);
  }
  if (fixClv) {
    const { fixed } = fixLegacyClvZeros({ apply });
    console.log(`\nCorrección CLV legacy: ${fixed.length} cierres con CLV 0 inventado → null (${apply ? 'aplicada' : 'dry-run'}).`);
    if (fixed.length) console.log(`   ${fixed.join(', ')}`);
  }
  console.log('');
}
