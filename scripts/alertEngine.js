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
import {
  getLearnedAdjustmentsForMatch,
  updateDynamicElo,
  isTeamMatch,
  hydrateDynamicEloFromCloud,
  hydrateCloudLessons,
  getDynamicEloStore
} from '../src/services/history.js';

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
  if (!botToken) {
    const cleanLocal = pruneCache(local);
    if (cleanLocal._meta?.dynamicElo) hydrateDynamicEloFromCloud(cleanLocal._meta.dynamicElo);
    return cleanLocal;
  }

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
        merged._meta = {
          ...(local._meta || {}),
          ...(cloudData._meta || {}),
          dynamicElo: { ...(local._meta?.dynamicElo || {}), ...(cloudData._meta?.dynamicElo || {}) }
        };
        const clean = pruneCache(merged);
        if (clean._meta?.dynamicElo) hydrateDynamicEloFromCloud(clean._meta.dynamicElo);
        saveLocalCache(clean);
        return clean;
      }
    }
  } catch (err) {
    console.warn('Aviso leyendo Cloud Ledger:', err.message);
  }

  const cleanFallback = pruneCache(local);
  if (cleanFallback._meta?.dynamicElo) hydrateDynamicEloFromCloud(cleanFallback._meta.dynamicElo);
  return cleanFallback;
}

/**
 * Guarda el Ledger persistente en la nube de Telegram y en disco local
 */
export async function saveCloudLedger(cache) {
  if (!cache._meta) cache._meta = {};
  cache._meta.dynamicElo = getDynamicEloStore();
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
    // Conservar pronósticos de los últimos 5 días (120 horas) y depurar pendientes pre-calibración con anomalías
    .filter(item => {
      if (item.data.timestamp && (now - item.data.timestamp >= 120 * 60 * 60 * 1000)) return false;
      if (!item.data.audited && item.data.status === 'pending') {
        const oddVal = parseFloat(item.data.odds) || 1.90;
        const pickText = item.data.pick || '';
        // Descartar pendientes antiguos que violaban el Candado Anti-Underdog (> 2.05 en ML/1X2) o con signo invertido
        if (oddVal > 2.65) return false;
        if (oddVal > 2.05 && (pickText.includes('(1X2)') || pickText.includes('(Moneyline)'))) return false;
        if (pickText.includes('-2.5 (Hándicap Positivo)')) return false;
        if (item.id === 'nfl-tot-nfl-401872949') return false;
      }
      return true;
    })
    .sort((a, b) => (b.data.timestamp || 0) - (a.data.timestamp || 0))
    .slice(0, 65); // Hasta 65 pronósticos recientes (Top Telegram + Unánimes 3/3 del Portal/Radar)

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
 * Verifica si la fecha del partido corresponde exactamente al día de HOY en horario de Ciudad de México (CDMX)
 */
function isMatchTodayInCdmx(gameDate) {
  if (!gameDate) return true;
  try {
    const matchDateCdmx = new Date(gameDate).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const todayCdmx = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    return matchDateCdmx === todayCdmx;
  } catch (e) {
    return true;
  }
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
  // 2. Ambos Equipos Anotan (BTTS)
  else if (pickStr.includes('ambos') || pickStr.includes('btts') || (pick.id && pick.id.startsWith('btts-'))) {
    const bothScored = hScore > 0 && aScore > 0;
    const isNo = pickStr.includes('(no)') || pickStr.includes(': no');
    status = isNo ? (!bothScored ? 'won' : 'lost') : (bothScored ? 'won' : 'lost');
    scoreDisplay = `BTTS: ${bothScored ? 'Sí' : 'No'} (${hScore}-${aScore})`;
    if (status === 'lost') {
      failedTeam = hScore === 0 ? (m.home?.name || pick.homeName) : (m.away?.name || pick.awayName);
    }
  }
  // 3. Totales (Over / Under)
  else if (pickStr.includes('over') || pickStr.includes('under') || pickStr.includes('más de') || pickStr.includes('menos de') || (pick.id && pick.id.startsWith('nfl-tot-'))) {
    const lineMatch = pickStr.match(/(\d+\.?\d*)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : 44.5;
    const total = hScore + aScore;
    const isUnder = pickStr.includes('under') || pickStr.includes('menos de');
    scoreDisplay = `Total: ${total} (${hScore}-${aScore})`;

    if (total === line) status = 'void';
    else if (isUnder) status = total < line ? 'won' : 'lost';
    else status = total > line ? 'won' : 'lost';
  }
  // 4. Hándicap / Spread / Runline (+1.5 / -1.5 / NFL Spread)
  else if (pickStr.includes('cubre línea') || pickStr.includes('hándicap') || pickStr.includes('handicap') || pickStr.includes('runline') || /[+-]\d+\.?\d*/.test(pickStr)) {
    const spreadMatch = pickStr.match(/([+-]\d+\.?\d*)/);
    const spreadVal = spreadMatch ? parseFloat(spreadMatch[1]) : 0;
    const chosenScore = isHomePicked ? hScore : aScore;
    const oppScore = isHomePicked ? aScore : hScore;
    const adjScore = chosenScore + spreadVal;
    scoreDisplay = `${hScore}-${aScore} (Línea ${spreadVal > 0 ? '+' : ''}${spreadVal})`;

    if (adjScore === oppScore) {
      status = 'void';
    } else {
      status = adjScore > oppScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = isHomePicked ? (m.home?.name || pick.homeName) : (m.away?.name || pick.awayName);
    }
  }
  // 5. Doble Oportunidad (1X / X2 / o Empate)
  else if (pickStr.includes('o empate') || pickStr.includes('1x') || pickStr.includes('x2')) {
    if (isHomePicked || pickStr.includes('1x')) {
      status = hScore >= aScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.home?.name || pick.homeName;
    } else {
      status = aScore >= hScore ? 'won' : 'lost';
      if (status === 'lost') failedTeam = m.away?.name || pick.awayName;
    }
  }
  // 6. Victoria Directa (Moneyline / 1X2)
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
  runtimePenalties = {},
  sentCache = {},
  isForce = false
}) {
  const rawOpportunities = [];

  const getPenalty = (teamName, basePenalty) => {
    const basePct = (basePenalty || 0) <= 1 ? (basePenalty || 0) * 100 : (basePenalty || 0);
    const extra = runtimePenalties[teamName] || 0;
    return Math.min(12, basePct + extra) / 100;
  };

  // ================= A. EVALUACIÓN DE FÚTBOL (TIER 1: FAVORITOS, DOBLE OPORTUNIDAD Y AMBOS ANOTAN) =================
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
    const bttsYes = parseFloat(probs.bttsYes);
    const hXgNum = parseFloat(m.home.xG) || 1.35;
    const aXgNum = parseFloat(m.away.xG) || 1.05;

    const mc = simulateSoccerMatch(m.home.xG, m.away.xG);
    const calHWin = Math.max(5, mc.calibratedHomeWin - (runtimePenalties[m.home.name] || 0));
    const calAWin = Math.max(5, mc.calibratedAwayWin - (runtimePenalties[m.away.name] || 0));
    const calBtts = Math.max(35, (mc.calibratedBtts + bttsYes) / 2);

    const homeOddsDec = parseFloat(m.market?.homeOdds) || parseFloat(getFairOddsDecimal(calHWin));
    const awayOddsDec = parseFloat(m.market?.awayOdds) || parseFloat(getFairOddsDecimal(calAWin));
    const hasRealOdds = m.market?.hasRealOdds === true;

    const vegasImpliedHome = hasRealOdds ? (1 / homeOddsDec) * 100 : calHWin;
    const vegasImpliedAway = hasRealOdds ? (1 / awayOddsDec) * 100 : calAWin;

    const homeEV = calHWin - vegasImpliedHome;
    const awayEV = calAWin - vegasImpliedAway;

    // 1. Smart Money / Steam Move (Únicamente en cuotas competitivas <= 2.55)
    if (m.market?.isSteamMove && parseFloat(m.market.current || 3.0) <= 2.55) {
      const teamFavored = m.market.steamTeam || m.home.name;
      const isSteamHome = isTeamMatch(teamFavored, m.home.name);
      const dcProb = isSteamHome ? probs.doubleChance.dc1X : probs.doubleChance.dcX2;
      const dcOdds = isSteamHome ? probs.doubleChance.odds1X : probs.doubleChance.oddsX2;
      const dropPct = m.market.steamDropPct || '5.0';

      if (parseFloat(dcProb) >= 68) {
        rawOpportunities.push({
          id: `steam-${m.id}`,
          sport: 'Fútbol',
          league: m.league,
          game: `${m.home.name} vs ${m.away.name}`,
          gameDate: m.gameDate,
          type: `⚠️ SMART MONEY (STEAM -${dropPct}%)`,
          pick: `${teamFavored} o Empate (${isSteamHome ? '1X' : 'X2'})`,
          prob: `${dcProb}%`,
          odds: dcOdds,
          edgeVal: Math.min(14.0, parseFloat(dropPct) * 1.3),
          edgeStr: `Caída institucional: ${m.market.open} -> ${m.market.current} (-${dropPct}%)`,
          argument: m.market.steamDetails || `Fuerte flujo de dinero profesional en ${teamFavored}. Protegido con Doble Oportunidad (${dcProb}%).`,
          mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
          match: m,
          probs: probs
        });
      }
    }

    // 2. Favoritos con Valor (+EV) o Dominio Élite (CANDADO ANTI-UNDERDOG: Prohibido 1X2 directo en cuotas > 2.05)
    if (hasRealOdds && homeEV >= 4.5 && calHWin >= 52 && homeOddsDec <= 2.05 && mc.riskLevel !== 'Alto') {
      rawOpportunities.push({
        id: `ev-home-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💰 FAVORITO CON VALOR (EV+)',
        pick: `Victoria ${m.home.name} (1X2)`,
        prob: `${calHWin.toFixed(0)}%`,
        odds: homeOddsDec.toFixed(2),
        edgeVal: homeEV,
        edgeStr: `+${homeEV.toFixed(1)}% EV vs Vegas`,
        argument: `Favorito local respaldado por Monte Carlo (${calHWin.toFixed(0)}%) en cuota segura (${homeOddsDec.toFixed(2)} <= 2.05) y ventaja de xG (${m.home.xG} vs ${m.away.xG}).`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    } else if (hasRealOdds && awayEV >= 4.5 && calAWin >= 52 && awayOddsDec <= 2.05 && mc.riskLevel !== 'Alto') {
      rawOpportunities.push({
        id: `ev-away-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💰 FAVORITO VISITANTE CON VALOR (EV+)',
        pick: `Victoria ${m.away.name} (1X2)`,
        prob: `${calAWin.toFixed(0)}%`,
        odds: awayOddsDec.toFixed(2),
        edgeVal: awayEV,
        edgeStr: `+${awayEV.toFixed(1)}% EV vs Vegas`,
        argument: `Favorito visitante con ${calAWin.toFixed(0)}% real en cuota protegida (${awayOddsDec.toFixed(2)} <= 2.05) y ventaja de +${awayEV.toFixed(1)}% sobre Las Vegas.`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    } else if (
      calHWin >= 58 &&
      homeOddsDec >= 1.42 &&
      homeOddsDec <= 1.95 &&
      (calHWin - ((1 / homeOddsDec) * 100)) >= 2.5 &&
      mc.riskLevel !== 'Alto'
    ) {
      const realHomeMathEdge = calHWin - ((1 / homeOddsDec) * 100);
      rawOpportunities.push({
        id: `dom-home-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '💎 DOMINIO LOCAL ÉLITE',
        pick: `Victoria ${m.home.name} (1X2)`,
        prob: `${calHWin.toFixed(0)}%`,
        odds: homeOddsDec.toFixed(2),
        edgeVal: realHomeMathEdge,
        edgeStr: `Edge: +${realHomeMathEdge.toFixed(1)}% | Cuota: ${homeOddsDec.toFixed(2)}`,
        argument: `Dominio táctico neto con ${m.home.xG} xG frente a ${m.away.xG} rival, Elo superior (${m.home.elo} vs ${m.away.elo}) y ventaja matemática real de +${realHomeMathEdge.toFixed(1)}%.`,
        mcStats: { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 },
        match: m,
        probs: probs
      });
    }

    // 3. Conversión de Underdog Competitivo (2.06 a 2.65) o Riesgo de Empate a HÁNDICAP PROTEGIDO (Doble Oportunidad 1X / X2)
    const isCompetitiveHomeDog = homeOddsDec > 2.05 && homeOddsDec <= 2.65 && calHWin >= 42 && hXgNum >= 1.25;
    const isCompetitiveAwayDog = awayOddsDec > 2.05 && awayOddsDec <= 2.65 && calAWin >= 40 && aXgNum >= 1.20;
    const isHighDrawMatch = drWin >= 26 && (calHWin >= 42 || calAWin >= 42);

    if (isCompetitiveHomeDog || isCompetitiveAwayDog || isHighDrawMatch) {
      const isHome = isCompetitiveHomeDog ? true : (isCompetitiveAwayDog ? false : (calHWin >= calAWin));
      const baseTeamOdds = isHome ? homeOddsDec : awayOddsDec;
      if (baseTeamOdds <= 2.65) {
        const chosenTeam = isHome ? m.home.name : m.away.name;
        const dcProb = isHome ? probs.doubleChance.dc1X : probs.doubleChance.dcX2;
        const dcOdds = isHome ? probs.doubleChance.odds1X : probs.doubleChance.oddsX2;

        const dcOddsNum = parseFloat(dcOdds) || 1.40;
        const dcImplied = (1 / dcOddsNum) * 100;
        const dcEdge = parseFloat(dcProb) - dcImplied;

        if (parseFloat(dcProb) >= 70 && dcOddsNum >= 1.36 && dcOddsNum <= 2.30 && dcEdge >= 2.5) {
          rawOpportunities.push({
            id: `dc-${m.id}`,
            sport: 'Fútbol',
            league: m.league,
            game: `${m.home.name} vs ${m.away.name}`,
            gameDate: m.gameDate,
            type: '🛡️ HÁNDICAP PROTEGIDO (DOBLE OPORTUNIDAD)',
            pick: `${chosenTeam} o Empate (${isHome ? '1X' : 'X2'})`,
            prob: `${dcProb}%`,
            odds: dcOdds,
            edgeVal: Math.max(4.5, dcEdge),
            edgeStr: `Cobro Blindado: ${dcProb}% (Cubre Empate)`,
            argument: baseTeamOdds > 2.05
              ? `Candado Anti-Underdog activo: En lugar de arriesgar Moneyline (${baseTeamOdds.toFixed(2)}), se protege a ${chosenTeam} con Doble Oportunidad (${dcProb}% de éxito).`
              : `Riesgo de empate detectado (${drWin}%). Se activa Doble Oportunidad (${isHome ? '1X' : 'X2'}) para blindar el cobro.`,
            mcStats: { stability: Math.max(mc.stabilityScore, 68), risk: 'Bajo', iterations: 10000 },
            match: m,
            probs: probs
          });
        }
      }
    }

    // 4. NUEVO EN TIER 1: AMBOS EQUIPOS ANOTAN (BTTS - SÍ)
    // Se activa cuando AMBOS equipos generan alto volumen ofensivo (xG >= 1.25 local y >= 1.15 visita) y alto caudal de tiros a puerta
    const homeSoT = parseFloat(m.home.keyPlayer?.shotsOnTargetAvg) || hXgNum;
    const awaySoT = parseFloat(m.away.keyPlayer?.shotsOnTargetAvg) || (aXgNum * 0.85);
    const combinedSoT = homeSoT + awaySoT;

    if (hXgNum >= 1.25 && aXgNum >= 1.15 && calBtts >= 61.0 && combinedSoT >= 2.1 && mc.bttsRisk !== 'Alto') {
      const bttsOdds = m.market?.bttsOdds || getFairOddsDecimal(Math.min(62.5, calBtts * 0.90));
      const bttsImplied = (1 / parseFloat(bttsOdds)) * 100;
      const bttsEdge = Math.max(5.5, calBtts - bttsImplied);

      rawOpportunities.push({
        id: `btts-${m.id}`,
        sport: 'Fútbol',
        league: m.league,
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: '⚽ AMBOS EQUIPOS ANOTAN (TIER 1 ÉLITE)',
        pick: 'Ambos Equipos Anotan: Sí (BTTS)',
        prob: `${calBtts.toFixed(0)}%`,
        odds: bttsOdds,
        edgeVal: bttsEdge,
        edgeStr: `BTTS Sí: ${calBtts.toFixed(0)}% | xG: ${m.home.xG} + ${m.away.xG}`,
        argument: `Duelo abierto con ataque bilateral constante (${m.home.xG} xG local y ${m.away.xG} xG visitante) y alto volumen de remates al arco. Cobra sin importar quién gane o si empatan con goles.`,
        mcStats: { stability: mc.bttsStability, risk: mc.bttsRisk, iterations: 10000 },
        match: m,
        probs: probs
      });
    }
  });

  // ================= B. EVALUACIÓN DE MLB (F5 FAVORITOS Y RUNLINE PROTEGIDO +1.5) =================
  mlbMatches.forEach(m => {
    const homePitcherWhip = parseFloat(m.home.pitcher?.whip || '1.30');
    const awayPitcherWhip = parseFloat(m.away.pitcher?.whip || '1.30');

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

    const mcMlb = simulateMlbMatch(
      homePitcherWhip, awayPitcherWhip,
      m.home.ops, m.away.ops,
      10000,
      m.home.elo || 1500, m.away.elo || 1500
    );

    const f5Home = Math.max(20, parseFloat(sabers.f5?.homeMl || '50.0') - (runtimePenalties[m.home.name] || 0));
    const f5Away = Math.max(20, parseFloat(sabers.f5?.awayMl || '50.0') - (runtimePenalties[m.away.name] || 0));
    const homeMlOdds = parseFloat(m.market?.homeOdds) || 1.90;
    const awayMlOdds = parseFloat(m.market?.awayOdds) || 1.90;
    const hasRealMlbOdds = m.market?.hasRealOdds === true;

    // 1. Mercado F5 (Solo para el favorito o abridor dominante con cuota de equipo <= 2.05)
    if (f5Home >= 59 || f5Away >= 59) {
      const isHome = f5Home >= f5Away;
      const chosenTeam = isHome ? m.home.name : m.away.name;
      const chosenWhip = isHome ? homePitcherWhip : awayPitcherWhip;
      const teamOddsDec = isHome ? homeMlOdds : awayMlOdds;
      const winProb = isHome ? f5Home : f5Away;

      if (teamOddsDec <= 2.05 && chosenWhip <= 1.28 && mcMlb.bullpenRisk !== 'Alto') {
        const marketOdds = teamOddsDec <= 2.05 ? teamOddsDec.toFixed(2) : (winProb >= 63 ? '1.75' : '1.83');
        const impliedProb = (1 / parseFloat(marketOdds)) * 100;
        const mlbEdge = Number(Math.max(4.5, winProb - impliedProb).toFixed(1));

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
          edgeVal: mlbEdge,
          edgeStr: `+${mlbEdge}% EV vs Línea | WHIP ${chosenWhip.toFixed(2)}`,
          argument: `Superioridad en pitcheo abridor (WHIP ${chosenWhip.toFixed(2)}) y Elo aislando el bullpen. Estabilidad Monte Carlo F5: ${mcMlb.f5Stability}%.`,
          mcStats: { stability: mcMlb.f5Stability, risk: mcMlb.bullpenRisk, iterations: 10000 },
          match: m,
          probs: sabers
        });
      }
    }

    // 2. Underdog Competitivo (Cuota 2.06 a 2.55 con buen abridor WHIP <= 1.26) -> HÁNDICAP PROTEGIDO +1.5 CARRERAS (Runline)
    const expRunDiff = Math.abs(parseFloat(sabers.homeExpectedRuns) - parseFloat(sabers.awayExpectedRuns));
    const isHomeCompDog = hasRealMlbOdds && homeMlOdds > 2.05 && homeMlOdds <= 2.55 && homePitcherWhip <= 1.26 && expRunDiff <= 0.85;
    const isAwayCompDog = hasRealMlbOdds && awayMlOdds > 2.05 && awayMlOdds <= 2.55 && awayPitcherWhip <= 1.26 && expRunDiff <= 0.85;

    if (isHomeCompDog || isAwayCompDog) {
      const isHomeDog = isHomeCompDog;
      const dogTeam = isHomeDog ? m.home.name : m.away.name;
      const dogWhip = isHomeDog ? homePitcherWhip : awayPitcherWhip;
      const rlProb = isHomeDog
        ? Math.max(parseFloat(sabers.runline?.homePlus15 || 62), mcMlb.homePlus15Prob)
        : Math.max(parseFloat(sabers.runline?.awayPlus15 || 62), mcMlb.awayPlus15Prob);
      const rlOdds = isHomeDog
        ? (m.market?.homeSpreadOdds || sabers.runline?.homePlus15Odds || '1.68')
        : (m.market?.awaySpreadOdds || sabers.runline?.awayPlus15Odds || '1.68');

      if (rlProb >= 64.0) {
        const rlImplied = (1 / parseFloat(rlOdds)) * 100;
        const rlEdge = Math.max(5.5, rlProb - rlImplied);
        rawOpportunities.push({
          id: `mlb-rl-${m.id}`,
          sport: 'MLB',
          league: 'Major League Baseball',
          game: `${m.home.name} vs ${m.away.name}`,
          gameDate: m.gameDate,
          type: '🛡️ HÁNDICAP PROTEGIDO MLB (RUNLINE +1.5)',
          pick: `${dogTeam} +1.5 Carreras (Runline)`,
          prob: `${rlProb.toFixed(0)}%`,
          odds: rlOdds,
          edgeVal: rlEdge,
          edgeStr: `Cobertura +1.5: ${rlProb.toFixed(0)}% | Edge +${rlEdge.toFixed(1)}%`,
          argument: `Candado Anti-Underdog: ${dogTeam} cuenta con abridor sólido (WHIP ${dogWhip.toFixed(2)}) y proyección cerrada (dif. ${expRunDiff.toFixed(1)} carreras). Se blinda con +1.5 Carreras para cobrar incluso perdiendo por 1.`,
          mcStats: { stability: Math.max(68, Math.round(rlProb)), risk: 'Bajo', iterations: 10000 },
          match: m,
          probs: sabers
        });
      }
    }
  });

  // ================= C. EVALUACIÓN DE NFL (SPREADS CORREGIDOS Y TOTALES CALIBRADOS) =================
  nflMatches.forEach(m => {
    // Convención estricta: spread < 0 => Local es Favorito; spread > 0 => Local es Underdog (Visitante es Favorito)
    const spread = m.vegas?.spread !== undefined ? parseFloat(m.vegas.spread) : -3.5;
    const totalLine = m.vegas?.overUnder !== undefined ? parseFloat(m.vegas.overUnder) : 44.5;
    const homeYpp = m.home?.ypp !== undefined ? m.home.ypp : 5.3;
    const awayYpp = m.away?.ypp !== undefined ? m.away.ypp : 5.3;
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
    const absSpread = Math.abs(spread);
    const homeSpreadFmt = spread > 0 ? `+${spread}` : `${spread}`;
    const awaySpreadVal = -spread;
    const awaySpreadFmt = awaySpreadVal > 0 ? `+${awaySpreadVal}` : `${awaySpreadVal}`;

    const mcNfl = simulateNflMatch(expectedHomeLead, spread, totalLine, windMph);
    const homeCoverProb = mcNfl.calibratedHomeCover;
    const awayCoverProb = mcNfl.calibratedAwayCover;

    if (keyEval.trapWarning && absSpread <= 10.0) {
      const isHomeUnderdog = spread > 0;
      const underdogTeam = isHomeUnderdog ? m.home.name : m.away.name;
      const underdogCoverProb = isHomeUnderdog ? homeCoverProb : awayCoverProb;
      const ev = Number((underdogCoverProb - 52.4).toFixed(1));
      if (underdogCoverProb >= 55.5) {
        rawOpportunities.push({
          id: `nfl-trap-${m.id}`,
          sport: 'NFL',
          league: 'NFL',
          game: `${m.home.name} vs ${m.away.name}`,
          gameDate: m.gameDate,
          type: '🏈 PROTECCIÓN NÚMERO CLAVE (SHARP)',
          pick: `${underdogTeam} +${absSpread} (Hándicap Positivo)`,
          prob: `${underdogCoverProb.toFixed(0)}%`,
          odds: '1.91',
          edgeVal: Math.max(ev, 4.5),
          edgeStr: `Colchón Clave (+${absSpread}) | Edge: +${ev}%`,
          argument: `${keyEval.trapWarning} El modelo proyecta margen cerrado, protegiendo a ${underdogTeam} con +${absSpread} puntos.`,
          mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
          match: m,
          probs: nflProbs
        });
      }
    } else if (keyEval.keyAlert) {
      const isHomeFav = spread < 0;
      const favTeam = isHomeFav ? m.home.name : m.away.name;
      const favSpreadFmt = isHomeFav ? homeSpreadFmt : awaySpreadFmt;
      const favCoverProb = isHomeFav ? homeCoverProb : awayCoverProb;
      const ev = Number((favCoverProb - 52.4).toFixed(1));
      if (favCoverProb >= 56.0) {
        rawOpportunities.push({
          id: `nfl-key-${m.id}`,
          sport: 'NFL',
          league: 'NFL',
          game: `${m.home.name} vs ${m.away.name}`,
          gameDate: m.gameDate,
          type: '💎 NÚMERO CLAVE FAVORABLE (-2.5)',
          pick: `${favTeam} ${favSpreadFmt} (Cubre Línea)`,
          prob: `${favCoverProb.toFixed(0)}%`,
          odds: '1.91',
          edgeVal: Math.max(ev, 4.5),
          edgeStr: `Línea por debajo de 3 | Edge: +${ev}%`,
          argument: `${keyEval.keyAlert} Proyección favorable para ${favTeam} superando el gol de campo clave.`,
          mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
          match: m,
          probs: nflProbs
        });
      }
    } else if (homeCoverProb >= 57.0 && ((spread < 0 && absSpread <= 7.0) || (spread > 0 && absSpread <= 10.0))) {
      const ev = Number((homeCoverProb - 52.4).toFixed(1));
      const isHomeUnderdog = spread > 0;
      rawOpportunities.push({
        id: `nfl-spread-h-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: isHomeUnderdog ? '🛡️ HÁNDICAP POSITIVO LOCAL (NFL)' : '🏈 VENTAJA CONTRA EL SPREAD (NFL)',
        pick: `${m.home.name} ${homeSpreadFmt} (${isHomeUnderdog ? 'Hándicap Positivo' : 'Cubre Línea'})`,
        prob: `${homeCoverProb.toFixed(0)}%`,
        odds: '1.91',
        edgeVal: ev,
        edgeStr: `Prob. Cubrir: ${homeCoverProb.toFixed(0)}% | Edge: +${ev}%`,
        argument: `Monte Carlo proyecta margen local de ${expectedHomeLead.toFixed(1)} pts frente a línea de ${homeSpreadFmt} de Las Vegas.`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    } else if (awayCoverProb >= 57.0 && ((spread > 0 && absSpread <= 7.0) || (spread < 0 && absSpread <= 10.0))) {
      const ev = Number((awayCoverProb - 52.4).toFixed(1));
      const isAwayUnderdog = spread < 0;
      rawOpportunities.push({
        id: `nfl-spread-a-${m.id}`,
        sport: 'NFL',
        league: 'NFL',
        game: `${m.home.name} vs ${m.away.name}`,
        gameDate: m.gameDate,
        type: isAwayUnderdog ? '🛡️ HÁNDICAP POSITIVO VISITANTE (NFL)' : '🏈 VENTAJA CONTRA EL SPREAD (NFL)',
        pick: `${m.away.name} ${awaySpreadFmt} (${isAwayUnderdog ? 'Hándicap Positivo' : 'Cubre Línea'})`,
        prob: `${awayCoverProb.toFixed(0)}%`,
        odds: '1.91',
        edgeVal: ev,
        edgeStr: `Prob. Cubrir: ${awayCoverProb.toFixed(0)}% | Edge: +${ev}%`,
        argument: isAwayUnderdog
          ? `Defensa y eficiencia EPA respaldan a ${m.away.name} con colchón de puntos (${awaySpreadFmt}) ante la línea de Las Vegas.`
          : `Superioridad en EPA/Net YPP de ${m.away.name} para cubrir la línea corta (${awaySpreadFmt}) como visitante.`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    }

    const totalsEval = nflProbs.totalsEvaluation;
    if (totalsEval && totalsEval.isValue && parseFloat(totalsEval.edge) >= 6.5) {
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
        argument: `Proyección calibrada de ${totalsEval.effectiveTotal} pts frente a línea de ${totalLine} de Las Vegas. ${windMph >= 12 ? `Viento de ${windMph} mph favorece el Under.` : 'Diferencial validado en eficiencia ofensiva/defensiva.'}`,
        mcStats: { stability: mcNfl.stabilityScore, risk: mcNfl.riskLevel, iterations: 10000 },
        match: m,
        probs: nflProbs
      });
    }
  });

  // ================= D. TRIBUNAL DE CONSENSO Y ORDENAMIENTO CON PRIORIDAD AL DÍA ACTUAL (CDMX) =================
  rawOpportunities.forEach(opp => {
    opp.isToday = isMatchTodayInCdmx(opp.gameDate);
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

  // Ordenar: 1) Partidos que se juegan HOY (CDMX) primero, 2) Unanimidad 3/3 antes que 2/3, 3) Mayor +EV
  approvedOpps.sort((a, b) => {
    if (a.isToday !== b.isToday) {
      return a.isToday ? -1 : 1;
    }
    if (b.consensus.votesPassed !== a.consensus.votesPassed) {
      return b.consensus.votesPassed - a.consensus.votesPassed;
    }
    return b.edgeVal - a.edgeVal;
  });

  // Filtrar primero las que NO se han enviado aún a Telegram para que las enviadas a las 9:30 AM
  // nunca bloqueen los lugares del Top 6 en el corte de las 3:30 PM
  const eligibleForTop = isForce
    ? approvedOpps
    : approvedOpps.filter(pick => !sentCache[pick.id] || sentCache[pick.id].dispatchedToTelegram === false);

  const todayEligible = eligibleForTop.filter(o => o.isToday);
  const tomorrowEligible = eligibleForTop.filter(o => !o.isToday);
  const topSlate = [];
  const usedGames = new Set();

  // Paso 1: Llenar el Top 6 dando prioridad 100% a los partidos de HOY (diversificando por deporte y máximo 1 pick por partido)
  const todaySports = [...new Set(todayEligible.map(o => o.sport))];
  for (const sport of todaySports) {
    if (topSlate.length >= maxPicksToSend) break;
    const bestOfSportToday = todayEligible.find(o => o.sport === sport && !usedGames.has(o.game));
    if (bestOfSportToday && !topSlate.some(p => p.id === bestOfSportToday.id)) {
      topSlate.push(bestOfSportToday);
      usedGames.add(bestOfSportToday.game);
    }
  }

  for (const pick of todayEligible) {
    if (topSlate.length >= maxPicksToSend) break;
    if (!topSlate.some(p => p.id === pick.id) && !usedGames.has(pick.game)) {
      topSlate.push(pick);
      usedGames.add(pick.game);
    }
  }

  // Paso 2: Únicamente si HOY ya no tiene suficientes partidos para completar los 6 lugares,
  // rellenar los huecos restantes con los de mañana temprano (diversificando primero por deporte)
  const tomorrowSports = [...new Set(tomorrowEligible.map(o => o.sport))];
  for (const sport of tomorrowSports) {
    if (topSlate.length >= maxPicksToSend) break;
    const bestOfSportTomorrow = tomorrowEligible.find(o => o.sport === sport && !usedGames.has(o.game));
    if (bestOfSportTomorrow && !topSlate.some(p => p.id === bestOfSportTomorrow.id)) {
      topSlate.push(bestOfSportTomorrow);
      usedGames.add(bestOfSportTomorrow.game);
    }
  }

  for (const pick of tomorrowEligible) {
    if (topSlate.length >= maxPicksToSend) break;
    if (!topSlate.some(p => p.id === pick.id) && !usedGames.has(pick.game)) {
      topSlate.push(pick);
      usedGames.add(pick.game);
    }
  }

  topSlate.sort((a, b) => {
    if (a.isToday !== b.isToday) {
      return a.isToday ? -1 : 1;
    }
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
    const lines = picksToReport.slice(0, 20).map(p => {
      const icon = p.status === 'won' ? '✅' : (p.status === 'void' ? '➖' : '❌');
      const unitStr = p.status === 'void' ? '`0.00u (Push)`' : `\`${p.netUnits >= 0 ? '+' : ''}${Number(p.netUnits).toFixed(2)}u\``;
      const originTag = p.dispatchedToTelegram === false ? ' _(Radar/Portal 3/3)_' : '';
      return `${icon} *${p.sport}:* ${p.game}${originTag}\n   👉 _${p.pick}_ | \`${p.scoreDisplay}\` | ${unitStr}`;
    });
    if (picksToReport.length > 20) {
      lines.push(`_...y ${picksToReport.length - 20} selección(es) 3/3 adicional(es) sincronizadas en el Portal Web._`);
    }

    const penalizedTeams = Object.keys(runtimePenalties);
    const memoryLine = penalizedTeams.length > 0
      ? `🧠 *Memoria Forense:* _Castigo matemático (-6%) activado en: ${penalizedTeams.join(', ')}._`
      : `🧠 *Memoria Forense:* _Elo actualizado sin castigos requeridos._`;

    const pendingLine = pendingStillPlaying.length > 0
      ? `\n⏳ *En espera de juego:* _${pendingStillPlaying.length} selección(es) programada(s) en Memoria._`
      : '';

    const reportMsg = [
      `📊 *CORTE DE CAJA OFICIAL — AUDITORÍA STATS-AI PRO* 📊`,
      `🗓️ *Verificación Oficial (Telegram + Unánimes 3/3 del Portal)*`,
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

  // Hidratar lecciones forenses en memoria de Node.js para que el Voto 3 del Tribunal las consulte de inmediato
  const cloudLessonsForMemory = allAuditedRecent
    .filter(p => p.status === 'lost')
    .map(p => ({
      id: `tg-lesson-${p.id}`,
      sport: (p.sport === 'Fútbol' || p.sport === 'futbol') ? 'futbol' : (p.sport || 'futbol').toLowerCase(),
      match: p.game,
      failedPick: p.pick,
      penaltyModifier: 6,
      lesson: `Auditoría Oficial: El modelo sobreestimó el pick "${p.pick}" en ${p.game} (Marcador Real: ${p.scoreDisplay}). Se activa penalización preventiva (-6%) sobre ${p.failedTeam || p.homeName}.`
    }));
  hydrateCloudLessons(cloudLessonsForMemory);

  if (ledgerModified && !isDryRun) {
    await saveCloudLedger(providedCache);
  }

  return {
    auditSent,
    auditedPicks: allAuditedRecent,
    newlyGraded,
    pendingPicks: pendingStillPlaying,
    runtimePenalties,
    dynamicElo: getDynamicEloStore(),
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

  // Determinar hora actual en CDMX para calibrar la ventana:
  // - Corte Matutino (ej. 9:30 AM, antes de las 14:00): Mira exclusivamente partidos de HOY (próximas 16h).
  // - Corte Vespertino (ej. 3:30 PM, 14:00 en adelante): Prioriza 100% la tarde/noche de HOY y mira máximo 18h adelante (hasta las 9:30 AM de mañana).
  const cdmxNow = new Date();
  const cdmxHour = parseInt(cdmxNow.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', timeZone: 'America/Mexico_City' }), 10);
  const cdmxDateStr = cdmxNow.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const isMorningShift = cdmxHour < 14;

  const rangeArg = process.argv.find(a => a.startsWith('--range='));
  const defaultRange = isMorningShift ? 'hoy' : 'hoy_y_manana';
  const defaultHorizon = isMorningShift ? 16 : 18;

  const dateRange = options.dateRange || (rangeArg ? rangeArg.split('=')[1] : defaultRange);
  const maxHoursAhead = options.maxHoursAhead !== undefined ? options.maxHoursAhead : defaultHorizon;

  console.log(`[${new Date().toISOString()}] 🚀 Iniciando Escaneo Cuantitativo Stats-AI Pro (Turno CDMX ${cdmxHour}h, Rango: ${dateRange}, Horizonte: ${maxHoursAhead}h)...`);
  if (isDryRun) console.log('⚠️ Modo Dry-Run activo: no se mandarán mensajes reales.');

  const sentCache = await loadCloudLedger();
  if (!sentCache._meta) sentCache._meta = {};

  // Determinar si es turno matutino en CDMX (6:00 AM a 1:30 PM) para enviar el Corte de Caja una vez al día
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

  // Descargar programación dentro de la ventana calibrada del turno
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
    runtimePenalties: auditResult.runtimePenalties,
    sentCache,
    isForce
  });

  // topSlate ya viene filtrado contra sentCache y con prioridad estricta para los juegos de HOY
  const toSend = topSlate;

  // Además, identificar TODAS las oportunidades con Unanimidad 3/3 (incluyendo las que no entraron al Top 6 de Telegram)
  // para guardarlas automáticamente en la Memoria de Auditoría y calificarlas contra resultados oficiales
  const allUnanimousOpps = approvedOpps.filter(opp => opp.consensus && opp.consensus.votesPassed === 3);
  let autoSavedUnanimousCount = 0;

  for (const uPick of allUnanimousOpps) {
    if (!sentCache[uPick.id]) {
      sentCache[uPick.id] = {
        id: uPick.id,
        sport: uPick.sport,
        league: uPick.league,
        type: uPick.type,
        game: uPick.game,
        gameDate: uPick.gameDate,
        pick: uPick.pick,
        prob: uPick.prob,
        odds: uPick.odds,
        stakeUnits: parseFloat(uPick.consensus?.recommendedStake) || 2.0,
        homeName: uPick.match?.home?.name,
        awayName: uPick.match?.away?.name,
        argument: uPick.argument,
        votesPassed: 3,
        source: 'radar_3v3',
        dispatchedToTelegram: false,
        status: 'pending',
        audited: false,
        reportedInTelegram: false,
        timestamp: Date.now()
      };
      autoSavedUnanimousCount++;
    }
  }

  if (isVerbose) {
    console.log(`Top ${maxPicksToSend} de la jornada: ${topSlate.length}`);
    console.log(`Unánimes 3/3 totales detectadas: ${allUnanimousOpps.length} (${autoSavedUnanimousCount} nuevas en Memoria)`);
    console.log(`Pendientes por enviar a Telegram (no duplicadas): ${toSend.length}`);
  }

  if (toSend.length === 0) {
    if (!isDryRun && (auditResult.auditSent || autoSavedUnanimousCount > 0)) {
      await saveCloudLedger(sentCache);
    }
    console.log('✅ Mercado analizado. Las mejores selecciones de la jornada ya fueron notificadas hoy. Cero spam.');
    return {
      sentCount: 0,
      autoSavedUnanimousCount,
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
        ...(sentCache[pick.id] || {}),
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
        votesPassed: pick.consensus?.votesPassed || 3,
        source: 'telegram',
        dispatchedToTelegram: true,
        status: sentCache[pick.id]?.status || 'pending',
        audited: sentCache[pick.id]?.audited || false,
        reportedInTelegram: sentCache[pick.id]?.reportedInTelegram || false,
        timestamp: Date.now()
      };
    }
  }

  if (!isDryRun && (sentCount > 0 || auditResult.auditSent || autoSavedUnanimousCount > 0)) {
    await saveCloudLedger(sentCache);
  }

  console.log(`✅ Proceso finalizado con éxito. ${sentCount} alertas enviadas a Telegram y ${autoSavedUnanimousCount} unánimes adicionales en Memoria.`);
  return {
    sentCount,
    autoSavedUnanimousCount,
    totalAnalyzed: rawOpportunities.length,
    totalOpportunities: approvedOpps.length,
    auditSummary: auditResult.summary,
    auditSent: auditResult.auditSent
  };
}

/**
 * 6. REGISTRO EN NUBE DE SELECCIONES UNÁNIMES (3/3) GENERADAS EN EL PORTAL WEB
 * Permite que cualquier apuesta con votación 3/3 detectada en el Radar o Simulador del Portal
 * quede respaldada en el Cloud Ledger para auditoría oficial.
 */
export async function registerPortalUnanimousPicks(picks = []) {
  if (!Array.isArray(picks) || picks.length === 0) return { registeredCount: 0 };
  const sentCache = await loadCloudLedger();
  let registeredCount = 0;

  for (const p of picks) {
    if (!p || !p.pick) continue;
    const homeName = p.homeName || p.match?.home?.name || 'Local';
    const awayName = p.awayName || p.match?.away?.name || 'Visitante';
    const id = p.id || `portal-3v3-${homeName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${awayName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${p.pick.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18)}`;

    // Verificar si ya existe por ID o por mismo partido + pick
    const alreadyExists = Boolean(sentCache[id]) || Object.values(sentCache).some(entry =>
      entry && typeof entry === 'object' && entry.pick === p.pick &&
      isTeamMatch(entry.homeName || '', homeName) && isTeamMatch(entry.awayName || '', awayName)
    );

    if (!alreadyExists) {
      sentCache[id] = {
        id,
        sport: p.sport || 'Deporte',
        league: p.league || p.sport || 'Portal Web',
        type: p.type || '🗳️ UNANIMIDAD 3/3 PORTAL',
        game: `${homeName} vs ${awayName}`,
        gameDate: p.gameDate || new Date().toISOString(),
        pick: p.pick,
        prob: p.prob || '65%',
        odds: p.odds || '1.90',
        stakeUnits: parseFloat(p.stakeUnits) || 1.5,
        homeName,
        awayName,
        argument: p.argument || p.reason || 'Unanimidad 3/3 detectada automáticamente en el Portal Web.',
        votesPassed: 3,
        source: 'portal_3v3',
        dispatchedToTelegram: false,
        status: 'pending',
        audited: false,
        reportedInTelegram: false,
        timestamp: Date.now()
      };
      registeredCount++;
    }
  }

  if (registeredCount > 0) {
    await saveCloudLedger(sentCache);
  }

  return { registeredCount };
}

// Ejecución directa por CLI si se invoca con `node scripts/alertEngine.js`
if (process.argv[1] && process.argv[1].endsWith('alertEngine.js')) {
  runAlertEngine().catch(err => {
    console.error('Error fatal en alertEngine:', err);
    process.exit(1);
  });
}
