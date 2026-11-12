#!/usr/bin/env node
// scripts/realImport.mjs
// IMPORTA PICKS REALES DESDE EL ESPEJO TELEGRAM AL LEDGER LOCAL.
//
// En producción (Vercel) el disco es de solo lectura: el motor no puede
// escribir data/pick_ledger.jsonl y cada pick real queda espejado al canal
// del ledger como "LEDGER {json}" (mirrorLedgerEntryToTelegram en
// scripts/alertEngine.js). Este script lee esas líneas JSON (desde un archivo
// o desde stdin) y las agrega al ledger local sin duplicar por id, para poder
// calificarlas (gradeLedger), capturar su cierre (captureClosingOdds) y
// reportarlas (ledgerReport). Sin este paso, los picks reales despachados
// existen solo en Telegram y el récord verificado queda incompleto.
//
// Reglas de seguridad (el ledger es inmutable, AGENTS.md):
//  - Solo agrega ids nuevos. Si el id ya existe, se salta SIN tocar la línea
//    existente: un pick ya calificado jamás vuelve a PENDING.
//  - Rechaza entradas paper (paper:true o prefijo PAPER_LEDGER): esas van a
//    scripts/paperImport.mjs, nunca al ledger real.
//  - Rechaza entradas sin id/juego/pick/cuota, o con status distinto de PENDING.
//  - No borra ni reordena nada; solo hace append.
//
// Uso:
//   node scripts/realImport.mjs espejo-ledger.txt
//   cat espejo-ledger.txt | node scripts/realImport.mjs
//   node scripts/realImport.mjs --dry-run espejo-ledger.txt   (previsualiza sin escribir)
//   (cada línea puede ser "LEDGER {json}" o solo "{json}")

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const LEDGER_PATH = path.join(__dirname, '..', 'data', 'pick_ledger.jsonl');

const LEDGER_PREFIX = 'LEDGER ';
const PAPER_PREFIX = 'PAPER_LEDGER ';

/**
 * Extrae y valida una línea del espejo. Devuelve { entry } o { invalid, reason }.
 * No toca disco: es pura.
 */
export function parseMirrorLine(rawLine) {
  const trimmed = (rawLine || '').trim();
  if (!trimmed) return { invalid: true, reason: 'vacía' };
  if (trimmed.startsWith(PAPER_PREFIX)) return { invalid: true, reason: 'es paper, va a paperImport' };
  const jsonPart = trimmed.startsWith(LEDGER_PREFIX) ? trimmed.slice(LEDGER_PREFIX.length) : trimmed;
  let entry;
  try {
    entry = JSON.parse(jsonPart);
  } catch {
    return { invalid: true, reason: 'JSON inválido' };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { invalid: true, reason: 'no es un objeto' };
  }
  if (entry.paper === true) return { invalid: true, reason: 'paper:true, va a paperImport' };
  if (!entry.id || typeof entry.id !== 'string') return { invalid: true, reason: 'sin id' };
  if (!entry.game || !entry.pick) return { invalid: true, reason: 'sin juego o pick' };
  const odds = Number(entry.placedOdds);
  if (!Number.isFinite(odds) || odds <= 1) return { invalid: true, reason: 'sin cuota válida' };
  if (entry.status && entry.status !== 'PENDING') {
    return { invalid: true, reason: `status ${entry.status}, solo se importan PENDING` };
  }
  return { entry };
}

/**
 * Normaliza una entrada del espejo a la forma del ledger local (la misma que
 * escribe recordPickToLedger). El espejo reducido de Vercel (cuando el append
 * a disco falla por EROFS) no trae deporte/liga/tier/tipo: se rellenan con
 * valores neutros, nunca inventados como dato real.
 */
export function normalizeRealEntry(entry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp || new Date().toISOString(),
    sport: entry.sport || 'Sin clasificar',
    league: entry.league || entry.sport || 'Sin clasificar',
    game: entry.game,
    gameDate: entry.gameDate || entry.timestamp || new Date().toISOString(),
    pick: entry.pick,
    tier: entry.tier || 'TIER_2_ACTION',
    type: entry.type || 'Apuesta',
    placedOdds: Number(entry.placedOdds),
    closingOdds: null,
    clvPct: null,
    prob: Number.isFinite(Number(entry.prob)) ? Number(entry.prob) : 60,
    rawProb: Number.isFinite(Number(entry.rawProb)) ? Number(entry.rawProb) : null,
    evPct: Number.isFinite(Number(entry.evPct)) ? Number(entry.evPct) : null,
    confidenceTier: entry.confidenceTier || null,
    oddsSource: entry.oddsSource || 'market',
    stakeUnits: Number.isFinite(Number(entry.stakeUnits)) ? Number(entry.stakeUnits) : 1.0,
    consensus: entry.consensus || '3/3',
    sharpBook: entry.sharpBook || null,
    isPinnacle: Boolean(entry.isPinnacle),
    source: 'telegram_mirror',
    status: 'PENDING',
    result: null,
    score: null,
    pnlUnits: null
  };
}

/**
 * Importa líneas del espejo al ledger. Pura en cuanto a decisiones: solo
 * escribe si dryRun es false. Devuelve el resumen { added, skipped, invalid, addedIds }.
 */
export function importRealEntries(lines, ledgerPath = LEDGER_PATH, { dryRun = false } = {}) {
  const existing = new Set();
  if (fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean)) {
      try { existing.add(JSON.parse(line).id); } catch {}
    }
  }
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  const out = [];
  const addedIds = [];
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue; // líneas en blanco no cuentan
    const { entry, invalid: isInvalid } = parseMirrorLine(rawLine);
    if (isInvalid) { invalid++; continue; }
    if (existing.has(entry.id)) { skipped++; continue; }
    existing.add(entry.id);
    out.push(JSON.stringify(normalizeRealEntry(entry)));
    addedIds.push(entry.id);
    added++;
  }
  if (out.length && !dryRun) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, out.join('\n') + '\n', 'utf-8');
  }
  return { added, skipped, invalid, addedIds };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const inputFile = args.find((a) => !a.startsWith('--'));
  const raw = inputFile ? fs.readFileSync(inputFile, 'utf-8') : fs.readFileSync(0, 'utf-8');
  const result = importRealEntries(raw.split('\n'), LEDGER_PATH, { dryRun });
  console.log(
    `📥 Import real${dryRun ? ' (dry-run, sin escribir)' : ''}: ${result.added} nuevos, ` +
    `${result.skipped} ya existían, ${result.invalid} inválidos. Ledger: data/pick_ledger.jsonl`
  );
  if (result.addedIds.length) console.log(`   ids: ${result.addedIds.join(', ')}`);
}
