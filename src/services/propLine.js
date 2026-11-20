// src/services/propLine.js
// ADAPTADOR PROPLINE — precios reales DraftKings para player props y totales de equipo.
// Cubre los dos huecos del sistema:
//   - ESPN no trae props de jugador ni totales de equipo (solo ML/spread/total).
//   - The Odds API está agotado hasta el 1 dic 2026; API-Sports es solo fútbol.
// La llave vive SOLO en process.env.PROPLINE_API_KEY (Vercel); nunca en código
// ni en archivos. Plan gratis: 1,000 requests/día.
// Formato de respuesta compatible con The Odds API (bookmakers/markets/outcomes).
//
// FAIL-SAFE: sin llave, con PropLine caído, con respuesta malformada o sin
// precio para un partido, todo devuelve vacío y el motor se comporta
// exactamente como hoy (props con procedencia 'model', vetados por C3).
// Ninguna función de este archivo lanza excepciones.

export const PROPLINE_BASE_URL = 'https://api.prop-line.com/v1';
export const PROPLINE_TIMEOUT_MS = 10000;
export const PROPLINE_BOOKMAKER = 'draftkings';

// Deporte del motor -> llave de deporte PropLine.
export const PROPLINE_SPORT_KEYS = {
  nfl: 'football_nfl',
  ncaaf: 'football_ncaaf',
  nba: 'basketball_nba',
  mlb: 'baseball_mlb',
};

// Liga de fútbol (nombre local) -> llave de deporte PropLine. Solo las ligas
// que el sistema cubre; una liga sin mapeo se salta en silencio (fail-safe).
export const PROPLINE_SOCCER_LEAGUE_KEYS = {
  'premier league': 'soccer_epl',
  'la liga': 'soccer_spain_la_liga',
  laliga: 'soccer_spain_la_liga',
  'serie a': 'soccer_italy_serie_a',
  bundesliga: 'soccer_germany_bundesliga',
  'ligue 1': 'soccer_france_ligue_one',
  'liga mx': 'soccer_mexico_ligamx',
  'champions league': 'soccer_uefa_champs_league',
  mls: 'soccer_usa_mls',
  eredivisie: 'soccer_netherlands_eredivisie',
  'primeira liga': 'soccer_portugal_primeira_liga',
  'jupiler pro league': 'soccer_belgium_first_div',
  'süper lig': 'soccer_turkey_super_league',
  'super lig': 'soccer_turkey_super_league',
  'primera división argentina': 'soccer_argentina_primera_division',
  'brasileirão': 'soccer_brazil_campeonato',
  'serie a brasileirão': 'soccer_brazil_campeonato',
};

// Mercados que se piden por deporte: los props que el motor sabe usar más
// los totales (de donde salen los totales de equipo).
export const PROPLINE_MARKETS_BY_SPORT = {
  nfl: ['player_pass_yds', 'totals'],
  ncaaf: ['player_pass_yds', 'totals'],
  nba: ['player_points', 'player_rebounds', 'player_assists', 'totals'],
  mlb: ['player_strikeouts', 'player_total_bases', 'totals'],
  soccer: ['player_shots_on_target', 'totals'],
};

export function getPropLineApiKey() {
  const key = process.env.PROPLINE_API_KEY;
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
}

// Normaliza un nombre (jugador/equipo) para comparar sin importar
// mayúsculas, acentos ni espacios extra.
export function normalizePropLineName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Momio americano -> decimal. null si no es un momio válido.
export function americanToDecimal(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0) return Number((1 + n / 100).toFixed(2));
  return Number((1 + 100 / Math.abs(n)).toFixed(2));
}

// Probabilidad implícita (%) de un momio americano.
function impliedProbPct(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return NaN;
  return n > 0 ? (100 / (n + 100)) * 100 : (Math.abs(n) / (Math.abs(n) + 100)) * 100;
}

// Resuelve la llave de deporte PropLine aceptando tanto la clave del motor
// ('nfl') como la de PropLine ('football_nfl').
export function resolvePropLineSportKey(sport) {
  const s = String(sport || '').toLowerCase().trim();
  if (PROPLINE_SPORT_KEYS[s]) return PROPLINE_SPORT_KEYS[s];
  if (Object.values(PROPLINE_SPORT_KEYS).includes(s)) return s;
  if (Object.values(PROPLINE_SOCCER_LEAGUE_KEYS).includes(s)) return s;
  return s || null;
}

function propLineSportKeyForMatch(match, sport) {
  if (String(sport || '').toLowerCase() !== 'soccer') return resolvePropLineSportKey(sport);
  const league = String(match?.league || '').toLowerCase();
  for (const [needle, key] of Object.entries(PROPLINE_SOCCER_LEAGUE_KEYS)) {
    if (league.includes(needle)) return key;
  }
  return null;
}

async function fetchPropLineJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPLINE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Eventos del deporte (para cruzar con los partidos locales). Sin llave o
// con cualquier fallo devuelve [] (nunca lanza).
export async function fetchPropLineEvents(sport) {
  const apiKey = getPropLineApiKey();
  if (!apiKey) return [];
  const sportKey = resolvePropLineSportKey(sport);
  if (!sportKey) return [];
  try {
    const data = await fetchPropLineJson(
      `${PROPLINE_BASE_URL}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${encodeURIComponent(apiKey)}`
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Cuotas (props + totales) de un evento PropLine. Sin llave o con cualquier
// fallo devuelve null (nunca lanza). `markets` puede ser string o array.
export async function fetchPropLineOdds(sport, eventId, markets) {
  const apiKey = getPropLineApiKey();
  if (!apiKey || eventId === undefined || eventId === null || String(eventId).length === 0) return null;
  const sportKey = resolvePropLineSportKey(sport);
  if (!sportKey) return null;
  const marketsParam = Array.isArray(markets) ? markets.join(',') : String(markets || '');
  if (!marketsParam) return null;
  try {
    return await fetchPropLineJson(
      `${PROPLINE_BASE_URL}/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(String(eventId))}/odds?apiKey=${encodeURIComponent(apiKey)}&markets=${encodeURIComponent(marketsParam)}`
    );
  } catch {
    return null;
  }
}

// Extrae el valor de una escalera ("300+ Passing Yards", "1+ Shots on Target").
// Devuelve el número o null si el nombre no es una escalera.
function milestoneValue(name) {
  const m = String(name || '').match(/^\s*(\d+(?:\.\d+)?)\s*\+/);
  return m ? parseFloat(m[1]) : null;
}

// Normaliza los outcomes DraftKings de un mercado de props en un objeto:
//   { player, market, line, overPrice, underPrice, overDecimal, underDecimal,
//     format: 'over_under' | 'milestone', ladder: [...] | null }
// Dos formatos reales (verificados en vivo 2026-11-20):
//   - Over/Under: outcomes Over/Under con point (la línea) y price.
//   - Escalera: outcomes "300+ ..." / "1+ ..." con price y point null; la
//     línea principal es la fila cuya probabilidad implícita está más cerca
//     de -110 (52.38%), y su equivalente Over/Under es (valor - 0.5)
//     ("300+" = Más de 299.5; "1+" = Más de 0.5). Solo existe lado Over.
// Devuelve null si el grupo no trae ningún precio válido.
function normalizePropGroup(player, market, outcomes = []) {
  const ou = { over: null, under: null };
  const ladder = [];
  for (const o of outcomes) {
    if (!o || typeof o !== 'object') continue;
    const price = Number(o.price);
    if (!Number.isFinite(price) || price === 0) continue;
    const name = String(o.name || '').trim();
    const ms = milestoneValue(name);
    if (ms !== null) {
      ladder.push({ line: ms, price });
      continue;
    }
    if (/^over$/i.test(name)) {
      ou.over = { point: Number(o.point), price };
    } else if (/^under$/i.test(name)) {
      ou.under = { point: Number(o.point), price };
    }
  }
  // Formato Over/Under (tiene ambos lados y la línea exacta del mercado).
  if (ou.over && Number.isFinite(ou.over.point)) {
    const line = ou.over.point;
    return {
      player,
      market,
      line,
      overPrice: ou.over.price,
      underPrice: ou.under ? ou.under.price : null,
      overDecimal: americanToDecimal(ou.over.price),
      underDecimal: ou.under ? americanToDecimal(ou.under.price) : null,
      format: 'over_under',
      ladder: ladder.length > 0 ? ladder.sort((a, b) => a.line - b.line) : null,
    };
  }
  // Formato escalera: línea principal = fila más cercana a -110.
  if (ladder.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const row of ladder) {
      const p = impliedProbPct(row.price);
      if (!Number.isFinite(p)) continue;
      const dist = Math.abs(p - 52.38);
      if (dist < bestDist) { bestDist = dist; best = row; }
    }
    if (!best) return null;
    return {
      player,
      market,
      line: best.line - 0.5,
      overPrice: best.price,
      underPrice: null,
      overDecimal: americanToDecimal(best.price),
      underDecimal: null,
      format: 'milestone',
      ladder: ladder.sort((a, b) => a.line - b.line),
    };
  }
  return null;
}

// Parsea la respuesta de /odds de PropLine (bookmakers DraftKings) en:
//   { props: [normalizados], teamTotals: { home, away } | null, gameTotal: {...} | null }
// `event` (opcional) aporta home_team/away_team para asignar cada total de
// equipo a local/visitante. Los totales alternos ("Total Alternate") se
// ignoran. Cualquier entrada malformada devuelve vacío, nunca lanza.
export function parsePropLineProps(oddsJson, event = null) {
  const empty = { props: [], teamTotals: null, gameTotal: null };
  try {
    const bookmakers = oddsJson && Array.isArray(oddsJson.bookmakers) ? oddsJson.bookmakers : null;
    if (!bookmakers) return empty;
    const dk = bookmakers.find(b => b && String(b.key || '').toLowerCase() === PROPLINE_BOOKMAKER);
    if (!dk || !Array.isArray(dk.markets)) return empty;

    // Agrupa outcomes de props por (jugador, mercado): un mismo jugador puede
    // traer mercado Over/Under Y escalera en objetos de mercado separados.
    const groups = new Map();
    let gameTotal = null;
    const teamTotalsRaw = [];
    for (const m of dk.markets) {
      if (!m || typeof m !== 'object' || !Array.isArray(m.outcomes)) continue;
      const key = String(m.key || '');
      if (key === 'totals') {
        const desc = String(m.description || '');
        const over = m.outcomes.find(o => o && /^over$/i.test(String(o.name || '')));
        const under = m.outcomes.find(o => o && /^under$/i.test(String(o.name || '')));
        if (!over || !Number.isFinite(Number(over.point))) continue;
        const entry = {
          line: Number(over.point),
          overPrice: Number(over.price),
          underPrice: under ? Number(under.price) : null,
          overDecimal: americanToDecimal(over.price),
          underDecimal: under ? americanToDecimal(under.price) : null,
        };
        if (/^total$/i.test(desc.trim())) {
          gameTotal = entry;
        } else if (/^team total points\s*-/i.test(desc.trim())) {
          const teamStr = desc.replace(/^team total points\s*-\s*/i, '').trim();
          teamTotalsRaw.push({ teamStr, ...entry });
        }
        // "Total Alternate ..." se ignora.
        continue;
      }
      if (!key.startsWith('player_')) continue;
      for (const o of m.outcomes) {
        const player = o && o.description ? String(o.description).trim() : '';
        if (!player) continue;
        const gk = `${normalizePropLineName(player)}|${key}`;
        if (!groups.has(gk)) groups.set(gk, { player, market: key, outcomes: [] });
        groups.get(gk).outcomes.push(o);
      }
    }

    const props = [];
    for (const g of groups.values()) {
      const norm = normalizePropGroup(g.player, g.market, g.outcomes);
      if (norm) props.push(norm);
    }

    // Asigna cada total de equipo a local/visitante por el nombre del equipo
    // en la descripción ("Team Total Points - CIN Bengals"). Si no se puede
    // asignar con certeza, ese lado queda null (fail-safe).
    let teamTotals = null;
    if (teamTotalsRaw.length > 0) {
      const homeName = normalizePropLineName(event?.home_team || oddsJson?.home_team || '');
      const awayName = normalizePropLineName(event?.away_team || oddsJson?.away_team || '');
      const assign = (teamStr) => {
        const tokens = normalizePropLineName(teamStr).split(' ').filter(t => t.length >= 3);
        if (tokens.length === 0) return null;
        const hay = (teamNorm) => teamNorm && tokens.some(t => teamNorm.includes(t));
        if (hay(homeName) && !hay(awayName)) return 'home';
        if (hay(awayName) && !hay(homeName)) return 'away';
        return null;
      };
      const home = teamTotalsRaw.find(t => assign(t.teamStr) === 'home') || null;
      const away = teamTotalsRaw.find(t => assign(t.teamStr) === 'away') || null;
      if (home || away) {
        const strip = (t) => (t ? { line: t.line, overPrice: t.overPrice, underPrice: t.underPrice, overDecimal: t.overDecimal, underDecimal: t.underDecimal } : null);
        teamTotals = { home: strip(home), away: strip(away) };
      }
    }

    return { props, teamTotals, gameTotal };
  } catch {
    return empty;
  }
}

// Busca el precio PropLine de un prop concreto (jugador + mercado + línea +
// lado). Devuelve { decimal, american } o null. La línea debe coincidir
// (tolerancia 0.01): un precio de otra línea no aplica a este pick.
export function findPropLinePrice(propLineProps, { player, market, line, side } = {}) {
  try {
    if (!Array.isArray(propLineProps) || !player || !market) return null;
    const wantPlayer = normalizePropLineName(player);
    const wantLine = Number(line);
    const wantSide = String(side || 'over').toLowerCase();
    for (const p of propLineProps) {
      if (!p || typeof p !== 'object') continue;
      if (String(p.market || '') !== String(market)) continue;
      if (normalizePropLineName(p.player) !== wantPlayer) continue;
      if (Number.isFinite(wantLine) && Number.isFinite(Number(p.line)) && Math.abs(Number(p.line) - wantLine) > 0.01) continue;
      if (wantSide === 'over' && Number.isFinite(Number(p.overDecimal)) && Number(p.overDecimal) >= 1.10) {
        return { decimal: Number(p.overDecimal), american: p.overPrice ?? null };
      }
      if (wantSide === 'under' && Number.isFinite(Number(p.underDecimal)) && Number(p.underDecimal) >= 1.10) {
        return { decimal: Number(p.underDecimal), american: p.underPrice ?? null };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

// Cruza un partido local con un evento PropLine: primero por id ESPN
// (el id local es `nfl-<espnId>`, `ncaaf-<espnId>`, `nba-<espnId>`; MLB por
// gamePk), y si no, por nombres de equipos + proximidad de horario (12h).
export function matchPropLineEvent(events, match) {
  try {
    if (!Array.isArray(events) || events.length === 0 || !match) return null;
    const localId = String(match.id || '');
    const espnId = localId.replace(/^(nfl|ncaaf|nba|mlb)-/, '');
    if (espnId && espnId !== localId) {
      const byEspn = events.find(e => String(e.espn_event_id || '') === espnId);
      if (byEspn) return byEspn;
      if (localId.startsWith('mlb-')) {
        const byPk = events.find(e => e.mlb_game_pk !== null && e.mlb_game_pk !== undefined && String(e.mlb_game_pk) === espnId);
        if (byPk) return byPk;
      }
    }
    const hNorm = normalizePropLineName(match.home?.baseName || match.home?.name || '');
    const aNorm = normalizePropLineName(match.away?.baseName || match.away?.name || '');
    const gameTs = match.gameDate ? new Date(match.gameDate).getTime() : NaN;
    const namesMatch = (a, b) => a.length >= 3 && b.length >= 3 && (a === b || a.includes(b) || b.includes(a));
    return events.find(e => {
      const eh = normalizePropLineName(e.home_team || '');
      const ea = normalizePropLineName(e.away_team || '');
      if (!namesMatch(eh, hNorm) || !namesMatch(ea, aNorm)) return false;
      if (e.commence_time && Number.isFinite(gameTs)) {
        return Math.abs(new Date(e.commence_time).getTime() - gameTs) <= 12 * 60 * 60 * 1000;
      }
      return true;
    }) || null;
  } catch {
    return null;
  }
}

// Enriquecimiento: adjunta a cada partido sus props PropLine
// (match.propLineProps), su total de equipo (match.propLineTeamTotal) y la
// hora de descarga (match.propLineFetchedAt). Devuelve un arreglo nuevo;
// ante cualquier fallo devuelve los partidos intactos (fail-safe).
export async function enrichMatchesWithPropLine(matches = [], sport = 'nfl') {
  if (!Array.isArray(matches) || matches.length === 0) return matches;
  if (!getPropLineApiKey()) return matches;
  const fetchedAt = new Date().toISOString();
  try {
    if (String(sport || '').toLowerCase() === 'soccer') {
      // Fútbol: una llave de deporte por liga; se agrupa por liga.
      const byKey = new Map();
      matches.forEach((m, i) => {
        const k = propLineSportKeyForMatch(m, 'soccer');
        if (!k) return;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ m, i });
      });
      if (byKey.size === 0) return matches;
      const out = [...matches];
      let enrichedCount = 0;
      await Promise.all([...byKey.entries()].map(async ([sportKey, items]) => {
        const enriched = await enrichOneSport(items.map(x => x.m), sportKey, PROPLINE_MARKETS_BY_SPORT.soccer, fetchedAt);
        enriched.forEach((em, j) => {
          if (em !== items[j].m) { out[items[j].i] = em; enrichedCount++; }
        });
      }));
      if (enrichedCount > 0) console.log(`📊 [PropLine] ${enrichedCount} partidos de FÚTBOL con precios DraftKings (props/totales).`);
      return out;
    }
    const sportKey = resolvePropLineSportKey(sport);
    const markets = PROPLINE_MARKETS_BY_SPORT[String(sport || '').toLowerCase()] || ['totals'];
    const enriched = await enrichOneSport(matches, sportKey, markets, fetchedAt);
    const count = enriched.filter((em, i) => em !== matches[i]).length;
    if (count > 0) console.log(`📊 [PropLine] ${count} partidos de ${String(sport).toUpperCase()} con precios DraftKings (props/totales).`);
    return enriched;
  } catch (e) {
    console.warn('[PropLine] Error enriqueciendo:', e.message);
    return matches;
  }
}

async function enrichOneSport(matches, sportKey, markets, fetchedAt) {
  if (!sportKey) return matches;
  const events = await fetchPropLineEvents(sportKey);
  if (!events || events.length === 0) return matches;
  const results = await Promise.all(matches.map(async (m) => {
    try {
      const ev = matchPropLineEvent(events, m);
      if (!ev) return m;
      const oddsJson = await fetchPropLineOdds(sportKey, ev.id, markets);
      const parsed = parsePropLineProps(oddsJson, ev);
      if ((!parsed.props || parsed.props.length === 0) && !parsed.teamTotals) return m;
      return {
        ...m,
        propLineProps: parsed.props,
        propLineTeamTotal: parsed.teamTotals,
        propLineFetchedAt: fetchedAt,
      };
    } catch {
      return m;
    }
  }));
  return results;
}
