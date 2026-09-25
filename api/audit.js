// api/audit.js - Sincronización de Alertas y Auditoría de Telegram hacia la Web App
import { runDailyTelegramAudit } from '../scripts/alertEngine.js';

export default async function handler(req, res) {
  try {
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
