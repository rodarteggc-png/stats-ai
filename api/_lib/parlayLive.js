import { getApiSportsKey } from '../../src/services/apiSports.js';

const cache = new Map();
const RESERVE_REQUESTS = 10;
const MAX_TICKET_REQUESTS = 10;

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
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(word => word && !['fc', 'cf', 'club', 'sc', 'afc'].includes(word)).join(' ');
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
    'Lee este boleto de apuestas. Devuelve SOLO las selecciones individuales, no la cuota total.',
    `Hoy es ${new Date().toISOString().slice(0, 10)} UTC. No inventes equipos, rivales, fechas ni cuotas ausentes.`,
    'sport: football para futbol soccer, nba/nfl/mlb para esos deportes, unknown si no es claro.',
    'homeTeam y awayTeam son local y visitante; si no se identifican ambos deja el dato null.',
    'market: match_winner, goals_over_under, both_teams_score, double_chance, asian_handicap o unknown.',
    'selection: home, away, draw, over, under, yes, no, home_draw, draw_away o home_away; unknown si no se identifica.',
    'line: numero exacto del total o handicap de la seleccion; null si no aplica o no se lee.',
    'ticketOdds: copia la cuota individual visible como cadena, decimal o americana con signo; null si no se lee.',
    'date: fecha del partido YYYY-MM-DD solo si figura en el boleto; null si no figura.',
    'No confundas tiros, corners, periodos ni goles de un equipo con goles totales del partido; usa unknown para esos mercados.',
    'Si hay mas de 8 selecciones, indica tooMany=true y devuelve solo las primeras 8.',
    text ? `Texto del boleto: ${text.slice(0, 12000)}` : ''
  ].join('\n') }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  const nullableString = { type: 'STRING', nullable: true };
  const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT', required: ['selections', 'tooMany'], properties: {
            tooMany: { type: 'BOOLEAN' },
            selections: { type: 'ARRAY', maxItems: 8, items: {
              type: 'OBJECT',
              required: ['homeTeam', 'awayTeam', 'sport', 'date', 'market', 'selection', 'line', 'ticketOdds'],
              properties: {
                homeTeam: nullableString, awayTeam: nullableString, sport: { type: 'STRING' },
                date: nullableString, market: { type: 'STRING' }, selection: { type: 'STRING' },
                line: { type: 'NUMBER', nullable: true }, ticketOdds: nullableString
              }
            } }
          }
        }
      }
    }),
    signal: AbortSignal.timeout(18000)
  });
  if (!response.ok) throw new Error(`Lectura del boleto no disponible (HTTP ${response.status}).`);
  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('');
  if (!content) throw new Error('No se pudieron leer selecciones en el boleto.');
  const ticket = JSON.parse(content);
  if (!Array.isArray(ticket.selections) || !ticket.selections.length) throw new Error('No se detectaron selecciones.');
  if (ticket.tooMany || ticket.selections.length > 8) throw new Error('Envia el boleto en partes de hasta 8 selecciones.');
  return ticket.selections;
}

function findMarketQuote(event, leg, reversed) {
  let selection = leg.selection;
  if (reversed) {
    selection = ({ home: 'away', away: 'home', home_draw: 'draw_away', draw_away: 'home_draw' })[selection] || selection;
  }
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

export async function auditTicketLive(selections, options = {}) {
  const client = createTicketClient(options);
  const results = [];
  const today = new Date(options.now ? options.now() : Date.now()).toISOString().slice(0, 10);
  let initialized = false;
  let initializationError;
  for (const leg of selections.slice(0, 8)) {
    const result = { ...leg, ticketOdds: decimalOdds(leg.ticketOdds), verified: false };
    results.push(result);
    try {
      if (leg.sport !== 'football') throw new Error('Deporte sin cobertura en esta cuenta API-Football.');
      if (!leg.homeTeam || !leg.awayTeam) throw new Error('Faltan ambos equipos; envia el partido completo.');
      if (!['match_winner', 'goals_over_under', 'both_teams_score', 'double_chance', 'asian_handicap'].includes(leg.market)) {
        throw new Error('Mercado no compatible; no se sustituye por otro.');
      }
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
      const home = normalizeTeam(leg.homeTeam);
      const away = normalizeTeam(leg.awayTeam);
      const matches = fixtures.data.filter(item => {
        const actualHome = normalizeTeam(item.teams?.home?.name);
        const actualAway = normalizeTeam(item.teams?.away?.name);
        return home && away && home !== away && ((actualHome === home && actualAway === away) || (actualHome === away && actualAway === home));
      });
      if (matches.length !== 1) throw new Error(matches.length ? 'Partido ambiguo; especifica fecha y equipos.' : 'No se encontro ese enfrentamiento en la fecha consultada.');
      const fixture = matches[0];
      result.fixtureId = fixture.fixture.id;
      result.match = `${fixture.teams.home.name} vs ${fixture.teams.away.name}`;
      result.kickoff = fixture.fixture.date;
      result.fixtureStatus = fixture.fixture.status?.short;
      if (result.fixtureStatus !== 'NS') throw new Error(`Partido ${result.fixtureStatus || 'sin estado'}: no se usan cuotas prepartido como si fueran en juego.`);
      const reversed = normalizeTeam(fixture.teams.home.name) !== home;
      for (const bookmaker of ['4', '8']) {
        const response = await client.request('/odds', { fixture: String(result.fixtureId), bookmaker });
        const quotes = response.data.filter(item => item.fixture?.id === result.fixtureId)
          .map(item => findMarketQuote(item, leg, reversed)).filter(Boolean);
        if (quotes.length) {
          const quote = quotes[0];
          const timestamp = Date.parse(quote.updatedAt);
          const ageMs = (options.now ? options.now() : Date.now()) - timestamp;
          quote.ageMinutes = Number.isFinite(ageMs) && ageMs >= -60000 ? Math.max(0, Math.floor(ageMs / 60000)) : null;
          quote.fresh = quote.ageMinutes !== null && ageMs <= 15 * 60000;
          if (!result.quote || quote.fresh || (Number.isFinite(timestamp) && timestamp > Date.parse(result.quote.updatedAt || '1970-01-01'))) {
            result.quote = quote;
            result.checkedAt = response.checkedAt;
          }
          if (quote.fresh) { result.verified = true; break; }
        }
      }
      if (!result.verified) throw new Error(result.quote
        ? 'La ultima cuota publicada supera 15 minutos o no tiene hora verificable; no confirma el precio actual.'
        : 'Sin cuota para ese mercado y linea en Pinnacle/Bet365.');
    } catch (error) {
      result.reason = error.name === 'TimeoutError' ? 'El proveedor no respondio a tiempo.' : error.message;
    }
  }
  return { results, usage: client.usage(), checkedAt: new Date(options.now ? options.now() : Date.now()).toISOString() };
}

function safeText(value) {
  return String(value ?? '').replace(/[_*`[\]<>]/g, '').replace(/[\r\n]/g, ' ').slice(0, 160);
}

export function formatLiveTicketReport(audit) {
  const lines = ['*BOLETO: CONTRASTE CON CUOTAS ACTUALES*', 'API-Football | Prepartido | Pinnacle / Bet365', ''];
  const markets = { match_winner: 'Ganador', goals_over_under: 'Goles totales', both_teams_score: 'Ambos anotan', double_chance: 'Doble oportunidad', asian_handicap: 'Handicap asiatico' };
  for (const [index, result] of audit.results.entries()) {
    const selections = { home: result.homeTeam, away: result.awayTeam, draw: 'Empate', over: 'Mas de', under: 'Menos de', yes: 'Si', no: 'No', home_draw: `${result.homeTeam} o empate`, draw_away: `Empate o ${result.awayTeam}`, home_away: 'Sin empate' };
    lines.push(`*${index + 1}. ${safeText(result.match || `${result.homeTeam || '?'} vs ${result.awayTeam || '?'}`)}*`);
    lines.push(`${safeText(markets[result.market] || result.market)}: ${safeText(selections[result.selection] || result.selection)}${result.line == null ? '' : ` ${result.line}`}`);
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
  lines.push(`Consultas de este boleto: ${audit.usage.requests}/10. Saldo diario reportado: ${audit.usage.remaining ?? 'no disponible'}. Reserva: 10.`);
  lines.push('Cache maxima: 60 segundos. Solo se valida precio con actualizacion de hasta 15 min. No son cuotas en juego.');
  lines.push('Este contraste no acredita +EV, aprobacion de los 5 candados ni probabilidad conjunta; selecciones del mismo partido pueden estar correlacionadas.');
  return lines.join('\n');
}