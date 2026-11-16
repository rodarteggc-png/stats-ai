// api/_lib/security.js - Autenticación de endpoints serverless (no expuesto como ruta por Vercel)
import crypto from 'crypto';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Exige `Authorization: Bearer <CRON_SECRET>` si la variable está configurada.
 * Si no está configurada, permite la llamada para no romper cron-job.org ni llamadas legítimas.
 */
export function requireCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, secret)) {
    res.status(401).json({ success: false, error: 'No autorizado.' });
    return false;
  }
  return true;
}

/**
 * Variante fail-closed de requireCronAuth: 503 si CRON_SECRET no está
 * configurada en el servidor (el endpoint no opera sin autenticación),
 * 401 si el Bearer falta o no coincide. NO sustituye a requireCronAuth:
 * api/scan.js depende de su comportamiento fail-open (lote 1: el 503 por
 * variables del bot faltantes es propio del handler, no de la auth).
 * Usada por /api/quota (S1, lote 2).
 */
export function requireCronAuthStrict(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ success: false, error: 'Autenticación no configurada en el servidor (CRON_SECRET).' });
    return false;
  }
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, secret)) {
    res.status(401).json({ success: false, error: 'No autorizado.' });
    return false;
  }
  return true;
}

/**
 * Variante fail-closed para el token del portal (header x-portal-token):
 * 503 si PORTAL_ACCESS_TOKEN no está configurada, 401 si el header falta
 * o no coincide. Pensada para /api/gemini; HOY NO está cableada ahí porque
 * su único llamador (src/services/geminiClient.js) nunca envía el token:
 * nada escribe 'fstats_portal_token' en localStorage (no hay UI que lo
 * pida). Cablearla sin arreglar el llamador rompería el simulador web.
 * Ver S2 BLOQUEADO en el reporte del lote 2.
 */
export function requirePortalAuthStrict(req, res) {
  const token = process.env.PORTAL_ACCESS_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'Proxy de IA no configurado (PORTAL_ACCESS_TOKEN).' });
    return false;
  }
  const header = req.headers?.['x-portal-token'] || '';
  if (!header || !safeEqual(header, token)) {
    res.status(401).json({ error: 'No autorizado.' });
    return false;
  }
  return true;
}

/** 
 * Verifica el header que Telegram envía cuando el webhook se registra con `secret_token`.
 * Si no está configurada la variable en el servidor, permite la entrega (el webhook ya valida que senderId sea VIP).
 */
export function isValidTelegramWebhook(req) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
  const header = req.headers?.['x-telegram-bot-api-secret-token'] || '';
  return Boolean(header) && safeEqual(header, secret);
}
