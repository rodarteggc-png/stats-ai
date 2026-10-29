// api/quota.js - Vercel Serverless Function para auditar cuota de The Odds API y API-Sports
import { getOddsApiKeys } from '../src/services/sportsApi.js';
import { getApiSportsStatus } from '../src/services/apiSports.js';

export default async function handler(req, res) {
  try {
    const [theOddsApiResults, apiSportsStatus] = await Promise.all([
      (async () => {
        const keys = getOddsApiKeys();
        const results = await Promise.all(
          keys.map(async (key, idx) => {
            const masked = `****${key.slice(-4)}`;
            try {
              const response = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${key}`);
              const remaining = response.headers.get('x-requests-remaining');
              const used = response.headers.get('x-requests-used');
              const lastCost = response.headers.get('x-requests-last');
              
              return {
                id: `Llave ${idx + 1}`,
                key: masked,
                status: response.status === 200 ? 'ACTIVA (200 OK)' : `HTTP ${response.status}`,
                requestsRemaining: remaining !== null ? parseInt(remaining, 10) : null,
                requestsUsed: used !== null ? parseInt(used, 10) : null,
                lastCost: lastCost !== null ? parseInt(lastCost, 10) : null,
                isValid: response.status === 200
              };
            } catch (err) {
              return {
                id: `Llave ${idx + 1}`,
                key: masked,
                status: 'ERROR_CONEXION',
                error: err.message,
                requestsRemaining: null,
                requestsUsed: null,
                isValid: false
              };
            }
          })
        );
        const totalRemaining = results.reduce((acc, r) => acc + (r.requestsRemaining || 0), 0);
        const totalUsed = results.reduce((acc, r) => acc + (r.requestsUsed || 0), 0);
        const totalCapacity = results.length * 500;
        return {
          poolSummary: {
            totalKeys: keys.length,
            activeKeys: results.filter(r => r.isValid).length,
            totalCapacity,
            totalRemaining,
            totalUsed,
            usagePercentage: totalCapacity > 0 ? ((totalUsed / totalCapacity) * 100).toFixed(1) + '%' : '0%'
          },
          keys: results
        };
      })(),
      getApiSportsStatus()
    ]);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      apiSports: {
        provider: 'API-SPORTS (api-sports.io)',
        plan: apiSportsStatus.plan,
        active: apiSportsStatus.active,
        dailyLimit: apiSportsStatus.dailyLimit,
        requestsUsedToday: apiSportsStatus.requestsUsedToday,
        remainingToday: apiSportsStatus.remainingToday,
        status: apiSportsStatus.success ? '🟢 CONECTADA Y OPERATIVA' : '🔴 ERROR'
      },
      theOddsApi: theOddsApiResults
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
