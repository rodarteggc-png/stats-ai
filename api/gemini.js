// api/gemini.js - Proxy server-side de Gemini: la llave nunca viaja al navegador.
// Cascada de modelos (2026-11-19): si el modelo pedido devuelve 503 (saturado)
// o 429 (cuota), el proxy prueba automáticamente el siguiente modelo, sin que
// el navegador tenga que reintentar. Es el arreglo al error "This model is
// currently experiencing high demand" del simulador manual (gemini-3.8-flash
// saturado). La llave nunca viaja al navegador.
const ALLOWED = {
  generateContent: new Set(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']),
  embedContent: new Set(['text-embedding-004'])
};
const MAX_BODY_BYTES = 200 * 1024;

// Orden de respaldo tras el modelo pedido: los modelos más nuevos primero.
// gemini-2.0-flash fue RETIRADO por Google (404 NOT_FOUND, verificado en vivo
// 2026-11-19) y NO está en la cascada. Un 404 también dispara el respaldo,
// así que un modelo retirado se salta automáticamente.
export const GEMINI_FALLBACK_ORDER = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
const MAX_ATTEMPTS = 5; // modelo pedido + 4 respaldos
const FIRST_ATTEMPT_TIMEOUT_MS = 15000;
const FALLBACK_TIMEOUT_MS = 8000;

const FALLBACK_GEMINI_KEY = ''; // Sin llave en el codigo: solo GEMINI_API_KEY en variables de entorno.

function cascadeFor(requestedModel) {
  const rest = GEMINI_FALLBACK_ORDER.filter((m) => m !== requestedModel);
  return [requestedModel, ...rest].slice(0, MAX_ATTEMPTS);
}

async function callUpstream(model, op, payload, geminiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:${op}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      }
    );
    const data = await upstream.json().catch(() => ({}));
    return { status: upstream.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const portalToken = process.env.PORTAL_ACCESS_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY || FALLBACK_GEMINI_KEY;
  if (!geminiKey) {
    return res.status(503).json({ error: 'Proxy de IA no configurado.' });
  }
  if (portalToken && req.headers['x-portal-token'] !== portalToken) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { model, op, payload } = body;
  if (!ALLOWED[op]?.has(model) || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Modelo u operación no permitidos.' });
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Payload demasiado grande.' });
  }

  // Solo generateContent tiene cascada; embedContent usa el modelo pedido.
  const models = op === 'generateContent' ? cascadeFor(model) : [model];
  let lastUpstreamStatus = null;
  for (let i = 0; i < models.length; i++) {
    const attemptModel = models[i];
    const timeoutMs = i === 0 ? FIRST_ATTEMPT_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;
    try {
      const { status, data } = await callUpstream(attemptModel, op, payload, geminiKey, timeoutMs);
      if (status >= 200 && status < 300) {
        return res.status(status).json(data);
      }
      // 503 (saturado), 429 (cuota) o 404 (modelo retirado/no existe) ->
      // probar el siguiente modelo.
      if (status === 503 || status === 429 || status === 404) {
        lastUpstreamStatus = status;
        continue;
      }
      // Cualquier otro error (400/401/403/...) es del cliente o de config:
      // no tiene sentido probar otro modelo.
      return res.status(status).json(data);
    } catch (err) {
      // Timeout o fallo de red: probar el siguiente modelo.
      lastUpstreamStatus = 502;
      console.error(`Error en proxy Gemini (${attemptModel}):`, err.message);
      continue;
    }
  }
  // Todos los modelos fallaron por saturación/cuota.
  return res.status(503).json({
    error: `Todos los modelos de IA están saturados o sin cuota (${models.join(', ')}). Inténtalo de nuevo en unos minutos.`,
    triedModels: models,
    lastUpstreamStatus,
  });
}
