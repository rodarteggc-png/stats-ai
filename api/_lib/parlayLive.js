import { getApiSportsKey } from '../../src/services/apiSports.js';
import { getOddsApiKeys, inMemoryExhaustedKeys } from '../../src/services/sportsApi.js';

const cache = new Map();
const RESERVE_REQUESTS = 10;
const MAX_TICKET_REQUESTS = 10;
const ODDS_API_SPORTS = { nba: 'basketball_nba', nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', mlb: 'baseball_mlb' };
const FOOTBALL_MARKETS = ['match_winner', 'goals_over_under', 'both_teams_score', 'double_chance', 'asian_handicap'];
const US_MARKETS = ['match_winner', 'total', 'spread'];

export function createTicketClient({ fetchImpl = fetch, now = Date.now, apiKey = getApiSportsKey(), maxRequests = MAX_TICKET_REQUESTS, reserveRequests = RESERVE_REQUESTS, budgetMs = 20000 } = {}) {
  let remaining = null;
  let requests = 0;
  let initialized = false;
  const deadline = now() + budgetMs;

  async function request(path, params = {}, ttl = 60000) {
    const url = new URL(path, 'https://v3.football.api-sports.io');
    url.search = new URLSearchParams(params).toString();
    const cacheKey = `${apiKey}:${url}`;
    const cached = cache.get(cacheKey);
    if (path !== '/status' && cached && now() - cached.at < ttl) return cached.value;
    if (now() >= deadline) throw new Error('Tiempo de consulta del boleto agotado.');
    if (!apiKey) throw new Error('API-Sports no configurada.');
    if (requests >= maxRequests) throw new Error('Limite de consultas por boleto alcanzado.');
    if (path !== '/status' && (!initialized || remaining === null || remaining <= reserveRequests)) {
      throw new Error(`Saldo diario insuficiente; se reservan ${reserveRequests} consultas para las alertas.`);
    }
    requests++;
    if (remaining !== null) remaining--;
    const response = await fetchImpl(url, {
      headers: { 'x-apisports-key': apiKey },
      signal: AbortSignal.timeout(Math.max(1, Math.min(6000, deadline - now())))
    });
    const header = response.headers.get('x-ratelimit-requests-remaining');
    if (header !== null && Number.isFinite(Number(header))) remaining = Number(header);
    if (!response.ok) throw new Error(`API-Sports HTTP ${response.status}.`);
    const data = await response.json();
    if (data.errors && Object.keys(data.errors).length) {
      throw new Error(`API-Sports: ${Object.values(data.errors).join(' ').slice(0, 180)}`);
    }
    const value = { data: data.response, checkedAt: new Date(now()).toISOString(), paging: data.paging };
    if (path === '/status') {
      const current = data.response?.requests?.current;
      const limit = data.response?.requests?.limit_day;
      if (!Number.isFinite(current) || !Number.isFinite(limit)) throw new Error('No se pudo verificar el saldo diario.');
      remaining = Math.max(0, Math.min(100, limit) - current);
      initialized = true;
    } else {
      const teamStatistics = path === '/teams/statistics' && data.response && typeof data.response === 'object' && !Array.isArray(data.response);
      if (!Array.isArray(data.response) && !teamStatistics) throw new Error('Respuesta inesperada de API-Sports.');
      cache.set(cacheKey, { at: now(), value });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    return value;
  }

  return { request, usage: () => ({ remaining, requests, reserve: reserveRequests }) };
}

function normalizeTeam(value = '') {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(word => word && !['fc', 'cf', 'club', 'sc', 'afc'].includes(word)).join(' ');
}

// En ligas de EE.UU. el apodo (Chiefs, Celtics) identifica al equipo; en futbol no (Real Madrid / Atletico Madrid).
function teamMatches(first, second, nicknames = false) {
  const a = normalizeTeam(first);
  const b = normalizeTeam(second);
  if (!a || !b) return false;
  if (a === b) return true;
  if ((a.length >= 4 && ` ${b} `.includes(` ${a} `)) || (b.length >= 4 && ` ${a} `.includes(` ${b} `))) return true;
  const lastA = a.split(' ').at(-1);
  return nicknames && lastA.length > 3 && lastA === b.split(' ').at(-1);
}

function splitEvent(text = '') {
  const value = String(text ?? '').replace(/\|.*$/, '').trim();
  const away = value.match(/^(.+?)\s+@\s+(.+)$/);
  if (away) return { homeTeam: away[2].trim(), awayTeam: away[1].trim() };
  const pair = value.match(/^(.+?)\s+(?:vs\.?|v|-|–)\s+(.+)$/i);
  return pair ? { homeTeam: pair[1].trim(), awayTeam: pair[2].trim() } : {};
}

function normalizeLeg(raw) {
  const leg = { ...raw };
  if (!leg.homeTeam || !leg.awayTeam) {
    const parsed = splitEvent(leg.eventText);
    leg.homeTeam ||= parsed.homeTeam || null;
    leg.awayTeam ||= parsed.awayTeam || null;
  }
  leg.sport = String(leg.sport || 'unknown').toLowerCase();
  if (leg.sport === 'football') {
    leg.market = ({ total: 'goals_over_under', spread: 'asian_handicap' })[leg.market] || leg.market;
  } else if (ODDS_API_SPORTS[leg.sport]) {
    leg.market = ({ goals_over_under: 'total', asian_handicap: 'spread' })[leg.market] || leg.market;
  }
  return leg;
}

// Orienta la seleccion al local/visitante reales del partido encontrado.
function resolveSide(leg, homeName, awayName, nicknames) {
  const text = normalizeTeam(String(leg.selectionText || '').replace(/[+-]?\d+(?:\.\d+)?/g, ' '));
  const named = text && !/^(over|under|mas|menos|si|no|yes)\b/.test(text);
  const home = named && (teamMatches(text, homeName, nicknames) || text.includes(normalizeTeam(homeName)));
  const away = named && (teamMatches(text, awayName, nicknames) || text.includes(normalizeTeam(awayName)));
  const draw = /\b(empate|draw|x)\b/.test(text);
  if (home !== away) {
    if (leg.market === 'double_chance' && draw) return home ? 'home_draw' : 'draw_away';
    if (['match_winner', 'spread', 'asian_handicap'].includes(leg.market)) return home ? 'home' : 'away';
  }
  if (leg.market === 'match_winner' && draw && !home && !away) return 'draw';
  const legHome = leg.homeTeam && teamMatches(leg.homeTeam, homeName, nicknames);
  const swapped = !legHome && leg.homeTeam && teamMatches(leg.homeTeam, awayName, nicknames);
  if (!swapped) return leg.selection;
  return ({ home: 'away', away: 'home', home_draw: 'draw_away', draw_away: 'home_draw' })[leg.selection] || leg.selection;
}

function decimalOdds(value) {
  const raw = String(value ?? '').trim();
  if (/^[+-]\d{3,5}$/.test(raw)) {
    const american = Number(raw);
    if (Math.abs(american) < 100) return null;
    return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const decimal = Number(raw);
  return decimal > 1 && decimal < 10000 ? decimal : null;
}

export async function extractTicketSelections({ imageBase64, mimeType = 'image/jpeg', text = '' }, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error('Vision no configurada.');
  const parts = [{ text: [
    'Lee este boleto de apuestas. Devuelve SOLO las selecciones individuales, no la cuota total ni el pago.',
    `Hoy es ${new Date().toISOString().slice(0, 10)} UTC. No inventes equipos, rivales, fechas ni cuotas ausentes.`,
    'eventText: copia literal del partido tal como aparece (ej. "Monterrey - Toluca", "KC Chiefs @ LV Raiders"); null si no aparece.',
    'selectionText: copia literal de lo apostado (ej. "Monterrey", "Mas de 1.5", "Boston Celtics -4.5", "America o Empate").',
    'homeTeam y awayTeam: local y visitante del partido. En "A @ B" A es visitante y B local; en "A vs B" o "A - B" A es local. null si no aparece el nombre.',
    'sport: football (futbol soccer), nba, nfl, ncaaf, mlb o unknown. Deducelo por liga o equipos conocidos aunque el boleto no lo diga.',
    'market: match_winner (Ganador, Resultado final, 1X2, Linea de dinero, Moneyline, ML), total (Total, Mas/Menos, Over/Under),',
    'spread (Handicap, Spread, Linea, Runline, Handicap asiatico), both_teams_score (Ambos anotan), double_chance (Doble oportunidad) o unknown.',
    'selection: home, away, draw, over, under, yes, no, home_draw, draw_away o home_away; unknown si no se identifica.',
    'line: numero exacto del total o handicap con su signo; null si no aplica o no se lee.',
    'ticketOdds: cuota individual visible como cadena, decimal o americana con signo; null si no se lee.',
    'date: fecha del partido YYYY-MM-DD solo si figura (convierte "Hoy" o "Manana" a fecha); null si no figura.',
    'Tiros, corners, tarjetas, periodos, mitades, props de jugador o goles de un solo equipo: market unknown.',
    'Si hay mas de 8 selecciones, indica tooMany=true y devuelve solo las primeras 8.',
    text ? `Texto del boleto: ${text.slice(0, 12000)}` : ''
  ].join('\n') }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  const nullableString = { type: 'STRING', nullable: true };
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT', required: ['selections', 'tooMany'], properties: {
          tooMany: { type: 'BOOLEAN' },
          selections: { type: 'ARRAY', maxItems: 8, items: {
            type: 'OBJECT',
            required: ['eventText', 'selectionText', 'homeTeam', 'awayTeam', 'sport', 'date', 'market', 'selection', 'line', 'ticketOdds'],
            properties: {
              eventText: nullableString, selectionText: nullableString,
              homeTeam: nullableString, awayTeam: nullableString, sport: { type: 'STRING' },
              date: nullableString, market: { type: 'STRING' }, selection: { type: 'STRING' },
              line: { type: 'NUMBER', nullable: true }, ticketOdds: nullableString
            }
          } }
        }
      }
    }
  });
  let response;
  let lastError = 'Lectura del boleto no disponible.';
  // Plan gratuito: 20 lecturas diarias por modelo; ante 429/503 se pasa al siguiente modelo.
  for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.6-flash']) {
    try {
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(12000)
      });
      if (response.ok) break;
      lastError = response.status === 429
        ? 'Se agoto el cupo diario de lectura de boletos (plan gratuito de Gemini).'
        : `Lectura del boleto no disponible (HTTP ${response.status}).`;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error.name === 'TimeoutError' ? 'La lectura del boleto excedio el tiempo.' : error.message;
    }
    response = null;
  }
  if (!response?.ok) throw new Error(lastError);
  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('');
  if (!content) throw new Error('No se pudieron leer selecciones en el boleto.');
  const ticket = JSON.parse(content);
  if (!Array.isArray(ticket.selections) || !ticket.selections.length) throw new Error('No se detectaron selecciones.');
  if (ticket.tooMany || ticket.selections.length > 8) throw new Error('Envia el boleto en partes de hasta 8 selecciones.');
  return ticket.selections.map(normalizeLeg);
}

function findMarketQuote(event, leg, selection) {
  const names = {
    match_winner: 'Match Winner', goals_over_under: 'Goals Over/Under',
    both_teams_score: 'Both Teams Score', double_chance: 'Double Chance', asian_handicap: 'Asian Handicap'
  };
  const book = event.bookmakers?.find(bookmaker => [4, 8].includes(bookmaker.id));
  const market = book?.bets?.find(bet => bet.name === names[leg.market]);
  if (!market) return null;
  const outcomes = { home: 'Home', away: 'Away', draw: 'Draw', yes: 'Yes', no: 'No', home_draw: 'Home/Draw', draw_away: 'Draw/Away', home_away: 'Home/Away' };
  let values = market.values || [];
  let outcome = outcomes[selection];
  if (leg.market === 'goals_over_under' || leg.market === 'asian_handicap') {
    if (typeof leg.line !== 'number' || !Number.isFinite(leg.line)) return null;
    const sides = leg.market === 'goals_over_under' ? { over: 'Over', under: 'Under' } : { home: 'Home', away: 'Away' };
    if (!sides[selection]) return null;
    const quote = values.find(value => {
      const match = value.value?.match(/^(Home|Away|Over|Under)\s+([+-]?\d+(?:\.\d+)?)$/);
      return match && match[1] === sides[selection] && Number(match[2]) === leg.line;
    });
    outcome = quote?.value;
    if (leg.market === 'goals_over_under') {
      values = values.filter(value => {
        const match = value.value?.match(/^(Over|Under)\s+([+-]?\d+(?:\.\d+)?)$/);
        return match && Number(match[2]) === leg.line;
      });
    }
  }
  const odds = decimalOdds(values.find(value => value.value === outcome)?.odd);
  if (!odds) return null;
  const expected = leg.market === 'match_winner' ? ['Home', 'Draw', 'Away']
    : leg.market === 'both_teams_score' ? ['Yes', 'No']
    : leg.market === 'goals_over_under' && Math.abs(leg.line % 1) === 0.5 ? [`Over ${leg.line}`, `Under ${leg.line}`] : [];
  const prices = expected.map(name => decimalOdds(values.find(value => value.value === name)?.odd));
  const fairProbability = prices.length && prices.every(Boolean)
    ? (1 / odds) / prices.reduce((sum, price) => sum + 1 / price, 0) : null;
  return { odds, bookmaker: book.name, outcome, fairProbability, updatedAt: event.update || null };
}

function ageOf(updatedAt, now) {
  const ageMs = now - Date.parse(updatedAt);
  const ageMinutes = Number.isFinite(ageMs) && ageMs >= -60000 ? Math.max(0, Math.floor(ageMs / 60000)) : null;
  return { ageMinutes, fresh: ageMinutes !== null && ageMs <= 15 * 60000 };
}

function findOddsApiQuote(event, leg, selection) {
  const key = { match_winner: 'h2h', total: 'totals', spread: 'spreads' }[leg.market];
  const isLine = leg.market !== 'match_winner';
  if (isLine && !(typeof leg.line === 'number' && Number.isFinite(leg.line))) return null;
  const sideName = { home: event.home_team, away: event.away_team, over: 'Over', under: 'Under' }[selection];
  if (!sideName || (leg.market === 'total' && !['over', 'under'].includes(selection))
    || (leg.market !== 'total' && !['home', 'away'].includes(selection))) return null;
  const books = (event.bookmakers || []).filter(book => ['pinnacle', 'bet365'].includes(book.key))
    .sort((first, second) => Number(second.key === 'pinnacle') - Number(first.key === 'pinnacle'));
  const now = Date.now();
  let fallback = null;
  for (const book of books) {
    const market = book.markets?.find(item => item.key === key);
    const outcomes = market?.outcomes || [];
    const target = outcomes.find(outcome => outcome.name === sideName && (!isLine || Number(outcome.point) === leg.line));
    const odds = decimalOdds(target?.price);
    if (!odds) continue;
    const pool = isLine ? outcomes.filter(outcome => Math.abs(Number(outcome.point)) === Math.abs(leg.line)) : outcomes;
    const prices = pool.map(outcome => decimalOdds(outcome.price));
    const fairProbability = pool.length >= 2 && prices.every(Boolean) ? (1 / odds) / prices.reduce((sum, price) => sum + 1 / price, 0) : null;
    const updatedAt = market.last_update || book.last_update || null;
    const quote = { odds, bookmaker: book.title, outcome: target.name, fairProbability, updatedAt, ...ageOf(updatedAt, now) };
    if (quote.fresh) return quote;
    fallback ||= quote;
  }
  return fallback;
}

function legTeams(leg) {
  const parsed = splitEvent(leg.eventText);
  const named = String(leg.selectionText || '').replace(/[+-]?\d+(?:\.\d+)?/g, ' ').replace(/\b(o empate|empate|or draw)\b/gi, ' ').trim();
  return [leg.homeTeam, leg.awayTeam, parsed.homeTeam, parsed.awayTeam, named].filter(Boolean);
}

// Exige coincidencia de ambos equipos si se conocen; con uno solo, solo acepta un partido unico.
function pickEvent(events, leg, getHome, getAway, nicknames) {
  const names = legTeams(leg);
  if (!names.length) return { error: 'No se leyeron los equipos del boleto.' };
  const both = leg.homeTeam && leg.awayTeam;
  const matches = events.filter(event => {
    const home = getHome(event);
    const away = getAway(event);
    if (both) {
      return (teamMatches(leg.homeTeam, home, nicknames) && teamMatches(leg.awayTeam, away, nicknames))
        || (teamMatches(leg.homeTeam, away, nicknames) && teamMatches(leg.awayTeam, home, nicknames));
    }
    return names.some(name => teamMatches(name, home, nicknames) || teamMatches(name, away, nicknames));
  });
  if (matches.length === 1) return { event: matches[0] };
  return { error: matches.length ? 'Partido ambiguo; agrega ambos equipos o la fecha.' : 'No se encontro ese partido en la fecha consultada.' };
}

export async function auditTicketLive(selections, options = {}) {
  const client = createTicketClient(options);
  const results = [];
  const nowFn = options.now || Date.now;
  const today = new Date(nowFn()).toISOString().slice(0, 10);
  const fetchImpl = options.fetchImpl || fetch;
  const oddsKeys = options.oddsKeys || getOddsApiKeys();
  const oddsCache = new Map();
  const oddsUsage = { requests: 0 };
  let initialized = false;
  let initializationError;

  async function oddsEvents(sport) {
    if (oddsCache.has(sport)) return oddsCache.get(sport);
    const loader = (async () => {
      for (const key of oddsKeys.filter(item => !inMemoryExhaustedKeys.has(item)).slice(0, 2)) {
        if (oddsUsage.requests >= 4) break;
        const url = new URL(`https://api.the-odds-api.com/v4/sports/${ODDS_API_SPORTS[sport]}/odds/`);
        url.search = new URLSearchParams({ apiKey: key, regions: 'eu,us', markets: 'h2h,spreads,totals', bookmakers: 'pinnacle,bet365', oddsFormat: 'decimal' }).toString();
        oddsUsage.requests++;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
        if ([401, 429].includes(response.status)) { inMemoryExhaustedKeys.add(key); continue; }
        if (!response.ok) throw new Error(`Cuotas ${sport.toUpperCase()} HTTP ${response.status}.`);
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Respuesta de cuotas no valida.');
        return data;
      }
      throw new Error('Sin saldo disponible en The Odds API para este deporte.');
    })();
    oddsCache.set(sport, loader);
    return loader;
  }

  async function footballFixture(leg, result) {
    const date = leg.date || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error('Fecha del partido no valida.');
    }
    result.assumedDate = !leg.date;
    result.date = date;
    if (initializationError) throw initializationError;
    if (!initialized) {
      try { await client.request('/status'); initialized = true; }
      catch (error) { initializationError = error; throw error; }
    }
    const fixtures = await client.request('/fixtures', { date });
    return pickEvent(fixtures.data, leg, item => item.teams?.home?.name, item => item.teams?.away?.name, false);
  }

  async function auditFootball(leg, result, found) {
    const fixture = found.event;
    result.sport = 'football';
    result.fixtureId = fixture.fixture.id;
    result.match = `${fixture.teams.home.name} vs ${fixture.teams.away.name}`;
    result.kickoff = fixture.fixture.date;
    result.fixtureStatus = fixture.fixture.status?.short;
    if (!FOOTBALL_MARKETS.includes(leg.market)) throw new Error('Mercado no compatible; no se sustituye por otro.');
    if (result.fixtureStatus !== 'NS') throw new Error(`Partido ${result.fixtureStatus || 'sin estado'}: no se usan cuotas prepartido como si fueran en juego.`);
    const selection = resolveSide(leg, fixture.teams.home.name, fixture.teams.away.name, false);
    result.resolvedSelection = selection;
    for (const bookmaker of ['4', '8']) {
      const response = await client.request('/odds', { fixture: String(result.fixtureId), bookmaker });
      const quotes = response.data.filter(item => item.fixture?.id === result.fixtureId)
        .map(item => findMarketQuote(item, leg, selection)).filter(Boolean);
      if (quotes.length) {
        const quote = { ...quotes[0], ...ageOf(quotes[0].updatedAt, nowFn()) };
        if (!result.quote || quote.fresh || Date.parse(quote.updatedAt) > Date.parse(result.quote.updatedAt || '1970-01-01')) {
          result.quote = quote;
          result.checkedAt = response.checkedAt;
        }
        if (quote.fresh) { result.verified = true; return; }
      }
    }
  }

  async function auditUsSport(leg, result, sport) {
    if (!US_MARKETS.includes(leg.market)) throw new Error('Mercado no compatible (solo ganador, total o handicap); no se sustituye por otro.');
    const events = await oddsEvents(sport);
    const targetDate = leg.date ? Date.parse(`${leg.date}T12:00:00Z`) : null;
    const window = events.filter(event => !targetDate || Math.abs(Date.parse(event.commence_time) - targetDate) <= 36 * 3600000);
    const found = pickEvent(window, leg, event => event.home_team, event => event.away_team, true);
    if (!found.event) throw new Error(found.error);
    const event = found.event;
    result.sport = sport;
    result.match = `${event.away_team} @ ${event.home_team}`;
    result.kickoff = event.commence_time;
    if (!(Date.parse(event.commence_time) > nowFn())) throw new Error('Partido ya iniciado: no se usan cuotas prepartido como si fueran en juego.');
    const selection = resolveSide(leg, event.home_team, event.away_team, true);
    result.resolvedSelection = selection;
    result.checkedAt = new Date(nowFn()).toISOString();
    const quote = findOddsApiQuote(event, leg, selection);
    if (quote) {
      result.quote = quote;
      result.verified = quote.fresh;
    }
  }

  for (const raw of selections.slice(0, 8)) {
    const leg = normalizeLeg(raw);
    const result = { ...leg, ticketOdds: decimalOdds(leg.ticketOdds), verified: false };
    results.push(result);
    try {
      if (!legTeams(leg).length) throw new Error('No se leyeron los equipos. Envia la captura como archivo (sin comprimir) o recortada a las selecciones.');
      if (ODDS_API_SPORTS[leg.sport]) {
        await auditUsSport(leg, result, leg.sport);
      } else if (leg.sport === 'football' || leg.sport === 'unknown') {
        leg.market = ({ total: 'goals_over_under', spread: 'asian_handicap' })[leg.market] || leg.market;
        result.market = leg.market;
        const found = await footballFixture(leg, result);
        if (!found.event) {
          throw new Error(leg.sport === 'unknown' ? `Deporte no identificado y ${found.error.charAt(0).toLowerCase()}${found.error.slice(1)}` : found.error);
        }
        await auditFootball(leg, result, found);
      } else {
        throw new Error(`Deporte ${leg.sport} sin cobertura de cuotas.`);
      }
      if (!result.verified) throw new Error(result.quote
        ? 'La ultima cuota publicada supera 15 minutos o no tiene hora verificable; no confirma el precio actual.'
        : 'Sin cuota para ese mercado y linea en Pinnacle/Bet365.');
    } catch (error) {
      result.reason = error.name === 'TimeoutError' ? 'El proveedor no respondio a tiempo.' : error.message;
    }
  }
  const usage = { ...client.usage(), oddsApiRequests: oddsUsage.requests };
  return { results, usage, checkedAt: new Date(nowFn()).toISOString() };
}

function safeText(value) {
  return String(value ?? '').replace(/[_*`[\]<>]/g, '').replace(/[\r\n]/g, ' ').slice(0, 160);
}

export function formatLiveTicketReport(audit) {
  const lines = ['*BOLETO: CONTRASTE CON CUOTAS ACTUALES*', 'Prepartido | Pinnacle / Bet365 | Futbol: API-Football | NBA, NFL, NCAAF, MLB: The Odds API', ''];
  const markets = { match_winner: 'Ganador', goals_over_under: 'Goles totales', total: 'Total', spread: 'Handicap', both_teams_score: 'Ambos anotan', double_chance: 'Doble oportunidad', asian_handicap: 'Handicap asiatico', unknown: 'Mercado no identificado' };
  for (const [index, result] of audit.results.entries()) {
    const selections = { home: result.homeTeam, away: result.awayTeam, draw: 'Empate', over: 'Mas de', under: 'Menos de', yes: 'Si', no: 'No', home_draw: `${result.homeTeam} o empate`, draw_away: `Empate o ${result.awayTeam}`, home_away: 'Sin empate', unknown: 'no identificada' };
    const title = result.match || (result.homeTeam && result.awayTeam ? `${result.homeTeam} vs ${result.awayTeam}` : result.eventText || result.selectionText || 'Partido no legible');
    lines.push(`*${index + 1}. ${safeText(title)}*`);
    const picked = result.selectionText || selections[result.selection] || result.selection;
    lines.push(`${safeText(markets[result.market] || result.market)}: ${safeText(picked)}${result.line == null || String(picked).includes(String(Math.abs(result.line))) ? '' : ` ${result.line}`}`);
    lines.push(`Cuota boleto: ${result.ticketOdds ? result.ticketOdds.toFixed(2) : 'no legible; no se inventa'}`);
    if (result.quote) {
      const quote = result.quote;
      lines.push(`Ultima cuota publicada: *${quote.odds.toFixed(2)}* (${safeText(quote.bookmaker)})`);
      if (result.verified && result.ticketOdds) lines.push(`Diferencia de precio boleto/referencia: ${((result.ticketOdds / quote.odds - 1) * 100).toFixed(1)}%`);
      if (result.verified && quote.fairProbability) lines.push(`Prob. implicita sin margen: ${(quote.fairProbability * 100).toFixed(1)}% (referencia de mercado, no prediccion)`);
      lines.push(`Consultada: ${safeText(result.checkedAt)}`);
      if (quote.updatedAt) lines.push(`Actualizacion del proveedor: ${safeText(quote.updatedAt)}`);
      lines.push(`Antiguedad: ${quote.ageMinutes === null ? 'desconocida' : `${quote.ageMinutes} min`}.`);
    }
    if (!result.verified) lines.push(`*SIN VERIFICAR:* ${safeText(result.reason)}`);
    if (result.assumedDate) lines.push(`Sin fecha legible: se consulto ${result.date} UTC.`);
    lines.push('');
  }
  lines.push(`Verificadas: ${audit.results.filter(result => result.verified).length}/${audit.results.length}.`);
  if (audit.results.some(result => /No se leyeron los equipos/.test(result.reason || ''))) {
    lines.push('Tip: Telegram comprime las fotos y los nombres pequenos se pierden. Envia la captura como Archivo o recortada a las selecciones.');
  }
  lines.push(`Consultas API-Football: ${audit.usage.requests}/10 (saldo ${audit.usage.remaining ?? 'no disponible'}, reserva 10). The Odds API: ${audit.usage.oddsApiRequests ?? 0}.`);
  lines.push('Cache maxima: 60 segundos. Solo se valida precio con actualizacion de hasta 15 min. No son cuotas en juego.');
  lines.push('Este contraste no acredita +EV, aprobacion de los 5 candados ni probabilidad conjunta; selecciones del mismo partido pueden estar correlacionadas.');
  return lines.join('\n');
}