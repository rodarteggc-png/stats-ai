// api/audit.js - Sincronización Bidireccional de Alertas, Unánimes 3/3 del Portal y Auditoría Oficial
import { runDailyTelegramAudit, registerPortalUnanimousPicks } from '../scripts/alertEngine.js';
import { requireCronAuth } from './_lib/security.js';

const MAX_PORTAL_PICKS = 25;

function sanitizePortalPick(p) {
  if (!p || typeof p !== 'object' || typeof p.pick !== 'string') return null;
  const odds = parseFloat(p.odds);
  const prob = parseFloat(p.prob);
  if (!(odds > 1.01 && odds < 50) || !(prob > 0 && prob < 100)) return null;
  const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return {
    id: str(p.id, 80),
    pick: str(p.pick),
    sport: str(p.sport, 30),
    league: str(p.league, 60),
    type: str(p.type, 80),
    homeName: str(p.homeName || p.match?.home?.name, 60),
    awayName: str(p.awayName || p.match?.away?.name, 60),
    gameDate: str(p.gameDate, 40),
    prob: `${prob}%`,
    odds: odds.toFixed(2),
    stakeUnits: Math.min(2.0, Math.max(0, parseFloat(p.stakeUnits) || 1.0)),
    argument: str(p.argument || p.reason, 500)
  };
}

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const picks = (Array.isArray(body.picks) ? body.picks : [])
        .slice(0, MAX_PORTAL_PICKS)
        .map(sanitizePortalPick)
        .filter(Boolean);
      const reg = await registerPortalUnanimousPicks(picks);
      return res.status(200).json({
        success: true,
        registeredCount: reg.registeredCount
      });
    }

    const sendToTelegram = req.query?.notify === 'true' || req.query?.notify === '1';
    const forceAudit = req.query?.force === 'true' || req.query?.force === '1';
    const result = await runDailyTelegramAudit({
      sendToTelegram,
      forceAudit
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      auditSent: result.auditSent,
      summary: result.summary,
      auditedPicks: result.auditedPicks,
      pendingPicks: result.pendingPicks,
      runtimePenalties: result.runtimePenalties,
      dynamicElo: result.dynamicElo || {},
      plattCoefficients: result.plattCoefficients || null
    });
  } catch (error) {
    console.error('Error en api/audit:', error);
    return res.status(500).json({
      success: false,
      error: 'Fallo interno en la auditoría.'
    });
  }
}
