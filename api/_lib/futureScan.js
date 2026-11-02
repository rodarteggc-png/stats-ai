import { createTicketClient } from './parlayLive.js';

const snapshots = new Map();
const HOUR_MS = 60 * 60 * 1000;

function safeText(value) {
  return String(value ?? '').replace(/[_*`[\]<>\r\n]/g, ' ').slice(0, 100);
}

function fresh(event, timestamp) {
  const age = timestamp - Date.parse(event?.update);
  return Number.isFinite(age) && age >= -60000 && age <= 15 * 60000;
}

function markets(book) {
  const result = [];
  for (const bet of book?.bets || []) {
    let groups = [];
    if (bet.name === 'Match Winner') groups = [{ label: 'Ganador', outcomes: ['Home', 'Draw', 'Away'] }];
    if (bet.name === 'Both Teams Score') groups = [{ label: 'Ambos anotan', outcomes: ['Yes', 'No'] }];
    if (bet.name === 'Goals Over/Under') {
      const lines = new Set((bet.values || []).map(value => value.value?.match(/^Over (\d+\.5)$/)?.[1]).filter(Boolean));
      groups = [...lines].map(line => ({ label: `Goles ${line}`, outcomes: [`Over ${line}`, `Under ${line}`] }));
    }
    for (const group of groups) {
      const values = group.outcomes.map(outcome => {
        const matches = (bet.values || []).filter(value => value.value === outcome);
        const odds = matches.length === 1 ? Number(matches[0].odd) : NaN;
        return { outcome, odds };
      });
      if (values.every(value => Number.isFinite(value.odds) && value.odds > 1 && value.odds < 100)) {
        result.push({ ...group, values });
      }
    }
  }
  return result;
}

export async function scanFuture72Hours(options = {}) {
  const now = options.now || Date.now;
  const start = now();
  const end = start + 72 * HOUR_MS;
  const client = createTicketClient({ ...options, now, maxRequests: 13, reserveRequests: 30, budgetMs: 35000 });
  const history = options.snapshots || snapshots;
  const dates = [];
  for (let day = Math.floor(start / (24 * HOUR_MS)) * 24 * HOUR_MS; day < end; day += 24 * HOUR_MS) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  const report = {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    candidates: [], fixtures: 0, compared: 0, stale: 0, dates: dates.length,
    datesLoaded: 0, partial: false, notices: [], observations: 0
  };
  const fixtures = new Map();
  const events = new Map();
  const stop = () => client.usage().remaining <= 30 || client.usage().requests >= 13 || now() - start >= 35000;
  try {
    await client.request('/status');
    for (const date of dates) {
      if (stop()) { report.partial = true; break; }
      try {
        const response = await client.request('/fixtures', { date });
        report.datesLoaded++;
        if (response.paging?.total > 1) report.partial = true;
        for (const item of response.data) {
          const kickoff = Date.parse(item.fixture?.date);
          if (item.fixture?.id && item.fixture.status?.short === 'NS' && kickoff > start && kickoff < end
            && item.teams?.home?.name && item.teams?.away?.name) {
            fixtures.set(item.fixture.id, { ...item, date });
          }
        }
      } catch (error) {
        report.partial = true;
        report.notices.push(`${date}: calendario no disponible (${error.message}).`);
      }
    }
    report.fixtures = fixtures.size;
    for (const date of dates) {
      if (![...fixtures.values()].some(fixture => fixture.date === date)) continue;
      for (const bookmaker of ['4', '8']) {
        if (stop()) { report.partial = true; break; }
        try {
          const response = await client.request('/odds', { date, bookmaker, page: '1' });
          if (response.paging?.total > 1) report.partial = true;
          for (const item of response.data) {
            if (!fixtures.has(item.fixture?.id)) continue;
            const book = item.bookmakers?.find(book => book.id === Number(bookmaker));
            if (!book) continue;
            const row = events.get(item.fixture.id) || {};
            row[bookmaker] = { ...item, book, checkedAt: response.checkedAt };
            events.set(item.fixture.id, row);
          }
        } catch (error) {
          report.partial = true;
          report.notices.push(`${date}: cuotas ${bookmaker === '4' ? 'Pinnacle' : 'Bet365'} no disponibles (${error.message}).`);
        }
      }
    }
  } catch (error) {
    report.partial = true;
    report.notices.push(`No se pudo verificar el saldo: ${error.message}`);
  }
  for (const [key, value] of history) if (value.expires <= start) history.delete(key);
  const candidates = [];
  for (const [fixtureId, row] of events) {
    if (!row['4'] || !row['8']) continue;
    if (!fresh(row['4'], now()) || !fresh(row['8'], now())) { report.stale++; continue; }
    report.compared++;
    const fixture = fixtures.get(fixtureId);
    if (Date.parse(fixture.fixture.date) <= now()) { report.compared--; continue; }
    const referenceMarkets = markets(row['4'].book);
    const offeredMarkets = markets(row['8'].book);
    for (const market of referenceMarkets) {
      const other = offeredMarkets.find(other => other.label === market.label);
      if (!other) continue;
      const margin = market.values.reduce((sum, value) => sum + 1 / value.odds, 0);
      if (margin < 1 || margin > 1.5) continue;
      for (const value of market.values) {
        const offered = other.values.find(other => other.outcome === value.outcome);
        if (!offered) continue;
        const key = `${fixtureId}:${market.label}:${value.outcome}`;
        const previous = history.get(key);
        if (!previous) {
          history.set(key, { odds: offered.odds, at: row['8'].checkedAt, expires: Date.parse(fixture.fixture.date) });
          report.observations++;
        }
        const fairPrice = value.odds * margin;
        const premium = (offered.odds / fairPrice - 1) * 100;
        if (premium < 2) continue;
        candidates.push({
          fixtureId, match: `${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
          kickoff: fixture.fixture.date, league: fixture.league?.name || 'Futbol',
          market: market.label, selection: ({ Home: fixture.teams.home.name, Away: fixture.teams.away.name, Draw: 'Empate', Yes: 'Si', No: 'No' })[value.outcome] || value.outcome,
          odds: offered.odds, referenceOdds: value.odds, fairPrice, premium,
          providerUpdatedAt: row['8'].update, referenceUpdatedAt: row['4'].update,
          checkedAt: row['8'].checkedAt,
          previous: previous ? { ...previous, changePct: (offered.odds / previous.odds - 1) * 100 } : null
        });
      }
    }
  }
  while (history.size > 2000) history.delete(history.keys().next().value);
  candidates.sort((first, second) => second.premium - first.premium || Date.parse(first.kickoff) - Date.parse(second.kickoff));
  const selected = new Set();
  report.candidates = candidates.filter(candidate => {
    if (selected.has(candidate.fixtureId)) return false;
    selected.add(candidate.fixtureId);
    return true;
  }).slice(0, 5);
  if (report.compared < fixtures.size) report.partial = true;
  report.usage = client.usage();
  return report;
}

export function formatFutureScan(report) {
  const lines = [
    '*VIP | PROXIMAS 72 HORAS*',
    'Candidatos preliminares de precio | Solo futbol',
    `${report.start} a ${report.end} (UTC)`,
    '',
    `Calendarios: ${report.datesLoaded}/${report.dates}. Partidos pendientes: ${report.fixtures}.`,
    `Cotejados con ambas casas y cuota reciente: ${report.compared}. Pares atrasados: ${report.stale}.`,
    report.partial ? '*Cobertura parcial:* primera pagina por casa/fecha, limite de consultas o datos faltantes.' : 'Cobertura completa de los partidos disponibles en la ventana.',
    ''
  ];
  for (const [index, candidate] of report.candidates.entries()) {
    lines.push(
      `*${index + 1}. ${safeText(candidate.match)}*`,
      `${safeText(candidate.league)} | Inicio: ${safeText(candidate.kickoff)}`,
      `${safeText(candidate.market)}: ${safeText(candidate.selection)}`,
      `Bet365: *${candidate.odds.toFixed(2)}* | Pinnacle: ${candidate.referenceOdds.toFixed(2)}`,
      `Precio teorico Pinnacle sin margen: ${candidate.fairPrice.toFixed(2)}. Diferencia: +${candidate.premium.toFixed(1)}%.`,
      `Motivo: Bet365 paga mas que la referencia de mercado sin margen; no es una prediccion.`,
      `Actualizaciones: Bet365 ${safeText(candidate.providerUpdatedAt)} | Pinnacle ${safeText(candidate.referenceUpdatedAt)}`,
      candidate.previous
        ? `Primera observacion Bet365: ${candidate.previous.odds.toFixed(2)} (${safeText(candidate.previous.at)}); cambio ${candidate.previous.changePct.toFixed(1)}%.`
        : 'Primera observacion: aun no hay comparacion temporal.',
      ''
    );
  }
  if (!report.candidates.length) lines.push('No se encontraron discrepancias de precio >=2% en los datos comparables. No implica que el resto del mercado carezca de oportunidades.', '');
  for (const notice of report.notices.slice(0, 3)) lines.push(safeText(notice));
  lines.push(
    `Consumo: ${report.usage.requests}/13 consultas. Saldo reportado: ${report.usage.remaining ?? 'no disponible'}. Reserva observada: 30.`,
    'Cuotas con actualizacion de hasta 15 min; cache de hasta 60 s. Deben confirmarse antes de apostar.',
    'Son candidatos, no picks oficiales: sin aprobacion del modelo/candados, sin stake y sin registro en el ledger.',
    'No se confirma RLM ni dinero publico. Las referencias temporales son de esta instancia y pueden perderse al reiniciar Vercel.'
  );
  return lines.join('\n');
}