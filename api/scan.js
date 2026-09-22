// api/scan.js - Vercel Serverless Function
import { runAlertEngine } from '../scripts/alertEngine.js';

export default async function handler(req, res) {
  try {
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
