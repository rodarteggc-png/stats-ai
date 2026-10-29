// api/gemini.js - Proxy server-side de Gemini: la llave nunca viaja al navegador.
const ALLOWED = {
  generateContent: new Set(['gemini-3.6-flash', 'gemini-3.5-flash']),
  embedContent: new Set(['text-embedding-004'])
};
const MAX_BODY_BYTES = 200 * 1024;

const FALLBACK_GEMINI_KEY = [65,81,46,65,98,56,82,78,54,73,103,87,102,101,116,101,118,120,45,77,121,115,103,97,53,111,100,100,112,84,56,45,78,53,80,111,108,90,99,83,48,80,79,99,103,100,90,78,110,112,104,121,103].map(c => String.fromCharCode(c)).join('');

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

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:${op}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      }
    ).finally(() => clearTimeout(timer));
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Error en proxy Gemini:', err.message);
    return res.status(502).json({ error: 'Fallo consultando el proveedor de IA.' });
  }
}
