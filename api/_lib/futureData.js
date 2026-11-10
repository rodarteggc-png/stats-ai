import { getOddsApiKeys, inMemoryExhaustedKeys } from '../../src/services/sportsApi.js';
import { getDynamicElo } from '../../src/services/history.js';
import { createTicketClient } from './parlayLive.js';

const cache = new Map();
const sports = {
  nba: { path: 'basketball/nba', odds: 'basketball_nba', output: 'nbaMatches', league: 'NBA' },
  nfl: { path: 'football/nfl', odds: 'americanfootball_nfl', output: 'nflMatches', league: 'NFL' },
  ncaaf: { path: 'football/college-football', odds: 'americanfootball_ncaaf', output: 'ncaafMatches', league: 'NCAAF' },
  mlb: { odds: 'baseball_mlb', output: 'mlbMatches', league: 'Major League Baseball' }
};

// Ligas de futbol por prioridad: el plan gratuito de API-Football solo cubre
// 48h y en semanas de paron de selecciones las 9 ligas principales no tienen
// partidos; sin segundo nivel el escaneo de futbol evaluaba 0 partidos.
const SOCCER_TIER_1_LEAGUES = [2, 3, 39, 61, 78, 135, 140, 253, 262];
const SOCCER_TIER_2_LEAGUES = [88, 94, 144, 203, 128, 71, 143, 137];

export function pickSoccerFixtures(fixtures, max = 6) {
  const sorted = [...fixtures].sort((first, second) => Date.parse(first.fixture.date) - Date.parse(second.fixture.date));
  const picked = sorted.filter(fixture => SOCCER_TIER_1_LEAGUES.includes(fixture.league?.id)).slice(0, max);
  if (picked.length < max) {
    const tier2 = sorted.filter(fixture => SOCCER_TIER_2_LEAGUES.includes(fixture.league?.id) && !picked.includes(fixture));
    picked.push(...tier2.slice(0, max - picked.length));
  }
  return { picked, usedTier2: picked.some(fixture => SOCCER_TIER_2_LEAGUES.includes(fixture.league?.id)) };
}

function normalized(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function recent(value, now) {
  const age = now - Date.parse(value);
  return Number.isFinite(age) && age >= -60000 && age <= 15 * 60000;
}

// Para el escaneo a 72h las cuotas de partidos de manana o pasado no se
// actualizan cada 15 minutos como las de hoy: se aceptan hasta 12h. Solo se
// usa en la ruta de futbol del futuro; las alertas del dia siguen con 15 min.
function recentFuture(value, now) {
  const age = now - Date.parse(value);
  return Number.isFinite(age) && age >= -60000 && age <= 12 * 3600000;
}

function price(value) {
  const number = Number(value);
  return number > 1 && number < 1000 ? number : null;
}

function applyBook(match, book) {
  const money = book.markets.find(market => market.key === 'h2h');
  const spread = book.markets.find(market => market.key === 'spreads');
  const total = book.markets.find(market => market.key === 'totals');
  const find = (market, name) => market?.outcomes?.find(outcome => normalized(outcome.name) === normalized(name));
  const home = find(money, match.home.name);
  const away = find(money, match.away.name);
  const homeSpread = find(spread, match.home.name);
  const awaySpread = find(spread, match.away.name);
  const over = find(total, 'Over');
  const under = find(total, 'Under');
  const validSpread = typeof homeSpread?.point === 'number' && typeof awaySpread?.point === 'number'
    && homeSpread.point === -awaySpread.point && price(homeSpread.price) && price(awaySpread.price);
  const validTotal = typeof over?.point === 'number' && over.point === under?.point && price(over.price) && price(under.price);
  match.spread = validSpread ? homeSpread.point : null;
  match.total = validTotal ? over.point : null;
  match.hasRealSpread = Boolean(validSpread);
  match.hasRealTotal = Boolean(validTotal);
  match.vegas = {
    ...(validSpread ? { spread: homeSpread.point, spreadHomeOdds: price(homeSpread.price), spreadAwayOdds: price(awaySpread.price) } : {}),
    ...(validTotal ? { overUnder: over.point, overOdds: price(over.price), underOdds: price(under.price) } : {})
  };
  match.market = {
    homeOdds: price(home?.price), awayOdds: price(away?.price), hasRealOdds: Boolean(price(home?.price) && price(away?.price)),
    ...match.vegas, homeSpreadOdds: match.vegas.spreadHomeOdds, awaySpreadOdds: match.vegas.spreadAwayOdds,
    vegasOverUnder: match.vegas.overUnder, sharpBookmaker: book.title, isPinnacle: book.key === 'pinnacle',
    updatedAt: book.last_update, current: price(home?.price), open: null
  };
  match.odds = { homeMl: match.market.homeOdds, awayMl: match.market.awayOdds, spread: match.spread, overUnder: match.total };
}

export async function loadFutureModelData(options = {}) {
  const now = options.now || Date.now;
  const start = now();
  const end = start + 72 * 3600000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  const fetchImpl = options.fetchImpl || fetch;
  const usage = { requests: 0, maxRequests: 60, oddsCalls: 0, oddsCredits: 0, apiFootball: null };
  const notices = [];
  const coverage = {};
  const result = { soccerMatches: [], nbaMatches: [], nflMatches: [], ncaafMatches: [], mlbMatches: [] };
  const request = async (input, config = {}) => {
    if (usage.requests >= 60 || now() - start >= 40000) throw new Error('Presupuesto global del escaneo agotado.');
    usage.requests++;
    const response = await fetchImpl(input, {
      ...config,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000), ...(config.signal ? [config.signal] : [])])
    });
    if (new URL(input).hostname === 'api.the-odds-api.com') {
      usage.oddsCalls++;
      usage.oddsCredits += Number(response.headers.get('x-requests-last')) || 0;
    }
    return response;
  };
  const json = async (url, config = {}) => {
    const key = `${url}:${JSON.stringify(config.headers || {})}`;
    const saved = cache.get(key);
    if (saved && now() - saved.at < 60000) return saved.data;
    const response = await request(url, config);
    if (!response.ok) throw new Error(`Fuente HTTP ${response.status}.`);
    const data = await response.json();
    cache.set(key, { data, at: now() });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return data;
  };
  const dateFrom = new Date(start).toISOString().slice(0, 10);
  const dateTo = new Date(end).toISOString().slice(0, 10);
  const espnDates = `${dateFrom.replaceAll('-', '')}-${dateTo.replaceAll('-', '')}`;
  const keys = options.oddsKeys || getOddsApiKeys();
  async function oddsForKey(oddsKey, regions, markets) {
    const fromIso = new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const toIso = new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const key of keys.filter(key => !inMemoryExhaustedKeys.has(key)).slice(0, 2)) {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${oddsKey}/odds/`);
      url.search = new URLSearchParams({ apiKey: key, regions, markets, bookmakers: 'pinnacle,bet365',
        commenceTimeFrom: fromIso, commenceTimeTo: toIso }).toString();
      try {
        const response = await request(url);
        if ([401, 429].includes(response.status)) { inMemoryExhaustedKeys.add(key); continue; }
        if (response.status === 404) {
          // Deporte fuera de temporada (ej. MLB en invierno)
          return [];
        }
        if (!response.ok) throw new Error(`Cuotas HTTP ${response.status}.`);
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Formato de cuotas no valido.');
        return data;
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
    }
    throw new Error('Sin cuotas disponibles en el pool The Odds API.');
  }
  async function oddsFor(sport) {
    return oddsForKey(sports[sport].odds, 'us,eu', 'h2h,spreads,totals');
  }
  async function footballStats(sport, team) {
    const data = await json(`https://site.api.espn.com/apis/site/v2/sports/${sports[sport].path}/teams/${team.id}/statistics`);
    const stats = (data.results?.stats?.categories || []).flatMap(category => category.stats || []);
    const stat = name => {
      const entry = stats.find(value => value.name === name);
      const value = Number(String(entry?.value ?? entry?.displayValue ?? '').replaceAll(',', ''));
      return entry && Number.isFinite(value) ? value : null;
    };
    const yards = stat('totalYards');
    const plays = stat('totalOffensivePlays');
    const turnover = stat('turnOverDifferential');
    if (!(yards > 0) || !(plays > 0) || turnover === null) throw new Error('Estadisticas de equipo incompletas.');
    return { ...team, ypp: yards / plays, netYardsPerPlay: yards / plays, turnoverDiff: turnover, turnoverDifferential: turnover, elo: getDynamicElo(team.name) };
  }
  async function loadAmericanSport(sport) {
    const config = sports[sport];
    const fetchSchedule = async () => {
      if (sport === 'mlb') {
        return json(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${dateFrom}&endDate=${dateTo}&hydrate=probablePitcher,team`);
      }
      const url = `https://site.api.espn.com/apis/site/v2/sports/${config.path}/scoreboard?dates=${espnDates}&limit=100${sport === 'ncaaf' ? '&groups=80' : ''}`;
      try {
        return await json(url);
      } catch (err) {
        // ESPN rechaza rangos con guion en scoreboard (HTTP 400) en NBA, NFL y
        // NCAAF. Fallback consultando fecha por fecha (antes solo existia para NBA):
        if (err.message && err.message.includes('400')) {
          const days = [];
          for (let d = new Date(start); d < new Date(end); d.setDate(d.getDate() + 1)) {
            days.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
          }
          const daysData = await Promise.all(days.map(dt =>
            json(`https://site.api.espn.com/apis/site/v2/sports/${config.path}/scoreboard?dates=${dt}&limit=100${sport === 'ncaaf' ? '&groups=80' : ''}`).catch(() => ({ events: [] }))
          ));
          return { events: daysData.flatMap(d => d.events || []) };
        }
        throw err;
      }
    };

    const schedule = await fetchSchedule();
    const fixtures = sport === 'mlb' ? (schedule.dates || []).flatMap(date => date.games || []).map(game => ({
      id: game.gamePk, date: game.gameDate, pending: ['Scheduled', 'Pre-Game'].includes(game.status?.detailedState),
      home: { id: game.teams?.home?.team?.id, name: game.teams?.home?.team?.name, pitcherId: game.teams?.home?.probablePitcher?.id, pitcherName: game.teams?.home?.probablePitcher?.fullName },
      away: { id: game.teams?.away?.team?.id, name: game.teams?.away?.team?.name, pitcherId: game.teams?.away?.probablePitcher?.id, pitcherName: game.teams?.away?.probablePitcher?.fullName }
    })) : (schedule.events || []).map(event => {
      const competition = event.competitions?.[0];
      const home = competition?.competitors?.find(team => team.homeAway === 'home')?.team;
      const away = competition?.competitors?.find(team => team.homeAway === 'away')?.team;
      return { id: event.id, date: event.date, pending: event.status?.type?.state === 'pre',
        home: { id: home?.id, name: home?.displayName }, away: { id: away?.id, name: away?.displayName } };
    });
    const upcoming = fixtures.filter(game => game.pending && Date.parse(game.date) > start && Date.parse(game.date) < end)
      .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
    coverage[sport] = { scheduled: upcoming.length, evaluated: 0, skipped: 0 };
    let odds;
    try {
      odds = await oddsFor(sport);
    } catch (error) {
      // Sin cuotas no se puede evaluar ningun partido, pero el deporte ya no
      // se tumba entero: queda registrado cuantos habia programados y el motivo.
      notices.push(`${config.league}: ${error.message}`);
      return;
    }
    for (const game of upcoming.slice(0, 4)) {
      try {
        const matching = odds.filter(event => normalized(event.home_team) === normalized(game.home.name)
          && normalized(event.away_team) === normalized(game.away.name) && Math.abs(Date.parse(event.commence_time) - Date.parse(game.date)) < 15 * 60000);
        if (matching.length !== 1) throw new Error('Sin cruce unico de equipos y horario con cuotas.');
        const book = matching[0].bookmakers?.filter(book => ['pinnacle', 'bet365'].includes(book.key) && recent(book.last_update, now()))
          .sort((first, second) => Number(second.key === 'pinnacle') - Number(first.key === 'pinnacle'))[0];
        if (!book) throw new Error('Sin cuota sharp actualizada en 15 minutos.');
        const match = { id: `${sport}-${game.id}`, sport, league: config.league, gameDate: game.date, date: game.date, home: game.home, away: game.away, inputBasis: sport === 'nba' ? 'Baseline NBA existente; no alineaciones confirmadas' : 'Estadisticas oficiales de temporada; no alineaciones confirmadas' };
        applyBook(match, { ...book, markets: (book.markets || []).filter(market => recent(market.last_update || book.last_update, now())) });
        if (sport === 'nfl' || sport === 'ncaaf') {
          [match.home, match.away] = await Promise.all([footballStats(sport, game.home), footballStats(sport, game.away)]);
          if (!match.hasRealSpread || !match.hasRealTotal) throw new Error('Faltan lineas y precios reales para el modelo de americano.');
        }
        if (sport === 'mlb') {
          const teamStats = async team => {
            if (!team.pitcherId) throw new Error('Abridor no anunciado; se omite MLB.');
            const [batting, pitching] = await Promise.all([
              json(`https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=season&group=hitting`),
              json(`https://statsapi.mlb.com/api/v1/people/${team.pitcherId}/stats?stats=season&group=pitching`)
            ]);
            const ops = Number(batting.stats?.[0]?.splits?.[0]?.stat?.ops);
            const whip = Number(pitching.stats?.[0]?.splits?.[0]?.stat?.whip);
            if (!(ops > 0) || !(whip > 0)) throw new Error('Sin OPS o WHIP oficiales.');
            return { ...team, ops, pitcher: { name: team.pitcherName, whip }, elo: getDynamicElo(team.name) };
          };
          [match.home, match.away] = await Promise.all([teamStats(game.home), teamStats(game.away)]);
        }
        result[config.output].push(match);
        coverage[sport].evaluated++;
      } catch (error) {
        coverage[sport].skipped++;
        notices.push(`${config.league}: ${error.message}`);
      }
    }
    if (upcoming.length > 4) notices.push(`${config.league}: muestra de 4 partidos; cobertura parcial.`);
  }
  let footballClient;
  async function loadSoccerPrimary() {
    footballClient = createTicketClient({ ...options, now, fetchImpl: request, maxRequests: 30, reserveRequests: 10, budgetMs: 35000 });
    await footballClient.request('/status');
    const fixtures = new Map();
    for (let date = Math.floor(start / 86400000) * 86400000; date < end; date += 86400000) {
      const dateStr = new Date(date).toISOString().slice(0, 10);
      try {
        const response = await footballClient.request('/fixtures', { date: dateStr });
        for (const fixture of response.data || []) {
          if (fixture.fixture?.status?.short === 'NS' && Date.parse(fixture.fixture.date) > start && Date.parse(fixture.fixture.date) < end) {
            fixtures.set(fixture.fixture.id, fixture);
          }
        }
      } catch (err) {
        if (err.message && err.message.toLowerCase().includes('free plans do not have access')) {
          notices.push('Futbol: Plan gratuito de API-Sports limitado a 48h (hoy y mañana); fechas posteriores omitidas.');
          break;
        }
        throw err;
      }
    }
    coverage.futbol = { scheduled: fixtures.size, evaluated: 0, skipped: 0 };
    const { picked: priority, usedTier2 } = pickSoccerFixtures([...fixtures.values()]);
    if (usedTier2) notices.push('Futbol: sin suficientes partidos de ligas principales en 48h; se incluyeron ligas de segundo nivel (Eredivisie, Primeira Liga, Copa del Rey, Coppa Italia, etc.).');
    for (const fixture of priority) {
      try {
        let event;
        let book;
        for (const bookmaker of ['4', '8']) {
          const response = await footballClient.request('/odds', { fixture: String(fixture.fixture.id), bookmaker });
          event = response.data.find(item => item.fixture?.id === fixture.fixture.id && recentFuture(item.update, now()));
          book = event?.bookmakers?.find(book => book.id === Number(bookmaker));
          if (book) break;
        }
        if (!book) throw new Error('Sin cuotas prepartido recientes.');
        const teamStats = async team => {
          const response = await footballClient.request('/teams/statistics', { team: String(team.id), league: String(fixture.league.id), season: String(fixture.league.season) });
          const stats = response.data;
          const average = Number(stats?.goals?.for?.average?.total);
          if (!(average > 0) || !(stats?.fixtures?.played?.total >= 5)) throw new Error('Muestra de goles insuficiente para modelar.');
          return { name: team.name, xG: average, elo: getDynamicElo(team.name) };
        };
        const [home, away] = await Promise.all([teamStats(fixture.teams.home), teamStats(fixture.teams.away)]);
        const bet = name => book.bets?.find(bet => bet.name === name)?.values || [];
        const odd = (name, value) => price(bet(name).find(item => item.value === value)?.odd);
        const match = { id: `future-${fixture.fixture.id}`, sport: 'futbol', league: fixture.league.name, gameDate: fixture.fixture.date, home, away,
          inputBasis: 'Promedio oficial de goles como tasa del modelo; no xG medido ni alineaciones confirmadas',
          market: { homeOdds: odd('Match Winner', 'Home'), awayOdds: odd('Match Winner', 'Away'), drawOdds: odd('Match Winner', 'Draw'), bttsOdds: odd('Both Teams Score', 'Yes'),
            sharpBookmaker: book.name, isPinnacle: book.id === 4, updatedAt: event.update },
          vegas: { overUnder: 2.5, overOdds: odd('Goals Over/Under', 'Over 2.5'), underOdds: odd('Goals Over/Under', 'Under 2.5') } };
        match.market.hasRealOdds = Boolean(match.market.homeOdds && match.market.awayOdds && match.market.drawOdds);
        result.soccerMatches.push(match);
        coverage.futbol.evaluated++;
      } catch (error) {
        coverage.futbol.skipped++;
        notices.push(`Futbol: ${error.message}`);
      }
    }
    if (fixtures.size > priority.length) notices.push('Futbol: muestra de hasta 6 partidos de ligas principales; cobertura parcial.');
  }

  // Respaldo de fútbol cuando API-Sports no responde (suspendida, 429 o sin
  // saldo): calendario por ESPN (gratis, sin llave) + cuotas por The Odds API.
  // Mejora 2, 2026-11-10. Solo ligas principales con slug ESPN y clave de
  // cuotas conocidos; las copas (Copa del Rey, Coppa Italia) no tienen
  // respaldo y quedan fuera con aviso. Máximo 4 ligas y 6 partidos para no
  // quemar el pool de cuotas (3 créditos por liga: h2h+totals+btts en UE).
  const SOCCER_FALLBACK_LEAGUES = [
    { apiFootballId: 39, espn: 'eng.1', odds: 'soccer_epl', name: 'Premier League' },
    { apiFootballId: 140, espn: 'esp.1', odds: 'soccer_spain_la_liga', name: 'LaLiga' },
    { apiFootballId: 135, espn: 'ita.1', odds: 'soccer_italy_serie_a', name: 'Serie A' },
    { apiFootballId: 78, espn: 'ger.1', odds: 'soccer_germany_bundesliga', name: 'Bundesliga' },
  ];

  async function loadSoccerFallback(reason) {
    const days = [];
    for (let d = new Date(start); d < new Date(end); d.setDate(d.getDate() + 1)) {
      days.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
    }
    const fixtures = [];
    const seenFixtureIds = new Set();
    for (const league of SOCCER_FALLBACK_LEAGUES) {
      for (const day of days) {
        try {
          const data = await json(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espn}/scoreboard?dates=${day}&limit=100`);
          for (const ev of data.events || []) {
            const comp = ev.competitions?.[0];
            if (comp?.status?.type?.state !== 'pre') continue;
            const home = comp.competitors?.find(c => c.homeAway === 'home')?.team;
            const away = comp.competitors?.find(c => c.homeAway === 'away')?.team;
            if (!home || !away) continue;
            const date = Date.parse(ev.date);
            if (date > start && date < end && !seenFixtureIds.has(ev.id)) {
              seenFixtureIds.add(ev.id);
              fixtures.push({ league, id: ev.id, date: ev.date, home, away });
            }
          }
        } catch {
          // Liga/día sin datos en ESPN: se omite sin tumbar el respaldo.
        }
      }
    }
    coverage.futbol = { scheduled: fixtures.length, evaluated: 0, skipped: 0 };
    const picked = fixtures.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 6);
    const oddsByLeague = new Map();
    for (const league of [...new Set(picked.map(f => f.league))]) {
      try {
        oddsByLeague.set(league.espn, await oddsForKey(league.odds, 'eu', 'h2h,totals,btts'));
      } catch (error) {
        notices.push(`Futbol (respaldo): sin cuotas para ${league.name}: ${error.message}`);
      }
    }
    const espnTeamGoals = async (league, team) => {
      const data = await json(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espn}/teams/${team.id}/statistics`);
      const stats = (data.results?.stats?.categories || []).flatMap(category => category.stats || []);
      const value = (names) => {
        const entry = stats.find(item => names.includes(String(item.name).toLowerCase()));
        const parsed = Number(String(entry?.value ?? entry?.displayValue ?? '').replaceAll(',', ''));
        return Number.isFinite(parsed) ? parsed : null;
      };
      const goals = value(['goals', 'totalgoals', 'goalsscored']);
      const games = value(['gamesplayed', 'appearances', 'matchesplayed', 'games']);
      if (!(goals > 0) || !(games >= 5)) throw new Error('Sin promedio de goles ESPN suficiente para modelar.');
      return { name: team.displayName, xG: goals / games, elo: getDynamicElo(team.displayName) };
    };
    for (const fixture of picked) {
      try {
        const events = oddsByLeague.get(fixture.league.espn) || [];
        const matching = events.filter(event => normalized(event.home_team) === normalized(fixture.home.displayName)
          && normalized(event.away_team) === normalized(fixture.away.displayName)
          && Math.abs(Date.parse(event.commence_time) - Date.parse(fixture.date)) < 15 * 60000);
        if (matching.length !== 1) throw new Error('Sin cruce unico de equipos y horario con cuotas.');
        const book = matching[0].bookmakers?.filter(item => ['pinnacle', 'bet365'].includes(item.key) && recentFuture(item.last_update, now()))
          .sort((first, second) => Number(second.key === 'pinnacle') - Number(first.key === 'pinnacle'))[0];
        if (!book) throw new Error('Sin cuota sharp actualizada en 12h.');
        const [home, away] = await Promise.all([
          espnTeamGoals(fixture.league, fixture.home),
          espnTeamGoals(fixture.league, fixture.away),
        ]);
        const find = (marketKey, outcomeName) => {
          const market = book.markets?.find(item => item.key === marketKey);
          const outcome = market?.outcomes?.find(item => normalized(item.name) === normalized(outcomeName));
          return price(outcome?.price);
        };
        const total = book.markets?.find(item => item.key === 'totals');
        const over = total?.outcomes?.find(item => normalized(item.name) === 'over' && item.point === 2.5);
        const under = total?.outcomes?.find(item => normalized(item.name) === 'under' && item.point === 2.5);
        const match = { id: `future-fallback-${fixture.id}`, sport: 'futbol', league: fixture.league.name, gameDate: fixture.date, home, away,
          inputBasis: 'Respaldo ESPN + The Odds API: promedio de goles de temporada ESPN como tasa del modelo; no xG medido ni alineaciones confirmadas',
          market: { homeOdds: find('h2h', fixture.home.displayName), awayOdds: find('h2h', fixture.away.displayName), drawOdds: find('h2h', 'Draw'), bttsOdds: find('btts', 'Yes'),
            sharpBookmaker: book.title, isPinnacle: book.key === 'pinnacle', updatedAt: book.last_update },
          vegas: { overUnder: 2.5, overOdds: price(over?.price), underOdds: price(under?.price) } };
        match.market.hasRealOdds = Boolean(match.market.homeOdds && match.market.awayOdds && match.market.drawOdds);
        if (!match.market.hasRealOdds) throw new Error('Cuotas 1X2 incompletas en el respaldo.');
        result.soccerMatches.push(match);
        coverage.futbol.evaluated++;
      } catch (error) {
        coverage.futbol.skipped++;
        notices.push(`Futbol (respaldo): ${error.message}`);
      }
    }
    notices.push(`Futbol: API-Sports no disponible (${reason}); respaldo ESPN + The Odds API: ${coverage.futbol.evaluated} evaluados de ${coverage.futbol.scheduled} programados.`);
  }

  async function loadSoccer() {
    try {
      await loadSoccerPrimary();
    } catch (error) {
      notices.push(`Futbol: ruta principal falló: ${error.message}`);
      try {
        await loadSoccerFallback(error.message);
      } catch (fallbackError) {
        notices.push(`Futbol: respaldo también falló: ${fallbackError.message}`);
        coverage.futbol ||= { scheduled: null, evaluated: 0, skipped: 0 };
      }
    }
  }
  try {
    const jobs = [loadSoccer(), ...Object.keys(sports).map(loadAmericanSport)];
    const outcomes = await Promise.allSettled(jobs);
    outcomes.forEach((outcome, index) => {
      const sport = ['futbol', ...Object.keys(sports)][index];
      if (outcome.status === 'rejected') notices.push(`${sport.toUpperCase()}: ${outcome.reason.message}`);
      coverage[sport] ||= { scheduled: null, evaluated: 0, skipped: 0 };
    });
    usage.apiFootball = footballClient?.usage();
    return { matches: result, coverage, notices, usage };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}