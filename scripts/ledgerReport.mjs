#!/usr/bin/env node
// scripts/ledgerReport.mjs
// REPORTE VERIFICADO DEL LEDGER: ROI, CLV y calibración por liga/mercado.
//
// Mejora 3 del plan 2026-11-10. Lee data/pick_ledger.jsonl (solo lectura,
// nunca lo modifica) y calcula lo que de verdad mide si el modelo gana:
//  - ROI por unidad y P&L neto (no solo % de aciertos).
//  - CLV: solo con cierres reales; si no hay datos, se dice "sin datos".
//  - Calibración: probabilidad promedio del modelo vs acierto observado,
//    por deporte, liga, mercado y cubo de probabilidad.
//  - Drawdown: caída máxima desde el pico y drawdown actual.
// Escribe el récord verificable en data/record.json y public/record.json
// (este último lo sirve Vercel en /record.json para mostrarlo en la web).
//
// Uso:
//   node scripts/ledgerReport.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePickMarket } from './gradeLedger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEDGER_PATH = path.join(__dirname, '..', 'data', 'pick_ledger.jsonl');
const RECORD_DATA_PATH = path.join(__dirname, '..', 'data', 'record.json');
const RECORD_PUBLIC_PATH = path.join(__dirname, '..', 'public', 'record.json');

const r2 = (n) => Math.round(n * 100) / 100;

function summarize(rows) {
  const settled = rows.filter(r => r.result === 'WON' || r.result === 'LOST');
  const wins = rows.filter(r => r.result === 'WON').length;
  const losses = rows.filter(r => r.result === 'LOST').length;
  const pushes = rows.filter(r => r.result === 'PUSH').length;
  const staked = rows.reduce((a, r) => a + (Number(r.stakeUnits) || 0), 0);
  const net = rows.reduce((a, r) => a + (Number(r.pnlUnits) || 0), 0);
  const probs = rows.map(r => Number(r.prob)).filter(Number.isFinite);
  const implied = rows.map(r => 1 / Number(r.placedOdds)).filter(Number.isFinite);
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const hitRate = settled.length ? wins / settled.length : null;
  return {
    n: rows.length,
    wins, losses, pushes,
    hitRate: hitRate === null ? null : r2(hitRate * 100),
    netUnits: r2(net),
    stakedUnits: r2(staked),
    roiPct: staked > 0 ? r2((net / staked) * 100) : null,
    avgProbPct: avg(probs) === null ? null : r2(avg(probs)),
    avgImpliedPct: avg(implied) === null ? null : r2(avg(implied) * 100),
    // Brecha de calibración: positiva = el modelo cree ganar más de lo que gana.
    calibrationGapPts: (avg(probs) !== null && hitRate !== null) ? r2(avg(probs) - hitRate * 100) : null,
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r) || 'Sin clasificar';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({ key, ...summarize(items) }))
    .sort((a, b) => b.n - a.n);
}

export function computeLedgerReport(rows) {
  const closed = rows.filter(r => r.status === 'CLOSED');
  const pending = rows.filter(r => r.status === 'PENDING');
  const withClv = closed.filter(r => r.clvPct !== null && r.clvPct !== undefined);
  // Drawdown en orden cronológico de cierre (o de publicación si falta).
  const ordered = [...closed].sort((a, b) =>
    Date.parse(a.closedAt || a.timestamp) - Date.parse(b.closedAt || b.timestamp));
  let peak = 0;
  let running = 0;
  let maxDrawdown = 0;
  for (const r of ordered) {
    running += Number(r.pnlUnits) || 0;
    if (running > peak) peak = running;
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }
  const overall = summarize(closed);
  const marketOf = (r) => {
    const m = parsePickMarket(r.pick, r.type);
    return { btts: 'BTTS', total: 'Totales', spread: 'Spread/Hándicap', doubleChance: 'Doble oportunidad', moneyline: 'Moneyline', prop: 'Player prop', unknown: 'Sin clasificar' }[m.kind] || 'Sin clasificar';
  };
  const bucketOf = (r) => {
    const p = Number(r.prob);
    if (!Number.isFinite(p)) return 'Sin probabilidad';
    if (p < 60) return '50–60%';
    if (p < 70) return '60–70%';
    if (p < 80) return '70–80%';
    return '80%+';
  };
  return {
    generatedAt: new Date().toISOString(),
    source: 'data/pick_ledger.jsonl (38 picks publicados por Telegram, calificados con marcador final ESPN)',
    totalPicks: rows.length,
    closed: closed.length,
    pending: pending.length,
    pendingIds: pending.map(r => r.id),
    overall,
    clv: withClv.length
      ? {
        n: withClv.length,
        beatRatePct: r2((withClv.filter(r => Number(r.clvPct) > 0).length / withClv.length) * 100),
        avgClvPct: r2(withClv.reduce((a, r) => a + Number(r.clvPct), 0) / withClv.length),
      }
      : { n: 0, beatRatePct: null, avgClvPct: null, note: 'Sin datos: no hay cuotas de cierre capturadas. El CLV requiere correr scripts/captureClosingOdds.mjs (ESPN/DraftKings, gratis) poco antes del inicio de cada partido.' },
    drawdown: {
      maxDrawdownUnits: r2(maxDrawdown),
      currentDrawdownUnits: r2(peak - running),
      peakUnits: r2(peak),
    },
    bySport: groupBy(closed, r => r.sport),
    byLeague: groupBy(closed, r => r.league),
    byMarket: groupBy(closed, marketOf),
    byProbBucket: groupBy(closed, bucketOf),
    warnings: [
      ...(closed.length < 100 ? [`Muestra insuficiente: ${closed.length} picks cerrados. Con menos de ~100 picks no se puede concluir que el modelo tenga edge; el ROI observado puede ser varianza.`] : []),
      ...(overall.roiPct !== null && overall.roiPct < 0 ? ['ROI negativo en la muestra cerrada: el récord publicado pierde dinero. No usar el backtest de 83.9% como argumento comercial.'] : []),
      ...(overall.calibrationGapPts !== null && overall.calibrationGapPts > 5 ? [`El modelo sobreestima: probabilidad promedio ${overall.avgProbPct}% vs acierto real ${overall.hitRate}%. Revisar calibración antes de subir stakes.`] : []),
    ],
  };
}

export function readLedgerRows() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function printReport(report) {
  const o = report.overall;
  console.log(`\n======================================================`);
  console.log(`📊 RÉCORD VERIFICADO DEL LEDGER (${report.closed} cerrados, ${report.pending} pendientes)`);
  console.log(`======================================================`);
  console.log(`Aciertos: ${o.wins}W - ${o.losses}L - ${o.pushes}P | Hit rate: ${o.hitRate}%`);
  console.log(`P&L neto: ${o.netUnits >= 0 ? '+' : ''}${o.netUnits}u | Apostado: ${o.stakedUnits}u | ROI: ${o.roiPct}%`);
  console.log(`Prob. modelo prom.: ${o.avgProbPct}% | Implícita prom.: ${o.avgImpliedPct}% | Brecha calibración: ${o.calibrationGapPts} pts`);
  console.log(`CLV: ${report.clv.n === 0 ? 'sin datos' : `${report.clv.beatRatePct}% lo superan (prom. ${report.clv.avgClvPct}%)`}`);
  console.log(`Drawdown máx.: ${report.drawdown.maxDrawdownUnits}u | Actual: ${report.drawdown.currentDrawdownUnits}u`);
  console.log(`\nPor mercado:`);
  for (const g of report.byMarket) console.log(` • ${g.key}: ${g.n} picks, ${g.wins}W-${g.losses}L, ROI ${g.roiPct}%`);
  console.log(`\nPor cubo de probabilidad (modelo vs real):`);
  for (const g of report.byProbBucket) console.log(` • ${g.key}: ${g.n} picks, acierto ${g.hitRate}% (esperado ~${g.avgProbPct}%), ROI ${g.roiPct}%`);
  console.log(`\nPor deporte:`);
  for (const g of report.bySport) console.log(` • ${g.key}: ${g.n} picks, ${g.wins}W-${g.losses}L, ROI ${g.roiPct}%`);
  if (report.warnings.length) {
    console.log(`\n⚠️ Advertencias:`);
    for (const w of report.warnings) console.log(` • ${w}`);
  }
  console.log(`======================================================\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const rows = readLedgerRows();
  const report = computeLedgerReport(rows);
  fs.writeFileSync(RECORD_DATA_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  fs.mkdirSync(path.dirname(RECORD_PUBLIC_PATH), { recursive: true });
  fs.writeFileSync(RECORD_PUBLIC_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  printReport(report);
  console.log(`Récord guardado en data/record.json y public/record.json (Vercel lo sirve en /record.json).\n`);
}
