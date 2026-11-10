#!/usr/bin/env node
// scripts/gradePaper.mjs
// CALIFICACIÓN AUDITADA DEL LEDGER PAPER (ESPN Scoreboard, gratis).
//
// Califica los picks paper PENDIENTES en data/paper_ledger.jsonl contra
// resultados reales, EXACTAMENTE con la misma lógica que gradeLedger.mjs
// (mismo parsePickMarket, mismo gradePick, mismo computePnl). La única
// diferencia es el archivo: el ledger paper nunca se mezcla con el real,
// y sus clausuras van a data/paper_ledger_closures.jsonl (nunca a
// pick_ledger_closures.jsonl).
//
// Uso:
//   node scripts/gradePaper.mjs                 # dry-run, no escribe
//   node scripts/gradePaper.mjs --apply         # aplica los cierres
//   node scripts/gradePaper.mjs --apply --id <id> --limit 5

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gradePendingPicks } from './gradeLedger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAPER_LEDGER_PATH = path.join(__dirname, '..', 'data', 'paper_ledger.jsonl');
const PAPER_CLOSURES_PATH = path.join(__dirname, '..', 'data', 'paper_ledger_closures.jsonl');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const idIdx = args.indexOf('--id');
  const onlyId = idIdx !== -1 ? args[idIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
  if (!fs.existsSync(PAPER_LEDGER_PATH)) {
    console.log('🧪 Ledger paper vacío o inexistente (data/paper_ledger.jsonl). Corre primero el motor en modo paper.');
    process.exit(0);
  }
  const { graded, skipped, total } = await gradePendingPicks({
    apply, onlyId, limit, ledgerPath: PAPER_LEDGER_PATH, closuresPath: PAPER_CLOSURES_PATH,
  });
  const wins = graded.filter(g => g.result === 'WON').length;
  const losses = graded.filter(g => g.result === 'LOST').length;
  const pushes = graded.filter(g => g.result === 'PUSH').length;
  const net = graded.reduce((a, g) => a + g.pnlUnits, 0);
  console.log(`\n🧪 ${apply ? 'CIERRES PAPER APLICADOS' : 'DRY-RUN PAPER (sin escribir, usa --apply para guardar)'}`);
  console.log(`Pendientes revisados: ${total} | Calificables: ${graded.length} (${wins}W-${losses}L-${pushes}P, ${net >= 0 ? '+' : ''}${net.toFixed(2)}u paper) | Sin calificar: ${skipped.length}`);
  for (const g of graded) {
    console.log(` • [${g.id}] ${g.result} ${g.score} (${g.pnlUnits >= 0 ? '+' : ''}${g.pnlUnits}u) — ${g.pick.game} → ${g.pick.pick}${g.pick.vetoReason ? ` [vetado: ${g.pick.vetoReason}]` : ''}`);
  }
  for (const s of skipped) {
    console.log(` • [${s.id}] SIN CALIFICAR: ${s.reason}`);
  }
  console.log('');
}
