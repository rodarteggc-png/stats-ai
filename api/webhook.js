// api/webhook.js - Webhook interactivo de Telegram para Stats-AI Pro
import { runAlertEngine, runDailyTelegramAudit, sendTelegramMessage, answerTelegramCallback, generateCheatsheetReport } from '../scripts/alertEngine.js';
import { getApiSportsStatus } from '../src/services/apiSports.js';
import { getOddsApiKeys } from '../src/services/sportsApi.js';
import { extractTicketSelections, auditTicketLive, formatLiveTicketReport } from './_lib/parlayLive.js';
import { scanFutureMultiSport, formatFutureMultiSport } from './_lib/futureMultiSport.js';
import { isValidTelegramWebhook } from './_lib/security.js';
import { fetchWithRetry } from '../src/services/httpClient.js';

// Llave de respaldo Gemini para visión artificial de boletos (proxy / OCR seguro)
const FALLBACK_GEMINI_KEY = ''; // Sin llave en el codigo: solo GEMINI_API_KEY en variables de entorno.

// Teclado inferior simplificado (persistente en pantalla con 5 botones organizados)
const BASE_KEYBOARD_MENU = {
  keyboard: [
    [{ text: '/vip' }, { text: '/cheatsheet' }],
    [{ text: '/parlay' }, { text: '/corte' }],
    [{ text: '/cuota' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

let futureScanRunning = false;

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

async function respondWithLiveTicket(input, chatId, keyboard) {
  const selections = await extractTicketSelections(input, process.env.GEMINI_API_KEY || FALLBACK_GEMINI_KEY);
  const audit = await auditTicketLive(selections);
  await sendReport(formatLiveTicketReport(audit), chatId, keyboard);
}

async function sendReport(report, chatId, keyboard) {
  let chunk = '';
  for (const line of report.split('\n')) {
    if (chunk.length + line.length + 1 > 3500) {
      if (!await sendTelegramMessage(chunk, false, chatId, keyboard)) throw new Error('No se pudo entregar el reporte.');
      chunk = '';
    }
    chunk += `${line}\n`;
  }
  if (chunk && !await sendTelegramMessage(chunk, false, chatId, keyboard)) throw new Error('No se pudo entregar el reporte.');
}

export default async function handler(req, res) {
  // Telegram envía las actualizaciones vía método POST
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'active' });
  }

  // Rechaza updates falsificados: solo Telegram conoce el secret_token registrado con setWebhook
  if (!isValidTelegramWebhook(req)) {
    return res.status(401).send('Unauthorized');
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
    const chatId = message?.chat?.id || (isCallback ? callback.from?.id : null);
    const rawText = isCallback ? (callback.data || '') : (message?.text || '').trim();
    const command = rawText.toLowerCase();

    const VIP_CHAT_ID = process.env.TELEGRAM_VIP_CHAT_ID
      ? Number(process.env.TELEGRAM_VIP_CHAT_ID)
      : 1258878024;
    const isPrivateVip = senderId === VIP_CHAT_ID && chatId === VIP_CHAT_ID && message?.chat?.type === 'private';
    const KEYBOARD_MENU = isPrivateVip ? {
      ...BASE_KEYBOARD_MENU,
      keyboard: [
        ...BASE_KEYBOARD_MENU.keyboard.slice(0, 2),
        [{ text: '/cuota' }, { text: '🔭 Próximas 72 h' }]
      ]
    } : BASE_KEYBOARD_MENU;

    // 🔒 Candado de seguridad exclusivo: solo responde a Tavo Rodarte (1258878024) o ID configurado
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

    if (['/futuro', '/72h', '🔭 próximas 72 h', 'próximas 72 h', 'proximas 72 h'].includes(command)) {
      if (!isPrivateVip) {
        await sendTelegramMessage('El analisis de 72 horas solo esta disponible en tu chat privado VIP.', false, chatId);
        return res.status(200).send('OK');
      }
      if (futureScanRunning) {
        await sendTelegramMessage('Ya hay un analisis de 72 horas en curso. No se iniciaron nuevas consultas.', false, chatId, KEYBOARD_MENU);
        return res.status(200).send('OK');
      }
      futureScanRunning = true;
      try {
        await sendTelegramMessage('Explorando las proximas 72 horas de futbol, NBA, NFL, NCAAF y MLB. Buscando probabilidad calibrada >=65% y combinacion opcional de dos partidos. Presupuesto ampliado: 60 peticiones de red, hasta 30 API-Football y reserva observada de 10; sin cambiar alertas ni registrar picks.', false, chatId, KEYBOARD_MENU);
        const result = await scanFutureMultiSport();
        await sendReport(formatFutureMultiSport(result), chatId, KEYBOARD_MENU);
      } catch (error) {
        await sendTelegramMessage(`No se completo el analisis de 72 horas: ${error.message}`, false, chatId, KEYBOARD_MENU);
      } finally {
        futureScanRunning = false;
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // DETECCIÓN DE FOTO / CAPTURA DE BOLETO O PARLAY
    // ==========================================
    const imageDocument = ['image/jpeg', 'image/png', 'image/webp'].includes(message?.document?.mime_type) ? message.document : null;
    if (message?.photo?.length || imageDocument) {
      const photo = imageDocument || message.photo[message.photo.length - 1];
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      await sendTelegramMessage('Leyendo boleto y contrastando cuotas prepartido (futbol, NBA, NFL, NCAAF, MLB)...', false, chatId, KEYBOARD_MENU);
      try {
        if (!botToken) throw new Error('Descarga de Telegram no configurada.');
        if (photo.file_size > 8 * 1024 * 1024) throw new Error('Envia una imagen de menos de 8 MB.');
        const fileRes = await fetchWithRetry(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(photo.file_id)}`, {}, { retries: 0, timeoutMs: 4000 });
        const fileData = await fileRes.json();
        if (!fileRes.ok || !fileData.ok || !fileData.result?.file_path) throw new Error('Telegram no pudo entregar la imagen.');
        const imageRes = await fetchWithRetry(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`, {}, { retries: 0, timeoutMs: 5000 });
        if (!imageRes.ok) throw new Error('No se pudo descargar la imagen.');
        const image = Buffer.from(await imageRes.arrayBuffer());
        if (image.length > 8 * 1024 * 1024) throw new Error('Envia una imagen de menos de 8 MB.');
        await respondWithLiveTicket({ imageBase64: image.toString('base64'), mimeType: imageDocument?.mime_type || 'image/jpeg', text: message.caption || '' }, chatId, KEYBOARD_MENU);
      } catch (error) {
        const reason = error.name === 'TimeoutError' ? 'El proveedor no respondio a tiempo.' : error.message;
        await sendTelegramMessage(`No se completo la lectura del boleto: ${reason}\nVuelve a intentar en un minuto. Si persiste, envia la captura como Archivo (sin comprimir) o usa /parlay con equipos, mercado y cuota.`, false, chatId, KEYBOARD_MENU);
      }
      return res.status(200).send('OK');
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
        const result = await runAlertEngine({ force: true, vip: true, sport: targetSport, skipAudit: true, targetChatId: chatId });
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
          `🛡️ _Los boletos y el analisis de 72 horas bajo pedido comparten el saldo diario con las alertas._`
        ].join('\n');

        await sendTelegramMessage(msg, false, chatId, KEYBOARD_MENU);
      } catch (err) {
        console.error('Error consultando cuota:', err);
        await sendTelegramMessage(`⚠️ Error consultando saldo: ${err.message}`, false, chatId, KEYBOARD_MENU);
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // OPCIÓN 3: /cheatsheet -> RESUMEN ULTRA COMPACTO TOP PICKS
    // ==========================================
    if (command === '/cheatsheet' || command === 'cheatsheet' || command === '/hoja' || command === 'hoja' || command === '4') {
      await sendTelegramMessage('⏳ *Generando Cheatsheet VIP de Alto Impacto...*', false, chatId, KEYBOARD_MENU);
      try {
        const result = await runAlertEngine({ force: true, vip: true, sport: 'all', skipAudit: true, targetChatId: chatId, dryRun: true });
        const candidates = (result.toSend && result.toSend.length > 0) ? result.toSend : (result.approvedOpps || []);
        const todayStr = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' }).toUpperCase();
        const cheatsheetMsg = generateCheatsheetReport(candidates, todayStr);
        await sendTelegramMessage(cheatsheetMsg, false, chatId, KEYBOARD_MENU);
      } catch (err) {
        console.error('Error en cheatsheet:', err);
        await sendTelegramMessage(`⚠️ Error generando Cheatsheet: ${err.message}`, false, chatId, KEYBOARD_MENU);
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // OPCIÓN: /parlay -> AUDITORÍA FORENSE DE COMBINADAS
    // ==========================================
    if (command.startsWith('/parlay') || command === '/parlay' || command.startsWith('parlay') || command === 'parlay' || command === 'combinada' || command.startsWith('/combinada')) {
      const cleanArgs = rawText
        .replace(/^\/parlay\s*/i, '')
        .replace(/^parlay\s*/i, '')
        .replace(/^\/combinada\s*/i, '')
        .replace(/^combinada\s*/i, '')
        .trim();

      if (!cleanArgs) {
        const guideMsg = [
          `🎰 *AUDITOR DE PARLAYS Y COMBINADAS — STATS-AI PRO*`,
          `Contrasta partidos y cuotas prepartido de Pinnacle/Bet365: futbol (API-Football) y NBA, NFL, NCAAF, MLB (The Odds API).`,
          ``,
          `👉 *¿Cómo usarlo?*`,
          `Escribe \`/parlay\` con ambos equipos, fecha, seleccion y cuota individual. Maximo 8 selecciones.`,
          ``,
          `*Ejemplo:*`,
          `\`/parlay America vs Cruz Azul, 2026-11-02, America ML @ 1.90\``,
          ``,
          `📸 _También puedes enviar la foto o captura de tu ticket directamente aquí._`
        ].join('\n');

        await sendTelegramMessage(guideMsg, false, chatId, KEYBOARD_MENU);
        return res.status(200).send('OK');
      }

      await sendTelegramMessage('Contrastando tu boleto con cuotas publicadas en API-Sports...', false, chatId, KEYBOARD_MENU);
      try {
        await respondWithLiveTicket({ text: cleanArgs }, chatId, KEYBOARD_MENU);
      } catch (error) {
        await sendTelegramMessage(`No se pudo procesar el boleto: ${error.message}`, false, chatId, KEYBOARD_MENU);
      }
      return res.status(200).send('OK');
    }

    // ==========================================
    // OPCIÓN 4: /corte -> CORTE DE CAJA OFICIAL
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
      `👋 ¡Hola Tavo! Aquí tienes tus opciones de control:`,
      ``,
      `1️⃣ */vip* — Seleccionar deporte o cartelera general en tiempo real`,
      `2️⃣ */cheatsheet* — Hoja resumen compacta con Hit Rates (Top picks para redes)`,
      `3️⃣ */parlay* — Contrastar tu boleto con cuotas prepartido (futbol, NBA, NFL, NCAAF, MLB)`,
      `4️⃣ */corte* — Ver Corte de Caja y Rendimiento de las últimas 24h`,
      `5️⃣ */cuota* — Consultar saldo de requests (API-Sports y The Odds API)`,
      ...(isPrivateVip ? ['6. */futuro* — Explorar 72 horas multideporte y candidatos de alta probabilidad'] : []),
      ``,
      `👉 *Toca cualquiera de los botones táctiles abajo en tu pantalla o manda foto de tu boleto.*`
    ].join('\n');

    await sendTelegramMessage(menuMsg, false, chatId, KEYBOARD_MENU);
    return res.status(200).send('OK');

  } catch (error) {
    console.error('Fallo no controlado en api/webhook:', error);
    return res.status(200).send('OK'); // Telegram requiere siempre 200 para no reintentar
  }
}
