// api/quota.js - Vercel Serverless Function para auditar cuota de The Odds API y API-Sports
// S1 (lote 2, 2026-11-16): endpoint autenticado (Bearer CRON_SECRET, fail-closed:
// 503 si la variable no está configurada) y con caché en memoria de 90 s.
// Antes era público, exponía el email y el nombre de la cuenta API-Sports, y cada
// llamada hacía 1 petición en vivo por llave a cada proveedor.
// Llamadores en código: NINGUNO. El /cuota de Telegram calcula en proceso
// (api/webhook.js) y el botón de la web llama directo al proveedor con la llave
// del usuario (src/App.jsx -> checkOddsApiUsage); este endpoint solo se abría
// a mano en el navegador. La consulta manual pasa a hacerse con:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://stats-ai-pi.vercel.app/api/quota
// o con /cuota en Telegram (sin cambios).
import { getOddsApiKeys } from '../src/services/sportsApi.js';
import { getApiSportsStatusAll } from '../src/services/apiSports.js';
import { requireCronAuthStrict } from './_lib/security.js';

// Dentro del rango pedido (60-120 s). Caché en memoria por instancia de Vercel:
// instancias distintas tienen cachés distintos; es solo un freno al golpeo de
// proveedores, no una garantía de una única llamada global.
export const QUOTA_CACHE_TTL_MS = 90 * 1000;

let cachedPayload = null;
let cachedAtMs = 0;

/** Solo para tests: vacía el caché en memoria. */
export function clearQuotaCache() {
  cachedPayload = null;
  cachedAtMs = 0;
}

// Quita los campos personales de cada llave API-Sports (email y nombre de la
// cuenta): el diagnóstico solo necesita plan, uso y estado. La llave ya viene
// enmascarada (****últimos 4) desde getApiSportsStatusAll.
function sanitizeApiSportsKeys(keys = []) {
  return keys.map(({ email: _email, account: _account, ...rest }) => rest);
}

async function buildQuotaPayload() {
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
    getApiSportsStatusAll()
  ]);

  const firstKey = apiSportsStatus.keys?.[0] || {};

  return {
    success: true,
    timestamp: new Date().toISOString(),
    apiSports: {
      provider: 'API-SPORTS (api-sports.io)',
      plan: firstKey.plan,
      active: firstKey.active,
      dailyLimit: apiSportsStatus.poolSummary.totalCapacity,
      requestsUsedToday: apiSportsStatus.poolSummary.totalUsed,
      remainingToday: apiSportsStatus.poolSummary.totalRemaining,
      status: apiSportsStatus.poolSummary.healthyKeys > 0 ? '🟢 CONECTADA Y OPERATIVA' : '🔴 ERROR',
      poolSummary: apiSportsStatus.poolSummary,
      keys: sanitizeApiSportsKeys(apiSportsStatus.keys)
    },
    theOddsApi: theOddsApiResults
  };
}

export default async function handler(req, res) {
  if (!requireCronAuthStrict(req, res)) return;
  try {
    const now = Date.now();
    if (cachedPayload && now - cachedAtMs < QUOTA_CACHE_TTL_MS) {
      return res.status(200).json({ ...cachedPayload, cached: true, cacheAgeMs: now - cachedAtMs });
    }
    const payload = await buildQuotaPayload();
    cachedPayload = payload;
    cachedAtMs = now;
    return res.status(200).json({ ...payload, cached: false, cacheAgeMs: 0 });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
