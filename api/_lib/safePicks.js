// api/_lib/safePicks.js — Picks Seguros (tier separado del slate +EV)
// 2026-11-24: favoritos ML con probabilidad calibrada >= 55% y cuota corta
// (1.13–1.50). Son picks de ALTA probabilidad y cuota corta, NO +EV: el EV
// según el modelo es negativo y se muestra explícitamente, nunca se oculta.
// No toca la matemática congelada ni los 5 candados: reutiliza
// calculateMatchProbabilities + applyPlattCalibration tal cual, y solo añade
// un umbral de selección propio. El registro va a un ledger SEPARADO
// (data/safe_picks_ledger.jsonl), jamás a data/pick_ledger.jsonl.
// Solo disponible en el chat privado VIP (el webhook lo gatea con isPrivateVip).
import { fetchDailySchedule } from '../../src/services/sportsApi.js';
import { calculateMatchProbabilities } from '../../src/utils/poisson.js';
import { applyPlattCalibration } from '../../src/utils/calibration.js';
import { appendFileSync } from 'node:fs';

export const SAFE_MIN_CAL_PROB = 55;
export const SAFE_MIN_ODDS = 1.13;
export const SAFE_MAX_ODDS = 1.5;
export const SAFE_WINDOW_MS = 12 * 60 * 60 * 1000; // próximas 12 h

const DEFAULT_LEDGER = 'data/safe_picks_ledger.jsonl';

function teamName(team) {
  return team?.name || team?.shortName || '';
}

/**
 * Selecciona los picks seguros de una lista de partidos. Pura y testeable.
 * @param {Array} matches - partidos con .home/.away (xG, elo, daysRest),
 *   .league, .gameDate y .market.homeOdds/.awayOdds (DraftKings).
 * @param {number} now - ms epoch (por defecto Date.now()).
 * @param {object} deps - { calculateMatchProbabilities, applyPlattCalibration }
 *   inyectables para tests; por defecto las reales.
 * @returns {Array} picks { game, league, gameDate, side, team, odds, rawProb,
 *   calProb, evCalPct, label: 'SEGURO' }.
 */
export function selectSafePicks(
  matches,
  now = Date.now(),
  deps = { calculateMatchProbabilities, applyPlattCalibration }
) {
  const { calculateMatchProbabilities: calcProbs, applyPlattCalibration: calibrate } = deps;
  const picks = [];
  for (const m of matches || []) {
    const kickoff = Date.parse(m.gameDate || m.date || '');
    if (!kickoff || kickoff <= now || kickoff > now + SAFE_WINDOW_MS) continue;
    const probs = calcProbs(
      m.home?.xG, m.away?.xG,
      m.home?.elo, m.away?.elo,
      m.home?.daysRest, m.away?.daysRest,
      0, 0, 6, false, -0.13, m.league
    );
    const homeName = teamName(m.home);
    const awayName = teamName(m.away);
    const game = `${homeName} vs ${awayName}`;
    const sides = [
      { side: 'home', team: homeName, raw: parseFloat(probs?.homeWin), odds: Number(m.market?.homeOdds) },
      { side: 'away', team: awayName, raw: parseFloat(probs?.awayWin), odds: Number(m.market?.awayOdds) }
    ];
    for (const s of sides) {
      if (!s.team || !Number.isFinite(s.raw) || !Number.isFinite(s.odds)) continue;
      if (s.odds < SAFE_MIN_ODDS || s.odds > SAFE_MAX_ODDS) continue;
      const calProb = calibrate(s.raw, 'futbol');
      if (!Number.isFinite(calProb) || calProb < SAFE_MIN_CAL_PROB) continue;
      picks.push({
        game,
        league: m.league || '',
        gameDate: m.gameDate || m.date || '',
        side: s.side,
        team: s.team,
        odds: s.odds,
        rawProb: s.raw,
        calProb: Math.round(calProb * 10) / 10,
        // EV según el modelo (se espera negativo en favoritos cortos): se
        // muestra, nunca se oculta.
        evCalPct: Math.round(((calProb / 100) * s.odds - 1) * 1000) / 10,
        label: 'SEGURO'
      });
    }
  }
  // Los más probables primero.
  picks.sort((a, b) => b.calProb - a.calProb);
  return picks;
}

/**
 * Carga la cartelera de fútbol de hoy y devuelve los picks seguros.
 * @returns {{ picks: Array, evaluated: number, total: number }}
 */
export async function getSafePicks() {
  const matches = await fetchDailySchedule('futbol');
  const picks = selectSafePicks(matches);
  return { picks, evaluated: matches?.length || 0, total: picks.length };
}

/**
 * Mensaje de Telegram con los picks seguros. Etiqueta clara: alta
 * probabilidad, cuota corta, NO son +EV y van aparte del slate +EV.
 */
export function formatSafePicksMessage(picks, dateStr, evaluated) {
  const lines = [
    `🛡️ *PICKS SEGUROS — STATS-AI PRO*`,
    `${dateStr || ''}`,
    ``,
    `Favoritos con probabilidad alta del modelo (≥ ${SAFE_MIN_CAL_PROB}%) y cuota corta (${SAFE_MIN_ODDS}–${SAFE_MAX_ODDS}).`,
    `⚠️ *NO son +EV:* el EV según el modelo es negativo; son picks de alta probabilidad y poco pago, separados del slate +EV.`,
    ``
  ];
  if (!picks || picks.length === 0) {
    lines.push(`No hay picks seguros que cumplan el umbral en este momento${evaluated ? ` (${evaluated} partidos evaluados)` : ''}.`);
    return lines.join('\n');
  }
  for (const p of picks) {
    lines.push(`🛡️ *${p.team}* — ML @${p.odds} | Prob modelo ${p.calProb}% | EV ${p.evCalPct >= 0 ? '+' : ''}${p.evCalPct}%`);
    lines.push(`   _${p.game}${p.league ? ` · ${p.league}` : ''}_`);
  }
  lines.push(``);
  lines.push(`_Registro aparte del récord +EV. Probabilidades del modelo Poisson + calibración Platt._`);
  return lines.join('\n');
}

/**
 * Registra los picks seguros en su ledger SEPARADO. Best-effort: en Vercel
 * el filesystem serverless es de solo lectura, así que un fallo de escritura
 * nunca bloquea la entrega; el mensaje de Telegram es el registro en
 * producción. Jamás toca data/pick_ledger.jsonl.
 */
export function recordSafePicks(picks, filePath = DEFAULT_LEDGER) {
  if (!picks || picks.length === 0) return 0;
  const date = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const p of picks) {
    try {
      appendFileSync(
        filePath,
        JSON.stringify({ date, match: p.game, pick: `${p.team} ML`, odds: p.odds, calProb: p.calProb }) + '\n'
      );
      written++;
    } catch (err) {
      console.warn('[safePicks] No se pudo registrar en ledger seguro:', err?.message || err);
    }
  }
  return written;
}
