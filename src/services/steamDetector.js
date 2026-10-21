// src/services/steamDetector.js
// DETECTOR DE STEAM MOVES (INYECCIÓN DE DINERO PROFESIONAL EN TIEMPO REAL)
// Monitorea cambios abruptos en cuotas de Pinnacle y Bet365 para enviar Alertas Flash VIP

import { sendTelegramMessage } from '../../scripts/alertEngine.js';

const ODDS_SNAPSHOT_CACHE = new Map();

/**
 * Registra o compara cuotas para detectar caídas bruscas (Steam Moves)
 * @param {Array} gamesWithOdds - Lista de partidos con cuotas de Pinnacle
 * @param {boolean} dispatchAlerts - Si es true, envía mensaje inmediato a Telegram VIP
 */
export async function detectAndAlertSteamMoves(gamesWithOdds = [], dispatchAlerts = false) {
  if (!Array.isArray(gamesWithOdds) || gamesWithOdds.length === 0) return [];
  const detectedSteamMoves = [];
  const now = Date.now();

  for (const game of gamesWithOdds) {
    if (!game || !game.id) continue;
    const cacheKey = `game-odds-${game.id}`;
    const previous = ODDS_SNAPSHOT_CACHE.get(cacheKey);

    const currentHomeOdds = parseFloat(game.pinnacleOdds?.home || game.homeOdds);
    const currentAwayOdds = parseFloat(game.pinnacleOdds?.away || game.awayOdds);
    const currentDrawOdds = parseFloat(game.pinnacleOdds?.draw || game.drawOdds);

    if (previous && (now - previous.timestamp < 12 * 60 * 60 * 1000)) {
      // Comparar Home
      if (previous.homeOdds && currentHomeOdds) {
        const drop = previous.homeOdds - currentHomeOdds;
        const dropPct = (drop / previous.homeOdds) * 100;
        // Si la cuota cayó >= 0.15 decimales o >= 7.5% de golpe
        if (drop >= 0.15 || dropPct >= 7.5) {
          detectedSteamMoves.push({
            game: `${game.homeName || 'Local'} vs ${game.awayName || 'Visitante'}`,
            sport: game.sport || 'Fútbol',
            selection: `Victoria ${game.homeName || 'Local'}`,
            previousOdds: previous.homeOdds.toFixed(2),
            currentOdds: currentHomeOdds.toFixed(2),
            dropCents: Number(drop.toFixed(2)),
            dropPct: dropPct.toFixed(1) + '%',
            bookmaker: 'Pinnacle (Sharp)',
            reason: 'Caída agresiva por entrada de dinero profesional masivo (Steam Move).'
          });
        }
      }

      // Comparar Away
      if (previous.awayOdds && currentAwayOdds) {
        const drop = previous.awayOdds - currentAwayOdds;
        const dropPct = (drop / previous.awayOdds) * 100;
        if (drop >= 0.15 || dropPct >= 7.5) {
          detectedSteamMoves.push({
            game: `${game.homeName || 'Local'} vs ${game.awayName || 'Visitante'}`,
            sport: game.sport || 'Fútbol',
            selection: `Victoria ${game.awayName || 'Visitante'}`,
            previousOdds: previous.awayOdds.toFixed(2),
            currentOdds: currentAwayOdds.toFixed(2),
            dropCents: Number(drop.toFixed(2)),
            dropPct: dropPct.toFixed(1) + '%',
            bookmaker: 'Pinnacle (Sharp)',
            reason: 'Caída agresiva por entrada de dinero profesional masivo (Steam Move).'
          });
        }
      }
    }

    // Actualizar snapshot
    ODDS_SNAPSHOT_CACHE.set(cacheKey, {
      timestamp: now,
      homeOdds: currentHomeOdds,
      awayOdds: currentAwayOdds,
      drawOdds: currentDrawOdds
    });
  }

  // Si se solicita despacho inmediato a Telegram VIP
  if (dispatchAlerts && detectedSteamMoves.length > 0) {
    const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID || '1258878024';
    for (const steam of detectedSteamMoves) {
      const msg = [
        `🚨 *ALERTA FLASH VIP — STEAM MOVE DETECTADO* 🚨`,
        `💼 *DINERO INSTITUCIONAL ENTRANTE (PINNACLE)*`,
        ``,
        `🏆 *${steam.sport}*`,
        `⚔️ *${steam.game}*`,
        ``,
        `👉 *Selección Favorecida:* *${steam.selection}*`,
        `📉 *Movimiento de Cuota:* \`${steam.previousOdds} ➔ ${steam.currentOdds}\` (-${steam.dropCents} pts | -${steam.dropPct})`,
        `🏛️ *Casa Marcadora:* \`${steam.bookmaker}\``,
        ``,
        `⚡ *Veredicto de Acción:*`,
        `_${steam.reason} Los sindicatos de apuestas acaban de golpear esta línea. Valor de entrada temprana antes del ajuste total._`
      ].join('\n');

      await sendTelegramMessage(msg, false, vipChatId);
    }
  }

  return detectedSteamMoves;
}
