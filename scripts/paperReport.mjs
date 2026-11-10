#!/usr/bin/env node
// scripts/paperReport.mjs
// REPORTE DEL LEDGER PAPER: ¿los candados vetan ganadores?
//
// Lee data/paper_ledger.jsonl (solo lectura, nunca lo modifica) y responde
// las tres preguntas del modo paper:
//  1. Emitidos paper: hit rate / ROI en unidades paper (¿qué habría pasado?).
//  2. Vetados paper: hit rate realizado por motivo de veto (¿los candados
//     bloquearon ganadores? Un veto con hit rate alto = el candado estorba).
//  3. Calibración: Brier crudo vs calibrado + ajuste Platt pooled sugerido
//     (con y sin el clamp del motor) para decidir el siguiente paso.
// Escribe data/paper_record.json y public/paper_record.json (la web puede
// mostrarlo en /paper_record.json cuando se decida).
//
// Uso:
//   node scripts/paperReport.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computePaperStats, vetoReasonLabel } from '../src/utils/paperLedger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAPER_LEDGER_PATH = path.join(__dirname, '..', 'data', 'paper_ledger.jsonl');
const RECORD_DATA_PATH = path.join(__dirname, '..', 'data', 'paper_record.json');
const RECORD_PUBLIC_PATH = path.join(__dirname, '..', 'public', 'paper_record.json');

export function buildPaperRecord(entries = []) {
  const stats = computePaperStats(entries);
  return {
    generatedAt: new Date().toISOString(),
    mode: 'paper',
    note: 'Simulación: unidades paper, sin dinero real. El ledger real no se toca.',
    ...stats,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  if (!fs.existsSync(PAPER_LEDGER_PATH)) {
    console.log('🧪 Ledger paper vacío o inexistente (data/paper_ledger.jsonl). Corre primero el motor en modo paper.');
    process.exit(0);
  }
  const entries = fs.readFileSync(PAPER_LEDGER_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const record = buildPaperRecord(entries);
  const fmt = (g) => `${g.won}W-${g.lost}L${g.push ? `-${g.push}P` : ''} (${g.hitRate ?? '—'}%) | ${g.net >= 0 ? '+' : ''}${g.net}u | ROI ${g.roi ?? '—'}%`;
  console.log('\n======================================================');
  console.log(`🧪 REPORTE PAPER (${record.total} registrados, ${record.graded} calificados)`);
  console.log('======================================================');
  console.log(`Emitidos paper: ${fmt(record.emitted)}`);
  console.log(`Vetados paper:  ${fmt(record.vetoed)}`);
  console.log(`Aprobados sin cupo: ${fmt(record.approvedNoCupo)}`);
  console.log('\nPor cubo de probabilidad calibrada (emitidos):');
  for (const [bucket, g] of Object.entries(record.byBucket)) {
    console.log(` • ${bucket}: ${g.n} picks, acierto ${g.hitRate ?? '—'}% (${fmt(g)})`);
  }
  console.log('\nPor motivo de veto (¿qué vetó y habría ganado?):');
  const reasons = Object.entries(record.vetoReasons).sort((a, b) => b[1].count - a[1].count);
  if (!reasons.length) console.log(' • Sin vetados calificados todavía.');
  for (const [code, r] of reasons) {
    console.log(` • ${vetoReasonLabel(code)}: ${r.count} vetados, ${r.won} habrían ganado (${r.winRate ?? '—'}%)`);
  }
  console.log(`\nBrier crudo: ${record.brierRaw ?? '—'} | Brier calibrado: ${record.brierCal ?? '—'} (0.25 = predecir siempre el promedio)`);
  const fit = record.plattFit;
  if (fit.A !== null) {
    console.log(`Recalibración Platt sugerida (pooled, n=${fit.n}): A=${fit.A} B=${fit.B} | con clamp del motor: A=${fit.Aclamped} B=${fit.Bclamped}`);
    if (fit.A < 0.4) console.log(' ⚠️ El ajuste honesto pide A < 0.40 (piso del clamp): el motor no puede aplicar el ajuste completo sin bajar el piso.');
  } else {
    console.log(`Recalibración Platt: ${fit.note}`);
  }
  console.log('\n⚠️ Advertencias:');
  if (record.graded < 30) console.log(' • Muestra paper pequeña (<30 calificados): las conclusiones son preliminares.');
  if (record.vetoed.n > 0 && record.vetoed.hitRate !== null && record.vetoed.hitRate > 50) {
    console.log(' • Los vetados aciertan más del 50%: los candados/filtros están bloqueando valor. Revisar motivos arriba.');
  }
  console.log('======================================================\n');
  fs.writeFileSync(RECORD_DATA_PATH, JSON.stringify(record, null, 2), 'utf-8');
  fs.writeFileSync(RECORD_PUBLIC_PATH, JSON.stringify(record, null, 2), 'utf-8');
  console.log('Reporte paper guardado en data/paper_record.json y public/paper_record.json.');
}
