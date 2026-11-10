#!/usr/bin/env node
// scripts/bankrollReset.mjs
// REINICIO MANUAL Y REGISTRADO DEL FRENO DE DRAWDOWN.
//
// El freno de bankroll (ver src/utils/bankroll.js) se levanta solo cuando la
// ventana de 30 días rueda. Este script permite reiniciar la base de forma
// explícita: a partir de la fecha de reinicio, el drawdown se mide desde
// cero. NO borra ni modifica el ledger: el historial sigue intacto y el
// reinicio queda registrado con fecha y motivo en data/bankroll_reset.json.
//
// Uso:
//   node scripts/bankrollReset.mjs --status
//   node scripts/bankrollReset.mjs --reason "Acepto la pérdida y recalibro antes de volver"
//   node scripts/bankrollReset.mjs --clear

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluateBankroll, BANKROLL } from '../src/utils/bankroll.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEDGER_PATH = path.join(__dirname, '..', 'data', 'pick_ledger.jsonl');
const RESET_PATH = path.join(__dirname, '..', 'data', 'bankroll_reset.json');

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function readReset() {
  if (!fs.existsSync(RESET_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(RESET_PATH, 'utf-8')); } catch { return null; }
}

const args = process.argv.slice(2);
const rows = readLedger();
const closed = rows.filter(r => r.status === 'CLOSED');

if (args.includes('--status')) {
  const reset = readReset();
  const state = evaluateBankroll({ closedRows: closed, allRows: rows, resetAt: reset?.resetAt || null });
  console.log(`\n🏦 ESTADO DE BANCA`);
  console.log(`Drawdown 30 días: ${state.drawdownUnits}u (máx. ${state.maxDrawdownUnits}u) | Pico: ${state.peakUnits}u | Cerrados en ventana: ${state.settledInWindow}`);
  console.log(`Exposición hoy: ${state.exposureTodayUnits}u | Restante: ${state.remainingExposureUnits}u (tope ${BANKROLL.maxDailyExposureUnits}u/día)`);
  console.log(`Freno: ${state.blocked ? `⛔ ACTIVO — ${state.reasons.join(' ')}` : '🟢 libre'}`);
  console.log(`Reinicio registrado: ${reset ? `${reset.resetAt} — ${reset.reason || '(sin motivo)'}` : 'ninguno'}\n`);
  process.exit(0);
}

if (args.includes('--clear')) {
  if (fs.existsSync(RESET_PATH)) fs.unlinkSync(RESET_PATH);
  console.log('Reinicio de drawdown eliminado. El freno vuelve a medirse desde el inicio del ledger.\n');
  process.exit(0);
}

const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : '';
if (!reason) {
  console.log('\nUso: node scripts/bankrollReset.mjs --reason "motivo del reinicio"');
  console.log('     node scripts/bankrollReset.mjs --status');
  console.log('     node scripts/bankrollReset.mjs --clear\n');
  process.exit(1);
}
const record = { resetAt: new Date().toISOString(), reason, note: 'El ledger no se modifica; solo cambia la base desde la que se mide el drawdown.' };
fs.writeFileSync(RESET_PATH, JSON.stringify(record, null, 2) + '\n', 'utf-8');
const state = evaluateBankroll({ closedRows: closed, allRows: rows, resetAt: record.resetAt });
console.log(`\n✅ Base de drawdown reiniciada a ${record.resetAt}.`);
console.log(`Motivo: ${reason}`);
console.log(`Drawdown medido desde el reinicio: ${state.drawdownUnits}u | Freno: ${state.blocked ? '⛔ sigue activo' : '🟢 libre'}\n`);
