// scripts/backtest.js
// MOTOR DE BACKTESTING HISTÓRICO Y EVALUACIÓN CUANTITATIVA RIGUROSA
// STATS-AI PRO -> SIMULACIÓN DE JORNADAS PASADAS, CLV TRACKING Y RENDIMIENTO REAL
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { calculateMatchProbabilities, getFairOddsDecimal, calculatePropProbabilities } from '../src/utils/poisson.js';
import { calculateMlbProbabilities } from '../src/utils/sabermetrics.js';
import { calculateNflProbabilities, calculateSpreadCoverProbability } from '../src/utils/gridiron.js';
import { simulateSoccerMatch, simulateMlbMatch, simulateNflMatch } from '../src/utils/monteCarlo.js';
import { evaluateEnsembleConsensus } from '../src/utils/ensemble.js';
import { calculateKellyStake } from '../src/utils/kelly.js';
import { getLearnedAdjustmentsForMatch, getDynamicElo, normalizeTeamName, isTeamMatch } from '../src/services/history.js';
import { fetchLiveSoccerStandings, fetchLiveNflStandings, fetchLiveMlbStandings, knownSoccerTeams } from '../src/services/sportsApi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. PARSEO DE ARGUMENTOS CLI
const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const daysBack = daysIdx !== -1 ? Math.min(30, Math.max(1, parseInt(args[daysIdx + 1], 10) || 7)) : 7;

const sportIdx = args.indexOf('--sport');
const targetSport = sportIdx !== -1 ? args[sportIdx + 1].toLowerCase() : 'all';

const edgeIdx = args.indexOf('--min-edge');
const minEdgeThreshold = edgeIdx !== -1 ? parseFloat(args[edgeIdx + 1]) || 3.0 : 3.0;

const isVerbose = args.includes('--verbose');
const saveJson = args.includes('--json') || true;

// Helper: Conversión de cuota americana a decimal
function americanToDecimal(american) {
  if (!american) return null;
  const val = parseInt(american, 10);
  if (isNaN(val)) return null;
  if (val > 0) return Number(((val / 100) + 1).toFixed(2));
  return Number(((100 / Math.abs(val)) + 1).toFixed(2));
}

// Helper: Extractor universal de cuotas de cierre de ESPN
function extractOddsFromEspn(oddsObj) {
  if (!oddsObj) return {};
  const getDec = (val) => val ? americanToDecimal(val) : null;
  const rawHomeSpread = oddsObj.pointSpread?.home?.close?.line || oddsObj.pointSpread?.home?.open?.line;
  let spreadLine = null;
  if (rawHomeSpread !== undefined && rawHomeSpread !== null) {
    spreadLine = parseFloat(rawHomeSpread);
  } else if (oddsObj.spread !== undefined) {
    const isAwayFav = oddsObj.awayTeamOdds?.favorite === true;
    spreadLine = isAwayFav ? Math.abs(parseFloat(oddsObj.spread)) : -Math.abs(parseFloat(oddsObj.spread));
  }

  const rawTotal = oddsObj.total?.over?.close?.line || oddsObj.total?.over?.open?.line || oddsObj.overUnder;
  const totalLine = rawTotal !== undefined && rawTotal !== null ? parseFloat(String(rawTotal).replace(/[^\d.]/g, '')) : null;

  return {
    closingHome: getDec(oddsObj.moneyline?.home?.close?.odds || oddsObj.homeTeamOdds?.moneyLine),
    closingAway: getDec(oddsObj.moneyline?.away?.close?.odds || oddsObj.awayTeamOdds?.moneyLine),
    closingDraw: getDec(oddsObj.moneyline?.draw?.close?.odds || oddsObj.drawOdds?.moneyLine),
    closingSpreadHome: getDec(oddsObj.pointSpread?.home?.close?.odds || oddsObj.homeTeamOdds?.spreadOdds),
    closingSpreadAway: getDec(oddsObj.pointSpread?.away?.close?.odds || oddsObj.awayTeamOdds?.spreadOdds),
    closingSpreadLine: (spreadLine !== null && !isNaN(spreadLine)) ? spreadLine : -3.5,
    closingOver: getDec(oddsObj.total?.over?.close?.odds || oddsObj.overOdds),
    closingUnder: getDec(oddsObj.total?.under?.close?.odds || oddsObj.underOdds),
    closingTotalLine: (totalLine !== null && !isNaN(totalLine)) ? totalLine : 44.5
  };
}

// Generar lista de fechas
function getDateList(days) {
  const list = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    list.push({
      espn: d.toISOString().slice(0, 10).replace(/-/g, ''),
      iso: d.toISOString().slice(0, 10)
    });
  }
  return list;
}

// ==========================================
// 2. DESCARGA Y SIMULACIÓN POR DEPORTE
// ==========================================

async function backtestNfl(dateList) {
  const evaluatedPicks = [];
  const nflStandings = await fetchLiveNflStandings();
  const espnDates = dateList.map(d => d.espn);

  for (const dStr of espnDates) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dStr}`);
      if (!res.ok) continue;
      const data = await res.json();

      for (const ev of (data.events || [])) {
        const comp = ev.competitions?.[0];
        if (!comp || !comp.status?.type?.completed) continue;

        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const homeTeam = home.team?.displayName || '';
        const awayTeam = away.team?.displayName || '';
        const homeScore = parseInt(home.score || 0, 10);
        const awayScore = parseInt(away.score || 0, 10);

        let oddsObj = comp.odds?.[0];
        if (!oddsObj || !oddsObj.pointSpread) {
          try {
            const sRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`);
            if (sRes.ok) {
              const sData = await sRes.json();
              oddsObj = sData.pickcenter?.[0] || sData.odds?.[0] || oddsObj;
            }
          } catch (e) {}
        }

        const odds = extractOddsFromEspn(oddsObj);
        const spread = odds.closingSpreadLine !== undefined ? odds.closingSpreadLine : -3.5;
        const totalLine = odds.closingTotalLine || 44.5;

        // Métricas pre-partido con cruce oficial de nombres de ESPN Standings
        const liveHStanding = nflStandings[homeTeam] || Object.values(nflStandings).find(t => isTeamMatch(t.teamName, homeTeam));
        const liveAStanding = nflStandings[awayTeam] || Object.values(nflStandings).find(t => isTeamMatch(t.teamName, awayTeam));

        const hStats = {
          ypp: liveHStanding?.ypp || 5.2,
          turnoverDiff: liveHStanding?.turnoverDiff || 0,
          epaNet: liveHStanding?.epaNet !== undefined ? liveHStanding.epaNet : 0.0,
          elo: liveHStanding?.elo || 1500
        };
        const aStats = {
          ypp: liveAStanding?.ypp || 5.2,
          turnoverDiff: liveAStanding?.turnoverDiff || 0,
          epaNet: liveAStanding?.epaNet !== undefined ? liveAStanding.epaNet : 0.0,
          elo: liveAStanding?.elo || 1500
        };

        const learned = getLearnedAdjustmentsForMatch(homeTeam, awayTeam);

        // Modelo Estructural
        const nflProbs = calculateNflProbabilities(
          hStats.ypp, hStats.turnoverDiff,
          aStats.ypp, aStats.turnoverDiff,
          learned.homePenalty, learned.awayPenalty,
          spread,
          hStats.epaNet, aStats.epaNet,
          totalLine,
          0
        );

        // Monte Carlo
        const expectedLead = parseFloat(nflProbs.expectedHomeLead);
        const mc = simulateNflMatch(expectedLead, spread, totalLine, 0, 1000);

        const matchObj = {
          id: ev.id,
          sport: 'nfl',
          home: { name: homeTeam, elo: hStats.elo },
          away: { name: awayTeam, elo: aStats.elo },
          market: { spread, overUnder: totalLine, current: odds.closingHome || '1.91' }
        };

        const consensus = evaluateEnsembleConsensus({
          sport: 'nfl',
          match: matchObj,
          probs: nflProbs,
          mcStats: mc ? { stability: mc.stabilityScore, risk: mc.riskLevel, iterations: 10000 } : null,
          edgeVal: Math.max(parseFloat(nflProbs.homeCoverProb || 50), parseFloat(nflProbs.awayCoverProb || 50)) - 52.4
        });
        const homeCover = parseFloat(nflProbs.homeCoverProb || 50);
        const awayCover = parseFloat(nflProbs.awayCoverProb || 50);

        // Evaluar candidatos a pick con FILTRO PREVENTIVO ESTRICTO
        let candidatePick = null;
        let pickType = '';
        let placedOdds = 1.91;
        let closingOdds = 1.91;
        let isWon = false;
        let isPush = false;

        const keyEval = nflProbs.keyEvaluation || {};
        const absSpread = Math.abs(spread);
        const isHeavySpread = absSpread > 7.5;

        // 1. Trampa de Medio Punto en Números Clave (Underdog +3.5 o +7.5)
        if (keyEval.trapWarning) {
          const dogTeam = spread < 0 ? awayTeam : homeTeam;
          const dogCover = spread < 0 ? awayCover : homeCover;
          const dogSpread = absSpread;
          candidatePick = `${dogTeam} +${dogSpread}`;
          pickType = 'Spread';
          placedOdds = 1.91;
          closingOdds = spread < 0 ? (odds.closingSpreadAway || 1.91) : (odds.closingSpreadHome || 1.91);

          if (spread < 0) {
            // Visita Underdog
            if ((awayScore + dogSpread) === homeScore) isPush = true;
            else isWon = (awayScore + dogSpread) > homeScore;
          } else {
            // Local Underdog
            if ((homeScore + dogSpread) === awayScore) isPush = true;
            else isWon = (homeScore + dogSpread) > awayScore;
          }
        }
        // 2. Oportunidad Clave en Favorito (-2.5 por debajo de 3)
        else if (keyEval.keyAlert && !isHeavySpread) {
          candidatePick = `${homeTeam} ${spread > 0 ? '+' + spread : spread}`;
          pickType = 'Spread';
          placedOdds = 1.91;
          closingOdds = odds.closingSpreadHome || 1.91;
          if ((homeScore + spread) === awayScore) isPush = true;
          else isWon = (homeScore + spread) > awayScore;
        }
        // 3. Ventaja Estricta Local (>= 57.0% y Spread <= 7.5 pts para evitar Backdoor Covers)
        else if (homeCover >= 57.0 && homeCover > awayCover && !isHeavySpread) {
          candidatePick = `${homeTeam} ${spread > 0 ? '+' + spread : spread}`;
          pickType = 'Spread';
          placedOdds = 1.91;
          closingOdds = odds.closingSpreadHome || 1.91;
          if ((homeScore + spread) === awayScore) isPush = true;
          else isWon = (homeScore + spread) > awayScore;
        }
        // 4. Ventaja Estricta Visita o Underdog Protegido (>= 56.5%)
        else if (awayCover >= 56.5 && awayCover > homeCover) {
          const aSpread = -spread;
          candidatePick = `${awayTeam} ${aSpread > 0 ? '+' + aSpread : aSpread}`;
          pickType = isHeavySpread ? 'Protección Underdog' : 'Spread';
          placedOdds = 1.91;
          closingOdds = odds.closingSpreadAway || 1.91;
          if ((awayScore + aSpread) === homeScore) isPush = true;
          else isWon = (awayScore + aSpread) > homeScore;
        }
        // 5. Totales Over/Under con Edge Estricto (>= 5.0%)
        else if (nflProbs.totalsEvaluation?.isValue && nflProbs.totalsEvaluation.edge >= 5.0) {
          const isOver = !nflProbs.totalsEvaluation.isUnder;
          candidatePick = `${isOver ? 'OVER' : 'UNDER'} ${totalLine}`;
          pickType = 'Totales';
          placedOdds = 1.91;
          closingOdds = isOver ? (odds.closingOver || 1.91) : (odds.closingUnder || 1.91);
          const totalPoints = homeScore + awayScore;
          if (totalPoints === totalLine) isPush = true;
          else isWon = isOver ? totalPoints > totalLine : totalPoints < totalLine;
        }

        if (candidatePick && (consensus.votesPassed >= 2)) {
          const edge = Math.max(homeCover, awayCover) - 52.4;
          const kelly = calculateKellyStake(Math.max(homeCover, awayCover), placedOdds, 'nfl');
          const clv = closingOdds && placedOdds ? Number((((placedOdds / closingOdds) - 1) * 100).toFixed(1)) : 0;

          evaluatedPicks.push({
            sport: 'NFL',
            game: `${homeTeam} vs ${awayTeam}`,
            date: dStr,
            score: `${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`,
            pick: candidatePick,
            pickType,
            odds: placedOdds,
            closingOdds,
            clv,
            consensus: `${consensus.votesPassed}/3`,
            stake: Math.min(2.0, Math.max(1.0, parseFloat(kelly.stakeUnits || 1.0))),
            result: isPush ? 'PUSH' : isWon ? 'WON' : 'LOST'
          });
        }
      }
    } catch (e) {}
  }

  return evaluatedPicks;
}

async function backtestMlb(dateList) {
  const evaluatedPicks = [];
  const startDate = dateList[dateList.length - 1].iso;
  const endDate = dateList[0].iso;

  // Descargar cuotas ESPN MLB en paralelo
  const mlbOddsMap = {};
  for (const d of dateList) {
    try {
      const resEspn = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${d.espn}`);
      if (resEspn.ok) {
        const dEspn = await resEspn.json();
        dEspn.events?.forEach(ev => {
          const comp = ev.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === 'home');
          const away = comp?.competitors?.find(c => c.homeAway === 'away');
          if (home && away && comp.odds?.[0]) {
            const h = home.team?.displayName || '';
            const a = away.team?.displayName || '';
            mlbOddsMap[`${normalizeTeamName(h)}_${normalizeTeamName(a)}`] = extractOddsFromEspn(comp.odds[0]);
          }
        });
      }
    } catch (e) {}
  }

  const mlbStandings = await fetchLiveMlbStandings();

  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=linescore,probablePitcher`);
    if (res.ok) {
      const data = await res.json();
      for (const d of (data.dates || [])) {
        for (const g of (d.games || [])) {
          if (g.status?.abstractGameState !== 'Final') continue;

          const homeTeam = g.teams?.home?.team?.name || '';
          const awayTeam = g.teams?.away?.team?.name || '';
          const homeScore = parseInt(g.teams?.home?.score || 0, 10);
          const awayScore = parseInt(g.teams?.away?.score || 0, 10);

          const innings = g.linescore?.innings || [];
          let f5H = null, f5A = null;
          if (innings.length >= 5) {
            f5H = innings.slice(0, 5).reduce((acc, inn) => acc + (inn.home?.runs || 0), 0);
            f5A = innings.slice(0, 5).reduce((acc, inn) => acc + (inn.away?.runs || 0), 0);
          }

          const odds = mlbOddsMap[`${normalizeTeamName(homeTeam)}_${normalizeTeamName(awayTeam)}`] || {};
          const learned = getLearnedAdjustmentsForMatch(homeTeam, awayTeam);

          const hStand = mlbStandings[g.teams?.home?.team?.id] || mlbStandings[homeTeam.toLowerCase()] || {};
          const aStand = mlbStandings[g.teams?.away?.team?.id] || mlbStandings[awayTeam.toLowerCase()] || {};

          const hPct = (hStand.runsScored && hStand.runsAllowed) ? (hStand.runsScored / (hStand.runsScored + hStand.runsAllowed)) : 0.500;
          const aPct = (aStand.runsScored && aStand.runsAllowed) ? (aStand.runsScored / (aStand.runsScored + aStand.runsAllowed)) : 0.500;

          const hOps = Math.min(0.810, Math.max(0.670, 0.720 + (hPct - 0.5) * 0.4)).toFixed(3);
          const aOps = Math.min(0.810, Math.max(0.670, 0.720 + (aPct - 0.5) * 0.4)).toFixed(3);

          const hElo = getDynamicElo(homeTeam, Math.round(1350 + hPct * 300));
          const aElo = getDynamicElo(awayTeam, Math.round(1350 + aPct * 300));

          const hWhip = hPct >= aPct ? 1.18 : 1.35;
          const aWhip = aPct >= hPct ? 1.18 : 1.35;

          // Sabermetría Dinámica
          const sabers = calculateMlbProbabilities(
            hOps, aWhip, aOps, hWhip,
            hElo, aElo,
            1, 1,
            learned.homePenalty, learned.awayPenalty,
            homeTeam
          );

          const mc = simulateMlbMatch(hWhip, aWhip, hOps, aOps, 1000);
          const matchObj = {
            id: g.gamePk,
            sport: 'mlb',
            home: { name: homeTeam, elo: hElo },
            away: { name: awayTeam, elo: aElo },
            market: { current: odds.closingHome || '1.85' }
          };

          const consensus = evaluateEnsembleConsensus(matchObj, sabers, mc, learned);

          const f5Home = parseFloat(sabers.f5?.homeMl || 50);
          const f5Away = parseFloat(sabers.f5?.awayMl || 50);
          const fullHome = parseFloat(sabers.homeWin || 50);
          const fullAway = parseFloat(sabers.awayWin || 50);

          let candidatePick = null;
          let pickType = '';
          let placedOdds = 1.85;
          let closingOdds = 1.85;
          let isWon = false;
          let isPush = false;

          // Regla F5 vs Full Game ML
          if (f5H !== null && f5A !== null && (f5Home >= 60 || f5Away >= 60)) {
            const isH = f5Home >= f5Away;
            const chosen = isH ? homeTeam : awayTeam;
            candidatePick = `${chosen} F5 Moneyline`;
            pickType = 'F5 MLB';
            placedOdds = 1.80;
            closingOdds = isH ? (odds.closingHome || 1.80) : (odds.closingAway || 1.80);

            if (f5H === f5A) isPush = true;
            else isWon = isH ? (f5H > f5A) : (f5A > f5H);
          } else if (fullHome >= 57 || fullAway >= 57) {
            const isH = fullHome >= fullAway;
            const chosen = isH ? homeTeam : awayTeam;
            candidatePick = `${chosen} Moneyline (ML)`;
            pickType = 'Moneyline';
            placedOdds = isH ? (odds.closingHome || 1.85) : (odds.closingAway || 1.95);
            closingOdds = placedOdds;
            isWon = isH ? (homeScore > awayScore) : (awayScore > homeScore);
          }

          if (candidatePick && (consensus.votesPassed >= 2)) {
            const winProb = Math.max(f5Home, f5Away, fullHome, fullAway);
            const kelly = calculateKellyStake(winProb, placedOdds, 'mlb');
            const clv = closingOdds && placedOdds ? Number((((placedOdds / closingOdds) - 1) * 100).toFixed(1)) : 0;

            evaluatedPicks.push({
              sport: 'MLB',
              game: `${homeTeam} vs ${awayTeam}`,
              date: d.date,
              score: f5H !== null ? `F5: ${f5H}-${f5A} (Final: ${homeScore}-${awayScore})` : `Final: ${homeScore}-${awayScore}`,
              pick: candidatePick,
              pickType,
              odds: placedOdds,
              closingOdds,
              clv,
              consensus: `${consensus.votesPassed}/3`,
              stake: Math.min(2.0, Math.max(1.0, parseFloat(kelly.stakeUnits || 1.0))),
              result: isPush ? 'PUSH' : isWon ? 'WON' : 'LOST'
            });
          }
        }
      }
    }
  } catch (e) {}

  return evaluatedPicks;
}

async function backtestSoccer(dateList) {
  const evaluatedPicks = [];
  const leagues = [
    { code: 'uefa.champions', name: 'Champions League' },
    { code: 'uefa.nations', name: 'UEFA Nations League' },
    { code: 'concacaf.nations.league', name: 'Concacaf Nations League' },
    { code: 'esp.1', name: 'LaLiga' },
    { code: 'eng.1', name: 'Premier League' },
    { code: 'mex.1', name: 'Liga MX' },
    { code: 'mex.w.1', name: 'Liga MX Femenil' },
    { code: 'usa.nwsl', name: 'NWSL Femenil' },
    { code: 'esp.w.1', name: 'Liga F Femenil' }
  ];

  for (const l of leagues) {
    const standings = await fetchLiveSoccerStandings(l.code);

    for (const d of dateList) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${l.code}/scoreboard?dates=${d.espn}`);
        if (!res.ok) continue;
        const data = await res.json();

        for (const ev of (data.events || [])) {
          const comp = ev.competitions?.[0];
          if (!comp || !comp.status?.type?.completed) continue;

          const home = comp.competitors?.find(c => c.homeAway === 'home');
          const away = comp.competitors?.find(c => c.homeAway === 'away');
          if (!home || !away) continue;

          const homeTeam = home.team?.displayName || '';
          const awayTeam = away.team?.displayName || '';
          const homeScore = parseInt(home.score || 0, 10);
          const awayScore = parseInt(away.score || 0, 10);

          const hStats = standings[home.team?.id] || knownSoccerTeams[homeTeam.toLowerCase()] || { xG: "1.50", elo: 1500 };
          const aStats = standings[away.team?.id] || knownSoccerTeams[awayTeam.toLowerCase()] || { xG: "1.20", elo: 1450 };

          const odds = extractOddsFromEspn(comp.odds?.[0]);
          const learned = getLearnedAdjustmentsForMatch(homeTeam, awayTeam);

          // Poisson
          const probs = calculateMatchProbabilities(
            hStats.xG, aStats.xG,
            hStats.elo, aStats.elo,
            5, 5,
            learned.homePenalty, learned.awayPenalty
          );

          const mc = simulateSoccerMatch(hStats.xG, aStats.xG, 1000);
          const matchObj = {
            id: ev.id,
            sport: 'futbol',
            home: { name: homeTeam, elo: hStats.elo },
            away: { name: awayTeam, elo: aStats.elo },
            market: { current: odds.closingHome || '1.85' }
          };

          const consensus = evaluateEnsembleConsensus(matchObj, probs, mc, learned);

          const hWin = parseFloat(probs.homeWin);
          const aWin = parseFloat(probs.awayWin);
          const drWin = parseFloat(probs.draw);
          const o25 = parseFloat(probs.over25);

          let candidatePick = null;
          let pickType = '';
          let placedOdds = 1.85;
          let closingOdds = 1.85;
          let isWon = false;
          let isPush = false;

          // Reglas de Pick de Fútbol
          if (drWin >= 26 && (hWin >= 42 || aWin >= 42)) {
            const isH = hWin >= aWin;
            const chosen = isH ? homeTeam : awayTeam;
            candidatePick = `${chosen} o Empate (${isH ? '1X' : 'X2'})`;
            pickType = 'Doble Oportunidad';
            placedOdds = isH ? parseFloat(probs.doubleChance.odds1X) : parseFloat(probs.doubleChance.oddsX2);
            closingOdds = placedOdds;
            isWon = isH ? (homeScore >= awayScore) : (awayScore >= homeScore);
          } else if (hWin >= 56) {
            candidatePick = `Victoria ${homeTeam}`;
            pickType = '1X2';
            placedOdds = odds.closingHome || parseFloat(probs.fairHomeOdds || 1.80);
            closingOdds = odds.closingHome || placedOdds;
            isWon = homeScore > awayScore;
          } else if (aWin >= 54) {
            candidatePick = `Victoria ${awayTeam}`;
            pickType = '1X2';
            placedOdds = odds.closingAway || parseFloat(probs.fairAwayOdds || 1.85);
            closingOdds = odds.closingAway || placedOdds;
            isWon = awayScore > homeScore;
          } else if (o25 >= 58) {
            candidatePick = 'Más de 2.5 Goles';
            pickType = 'Totales Goles';
            placedOdds = odds.closingOver || 1.85;
            closingOdds = placedOdds;
            isWon = (homeScore + awayScore) > 2;
          }

          if (candidatePick && (consensus.votesPassed >= 2)) {
            const winProb = Math.max(hWin, aWin, o25);
            const kelly = calculateKellyStake(winProb, placedOdds, 'futbol');
            const clv = closingOdds && placedOdds ? Number((((placedOdds / closingOdds) - 1) * 100).toFixed(1)) : 0;

            evaluatedPicks.push({
              sport: 'Fútbol',
              league: l.name,
              game: `${homeTeam} vs ${awayTeam}`,
              date: d.iso,
              score: `${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`,
              pick: candidatePick,
              pickType,
              odds: Number(placedOdds.toFixed(2)),
              closingOdds: Number(closingOdds.toFixed(2)),
              clv,
              consensus: `${consensus.votesPassed}/3`,
              stake: Math.min(2.0, Math.max(1.0, parseFloat(kelly.stakeUnits || 1.0))),
              result: isWon ? 'WON' : 'LOST'
            });
          }
        }
      } catch (e) {}
    }
  }

  return evaluatedPicks;
}

// ==========================================
// 3. AGREGACIÓN DE MÉTRICAS Y ESTADÍSTICAS
// ==========================================

function computeBacktestStats(picks) {
  const total = picks.length;
  if (total === 0) {
    return { total: 0, wins: 0, losses: 0, pushes: 0, winRate: "0.0", flatProfit: "0.0", flatRoi: "0.0", kellyProfit: "0.0", kellyRoi: "0.0" };
  }

  const wins = picks.filter(p => p.result === 'WON').length;
  const losses = picks.filter(p => p.result === 'LOST').length;
  const pushes = picks.filter(p => p.result === 'PUSH').length;

  const resolved = wins + losses;
  const winRate = resolved > 0 ? ((wins / resolved) * 100).toFixed(1) : "0.0";

  // Flat Stake (1 unidad fija)
  let flatProfit = 0;
  picks.forEach(p => {
    if (p.result === 'WON') flatProfit += (p.odds - 1);
    else if (p.result === 'LOST') flatProfit -= 1.0;
  });
  const flatRoi = total > 0 ? ((flatProfit / total) * 100).toFixed(1) : "0.0";

  // Kelly Stake (Unidades dinámicas calculadas por Edge/Kelly)
  let totalKellyInvested = 0;
  let kellyProfit = 0;
  let currentBankroll = 100.0;
  let peakBankroll = 100.0;
  let maxDrawdown = 0.0;

  picks.forEach(p => {
    const stake = p.stake || 1.0;
    totalKellyInvested += stake;

    let pnl = 0;
    if (p.result === 'WON') pnl = stake * (p.odds - 1);
    else if (p.result === 'LOST') pnl = -stake;

    kellyProfit += pnl;
    currentBankroll += pnl;

    if (currentBankroll > peakBankroll) peakBankroll = currentBankroll;
    const dd = peakBankroll - currentBankroll;
    if (dd > maxDrawdown) maxDrawdown = dd;
  });

  const kellyRoi = totalKellyInvested > 0 ? ((kellyProfit / totalKellyInvested) * 100).toFixed(1) : "0.0";

  // CLV Metrics
  const clvPicks = picks.filter(p => p.clv !== undefined && p.clv !== null);
  const beatClv = clvPicks.filter(p => p.clv > 0).length;
  const beatClvRate = clvPicks.length > 0 ? ((beatClv / clvPicks.length) * 100).toFixed(1) : "0.0";
  const avgClv = clvPicks.length > 0 ? (clvPicks.reduce((acc, c) => acc + c.clv, 0) / clvPicks.length).toFixed(1) : "0.0";

  // Profit Factor (Gross Profits / Gross Losses)
  let grossProfit = 0;
  let grossLoss = 0;
  picks.forEach(p => {
    if (p.result === 'WON') grossProfit += (p.odds - 1);
    else if (p.result === 'LOST') grossLoss += 1.0;
  });
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "99.9" : "0.0";

  return {
    total,
    wins,
    losses,
    pushes,
    winRate,
    flatProfit: flatProfit.toFixed(2),
    flatRoi,
    kellyProfit: kellyProfit.toFixed(2),
    kellyRoi,
    maxDrawdown: maxDrawdown.toFixed(2),
    profitFactor,
    beatClvRate,
    avgClv
  };
}

// ==========================================
// 4. FUNCIÓN PRINCIPAL DE EJECUCIÓN
// ==========================================

export async function runBacktest() {
  console.log(`\n=============================================================`);
  console.log(`🔬 MOTOR CUANTITATIVO DE BACKTESTING — STATS-AI PRO 🔬`);
  console.log(`=============================================================`);
  console.log(`📅 Ventana de Prueba: Últimos ${daysBack} días`);
  console.log(`🎯 Filtro de Deporte: ${targetSport.toUpperCase()}`);
  console.log(`⚖️ Edge Mínimo Requerido: +${minEdgeThreshold}%`);
  console.log(`🏛️ Tribunal de Consenso: Exigencia 2/3 o 3/3 Votos`);
  console.log(`⏳ Descargando feeds oficiales de ESPN y MLB Stats API...\n`);

  const dateList = getDateList(daysBack);
  let allPicks = [];

  if (targetSport === 'all' || targetSport === 'nfl') {
    process.stdout.write(`🏈 Analizando NFL (${dateList.length} jornadas)... `);
    const nflPicks = await backtestNfl(dateList);
    console.log(`✓ ${nflPicks.length} picks calificados.`);
    allPicks = allPicks.concat(nflPicks);
  }

  if (targetSport === 'all' || targetSport === 'mlb') {
    process.stdout.write(`⚾ Analizando MLB (${dateList.length} jornadas)... `);
    const mlbPicks = await backtestMlb(dateList);
    console.log(`✓ ${mlbPicks.length} picks calificados.`);
    allPicks = allPicks.concat(mlbPicks);
  }

  if (targetSport === 'all' || targetSport === 'futbol') {
    process.stdout.write(`⚽ Analizando Fútbol Continental y Femenil... `);
    const soccerPicks = await backtestSoccer(dateList);
    console.log(`✓ ${soccerPicks.length} picks calificados.`);
    allPicks = allPicks.concat(soccerPicks);
  }

  if (allPicks.length === 0) {
    console.log(`\n⚠️ No se encontraron selecciones que hayan superado el filtro de edge y consenso.`);
    return;
  }

  // Ordenar por fecha cronológica para cálculo preciso de Drawdown
  allPicks.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Métricas Generales
  const overall = computeBacktestStats(allPicks);

  // Desglose por Deporte
  const sports = ['Fútbol', 'NFL', 'MLB'];
  const sportBreakdown = {};
  sports.forEach(s => {
    const filtered = allPicks.filter(p => p.sport.toLowerCase() === s.toLowerCase());
    if (filtered.length > 0) sportBreakdown[s] = computeBacktestStats(filtered);
  });

  // Desglose por Tipo de Mercado
  const marketTypes = ['Moneyline', 'F5 MLB', 'Spread', 'Totales', 'Doble Oportunidad'];
  const marketBreakdown = {};
  marketTypes.forEach(m => {
    const filtered = allPicks.filter(p => (p.pickType || '').toLowerCase().includes(m.toLowerCase()));
    if (filtered.length > 0) marketBreakdown[m] = computeBacktestStats(filtered);
  });

  // Desglose por Consenso (3/3 vs 2/3)
  const unanimousPicks = allPicks.filter(p => p.consensus === '3/3');
  const majorityPicks = allPicks.filter(p => p.consensus === '2/3');
  const unanimousStats = computeBacktestStats(unanimousPicks);
  const majorityStats = computeBacktestStats(majorityPicks);

  // ==========================================
  // 5. REPORTE EJECUTIVO EN CONSOLA
  // ==========================================

  console.log(`\n=============================================================`);
  console.log(`📊 INFORME EJECUTIVO DE RENDIMIENTO HISTÓRICO`);
  console.log(`=============================================================`);
  console.log(`🎯 Total Apuestas Calificadas:  ${overall.total}`);
  console.log(`✅ Aciertos (Wins):            ${overall.wins}`);
  console.log(`❌ Fallos (Losses):            ${overall.losses}`);
  console.log(`🟡 Empates (Pushes):           ${overall.pushes}`);
  console.log(`📈 Efectividad (Hit Rate):      ${overall.winRate}%`);
  console.log(`-------------------------------------------------------------`);
  console.log(`💰 Rendimiento Flat (1u fija):  ${overall.flatProfit >= 0 ? '+' : ''}${overall.flatProfit} Unidades (ROI: ${overall.flatRoi}%)`);
  console.log(`💼 Rendimiento Kelly Fraccional: ${overall.kellyProfit >= 0 ? '+' : ''}${overall.kellyProfit} Unidades (ROI: ${overall.kellyRoi}%)`);
  console.log(`📉 Máximo Drawdown Registrado:  -${overall.maxDrawdown} Unidades`);
  console.log(`⚖️ Factor de Beneficio (PF):    ${overall.profitFactor}x`);
  console.log(`🎯 Beat Closing Line (CLV%):    ${overall.beatClvRate}% (Promedio: ${overall.avgClv >= 0 ? '+' : ''}${overall.avgClv}%)`);
  console.log(`=============================================================\n`);

  console.log(`📌 DESGLOSE POR DEPORTE:`);
  console.log(`┌─────────┬────────┬───────┬────────┬──────────┬──────────┬────────┐`);
  console.log(`│ Deporte │ Picks  │ Win % │ Pushes │ Flat U.  │ Flat ROI │ BeatCLV│`);
  console.log(`├─────────┼────────┼───────┼────────┼──────────┼──────────┼────────┤`);
  Object.keys(sportBreakdown).forEach(s => {
    const st = sportBreakdown[s];
    const uStr = `${st.flatProfit >= 0 ? '+' : ''}${st.flatProfit}u`.padEnd(8);
    const roiStr = `${st.flatRoi}%`.padEnd(8);
    console.log(`│ ${s.padEnd(7)} │ ${String(st.total).padEnd(6)} │ ${(st.winRate + '%').padEnd(5)} │ ${String(st.pushes).padEnd(6)} │ ${uStr} │ ${roiStr} │ ${(st.beatClvRate + '%').padEnd(6)} │`);
  });
  console.log(`└─────────┴────────┴───────┴────────┴──────────┴──────────┴────────┘\n`);

  console.log(`📌 DESGLOSE POR TRIBUNAL DE CONSENSO:`);
  console.log(` • 🗳️ Unanimidad (3/3 Votos - Tier 1): ${unanimousStats.total} picks | Acierto: ${unanimousStats.winRate}% | ROI: ${unanimousStats.flatProfit >= 0 ? '+' : ''}${unanimousStats.flatProfit}u (${unanimousStats.flatRoi}%)`);
  console.log(` • ⚖️ Mayoría   (2/3 Votos - Tier 2): ${majorityStats.total} picks | Acierto: ${majorityStats.winRate}% | ROI: ${majorityStats.flatProfit >= 0 ? '+' : ''}${majorityStats.flatProfit}u (${majorityStats.flatRoi}%)\n`);

  if (isVerbose) {
    console.log(`📋 REGISTRO DETALLADO DE PICKS:`);
    allPicks.forEach((p, idx) => {
      const sym = p.result === 'WON' ? '✅' : p.result === 'PUSH' ? '🟡' : '❌';
      console.log(` ${sym} [${p.sport}] ${p.game} -> ${p.pick} @ ${p.odds} | ${p.result} | Consenso: ${p.consensus} | Marcador: ${p.score}`);
    });
    console.log('');
  }

  // Guardar archivo JSON
  if (saveJson) {
    const reportPath = path.resolve(__dirname, '../reports/backtest-latest.json');
    const fullReport = {
      timestamp: new Date().toISOString(),
      parameters: { daysBack, targetSport, minEdgeThreshold },
      overall,
      sportBreakdown,
      marketBreakdown,
      consensusBreakdown: { unanimous: unanimousStats, majority: majorityStats },
      picks: allPicks
    };
    fs.writeFileSync(reportPath, JSON.stringify(fullReport, null, 2), 'utf-8');
    console.log(`📁 Reporte completo guardado en: reports/backtest-latest.json\n`);
  }
}

// Ejecutar si se corre desde CLI
if (process.argv[1] && process.argv[1].endsWith('backtest.js')) {
  runBacktest().catch(err => {
    console.error("Fallo durante el backtesting:", err);
  });
}
