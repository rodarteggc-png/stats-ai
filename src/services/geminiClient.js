// src/services/geminiClient.js - Llamadas a Gemini vía /api/gemini (sin llaves en el bundle).
const TOKEN_KEY = 'fstats_portal_token';

function getPortalToken() {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) || '';
}

/**
 * @param {string} model
 * @param {'generateContent'|'embedContent'} op
 * @param {object} payload - Cuerpo idéntico al que espera la API de Gemini
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
export async function callGemini(model, op, payload) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getPortalToken();
  if (token) headers['x-portal-token'] = token;

  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, op, payload })
  });
  if (res.status === 401) localStorage.removeItem(TOKEN_KEY);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
