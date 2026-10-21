// api/webhook.js - Webhook interactivo de Telegram para Stats-AI Pro
import { runAlertEngine, runDailyTelegramAudit, sendTelegramMessage } from '../scripts/alertEngine.js';
import { getApiSportsStatus } from '../src/services/apiSports.js';
import { getOddsApiKeys } from '../src/services/sportsApi.js';

// Teclado simplificado con ÚNICAMENTE las 3 opciones requeridas por el usuario
const KEYBOARD_MENU = {
  keyboard: [
    [{ text: '/vip' }, { text: '/cuota' }, { text: '/corte' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

export default async function handler(req, res) {
  // Telegram envía las actualizaciones vía método POST
  if (req.method !== 'POST') {
    return res.status(200).json({
      status: 'active',
      bot: '@stat_io_pro_bot',
      webhook: 'ready',
      options: ['/vip', '/cuota', '/corte']
    });
  }

  try {
    const update = req.body;
    if (!update || (!update.message && !update.edited_message)) {
      return res.status(200).send('OK');
    }

    const message = update.message || update.edited_message;
    const senderId = message.from?.id;
    const chatId = message.chat?.id;
    const rawText = (message.text || '').trim();
    const command = rawText.toLowerCase();

    const VIP_CHAT_ID = process.env.TELEGRAM_VIP_CHAT_ID 
      ? Number(process.env.TELEGRAM_VIP_CHAT_ID) 
      : 1258878024;

    // 🔒 Candado de seguridad exclusivo: solo responde a Tavo Rodarte
    if (senderId !== VIP_CHAT_ID) {
      console.warn(`[Webhook] Intento no autorizado desde ID ${senderId} (${message.from?.first_name || 'Desconocido'})`);
      await sendTelegramMessage(
        '⛔ *Acceso restringido.* Este asistente cuantitativo está configurado exclusivamente para uso administrativo VIP.',
        false,
        chatId
      );
      return res.status(200).send('OK');
    }

    // ==========================================
    // OPCIÓN 1: /vip -> DISPARAR CARTELERA VIP
    // ==========================================
    if (command === '/vip' || command === '/cartelera' || command === '1' || command === 'vip' || command === 'cartelera' || command === '/flash' || command === '/steam') {
      await sendTelegramMessage(
        '⏳ *Escaneando mercados en tiempo real...*\n🔬 _Consultando cuotas Pinnacle en API-Sports, clima Open-Meteo, xG en FotMob y simulaciones Monte Carlo en Fútbol, NFL, MLB y NBA... Recibirás el análisis individual a continuación._',
        false,
        chatId,
        KEYBOARD_MENU
      );

      try {
        const result = await runAlertEngine({ force: true, vip: true });
        if (result.sentCount === 0) {
          await sendTelegramMessage(
            '✅ *Mercado al día:* Todas las selecciones aprobadas de hoy ya fueron analizadas o las cuotas actuales no superan los filtros institucionales.',
            false,
            chatId,
            KEYBOARD_MENU
          );
        }
      } catch (err) {
        console.error('Error ejecutando runAlertEngine en webhook:', err);
        await sendTelegramMessage(
          `⚠️ *Aviso en escaneo:* ${err.message}`,
          false,
          chatId,
          KEYBOARD_MENU
        );
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // OPCIÓN 2: /cuota -> CONSULTAR SALDO APIS
    // ==========================================
    if (command === '/cuota' || command === '/quota' || command === '2' || command === 'cuota' || command === 'quota') {
      try {
        const apiSports = await getApiSportsStatus();
        const keys = getOddsApiKeys();

        const msg = [
          `📊 *ESTADO OFICIAL DE CONSUMO DE APIS*`,
          ``,
          `🏛️ *API-Sports (Pinnacle & Bet365 Failover):*`,
          `• *Plan:* \`Free (100 req/día)\``,
          `• *Usadas hoy:* \`${apiSports.requestsUsedToday} / ${apiSports.dailyLimit}\``,
          `• *Margen libre:* \`${apiSports.remainingToday} requests disponibles\``,
          `• *Estatus:* \`${apiSports.status}\``,
          `• *Caché en memoria:* \`${apiSports.cachedOddsCount} partidos indexados\``,
          ``,
          `⚡ *The Odds API:*`,
          `• *Llaves configuradas:* \`${keys.length} llaves activas\``,
          `• *Capacidad total:* \`2,000 req/mes\``,
          ``,
          `🛡️ _Consumo optimizado: Solo 4 requests al día en automático (96% de margen libre todos los días)._`
        ].join('\n');

        await sendTelegramMessage(msg, false, chatId, KEYBOARD_MENU);
      } catch (err) {
        console.error('Error consultando cuota:', err);
        await sendTelegramMessage(`⚠️ Error consultando saldo: ${err.message}`, false, chatId, KEYBOARD_MENU);
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // OPCIÓN 3: /corte -> CORTE DE CAJA OFICIAL
    // ==========================================
    if (command === '/corte' || command === '3' || command === 'corte') {
      await sendTelegramMessage('⏳ *Generando Corte de Caja y Auditoría Oficial...*', false, chatId, KEYBOARD_MENU);
      try {
        const auditRes = await runDailyTelegramAudit({
          forceAudit: true,
          targetChatId: chatId,
          sendToTelegram: true
        });
        if (!auditRes.auditSent) {
          await sendTelegramMessage(
            'ℹ️ *Sin partidos finalizados ayer:* No hay selecciones pendientes de calificar o ya fueron reportadas con anterioridad.',
            false,
            chatId,
            KEYBOARD_MENU
          );
        }
      } catch (err) {
        console.error('Error en corte:', err);
        await sendTelegramMessage(`⚠️ Error generando corte de caja: ${err.message}`, false, chatId, KEYBOARD_MENU);
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // MENÚ POR DEFECTO (/start, ayuda o cualquier otro texto)
    // ==========================================
    const menuMsg = [
      `👑 *PANEL DE CONTROL VIP — STATS-AI PRO*`,
      `👋 ¡Hola Tavo! Aquí tienes tus 3 únicas opciones de control:`,
      ``,
      `1️⃣ */vip* — Escanear y recibir Cartelera VIP en tiempo real`,
      `2️⃣ */cuota* — Consultar saldo de requests (API-Sports y The Odds API)`,
      `3️⃣ */corte* — Ver Corte de Caja y Rendimiento de las últimas 24h`,
      ``,
      `👉 *Usa los 3 botones que aparecen abajo en tu pantalla para ejecutar de inmediato sin escribir nada.*`
    ].join('\n');

    await sendTelegramMessage(menuMsg, false, chatId, KEYBOARD_MENU);
    return res.status(200).send('OK');

  } catch (error) {
    console.error('Fallo no controlado en api/webhook:', error);
    return res.status(200).send('OK'); // Telegram requiere siempre 200 para no reintentar
  }
}
