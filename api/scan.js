// api/scan.js - Vercel Serverless Function
import { runAlertEngine } from '../scripts/alertEngine.js';

export default async function handler(req, res) {
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

    const result = await runAlertEngine();
    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      sentCount: result.sentCount,
      totalOpportunities: result.totalOpportunities
    });
  } catch (error) {
    console.error('Error en api/scan:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
