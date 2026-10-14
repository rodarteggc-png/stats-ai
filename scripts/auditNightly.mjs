#!/usr/bin/env node
// scripts/auditNightly.mjs
// SCRIPT NOCTURNO AUTOMATIZADO DE AUDITORÍA Y CORTE DE CAJA OFICIAL
// Cierra los marcadores de la jornada, calcula CLV, P&L en unidades y sincroniza data/pick_ledger.jsonl
import { runDailyTelegramAudit } from './alertEngine.js';

console.log(`\n=============================================================`);
console.log(`🌙 INICIANDO AUDITORÍA NOCTURNA Y CORTE DE CAJA OFICIAL 🌙`);
console.log(`=============================================================\n`);

try {
  const result = await runDailyTelegramAudit({
    sendToTelegram: true,
    forceAudit: true
  });

  console.log(`\n✅ Auditoría Nocturna Finalizada:`);
  console.log(` • Notificación enviada a Telegram: ${result.auditSent ? 'SÍ' : 'NO'}`);
  console.log(` • Picks Auditados:                 ${result.auditedPicks || 0}`);
  console.log(` • Picks Aún Pendientes de Juego:   ${result.pendingPicks || 0}`);
  if (result.summary) {
    console.log(`\n📊 Balance del Corte:`);
    console.log(result.summary);
  }
  process.exit(0);
} catch (err) {
  console.error(`❌ Error en auditoría nocturna:`, err);
  process.exit(1);
}
