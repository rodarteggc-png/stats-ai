#!/usr/bin/env node
// scripts/closePick.mjs
// CLI PARA GESTIÓN Y CIERRE AUDITADO DE PICKS EN EL LEDGER PERSISTENTE
// Uso:
//   node scripts/closePick.mjs --list-pending
//   node scripts/closePick.mjs --id <pick-id> --result WON|LOST|PUSH --score "2-1" --closing-odds 1.75
//   node scripts/closePick.mjs --summary

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEDGER_PATH = path.join(__dirname, '..', 'data', 'pick_ledger.jsonl');

// Asegurar directorio data/
const dataDir = path.dirname(LEDGER_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  const lines = fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean);
  return lines.map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { return null; }
  }).filter(Boolean);
}

function writeLedger(picks) {
  const content = picks.map(p => JSON.stringify(p)).join('\n') + '\n';
  fs.writeFileSync(LEDGER_PATH, content, 'utf-8');
}

const args = process.argv.slice(2);
const isList = args.includes('--list-pending') || args.includes('--list');
const isSummary = args.includes('--summary');
const idIdx = args.indexOf('--id');
const pickId = idIdx !== -1 ? args[idIdx + 1] : null;
const resIdx = args.indexOf('--result');
const result = resIdx !== -1 ? args[resIdx + 1]?.toUpperCase() : null;
const scoreIdx = args.indexOf('--score');
const score = scoreIdx !== -1 ? args[scoreIdx + 1] : '';
const closeOddsIdx = args.indexOf('--closing-odds');
const closingOdds = closeOddsIdx !== -1 ? parseFloat(args[closeOddsIdx + 1]) : null;

const picks = readLedger();

if (isSummary) {
  const closed = picks.filter(p => p.status === 'CLOSED');
  const wins = closed.filter(p => p.result === 'WON').length;
  const losses = closed.filter(p => p.result === 'LOST').length;
  const pushes = closed.filter(p => p.result === 'PUSH').length;
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
  const netUnits = closed.reduce((acc, p) => acc + (parseFloat(p.pnlUnits) || 0), 0);
  const totalStaked = closed.reduce((acc, p) => acc + (parseFloat(p.stakeUnits) || 1.0), 0);
  const roi = totalStaked > 0 ? ((netUnits / totalStaked) * 100).toFixed(1) : '0.0';
  const beatClvCount = closed.filter(p => (parseFloat(p.clvPct) || 0) > 0).length;
  const clvRate = closed.length > 0 ? ((beatClvCount / closed.length) * 100).toFixed(1) : '0.0';
  const avgClv = closed.length > 0 ? (closed.reduce((acc, p) => acc + (parseFloat(p.clvPct) || 0), 0) / closed.length).toFixed(2) : '0.00';

  console.log(`\n======================================================`);
  console.log(`📊 RESUMEN AUDITADO DEL PICK LEDGER`);
  console.log(`======================================================`);
  console.log(`Picks Totales en Ledger: ${picks.length}`);
  console.log(`Picks Pendientes:        ${picks.filter(p => p.status === 'PENDING').length}`);
  console.log(`Picks Cerrados:          ${closed.length}`);
  console.log(`Aciertos / Fallos / Push: ${wins}W - ${losses}L - ${pushes}P`);
  console.log(`Hit Rate (Win %):        ${winRate}%`);
  console.log(`P&L Neto Acumulado:      ${netUnits >= 0 ? '+' : ''}${netUnits.toFixed(2)} Unidades`);
  console.log(`ROI Real:                ${roi}%`);
  console.log(`Beat Closing Line (CLV): ${clvRate}% (Promedio CLV: ${avgClv}%)`);
  console.log(`======================================================\n`);
  process.exit(0);
}

if (isList) {
  const pending = picks.filter(p => p.status === 'PENDING');
  console.log(`\n📋 PICKS PENDIENTES DE CIERRE (${pending.length}):`);
  if (pending.length === 0) {
    console.log('No hay picks pendientes en el ledger.');
  } else {
    pending.forEach(p => {
      console.log(` • [${p.id}] ${p.sport} | ${p.game} -> ${p.pick} @ ${p.placedOdds} (Stake: ${p.stakeUnits}u) [${p.timestamp}]`);
    });
  }
  console.log('');
  process.exit(0);
}

if (pickId && result) {
  if (!['WON', 'LOST', 'PUSH'].includes(result)) {
    console.error('❌ Error: --result debe ser WON, LOST o PUSH.');
    process.exit(1);
  }

  const idx = picks.findIndex(p => p.id === pickId);
  if (idx === -1) {
    console.error(`❌ Error: No se encontró el pick con ID "${pickId}".`);
    process.exit(1);
  }

  const p = picks[idx];
  const placedOdds = parseFloat(p.placedOdds) || 1.90;
  const stake = parseFloat(p.stakeUnits) || 1.0;
  const finalCloseOdds = closingOdds || placedOdds;

  // Cálculo CLV: ((placed / close) - 1) * 100
  const clvPct = Number((((placedOdds / finalCloseOdds) - 1) * 100).toFixed(2));

  // Cálculo PnL
  let pnlUnits = 0;
  if (result === 'WON') {
    pnlUnits = Number(((placedOdds - 1) * stake).toFixed(2));
  } else if (result === 'LOST') {
    pnlUnits = -stake;
  } else {
    pnlUnits = 0;
  }

  p.status = 'CLOSED';
  p.result = result;
  p.score = score || p.score || '';
  p.closingOdds = finalCloseOdds;
  p.clvPct = clvPct;
  p.pnlUnits = pnlUnits;
  p.closedAt = new Date().toISOString();

  picks[idx] = p;
  writeLedger(picks);

  console.log(`\n✅ Pick [${pickId}] CERRADO con éxito:`);
  console.log(` • Juego:       ${p.game}`);
  console.log(` • Selección:   ${p.pick}`);
  console.log(` • Marcador:    ${p.score}`);
  console.log(` • Resultado:   ${result} (${pnlUnits >= 0 ? '+' : ''}${pnlUnits}u)`);
  console.log(` • Cuota Inicial vs Cierre: ${placedOdds} vs ${finalCloseOdds} (CLV: ${clvPct >= 0 ? '+' : ''}${clvPct}%)`);
  console.log(`\nLedger actualizado en: data/pick_ledger.jsonl\n`);
  process.exit(0);
}

console.log(`
Uso de closePick.mjs:
  node scripts/closePick.mjs --list-pending
  node scripts/closePick.mjs --id <ID> --result <WON|LOST|PUSH> [--score "2-1"] [--closing-odds 1.85]
  node scripts/closePick.mjs --summary
`);
