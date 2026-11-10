// api/scan.js - Vercel Serverless Function
import { runAlertEngine } from '../scripts/alertEngine.js';
import { requireCronAuth } from './_lib/security.js';

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;
  try {
    const hasToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const hasChatId = Boolean(process.env.TELEGRAM_CHAT_ID);

    if (!hasToken || !hasChatId) {
      console.warn('Alerta api/scan: Faltan variables de entorno TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Vercel.');
      return res.status(200).json({
        success: false,
        warning: 'Faltan configurar las variables de entorno TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Vercel Dashboard (Settings -> Environment Variables).',
        timestamp: new Date().toISOString()
      });
    }

    const force = req.query?.force === 'true' || req.query?.force === '1';
    const audit = req.query?.audit === 'true' || req.query?.audit === '1';
    const shift = req.query?.shift || (req.query?.nocturno ? 'nocturno' : null);
    const vip = req.query?.vip === 'true' || req.query?.vip === '1';
    // MODO PAPER (2026-11-10): ?paper=1 corre el motor sin despachar picks
    // reales; el slate paper va al chat VIP y queda en el ledger paper.
    const paper = req.query?.paper === 'true' || req.query?.paper === '1';
    const result = await runAlertEngine({ force, audit, shift, vip, paper });
    const targetChat = vip 
      ? (process.env.TELEGRAM_VIP_CHAT_ID || '1258878024') 
      : (process.env.TELEGRAM_CHAT_ID || '');

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      sentCount: result.sentCount,
      totalOpportunities: result.totalOpportunities,
      auditSent: result.auditSent,
      auditSummary: result.auditSummary,
      forced: force,
      vip: vip,
      paper: paper,
      paperEmitted: result.paperEmitted ?? null,
      paperVetoed: result.paperVetoed ?? null,
      paperApprovedNoCupo: result.paperApprovedNoCupo ?? null,
      chatTarget: vip ? `VIP_PRIVATE (${targetChat})` : (targetChat ? `${targetChat.slice(0, 4)}...${targetChat.slice(-4)}` : 'none')
    });
  } catch (error) {
    console.error('Error en api/scan:', error);
    return res.status(500).json({
      success: false,
      error: 'Fallo interno en el escaneo.'
    });
  }
}
