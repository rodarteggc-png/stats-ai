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
 * Verifica el header que Telegram envía cuando el webhook se registra con `secret_token`.
 * Si no está configurada la variable en el servidor, permite la entrega (el webhook ya valida que senderId sea VIP).
 */
export function isValidTelegramWebhook(req) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
  const header = req.headers?.['x-telegram-bot-api-secret-token'] || '';
  return Boolean(header) && safeEqual(header, secret);
}
