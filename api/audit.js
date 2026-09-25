// api/audit.js - Sincronización Bidireccional de Alertas, Unánimes 3/3 del Portal y Auditoría Oficial
import { runDailyTelegramAudit, registerPortalUnanimousPicks } from '../scripts/alertEngine.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const picks = Array.isArray(body.picks) ? body.picks : [];
      const reg = await registerPortalUnanimousPicks(picks);
      return res.status(200).json({
        success: true,
        registeredCount: reg.registeredCount
      });
    }

    const sendToTelegram = req.query?.notify === 'true' || req.query?.notify === '1';
    const result = await runDailyTelegramAudit({
      sendToTelegram,
      forceAudit: sendToTelegram
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      auditSent: result.auditSent,
      summary: result.summary,
      auditedPicks: result.auditedPicks,
      pendingPicks: result.pendingPicks,
      runtimePenalties: result.runtimePenalties
    });
  } catch (error) {
    console.error('Error en api/audit:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
