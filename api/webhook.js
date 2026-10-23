// api/webhook.js - Webhook interactivo de Telegram para Stats-AI Pro
import { runAlertEngine, runDailyTelegramAudit, sendTelegramMessage, answerTelegramCallback } from '../scripts/alertEngine.js';
import { getApiSportsStatus } from '../src/services/apiSports.js';
import { getOddsApiKeys } from '../src/services/sportsApi.js';

// Teclado inferior simplificado (persistente en pantalla)
const KEYBOARD_MENU = {
  keyboard: [
    [{ text: '/vip' }, { text: '/cuota' }, { text: '/corte' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

// Menú interactivo de botones táctiles en mensaje (Opción A)
const INLINE_SPORT_MENU = {
  inline_keyboard: [
    [
      { text: '⚽ Fútbol (Liga MX & Europa)', callback_data: 'sport_futbol' },
      { text: '🏀 Baloncesto (NBA)', callback_data: 'sport_nba' }
    ],
    [
      { text: '🏈 Fútbol Americano (NFL)', callback_data: 'sport_nfl' },
      { text: '⚾ Béisbol (MLB)', callback_data: 'sport_mlb' }
    ],
    [
      { text: '🌟 Cartelera Completa (Todos)', callback_data: 'sport_all' }
    ]
  ]
};

export default async function handler(req, res) {
  // Telegram envía las actualizaciones vía método POST
  if (req.method !== 'POST') {
    return res.status(200).json({
      status: 'active',
      bot: '@stat_io_pro_bot',
      webhook: 'ready',
      options: ['/vip', '/cuota', '/corte', 'sport_futbol', 'sport_nba', 'sport_nfl', 'sport_mlb', 'sport_all']
    });
  }

  try {
    const update = req.body;
    if (!update || (!update.message && !update.edited_message && !update.callback_query)) {
      return res.status(200).send('OK');
    }

    const isCallback = Boolean(update.callback_query);
    const callback = update.callback_query;
    const message = isCallback ? callback.message : (update.message || update.edited_message);
    const senderId = isCallback ? callback.from?.id : message?.from?.id;
    const chatId = message?.chat?.id;
    const rawText = isCallback ? (callback.data || '') : (message?.text || '').trim();
    const command = rawText.toLowerCase();

    const VIP_CHAT_ID = process.env.TELEGRAM_VIP_CHAT_ID 
      ? Number(process.env.TELEGRAM_VIP_CHAT_ID) 
      : 1258878024;

    // 🔒 Candado de seguridad exclusivo: solo responde a Tavo Rodarte
    if (senderId !== VIP_CHAT_ID) {
      console.warn(`[Webhook] Intento no autorizado desde ID ${senderId} (${(isCallback ? callback.from : message?.from)?.first_name || 'Desconocido'})`);
      if (isCallback) await answerTelegramCallback(callback.id, 'Acceso restringido');
      await sendTelegramMessage(
        '⛔ *Acceso restringido.* Este asistente cuantitativo está configurado exclusivamente para uso administrativo VIP.',
        false,
        chatId
      );
      return res.status(200).send('OK');
    }

    // Si viene de un botón táctil en pantalla (callback), responder inmediatamente para retirar el reloj de arena
    if (isCallback) {
      await answerTelegramCallback(callback.id);
    }

    // ==========================================
    // OPCIÓN 1: /vip -> DESPLEGAR MENÚ DE DEPORTES
    // ==========================================
    if (command === '/vip' || command === '/cartelera' || command === '1' || command === 'vip' || command === 'cartelera') {
      const msg = [
        `👑 *PANEL VIP — SELECCIÓN DE CARTELERA*`,
        `¿Qué disciplina deportiva deseas escanear en tiempo real con los modelos cuantitativos?`,
        ``,
        `_Toca uno de los botones táctiles abajo para iniciar el escaneo:_`
      ].join('\n');

      await sendTelegramMessage(msg, false, chatId, INLINE_SPORT_MENU);
      return res.status(200).send('OK');
    }

    // ==========================================
    // EJECUCIÓN DE ESCANEO POR DEPORTE O GENERAL
    // ==========================================
    let targetSport = null;
    if (command === 'sport_futbol' || command === '/futbol' || command === '/soccer' || command === '/ligamx' || command === 'futbol') {
      targetSport = 'futbol';
    } else if (command === 'sport_nba' || command === '/nba' || command === '/basket' || command === '/baloncesto' || command === 'nba') {
      targetSport = 'nba';
    } else if (command === 'sport_nfl' || command === '/nfl' || command === '/ncaaf' || command === '/americano' || command === 'nfl') {
      targetSport = 'nfl';
    } else if (command === 'sport_mlb' || command === '/mlb' || command === '/beisbol' || command === 'mlb') {
      targetSport = 'mlb';
    } else if (command === 'sport_all' || command === '/todos' || command === '/all' || command === 'todos' || command === '/flash' || command === '/steam') {
      targetSport = 'all';
    }

    if (targetSport) {
      const sportNames = {
        futbol: '⚽ Fútbol (Liga MX y Europa)',
        nba: '🏀 Baloncesto NBA',
        nfl: '🏈 Fútbol Americano (NFL / NCAAF)',
        mlb: '⚾ Béisbol MLB',
        all: '🌟 Cartelera General Completa'
      };
      const sportLabel = sportNames[targetSport] || targetSport.toUpperCase();

      await sendTelegramMessage(
        `⏳ *Escaneando ${sportLabel} en tiempo real...*\n🔬 _Consultando cuotas Pinnacle en API-Sports, métricas avanzadas y simulación Monte Carlo 10k... Recibirás el análisis individual a continuación._`,
        false,
        chatId,
        KEYBOARD_MENU
      );

      try {
        const result = await runAlertEngine({ force: true, vip: true, sport: targetSport });
        if (result.sentCount === 0) {
          await sendTelegramMessage(
            `✅ *Mercado al día en ${sportLabel}:*\nNo se encontraron selecciones que superen los 5 Candados de Veto (+EV) en este momento o los partidos de hoy ya concluyeron.`,
            false,
            chatId,
            KEYBOARD_MENU
          );
        }
      } catch (err) {
        console.error('Error ejecutando runAlertEngine en webhook:', err);
        await sendTelegramMessage(
          `⚠️ *Aviso en escaneo (${sportLabel}):* ${err.message}`,
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
      `👋 ¡Hola Tavo! Aquí tienes tus 3 opciones de control:`,
      ``,
      `1️⃣ */vip* — Seleccionar deporte o cartelera general en tiempo real`,
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
