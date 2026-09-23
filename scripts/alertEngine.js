// scripts/alertEngine.js
// MOTOR CUANTITATIVO EN SEGUNDO PLANO - STATS-AI PRO -> TELEGRAM DISPATCHER
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDailySchedule } from '../src/services/sportsApi.js';
import { calculateMatchProbabilities } from '../src/utils/poisson.js';
import { calculateMlbProbabilities } from '../src/utils/sabermetrics.js';
import { calculateNflProbabilities } from '../src/utils/gridiron.js';
import { simulateSoccerMatch, simulateMlbMatch, simulateNflMatch, bayesianCalibrate } from '../src/utils/monteCarlo.js';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';
import { getLearnedAdjustmentsForMatch } from '../src/services/history.js';

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

// 2. ARCHIVO DE MEMORIA ANTI-SPAM (DEDUPLICACIÓN)
const cacheDir = process.env.VERCEL ? '/tmp' : __dirname;
const SENT_CACHE_FILE = path.join(cacheDir, '.sent_alerts.json');

function getSentAlertsCache() {
  try {
    if (!fs.existsSync(SENT_CACHE_FILE)) return {};
    const raw = fs.readFileSync(SENT_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const clean = {};
    Object.keys(parsed).forEach(id => {
      if (now - parsed[id].timestamp < 36 * 60 * 60 * 1000) {
        clean[id] = parsed[id];
      }
    });
    return clean;
  } catch (e) {
    return {};
  }
}

function saveSentAlertsCache(cache) {
  try {
    fs.writeFileSync(SENT_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error guardando cache de alertas enviadas:', e.message);
  }
}

// 3. ENVÍO DE MENSAJES VÍA TELEGRAM API
async function sendTelegramMessage(text, dryRun = false) {
  if (dryRun) {
    console.log('\n[DRY RUN - Mensaje que se enviaría a Telegram]:');
    console.log(text);
    return true;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Error enviando a Telegram:', data.description);
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

// 4. MOTOR PRINCIPAL DE EVALUACIÓN CON CONSENSO TRIPARTITO
export async function runAlertEngine(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  const isVerbose = options.verbose || process.argv.includes('--verbose');
  const maxPicksToSend = options.maxPicks || 6;
  const rangeArg = process.argv.find(a => a.startsWith('--range='));
  const dateRange = options.dateRange || (rangeArg ? rangeArg.split('=')[1] : 'fin_de_semana');

  console.log(`[${new Date().toISOString()}] 🚀 Iniciando Escaneo Cuantitativo Stats-AI Pro (Rango: ${dateRange})...`);
  if (isDryRun) console.log('⚠️ Modo Dry-Run activo: no se mandarán mensajes reales.');

  const sentCache = getSentAlertsCache();
  const rawOpportunities = [];

  // ================= A. ESCANEO DE FÚTBOL =================
  try {
    const soccerMatches = await fetchDailySchedule('futbol', dateRange);
    if (isVerbose) console.log(`⚽ Partidos de Fútbol descargados: ${soccerMatches.length}`);

    soccerMatches.forEach(m => {
      if (m.isCompleted) return;
      const diffHours = (new Date() - new Date(m.gameDate)) / (1000 * 60 * 60);
      if (diffHours > 4.5) return;

      const learned = getLearnedAdjustmentsForMatch(m.home.name, m.away.name);
      const probs = calculateMatchProbabilities(
        m.home.xG, m.away.xG,
        m.home.elo, m.away.elo,
        m.home.daysRest, m.away.daysRest,
        learned.homePenalty, learned.awayPenalty
      );

      const hWin = parseFloat(probs.homeWin);
      const aWin = parseFloat(probs.awayWin);
      const drWin = parseFloat(probs.draw);

      // Simulación Monte Carlo (10,000 iteraciones)
      const mc = simulateSoccerMatch(m.home.xG, m.away.xG);
      const calHWin = mc.calibratedHomeWin;
      const calAWin = mc.calibratedAwayWin;

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
      }
      else if (homeEV >= 5.0 && calHWin >= 45 && mc.riskLevel !== 'Alto') {
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
      }
      else if (awayEV >= 5.0 && calAWin >= 42 && mc.riskLevel !== 'Alto') {
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
      }
      else if (drWin >= 26 && (calHWin >= 40 || calAWin >= 40)) {
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
      }
      else if (calHWin >= 55 && homeEV >= 2.0 && mc.riskLevel !== 'Alto') {
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
  } catch (err) {
    console.error('Aviso: No se pudo procesar fútbol:', err.message);
  }

  // ================= B. ESCANEO DE MLB =================
  try {
    const mlbMatches = await fetchDailySchedule('mlb', dateRange);
    if (isVerbose) console.log(`⚾ Partidos de MLB descargados: ${mlbMatches.length}`);

    mlbMatches.forEach(m => {
      if (m.isCompleted) return;
      const diffHours = (new Date() - new Date(m.gameDate)) / (1000 * 60 * 60);
      if (diffHours > 4.5) return;

      const homePitcherWhip = m.home.pitcher?.whip || '1.30';
      const awayPitcherWhip = m.away.pitcher?.whip || '1.30';

      const learned = getLearnedAdjustmentsForMatch(m.home.name, m.away.name);
      const sabers = calculateMlbProbabilities(
        m.home.ops || '0.730', awayPitcherWhip,
        m.away.ops || '0.710', homePitcherWhip,
        m.home.elo || 1500, m.away.elo || 1500,
        m.home.daysRest || 1, m.away.daysRest || 1,
        learned.homePenalty, learned.awayPenalty,
        m.home.name
      );

      // Simulación Monte Carlo MLB (F5 vs Bullpen)
      const mcMlb = simulateMlbMatch(homePitcherWhip, awayPitcherWhip, m.home.ops, m.away.ops);

      const f5Home = parseFloat(sabers.f5?.homeMl || '50.0');
      const f5Away = parseFloat(sabers.f5?.awayMl || '50.0');

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
  } catch (err) {
    console.error('Aviso: No se pudo procesar MLB:', err.message);
  }

  // ================= C. ESCANEO DE NFL =================
  try {
    const nflMatches = await fetchDailySchedule('nfl', dateRange);
    if (isVerbose) console.log(`🏈 Partidos de NFL descargados: ${nflMatches.length}`);

    nflMatches.forEach(m => {
      if (m.isCompleted) return;
      const diffHours = (new Date() - new Date(m.gameDate)) / (1000 * 60 * 60);
      if (diffHours > 4.5) return;

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
      const nflProbs = calculateNflProbabilities(
        homeYpp, homeTo,
        awayYpp, awayTo,
        learned.homePenalty, learned.awayPenalty,
        spread,
        homeEpa, awayEpa,
        totalLine,
        windMph
      );

      const expectedHomeLead = parseFloat(nflProbs.expectedHomeLead);
      const keyEval = nflProbs.keyEvaluation || {};
      const spreadFmt = spread > 0 ? `+${spread}` : `${spread}`;

      // Simulación Monte Carlo NFL (10k iteraciones con clusters en números clave)
      const mcNfl = simulateNflMatch(expectedHomeLead, spread, totalLine, windMph);
      const homeCoverProb = mcNfl.calibratedHomeCover;
      const awayCoverProb = mcNfl.calibratedAwayCover;

      // 1. Detección de Trampa de Medio Punto en Números Clave (3.5 o 7.5) -> Tier 1
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
      }
      // 2. Colchón Clave Favorito (-2.5) -> Tier 1
      else if (keyEval.keyAlert) {
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
      }
      // 3. Ventaja Cuantitativa contra el Spread (Local Cubre con Veto a Spreads Pesados > 7.5)
      else if (homeCoverProb >= 57.0 && Math.abs(spread) <= 7.5) {
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
      }
      // 4. Ventaja Cuantitativa contra el Spread (Underdog o Visitante Cubre)
      else if (awayCoverProb >= 56.5) {
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

      // 5. Evaluación de Totales (Over / Under)
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
  } catch (err) {
    console.error('Aviso: No se pudo procesar NFL:', err.message);
  }

  // ================= D. TRIBUNAL DE CONSENSO Y ORDENAMIENTO MULTIDEPORTE =================
  // 1. Evaluar el Consenso Tripartito para cada oportunidad detectada
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

  // 2. Filtrar únicamente oportunidades aprobadas por el Tribunal (al menos 2 de 3 votos)
  const approvedOpps = rawOpportunities.filter(opp => opp.consensus && opp.consensus.votesPassed >= 2);

  if (isVerbose) {
    console.log(`Total oportunidades detectadas: ${rawOpportunities.length}`);
    console.log(`Aprobadas por Tribunal de Consenso (>= 2/3 votos): ${approvedOpps.length}`);
  }

  // 3. Ordenar: Prioridad 1: Votos de Consenso (3/3 sobre 2/3), Prioridad 2: Mayor Edge
  approvedOpps.sort((a, b) => {
    if (b.consensus.votesPassed !== a.consensus.votesPassed) {
      return b.consensus.votesPassed - a.consensus.votesPassed;
    }
    return b.edgeVal - a.edgeVal;
  });

  // 4. Selección Equilibrada Multideporte:
  // Garantizar que si hay deportes activos (NFL, MLB, Fútbol) con oportunidades élite,
  // no se monopolicen los 3 puestos por un solo deporte.
  const sportsPresent = [...new Set(approvedOpps.map(o => o.sport))];
  const topSlate = [];

  // Paso A: Tomar la mejor selección de cada deporte disponible
  for (const sport of sportsPresent) {
    if (topSlate.length >= maxPicksToSend) break;
    const bestOfSport = approvedOpps.find(o => o.sport === sport);
    if (bestOfSport && !topSlate.some(p => p.id === bestOfSport.id)) {
      topSlate.push(bestOfSport);
    }
  }

  // Paso B: Rellenar los cupos restantes con los mejores picks globales por consenso y edge
  for (const pick of approvedOpps) {
    if (topSlate.length >= maxPicksToSend) break;
    if (!topSlate.some(p => p.id === pick.id)) {
      topSlate.push(pick);
    }
  }

  // Ordenar el Top Slate final por mayor consenso y edge
  topSlate.sort((a, b) => {
    if (b.consensus.votesPassed !== a.consensus.votesPassed) {
      return b.consensus.votesPassed - a.consensus.votesPassed;
    }
    return b.edgeVal - a.edgeVal;
  });

  // 5. De ese Top, verificar cuáles NO se han enviado hoy
  const toSend = topSlate.filter(pick => !sentCache[pick.id]);

  if (isVerbose) {
    console.log(`Top ${maxPicksToSend} de la jornada: ${topSlate.length}`);
    console.log(`Pendientes por enviar (no duplicadas): ${toSend.length}`);
  }

  if (toSend.length === 0) {
    console.log('✅ Mercado analizado. Las mejores selecciones de la jornada ya fueron notificadas hoy. Cero spam.');
    return { sentCount: 0, totalAnalyzed: rawOpportunities.length };
  }

  console.log(`📢 Enviando ${toSend.length} nueva(s) selección(es) Élite con Consenso a Telegram...`);

  let sentCount = 0;
  for (const pick of toSend) {
    let timeStr = 'Hoy';
    try {
      const gDate = new Date(pick.gameDate);
      timeStr = gDate.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
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
      `⏰ *Hora:* ${timeStr} (CDMX)`,
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
        game: pick.game,
        pick: pick.pick,
        timestamp: Date.now()
      };
    }
  }

  if (!isDryRun && sentCount > 0) {
    saveSentAlertsCache(sentCache);
  }

  console.log(`✅ Proceso finalizado con éxito. ${sentCount} alertas enviadas a Telegram.`);
  return { sentCount, totalAnalyzed: rawOpportunities.length, totalOpportunities: approvedOpps.length };
}

// Ejecución directa por CLI si se invoca con `node scripts/alertEngine.js`
if (process.argv[1] && process.argv[1].endsWith('alertEngine.js')) {
  runAlertEngine().catch(err => {
    console.error('Error fatal en alertEngine:', err);
    process.exit(1);
  });
}
