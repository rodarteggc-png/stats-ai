import { buildOpportunitiesAndTopSlate } from '../../scripts/alertEngine.js';
import { loadFutureModelData } from './futureData.js';

const observations = new Map();

export function selectHighProbabilityCandidates(opportunities, start, end) {
  const games = new Set();
  return opportunities.filter(pick => {
    const kickoff = Date.parse(pick.gameDate);
    return kickoff > start && kickoff < end && parseFloat(pick.prob) >= 65 && parseFloat(pick.prob) < 100
      && Number.isFinite(Number(pick.odds)) && Number(pick.odds) > 1 && pick.oddsSource === 'market' && Number.isFinite(pick.evPct) && pick.evPct > 0
      && pick.consensus?.votesPassed >= 2 && !pick.marketOutlier && !pick.match?.isPostponed
      && !pick.consensus?.rlmInfo?.isTrapForPick && !pick.consensus?.rlmInfo?.isVetoedByMarket
      && !(['NFL', 'NCAAF'].includes(pick.sport) && /OVER|UNDER|TOTALES/i.test(`${pick.type} ${pick.pick}`) && !pick.match?.weather?.verified)
      && !/PROP|JUGADOR|PLAYER/i.test(pick.type || '');
  }).sort((first, second) => parseFloat(second.prob) - parseFloat(first.prob) || second.evPct - first.evPct)
    .filter(pick => {
      const key = `${pick.sport}:${pick.game}`;
      if (games.has(key)) return false;
      games.add(key);
      return true;
    }).slice(0, 5);
}

export function buildConservativeCombination(candidates) {
  const legs = [];
  const teams = new Set();
  for (const candidate of candidates) {
    const names = [candidate.match?.home?.name, candidate.match?.away?.name].filter(Boolean).map(name => name.toLowerCase());
    if (names.length !== 2 || names.some(name => teams.has(name))) continue;
    legs.push(candidate);
    names.forEach(name => teams.add(name));
    if (legs.length === 2) break;
  }
  if (legs.length !== 2) return null;
  const probability = legs.reduce((product, leg) => product * parseFloat(leg.prob) / 100, 1);
  if (probability < 0.60) return null;
  return { legs, probability: probability * 100, odds: legs.reduce((product, leg) => product * Number(leg.odds), 1) };
}

export function evaluateFutureModels(matches, start, end, evaluate = buildOpportunitiesAndTopSlate) {
  const result = evaluate({ ...matches, isForce: true, sentCache: {}, maxPicksToSend: 100 });
  const candidates = selectHighProbabilityCandidates(result.approvedOpps || [], start, end);
  return { candidates, combination: buildConservativeCombination(candidates) };
}

export async function scanFutureMultiSport(options = {}) {
  const start = options.now ? options.now() : Date.now();
  const end = start + 72 * 3600000;
  const data = await (options.loadData || loadFutureModelData)(options);
  const approved = [];
  for (const [group, matches] of Object.entries(data.matches)) {
    for (const match of matches) {
      try {
        const result = (options.evaluate || buildOpportunitiesAndTopSlate)({ [group]: [match], isForce: true, sentCache: {}, maxPicksToSend: 100 });
        approved.push(...(result.approvedOpps || []));
      } catch (error) {
        data.notices.push(`${match.league}: modelo no evaluable (${error.message}).`);
      }
    }
  }
  const validMarkets = approved.filter(candidate => {
    if (!String(candidate.id || '').startsWith('mlb-rl-')) return true;
    const home = String(candidate.pick).includes(candidate.match.home.name);
    return (home ? candidate.match.spread : -candidate.match.spread) === 1.5;
  });
  const candidates = selectHighProbabilityCandidates(validMarkets, start, end);
  const history = options.observations || observations;
  for (const [key, value] of history) if (value.expires <= start) history.delete(key);
  for (const candidate of candidates) {
    const key = `${candidate.sport}:${candidate.game}:${candidate.pick}:${candidate.match?.market?.sharpBookmaker}`;
    const previous = history.get(key);
    candidate.previous = previous || null;
    if (!previous) history.set(key, { odds: Number(candidate.odds), at: new Date(start).toISOString(), expires: Date.parse(candidate.gameDate) });
  }
  while (history.size > 500) history.delete(history.keys().next().value);
  return { ...data, start: new Date(start).toISOString(), end: new Date(end).toISOString(), candidates, combination: buildConservativeCombination(candidates) };
}

function safeText(value, length = 160) {
  return String(value ?? '').replace(/[_*`[\]<>\r\n]/g, ' ').slice(0, length);
}

export function formatFutureMultiSport(report) {
  const lines = [
    '*VIP | PROXIMAS 72 HORAS | MULTIDEPORTE*',
    'Futbol | NBA | NFL | NCAAF | MLB',
    `${report.start} a ${report.end} (UTC)`,
    'Muestra acotada; candidatos preliminares con probabilidad calibrada >=65%, cuota real y consenso del modelo existente.',
    ''
  ];
  for (const sport of ['futbol', 'nba', 'nfl', 'ncaaf', 'mlb']) {
    const status = report.coverage[sport];
    lines.push(`${sport.toUpperCase()}: ${status?.scheduled ?? '?'} programados, ${status?.evaluated || 0} con datos para evaluar, ${status?.skipped || 0} omitidos.`);
  }
  lines.push('');
  for (const [index, pick] of report.candidates.entries()) {
    lines.push(
      `*${index + 1}. ${safeText(pick.game)}* (${safeText(pick.sport)})`,
      `${safeText(pick.pick)} @ *${Number(pick.odds).toFixed(2)}*`,
      `Probabilidad calibrada: *${parseFloat(pick.prob).toFixed(1)}%* | EV estimado: ${Number(pick.evPct).toFixed(1)}% | Consenso: ${pick.consensus.votesPassed}/3`,
      `Inicio: ${safeText(pick.gameDate)} | Casa: ${safeText(pick.match?.market?.sharpBookmaker)}`,
      `Cuota actualizada: ${safeText(pick.match?.market?.updatedAt)}`,
      pick.previous ? `Primera observacion: ${pick.previous.odds.toFixed(2)} (${safeText(pick.previous.at)}); cambio ${((Number(pick.odds) / pick.previous.odds - 1) * 100).toFixed(1)}%.` : 'Sin observacion previa de esta seleccion.',
      `Base: ${safeText(pick.match?.inputBasis)}`,
      ''
    );
  }
  if (!report.candidates.length) lines.push('Sin candidatos que cumplan alta probabilidad y los filtros con los datos disponibles. No se fuerzan selecciones.', '');
  if (report.combination) {
    const combo = report.combination;
    lines.push('*COMBINACION OPCIONAL | DOS PARTIDOS*');
    combo.legs.forEach(leg => lines.push(`${safeText(leg.game)}: ${safeText(leg.pick)} @ ${Number(leg.odds).toFixed(2)}`));
    lines.push(`Cuota multiplicada estimada: ${combo.odds.toFixed(2)}. Probabilidad conjunta: ${combo.probability.toFixed(1)}%.`,
      'Estimacion bajo independencia, no garantia ni cuota cotizada de una combinada. Dos patas siempre reducen la probabilidad frente a jugar cada una por separado.', '');
  } else lines.push('No se construye combinada: faltan dos partidos de equipos distintos cuya probabilidad conjunta estimada alcance 60%.', '');
  for (const notice of [...new Set(report.notices)].slice(0, 6)) lines.push(safeText(notice));
  lines.push(
    `Red: ${report.usage.requests}/60 peticiones. API-Football: ${report.usage.apiFootball?.requests ?? 0}/30; saldo ${report.usage.apiFootball?.remaining ?? '?'}; reserva observada 10.`,
    `The Odds API: ${report.usage.oddsCalls} peticiones; creditos reportados ${report.usage.oddsCredits} (si el proveedor informa consumo). Cada peticion puede costar varios creditos.`,
    'Cobertura parcial: hasta 6 partidos de futbol y 4 por cada otro deporte. Datos faltantes, cuotas >15 min y mercados sin precio se omiten.',
    'Son candidatos, no picks oficiales: no se publican al canal, no se registran en el ledger y requieren revisar alineaciones y cuotas cerca del inicio.',
    'No se confirma RLM, no se garantiza acierto y no se aumenta el limite contratado ni se compra cuota adicional.'
  );
  lines.push('Referencia temporal solo en esta instancia; puede perderse al reiniciar Vercel. No es apertura oficial.');
  return lines.join('\n');
}