// scripts/alertEngine.js
// MOTOR CUANTITATIVO EN SEGUNDO PLANO & AUDITORÍA FORENSE CON PERSISTENCIA CLOUD - STATS-AI PRO
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { fetchDailySchedule } from '../src/services/sportsApi.js';
import { calculateMatchProbabilities } from '../src/utils/poisson.js';
import { calculateMlbProbabilities } from '../src/utils/sabermetrics.js';
import { calculateNflProbabilities } from '../src/utils/gridiron.js';
import { simulateSoccerMatch, simulateMlbMatch, simulateNflMatch } from '../src/utils/monteCarlo.js';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';
import { getLearnedAdjustmentsForMatch, updateDynamicElo, isTeamMatch } from '../src/services/history.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de entorno locales de .env si no vienen inyectadas en el proceso
try {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        if (!process.env[key]) {
          process.env[key] = v.join('=').trim();
        }
      }
    });
  }
} catch (e) {}

// 1. CREDENCIALES TELEGRAM
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 2. ARCHIVO DE MEMORIA LOCAL Y PERSISTENCIA CLOUD EN TELEGRAM (SOBREVIVE REINICIOS SERVERLESS EN VERCEL)
const cacheDir = process.env.VERCEL ? '/tmp' : __dirname;
const SENT_CACHE_FILE = path.join(cacheDir, '.sent_alerts.json');
const CLOUD_LANG_CODE = 'eo'; // Canal oculto en metadatos del Bot para almacenar el Ledger comprimido

function getLocalCache() {
  try {
    if (!fs.existsSync(SENT_CACHE_FILE)) return {};
    const raw = fs.readFileSync(SENT_CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveLocalCache(cache) {
  try {
    fs.writeFileSync(SENT_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error guardando cache local:', e.message);
  }
}

/**
 * Lee el Ledger persistente desde la nube de Telegram (comprimido con Deflate + Base64)
 */
export async function loadCloudLedger() {
  const local = getLocalCache();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  if (!botToken) return pruneCache(local);

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMyCommands?language_code=${CLOUD_LANG_CODE}`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
      const b64 = data.result
        .filter(c => c.command && c.command.startsWith('s_'))
        .sort((a, b) => parseInt(a.command.slice(2), 10) - parseInt(b.command.slice(2), 10))
        .map(c => c.description)
        .join('');

      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        const jsonStr = zlib.inflateRawSync(buf).toString('utf-8');
        const cloudData = JSON.parse(jsonStr);
        // Combinar nube + local dando prioridad a registros ya auditados
        const merged = { ...local, ...cloudData };
        Object.keys(local).forEach(k => {
          if (k !== '_meta' && local[k]?.audited && !merged[k]?.audited) {
            merged[k] = local[k];
          }
        });
        merged._meta = { ...(local._meta || {}), ...(cloudData._meta || {}) };
        const clean = pruneCache(merged);
        saveLocalCache(clean);
        return clean;
      }
    }
  } catch (err) {
    console.warn('Aviso leyendo Cloud Ledger:', err.message);
  }

  return pruneCache(local);
}

/**
 * Guarda el Ledger persistente en la nube de Telegram y en disco local
 */
export async function saveCloudLedger(cache) {
  const clean = pruneCache(cache);
  saveLocalCache(clean);

  const botToken = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  try {
    const jsonStr = JSON.stringify(clean);
    const compressed = zlib.deflateRawSync(Buffer.from(jsonStr, 'utf-8')).toString('base64');
    const commands = [];
    for (let i = 0; i < compressed.length && commands.length < 95; i += 250) {
      commands.push({
        command: `s_${commands.length}`,
        description: compressed.slice(i, i + 250)
      });
    }

    await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands,
        language_code: CLOUD_LANG_CODE
      })
    });
  } catch (err) {
    console.warn('Aviso guardando Cloud Ledger:', err.message);
  }
}

function pruneCache(cache) {
  const now = Date.now();
  const clean = { _meta: cache._meta || {} };
  const entries = Object.keys(cache)
    .filter(id => id !== '_meta' && cache[id] && typeof cache[id] === 'object')
    .map(id => ({ id, data: cache[id] }))
    // Conservar pronósticos de los últimos 5 días (120 horas)
    .filter(item => !item.data.timestamp || (now - item.data.timestamp < 120 * 60 * 60 * 1000))
    .sort((a, b) => (b.data.timestamp || 0) - (a.data.timestamp || 0))
    .slice(0, 40); // Máximo 40 pronósticos recientes para mantener ultraligero el Ledger

  entries.forEach(({ id, data }) => {
    clean[id] = data;
  });
  return clean;
}

// 3. ENVÍO DE MENSAJES VÍA TELEGRAM API
async function sendTelegramMessage(text, dryRun = false) {
  if (dryRun) {
    console.log('\n[DRY RUN - Mensaje que se enviaría a Telegram]:');
    console.log(text);
    return true;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error('Faltan credenciales de Telegram: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no definidos.');
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`Error enviando a Telegram (Chat: ${chatId}):`, data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Fallo en la petición a Telegram:', err.message);
    return false;
  }
}

function getFairOddsDecimal(probPct) {
  const p = parseFloat(probPct);
  if (!p || p <= 0) return '2.00';
  return (100 / p).toFixed(2);
}

/**
 * Verifica si un partido está dentro de la ventana óptima de tiempo (ej. próximas 36 horas)
 * y descarta partidos pasados o que comiencen con demasiada anticipación (riesgo de lesiones/clima).
 */
function isMatchWithinHorizon(gameDate, maxHoursAhead = 36) {
  if (!gameDate) return true;
  const now = Date.now();
  const matchTime = new Date(gameDate).getTime();
  if (isNaN(matchTime)) return true;

  const hoursUntilGame = (matchTime - now) / (1000 * 60 * 60);

  // Descartar si el partido ya inició hace más de 10 minutos
  if (hoursUntilGame < -0.15) return false;

  // Descartar si excede la ventana máxima de anticipación (ej. domingo en jueves)
  if (maxHoursAhead && hoursUntilGame > maxHoursAhead) return false;

  return true;
}

/**
 * Califica un pronóstico oficial contra el marcador final real (F5 en MLB, Spread/Totales en NFL, 1X2/DC en Fútbol)
 */
export function gradeOfficialPick(pick, match) {
  const m = match || pick.match;
  if (!m || !m.isCompleted || m.homeScore === null || m.awayScore === null || isNaN(m.homeScore) || isNaN(m.awayScore)) {
    return null;
  }

  const hScore = parseInt(m.homeScore, 10);
  const aScore = parseInt(m.awayScore, 10);
  const hName = (m.home?.name || pick.homeName || '').toLowerCase();
  const aName = (m.away?.name || pick.awayName || '').toLowerCase();
  const pickStr = (pick.pick || '').toLowerCase();
  const stakeUnits = parseFloat(pick.stakeUnits || pick.consensus?.recommendedStake) || 2.0;
  const oddsDec = parseFloat(pick.odds) || 1.90;

  let status = 'lost'; // 'won', 'lost', 'void'
  let scoreDisplay = `${hScore}-${aScore}`;
  let failedTeam = null;

  const isHomePicked = (hName && pickStr.includes(hName)) || (m.home?.name && isTeamMatch(m.home.name, pick.pick));

  // 1. MLB Primeros 5 Innings (F5)
  if (pickStr.includes('f5') || (pick.id && pick.id.startsWith('mlb-f5-'))) {
    const f5H = m.f5HomeScore !== undefined && m.f5HomeScore !== null ? parseInt(m.f5HomeScore, 10) : hScore;
    const f5A = m.f5AwayScore !== undefined && m.f5AwayScore !== null ? parseInt(m.f5AwayScore, 10) : aScore;
    scoreDisplay = `F5: ${f5H}-${f5A} (Final ${hScore}-${aScore})`;

    if (f5H === f5A) {
      status = 'void';
    } else if (isHomePicked) {
      status = f5H > f5A ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.home?.name || pick.homeName;
    } else {
      status = f5A > f5H ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.away?.name || pick.awayName;
    }
  }
  // 2. Totales (Over / Under)
  else if (pickStr.includes('over') || pickStr.includes('under') || pickStr.includes('más de') || pickStr.includes('menos de') || (pick.id && pick.id.startsWith('nfl-tot-'))) {
    const lineMatch = pickStr.match(/(\d+\.?\d*)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : 44.5;
    const total = hScore + aScore;
    const isUnder = pickStr.includes('under') || pickStr.includes('menos de');
    scoreDisplay = `Total: ${total} pts (${hScore}-${aScore})`;

    if (total === line) status = 'void';
    else if (isUnder) status = total < line ? 'won' : 'lost';
    else status = total > line ? 'won' : 'lost';
  }
  // 3. Hándicap / Spread
  else if (pickStr.includes('cubre línea') || pickStr.includes('hándicap') || pickStr.includes('handicap') || /[+-]\d+\.?\d*/.test(pickStr)) {
    const spreadMatch = pickStr.match(/([+-]\d+\.?\d*)/);
    const spreadVal = spreadMatch ? parseFloat(spreadMatch[1]) : 0;
    const chosenScore = isHomePicked ? hScore : aScore;
    const oppScore = isHomePicked ? aScore : hScore;
    const adjScore = chosenScore + spreadVal;

    if (adjScore === oppScore) {
      status = 'void';
    } else {
      status = adjScore > oppScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = isHomePicked ? (m.home?.name || pick.homeName) : (m.away?.name || pick.awayName);
    }
  }
  // 4. Doble Oportunidad (1X / X2 / o Empate)
  else if (pickStr.includes('o empate') || pickStr.includes('1x') || pickStr.includes('x2')) {
    if (isHomePicked || pickStr.includes('1x')) {
      status = hScore >= aScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.home?.name || pick.homeName;
    } else {
      status = aScore >= hScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.away?.name || pick.awayName;
    }
  }
  // 5. Victoria Directa (Moneyline / 1X2)
  else {
    if (isHomePicked) {
      status = hScore > aScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.home?.name || pick.homeName;
    } else {
      status = aScore > hScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.away?.name || pick.awayName;
    }
  }

  let netUnits = 0;
  if (status === 'won') {
    netUnits = Number((stakeUnits * (oddsDec - 1)).toFixed(2));
  } else if (status === 'lost') {
    netUnits = Number((-stakeUnits).toFixed(2));
  }

  const homeFull = m.home?.name || pick.homeName || 'Local';
  const awayFull = m.away?.name || pick.awayName || 'Visitante';

  return {
    id: pick.id,
    sport: pick.sport || 'Deporte',
    league: pick.league || pick.sport || 'Liga Oficial',
    type: pick.type || '🎯 SELECCIÓN OFICIAL TELEGRAM',
    game: pick.game || `${homeFull} vs ${awayFull}`,
    gameDate: pick.gameDate || m.gameDate,
    pick: pick.pick,
    prob: pick.prob || '65%',
    odds: oddsDec.toFixed(2),
    stakeUnits,
    status,
    netUnits,
    scoreDisplay,
    resultDetails: `Marcador Oficial: ${homeFull} ${hScore} - ${aScore} ${awayFull} (${scoreDisplay})`,
    homeName: homeFull,
    awayName: awayFull,
    homeScore: hScore,
    awayScore: aScore,
    failedTeam,
    opponentTeam: failedTeam === homeFull ? awayFull : homeFull,
    argument: pick.argument || 'Selección enviada por el motor cuantitativo de Telegram.',
    lessonText: status === 'lost' && failedTeam
      ? `Fallo en ${pick.pick} (${scoreDisplay}). El modelo sobreestimó a ${failedTeam}; se aplica penalización correctiva (-6%) y ajuste de Elo.`
      : null
  };
}

/**
 * Núcleo compartido que evalúa oportunidades en Fútbol, MLB y NFL y selecciona el Top Slate con Consenso 3v1
 */
export function buildOpportunitiesAndTopSlate({
  soccerMatches = [],
  mlbMatches = [],
  nflMatches = [],
  maxPicksToSend = 6,
  runtimePenalties = {}
}) {
  const rawOpportunities = [];

  const getPenalty = (teamName, basePenalty) => {
    const extra = runtimePenalties[teamName] || 0;
    return Math.min(15, (basePenalty || 0) + extra);
  };

  // ================= A. EVALUACIÓN DE FÚTBOL =================
  soccerMatches.forEach(m => {
    const learned = getLearnedAdjustmentsForMatch(m.home.name, m.away.name);
    const hPen = getPenalty(m.home.name, learned.homePenalty);
    const aPen = getPenalty(m.away.name, learned.awayPenalty);

    const probs = calculateMatchProbabilities(
      m.home.xG, m.away.xG,
      m.home.elo, m.away.elo,
      m.home.daysRest, m.away.daysRest,
      hPen, aPen
    );

    const hWin = parseFloat(probs.homeWin);
    const drWin = parseFloat(probs.draw);

    const mc = simulateSoccerMatch(m.home.xG, m.away.xG);
    const calHWin = Math.max(5, mc.calibratedHomeWin - (runtimePenalties[m.home.name] || 0));
    const calAWin = Math.max(5, mc.calibratedAwayWin - (runtimePenalties[m.away.name] || 0));

    const vegasImpliedHome = m.market?.homeOdds ? (1 / parseFloat(m.market.homeOdds)) * 100 : calHWin;
    const vegasImpliedAway = m.market?.awayOdds ? (1 / parseFloat(m.market.awayOdds)) * 100 : calAWin;

    const homeEV = calHWin - vegasImpliedHome;
    const awayEV = calAWin - vegasImpliedAway;

    if (m.market?.isSteamMove) {
      const teamFavored = m.market.steamTeam || m.home.name;
      const dropPct = m.market.steamDropPct || '5.0';
      rawOpportunities.push({
        id: `steam-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: `⚠️ SMART MONEY (STEAM -${dropPct}%)`,
        pick: `${teamFavored} o Empate (Doble Oportunidad)`,
        prob: hWin > 50 ? `${probs.doubleChance.dc1X}%` : `${probs.doubleChance.dcX2}%`,
        odds: m.market.current || '1.85',
        edgeVal: parseFloat(dropPct) * 1.5,
        edgeStr: `Caída institucional: ${m.market.open} -> ${m.market.current} (-${dropPct}%)`,
        argument: m.market.steamDetails || `Fuerte flujo de dinero profesional en ${teamFavored}. La línea se desplomó un ${dropPct}%.`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    } else if (homeEV >= 5.0 && calHWin >= 45 && mc.riskLevel !== 'Alto') {
      rawOpportunities.push({
        id: `ev-home-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💰 ALERTA DE VALOR (EV+)',
        pick: `Victoria ${m.home.name} (1X2)`,
        prob: `${calHWin.toFixed(0)}%`,
        odds: m.market.homeOdds || getFairOddsDecimal(calHWin),
        edgeVal: homeEV,
        edgeStr: `+${homeEV.toFixed(1)}% EV vs Vegas`,
        argument: `Monte Carlo (10k sims) proyecta ${calHWin.toFixed(0)}% calibrado ante cuota desfasada (xG: ${m.home.xG} vs ${m.away.xG}).`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    } else if (awayEV >= 5.0 && calAWin >= 42 && mc.riskLevel !== 'Alto') {
      rawOpportunities.push({
        id: `ev-away-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💰 ALERTA DE VALOR (EV+)',
        pick: `Victoria ${m.away.name} (1X2)`,
        prob: `${calAWin.toFixed(0)}%`,
        odds: m.market.awayOdds || getFairOddsDecimal(calAWin),
        edgeVal: awayEV,
        edgeStr: `+${awayEV.toFixed(1)}% EV vs Vegas`,
        argument: `Mercado subestima a la visita. Simulación Monte Carlo otorga ${calAWin.toFixed(0)}% real con ventaja de +${awayEV.toFixed(1)}%.`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    } else if (drWin >= 26 && (calHWin >= 40 || calAWin >= 40)) {
      const isHome = calHWin >= calAWin;
      const chosenTeam = isHome ? m.home.name : m.away.name;
      const dcProb = isHome ? probs.doubleChance.dc1X : probs.doubleChance.dcX2;
      const dcOdds = isHome ? probs.doubleChance.odds1X : probs.doubleChance.oddsX2;

      if (parseFloat(dcProb) >= 72) {
        rawOpportunities.push({
          id: `dc-${m.id}`,
          sport: 'Fútbol',
          league: m.league,
          game: `${m.home.name} vs ${m.away.name}`,
          gameDate: m.gameDate,
          type: '🛡️ MERCADO PROTEGIDO (ALTA PROBABILIDAD)',
          pick: `${chosenTeam} o Empate (${isHome ? '1X' : 'X2'})`,
          prob: `${dcProb}%`,
          odds: dcOdds,
          edgeVal: 6.0,
          edgeStr: `Probabilidad de cobro: ${dcProb}%`,
          argument: `Riesgo de empate detectado (${drWin}%). Se activa Doble Oportunidad para blindar cobro ante varianza.`,
          mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
          match: m,
          probs: probs
        });
      }
    } else if (calHWin >= 55 && homeEV >= 2.0 && mc.riskLevel !== 'Alto') {
      rawOpportunities.push({
        id: `dom-home-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💎 DOMINIO LOCAL ÉLITE',
        pick: `Victoria ${m.home.name} (1X2)`,
        prob: `${calHWin.toFixed(0)}%`,
        odds: m.market.homeOdds || getFairOddsDecimal(calHWin),
        edgeVal: homeEV + 2.0,
        edgeStr: `Win Rate: ${calHWin.toFixed(0)}% | Edge: +${homeEV.toFixed(1)}%`,
        argument: `Dominio táctico neto con ${m.home.xG} xG frente a ${m.away.xG} rival y Elo superior (${m.home.elo} vs ${m.away.elo}).`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    }
  });

  // ================= B. EVALUACIÓN DE MLB =================
  mlbMatches.forEach(m => {
    const homePitcherWhip = m.home.pitcher?.whip || '1.30';
    const awayPitcherWhip = m.away.pitcher?.whip || '1.30';

    const learned = getLearnedAdjustmentsForMatch(m.home.name, m.away.name);
    const hPen = getPenalty(m.home.name, learned.homePenalty);
    const aPen = getPenalty(m.away.name, learned.awayPenalty);

    const sabers = calculateMlbProbabilities(
      m.home.ops || '0.730', awayPitcherWhip,
      m.away.ops || '0.710', homePitcherWhip,
      m.home.elo || 1500, m.away.elo || 1500,
      m.home.daysRest || 1, m.away.daysRest || 1,
      hPen, aPen,
      m.home.name
    );

    const mcMlb = simulateMlbMatch(homePitcherWhip, awayPitcherWhip, m.home.ops, m.away.ops);

    const f5Home = Math.max(20, parseFloat(sabers.f5?.homeMl || '50.0') - (runtimePenalties[m.home.name] || 0));
    const f5Away = Math.max(20, parseFloat(sabers.f5?.awayMl || '50.0') - (runtimePenalties[m.away.name] || 0));

    const vegasImpliedHome = m.market?.homeOdds ? (1 / parseFloat(m.market.homeOdds)) * 100 : 50;
    const homeEV = parseFloat(sabers.homeWin) - vegasImpliedHome;

    if (f5Home >= 60 || f5Away >= 60) {
      const isHome = f5Home >= f5Away;
      const chosenTeam = isHome ? m.home.name : m.away.name;
      const winProb = isHome ? f5Home : f5Away;
      const vegasOdds = isHome ? (m.market?.homeOdds || m.market?.current) : (m.market?.awayOdds);
      const marketOdds = vegasOdds || (winProb >= 63 ? '1.75' : winProb >= 58 ? '1.80' : '1.85');
      const impliedProb = (1 / parseFloat(marketOdds)) * 100;
      const mlbEdge = Number((winProb - impliedProb).toFixed(1));

      rawOpportunities.push({
        id: `mlb-f5-${m.id}`,
        sport: 'MLB',
        league: 'Major League Baseball',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '⚾ VENTAJA PRIMEROS 5 INNINGS (F5)',
        pick: `${chosenTeam} Gana F5`,
        prob: `${winProb.toFixed(0)}%`,
        odds: marketOdds,
        edgeVal: Math.max(mlbEdge, 5.0),
        edgeStr: mlbEdge > 0 ? `+${mlbEdge}% EV vs Línea` : `Prob. F5: ${winProb.toFixed(0)}%`,
        argument: `Ventaja decisiva en pitcheo abridor aislando el bullpen rival. Monte Carlo F5 Resistencia: ${mcMlb.f5Stability}%.`,
        mcStats: { stability: mcMlb.f5Stability, risk: mcMlb.bullpenRisk, iterations: 10000 },
        match: m,
        probs: sabers
      });
    } else if (homeEV >= 5.5 && parseFloat(sabers.homeWin) >= 53) {
      rawOpportunities.push({
        id: `mlb-ml-${m.id}`,
        sport: 'MLB',
        league: 'Major League Baseball',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💰 ALERTA DE VALOR MLB (EV+)',
        pick: `Victoria ${m.home.name} (Moneyline)`,
        prob: `${sabers.homeWin}%`,
        odds: m.market.homeOdds || getFairOddsDecimal(sabers.homeWin),
        edgeVal: homeEV,
        edgeStr: `+${homeEV.toFixed(1)}% EV vs Vegas`,
        argument: `Sabermetría proyecta ${sabers.homeWin}% con superioridad en pitcheo abridor y OPS de alineación.`,
        mcStats: { stability: mcMlb.f5Stability, risk: mcMlb.bullpenRisk, iterations: 10000 },
        match: m,
        probs: sabers
      });
    }
  });

  // ================= C. EVALUACIÓN DE NFL =================
  nflMatches.forEach(m => {
    const spread = m.vegas?.spread !== undefined ? m.vegas.spread : -3.5;
    const totalLine = m.vegas?.overUnder !== undefined ? m.vegas.overUnder : 44.5;
    const homeYpp = m.home?.ypp !== undefined ? m.home.ypp : 5.2;
    const awayYpp = m.away?.ypp !== undefined ? m.away.ypp : 5.2;
    const homeTo = m.home?.turnoverDiff !== undefined ? m.home.turnoverDiff : 0;
    const awayTo = m.away?.turnoverDiff !== undefined ? m.away.turnoverDiff : 0;
    const homeEpa = m.home?.epaNet !== undefined ? m.home.epaNet : null;
    const awayEpa = m.away?.epaNet !== undefined ? m.away.epaNet : null;
    const windMph = m.weather?.windMph || 0;

    const learned = getLearnedAdjustmentsForMatch(m.home.name, m.away.name);
    const hPen = getPenalty(m.home.name, learned.homePenalty);
    const aPen = getPenalty(m.away.name, learned.awayPenalty);

    const nflProbs = calculateNflProbabilities(
      homeYpp, homeTo,
      awayYpp, awayTo,
      hPen, aPen,
      spread,
      homeEpa, awayEpa,
      totalLine,
      windMph
    );

    const expectedHomeLead = parseFloat(nflProbs.expectedHomeLead);
    const keyEval = nflProbs.keyEvaluation || {};
    const spreadFmt = spread > 0 ? `+${spread}` : `${spread}`;

    const mcNfl = simulateNflMatch(expectedHomeLead, spread, totalLine, windMph);
    const homeCoverProb = mcNfl.calibratedHomeCover;
    const awayCoverProb = mcNfl.calibratedAwayCover;

    if (keyEval.trapWarning) {
      const underdogTeam = spread < 0 ? m.away.name : m.home.name;
      const underdogSpread = Math.abs(spread);
      const ev = Number(((awayCoverProb / 100 * 1.91 - 1) * 100).toFixed(1));
      rawOpportunities.push({
        id: `nfl-trap-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '🏈 PROTECCIÓN NÚMERO CLAVE (SHARP)',
        pick: `${underdogTeam} +${underdogSpread} (Hándicap Positivo)`,
        prob: `${awayCoverProb.toFixed(0)}%`,
        odds: '1.91',
        edgeVal: Math.max(ev, 12.0),
        edgeStr: `Colchón Clave (+3.5/+7.5) | EV: +${ev}%`,
        argument: `${keyEval.trapWarning} El modelo proyecta margen de ${expectedHomeLead.toFixed(1)} pts, protegiendo con el número clave.`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    } else if (keyEval.keyAlert) {
      const ev = Number(((homeCoverProb / 100 * 1.91 - 1) * 100).toFixed(1));
      rawOpportunities.push({
        id: `nfl-key-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💎 NÚMERO CLAVE FAVORABLE (-2.5)',
        pick: `${m.home.name} ${spreadFmt} (Cubre Línea)`,
        prob: `${homeCoverProb.toFixed(0)}%`,
        odds: '1.91',
        edgeVal: Math.max(ev, 12.0),
        edgeStr: `Línea por debajo de 3 | EV: +${ev}%`,
        argument: `${keyEval.keyAlert} Proyección de victoria local por ${expectedHomeLead.toFixed(1)} pts superando el FG clave.`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    } else if (homeCoverProb >= 57.0 && Math.abs(spread) <= 7.5) {
      const ev = Number(((homeCoverProb / 100 * 1.91 - 1) * 100).toFixed(1));
      rawOpportunities.push({
        id: `nfl-spread-h-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '🏈 VENTAJA CONTRA EL SPREAD (NFL)',
        pick: `${m.home.name} ${spreadFmt} (Cubre Línea)`,
        prob: `${homeCoverProb.toFixed(0)}%`,
        odds: '1.91',
        edgeVal: ev,
        edgeStr: `Prob. Cubrir: ${homeCoverProb.toFixed(0)}% | EV: +${ev}%`,
        argument: `Monte Carlo proyecta margen local de ${expectedHomeLead.toFixed(1)} pts frente a línea de ${spreadFmt} de Las Vegas. Spread seguro (<= 7.5 pts).`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    } else if (awayCoverProb >= 56.5) {
      const underdogTeam = spread < 0 ? m.away.name : m.home.name;
      const underdogSpread = spread < 0 ? `+${Math.abs(spread)}` : `${-spread}`;
      const isHeavySpread = Math.abs(spread) > 7.5;
      const ev = Number(((awayCoverProb / 100 * 1.91 - 1) * 100).toFixed(1));
      rawOpportunities.push({
        id: `nfl-spread-a-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: isHeavySpread ? '🛡️ PROTECCIÓN UNDERDOG ANTE SPREAD PESADO (NFL)' : '🏈 VALOR EN PUNTOS UNDERDOG (NFL)',
        pick: `${underdogTeam} ${underdogSpread} (Hándicap Positivo)`,
        prob: `${awayCoverProb.toFixed(0)}%`,
        odds: '1.91',
        edgeVal: ev,
        edgeStr: `Prob. Cubrir: ${awayCoverProb.toFixed(0)}% | EV: +${ev}%`,
        argument: isHeavySpread
          ? `Las Vegas infló en exceso al favorito (${spreadFmt} > 7.5 pts). Valor defensivo de alto calibre en Underdog para resistir Backdoor Covers.`
          : `Las Vegas sobrevaloró la línea. Simulación otorga paridad en yardas por jugada y alto valor a los puntos del visitante.`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    }

    const totalsEval = nflProbs.totalsEvaluation;
    if (totalsEval && totalsEval.isValue && parseFloat(totalsEval.edge) >= 6.0) {
      const tProb = totalsEval.isUnder ? totalsEval.underProb : totalsEval.overProb;
      rawOpportunities.push({
        id: `nfl-tot-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: totalsEval.isUnder ? '💨 TOTALES NFL (VALOR UNDER)' : '🔥 TOTALES NFL (VALOR OVER)',
        pick: totalsEval.pick,
        prob: `${tProb}%`,
        odds: totalsEval.odds || '1.91',
        edgeVal: parseFloat(totalsEval.edge),
        edgeStr: `Edge Totales: +${totalsEval.edge}%`,
        argument: `Proyección de ${totalsEval.effectiveTotal} pts frente a línea de ${totalLine} de Las Vegas. ${windMph >= 12 ? `Viento adverso de ${windMph} mph afecta FGs y juego aéreo.` : 'Diferencial clave en ritmo ofensivo y eficiencia neta.'}`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    }
  });

  // ================= D. TRIBUNAL DE CONSENSO Y ORDENAMIENTO MULTIDEPORTE =================
  rawOpportunities.forEach(opp => {
    opp.consensus = evaluateEnsembleConsensus({
      sport: opp.sport,
      match: opp.match || {},
      probs: opp.probs || {},
      mcStats: opp.mcStats,
      pickType: opp.type,
      edgeVal: opp.edgeVal,
      prob: opp.prob,
      odds: opp.odds
    });
  });

  const approvedOpps = rawOpportunities.filter(opp => opp.consensus && opp.consensus.votesPassed >= 2);

  approvedOpps.sort((a, b) => {
    if (b.consensus.votesPassed !== a.consensus.votesPassed) {
      return b.consensus.votesPassed - a.consensus.votesPassed;
    }
    return b.edgeVal - a.edgeVal;
  });

  const sportsPresent = [...new Set(approvedOpps.map(o => o.sport))];
  const topSlate = [];

  for (const sport of sportsPresent) {
    if (topSlate.length >= maxPicksToSend) break;
    const bestOfSport = approvedOpps.find(o => o.sport === sport);
    if (bestOfSport && !topSlate.some(p => p.id === bestOfSport.id)) {
      topSlate.push(bestOfSport);
    }
  }

  for (const pick of approvedOpps) {
    if (topSlate.length >= maxPicksToSend) break;
    if (!topSlate.some(p => p.id === pick.id)) {
      topSlate.push(pick);
    }
  }

  topSlate.sort((a, b) => {
    if (b.consensus.votesPassed !== a.consensus.votesPassed) {
      return b.consensus.votesPassed - a.consensus.votesPassed;
    }
    return b.edgeVal - a.edgeVal;
  });

  return { rawOpportunities, approvedOpps, topSlate };
}

/**
 * 4. AUDITORÍA FORENSE Y CORTE DE CAJA OFICIAL DE ALERTAS ENVIADAS A TELEGRAM
 * Verifica los pronósticos reales guardados en el Cloud Ledger contra marcadores oficiales de ESPN y MLB,
 * actualiza Elo dinámico, aplica castigos a equipos fallidos y envía el Corte de Caja al grupo.
 */
export async function runDailyTelegramAudit(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  const sendToTelegram = options.sendToTelegram !== undefined ? options.sendToTelegram : true;
  const forceResend = options.forceAudit || process.argv.includes('--audit');
  const providedCache = options.ledger || await loadCloudLedger();

  // Descargar marcadores oficiales de ayer y hoy para cruzar contra las alertas enviadas
  const [soccerYest, soccerToday, mlbYest, mlbToday, nflWeek] = await Promise.all([
    fetchDailySchedule('futbol', 'ayer').catch(() => []),
    fetchDailySchedule('futbol', 'hoy').catch(() => []),
    fetchDailySchedule('mlb', 'ayer').catch(() => []),
    fetchDailySchedule('mlb', 'hoy').catch(() => []),
    fetchDailySchedule('nfl', 'ayer').catch(() => [])
  ]);

  const allCompletedMatches = [
    ...soccerYest,
    ...soccerToday,
    ...mlbYest,
    ...mlbToday,
    ...nflWeek
  ].filter(m => m && m.isCompleted);

  const ledgerEntries = Object.keys(providedCache)
    .filter(k => k !== '_meta' && providedCache[k] && typeof providedCache[k] === 'object')
    .map(k => providedCache[k]);

  const newlyGraded = [];
  const allAuditedRecent = [];
  const pendingStillPlaying = [];
  const runtimePenalties = {};
  let ledgerModified = false;

  for (const entry of ledgerEntries) {
    // Buscar si el partido ya finalizó oficialmente
    const matchedGame = allCompletedMatches.find(m => {
      if (entry.id && entry.id.includes(m.id)) return true;
      const eHome = entry.homeName || (entry.game ? entry.game.split(' vs ')[0] : '');
      const eAway = entry.awayName || (entry.game ? entry.game.split(' vs ')[1] : '');
      return eHome && eAway && isTeamMatch(eHome, m.home?.name) && isTeamMatch(eAway, m.away?.name);
    });

    if (matchedGame) {
      const graded = gradeOfficialPick(entry, matchedGame);
      if (graded) {
        const wasAlreadyReported = Boolean(entry.reportedInTelegram);
        const updatedEntry = {
          ...entry,
          ...graded,
          audited: true,
          reportedInTelegram: wasAlreadyReported,
          auditedAt: entry.auditedAt || Date.now()
        };
        providedCache[entry.id] = updatedEntry;
        ledgerModified = true;

        const sportCode = (updatedEntry.sport === 'Fútbol' || updatedEntry.sport === 'futbol') ? 'futbol' : updatedEntry.sport.toLowerCase();
        updateDynamicElo(sportCode, updatedEntry.homeName, updatedEntry.awayName, updatedEntry.homeScore, updatedEntry.awayScore);

        if (updatedEntry.status === 'lost' && updatedEntry.failedTeam) {
          runtimePenalties[updatedEntry.failedTeam] = (runtimePenalties[updatedEntry.failedTeam] || 0) + 6;
        }

        allAuditedRecent.push(updatedEntry);
        if (!wasAlreadyReported || forceResend) {
          newlyGraded.push(updatedEntry);
        }
        continue;
      }
    }

    if (entry.audited && entry.status && entry.status !== 'pending') {
      allAuditedRecent.push(entry);
      if (entry.status === 'lost' && entry.failedTeam) {
        runtimePenalties[entry.failedTeam] = (runtimePenalties[entry.failedTeam] || 0) + 6;
      }
      if (!entry.reportedInTelegram || forceResend) {
        newlyGraded.push(entry);
      }
    } else {
      pendingStillPlaying.push(entry);
    }
  }

  // Ordenar por fecha de juego
  const picksToReport = newlyGraded;
  let won = 0;
  let lost = 0;
  let push = 0;
  let totalStaked = 0;
  let netUnits = 0;

  picksToReport.forEach(p => {
    const st = parseFloat(p.stakeUnits) || 2.0;
    const nu = parseFloat(p.netUnits) || 0;
    if (p.status === 'won') {
      won++;
      totalStaked += st;
      netUnits += nu;
    } else if (p.status === 'lost') {
      lost++;
      totalStaked += st;
      netUnits += nu;
    } else {
      push++;
    }
  });

  const resolvedCount = won + lost;
  const winRate = resolvedCount > 0 ? ((won / resolvedCount) * 100).toFixed(0) : '0';
  const roi = totalStaked > 0 ? ((netUnits / totalStaked) * 100).toFixed(1) : '0.0';
  const netSign = netUnits >= 0 ? '+' : '';
  const roiSign = parseFloat(roi) >= 0 ? '+' : '';

  let auditSent = false;
  if (sendToTelegram && picksToReport.length > 0) {
    const lines = picksToReport.map(p => {
      const icon = p.status === 'won' ? '✅' : (p.status === 'void' ? '➖' : '❌');
      const unitStr = p.status === 'void' ? '`0.00u (Push)`' : `\`${p.netUnits >= 0 ? '+' : ''}${Number(p.netUnits).toFixed(2)}u\``;
      return `${icon} *${p.sport}:* ${p.game}\n   👉 _${p.pick}_ | \`${p.scoreDisplay}\` | ${unitStr}`;
    });

    const penalizedTeams = Object.keys(runtimePenalties);
    const memoryLine = penalizedTeams.length > 0
      ? `🧠 *Memoria Forense:* _Castigo matemático (-6%) activado en: ${penalizedTeams.join(', ')}._`
      : `🧠 *Memoria Forense:* _Elo actualizado sin castigos requeridos._`;

    const pendingLine = pendingStillPlaying.length > 0
      ? `\n⏳ *En espera de juego:* _${pendingStillPlaying.length} selección(es) programada(s) para hoy._`
      : '';

    const reportMsg = [
      `📊 *CORTE DE CAJA OFICIAL — AUDITORÍA STATS-AI PRO* 📊`,
      `🗓️ *Verificación Oficial de Alertas Enviadas a Telegram*`,
      ``,
      ...lines,
      ``,
      `📈 *BALANCE CONTABLE (CRITERIO DE KELLY):*`,
      `🎯 *Récord Oficial:* \`${won} Ganadas - ${lost} Perdidas${push > 0 ? ` - ${push} Push` : ''} (${winRate}% Efectividad)\``,
      `💼 *Unidades Netas:* \`${netSign}${netUnits.toFixed(2)} Unidades\``,
      `💰 *ROI de la Jornada:* \`${roiSign}${roi}%\``,
      memoryLine + pendingLine
    ].join('\n');

    auditSent = await sendTelegramMessage(reportMsg, isDryRun);
    if (auditSent && !isDryRun) {
      picksToReport.forEach(p => {
        if (providedCache[p.id]) {
          providedCache[p.id].reportedInTelegram = true;
        }
      });
      ledgerModified = true;
    }
  }

  if (ledgerModified && !isDryRun) {
    await saveCloudLedger(providedCache);
  }

  return {
    auditSent,
    auditedPicks: allAuditedRecent,
    newlyGraded,
    pendingPicks: pendingStillPlaying,
    runtimePenalties,
    summary: {
      total: picksToReport.length,
      won,
      lost,
      push,
      winRate: `${winRate}%`,
      netUnits: Number(netUnits.toFixed(2)),
      roi: `${roiSign}${roi}%`
    }
  };
}

// 5. MOTOR PRINCIPAL DE EVALUACIÓN Y DESPACHO A TELEGRAM
export async function runAlertEngine(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  const isVerbose = options.verbose || process.argv.includes('--verbose');
  const isForce = options.force || process.argv.includes('--force');
  const forceAudit = options.audit || process.argv.includes('--audit');
  const maxPicksToSend = options.maxPicks || 6;
  const rangeArg = process.argv.find(a => a.startsWith('--range='));
  const dateRange = options.dateRange || (rangeArg ? rangeArg.split('=')[1] : 'hoy_y_manana');
  const maxHoursAhead = options.maxHoursAhead !== undefined ? options.maxHoursAhead : 36;

  console.log(`[${new Date().toISOString()}] 🚀 Iniciando Escaneo Cuantitativo Stats-AI Pro (Rango: ${dateRange}, Horizonte: ${maxHoursAhead}h)...`);
  if (isDryRun) console.log('⚠️ Modo Dry-Run activo: no se mandarán mensajes reales.');

  const sentCache = await loadCloudLedger();
  if (!sentCache._meta) sentCache._meta = {};

  // Determinar si es turno matutino en CDMX (6:00 AM a 1:30 PM) para enviar el Corte de Caja una vez al día
  const cdmxNow = new Date();
  const cdmxHour = parseInt(cdmxNow.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', timeZone: 'America/Mexico_City' }), 10);
  const cdmxDateStr = cdmxNow.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const isMorningWindow = cdmxHour >= 6 && cdmxHour <= 13;
  const shouldSendAuditReport = forceAudit || (isMorningWindow && sentCache._meta.lastAuditDate !== cdmxDateStr);

  // Ejecutar siempre la auditoría para calificar alertas pendientes, actualizar Elo y obtener castigos
  let auditResult = { auditedPicks: [], pendingPicks: [], runtimePenalties: {}, summary: null, auditSent: false };
  try {
    auditResult = await runDailyTelegramAudit({
      dryRun: isDryRun,
      sendToTelegram: shouldSendAuditReport,
      forceAudit,
      ledger: sentCache
    });
    if (auditResult.auditSent && !isDryRun) {
      sentCache._meta.lastAuditDate = cdmxDateStr;
    }
  } catch (err) {
    console.error('Aviso en auditoría previa:', err.message);
  }

  // Descargar programación dentro de la ventana de 36 horas
  const [soccerRaw, mlbRaw, nflRaw] = await Promise.all([
    fetchDailySchedule('futbol', dateRange).catch(() => []),
    fetchDailySchedule('mlb', dateRange).catch(() => []),
    fetchDailySchedule('nfl', dateRange).catch(() => [])
  ]);

  const filterUpcoming = (m) => !m.isCompleted && isMatchWithinHorizon(m.gameDate, maxHoursAhead);

  const soccerMatches = soccerRaw.filter(filterUpcoming);
  const mlbMatches = mlbRaw.filter(filterUpcoming);
  const nflMatches = nflRaw.filter(filterUpcoming);

  if (isVerbose) {
    console.log(`⚽ Fútbol en ventana: ${soccerMatches.length} | ⚾ MLB: ${mlbMatches.length} | 🏈 NFL: ${nflMatches.length}`);
  }

  const { rawOpportunities, approvedOpps, topSlate } = buildOpportunitiesAndTopSlate({
    soccerMatches,
    mlbMatches,
    nflMatches,
    maxPicksToSend,
    runtimePenalties: auditResult.runtimePenalties
  });

  // De ese Top, verificar cuáles NO se han enviado hoy (a menos que se use force)
  const toSend = isForce ? topSlate : topSlate.filter(pick => !sentCache[pick.id]);

  if (isVerbose) {
    console.log(`Top ${maxPicksToSend} de la jornada: ${topSlate.length}`);
    console.log(`Pendientes por enviar (no duplicadas): ${toSend.length}`);
  }

  if (toSend.length === 0) {
    if (!isDryRun && auditResult.auditSent) {
      await saveCloudLedger(sentCache);
    }
    console.log('✅ Mercado analizado. Las mejores selecciones de la jornada ya fueron notificadas hoy. Cero spam.');
    return {
      sentCount: 0,
      totalAnalyzed: rawOpportunities.length,
      totalOpportunities: approvedOpps.length,
      auditSummary: auditResult.summary,
      auditSent: auditResult.auditSent
    };
  }

  console.log(`📢 Enviando ${toSend.length} nueva(s) selección(es) Élite con Consenso a Telegram...`);

  let sentCount = 0;
  for (const pick of toSend) {
    let timeStr = 'Hoy';
    try {
      const gDate = new Date(pick.gameDate);
      const dayFmt = gDate.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' });
      const hourFmt = gDate.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
      timeStr = `${dayFmt} • ${hourFmt}`;
    } catch (e) {}

    const stabilityLine = pick.mcStats 
      ? `🎲 *Estabilidad de Simulación:* \`${pick.mcStats.stability}% (Riesgo ${pick.mcStats.risk})\`` 
      : `🎲 *Estabilidad de Simulación:* \`Alta (Calibrada)\``;

    const consensusLines = pick.consensus ? [
      `🗳️ *Consenso Algorítmico:* \`${pick.consensus.badgeText}\``,
      ...pick.consensus.breakdown.map(b => `  ${b.icon} *${b.name}:* _${b.reason}_`),
      `💼 *Gestión de Banca:* \`${pick.consensus.recommendedStake}\``
    ].join('\n') : `_Gestión Kelly Sugerida: 1.0 a 1.5 Unidades_`;

    const message = [
      `🎯 *ALERTA DE VALOR CUANTITATIVO — TIER 1* 🎯`,
      `🔬 *CALIBRACIÓN MONTE CARLO & CONSENSO 3v1*`,
      ``,
      `🏆 *${pick.sport}* | ${pick.league}`,
      `⚔️ *${pick.game}*`,
      `⏰ *Fecha y Hora:* ${timeStr} (CDMX)`,
      ``,
      `📌 *SELECCIÓN RECOMENDADA:*`,
      `👉 *${pick.pick}*`,
      ``,
      `📊 *Probabilidad Calibrada:* \`${pick.prob}\``,
      stabilityLine,
      `💰 *Cuota de Mercado:* \`${pick.odds}\``,
      `📈 *Ventaja Cuantitativa:* *${pick.edgeStr}*`,
      ``,
      `🧠 *Veredicto del Tribunal de Consenso:*`,
      consensusLines
    ].join('\n');

    const ok = await sendTelegramMessage(message, isDryRun);
    if (ok) {
      sentCount++;
      sentCache[pick.id] = {
        id: pick.id,
        sport: pick.sport,
        league: pick.league,
        type: pick.type,
        game: pick.game,
        gameDate: pick.gameDate,
        pick: pick.pick,
        prob: pick.prob,
        odds: pick.odds,
        stakeUnits: parseFloat(pick.consensus?.recommendedStake) || 2.0,
        homeName: pick.match?.home?.name,
        awayName: pick.match?.away?.name,
        argument: pick.argument,
        status: 'pending',
        audited: false,
        reportedInTelegram: false,
        timestamp: Date.now()
      };
    }
  }

  if (!isDryRun && (sentCount > 0 || auditResult.auditSent)) {
    await saveCloudLedger(sentCache);
  }

  console.log(`✅ Proceso finalizado con éxito. ${sentCount} alertas enviadas a Telegram.`);
  return {
    sentCount,
    totalAnalyzed: rawOpportunities.length,
    totalOpportunities: approvedOpps.length,
    auditSummary: auditResult.summary,
    auditSent: auditResult.auditSent
  };
}

// Ejecución directa por CLI si se invoca con `node scripts/alertEngine.js`
if (process.argv[1] && process.argv[1].endsWith('alertEngine.js')) {
  runAlertEngine().catch(err => {
    console.error('Error fatal en alertEngine:', err);
    process.exit(1);
  });
}
