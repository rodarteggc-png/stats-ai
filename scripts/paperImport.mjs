#!/usr/bin/env node
// scripts/paperImport.mjs
// IMPORTA PICKS PAPER DESDE EL ESPEJO TELEGRAM AL LEDGER PAPER LOCAL.
//
// En producción (Vercel) el motor espeja cada pick paper al canal del ledger
// como "PAPER_LEDGER {json}". Este script lee esas líneas JSON (desde un
// archivo o desde stdin) y las agrega a data/paper_ledger.jsonl sin duplicar
// por id, para poder calificarlas localmente con gradePaper + paperReport.
//
// Uso:
//   node scripts/paperImport.mjs paper-mirror.txt
//   cat paper-mirror.txt | node scripts/paperImport.mjs
//   (cada línea puede ser "PAPER_LEDGER {json}" o solo "{json}")

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAPER_LEDGER_PATH = path.join(__dirname, '..', 'data', 'paper_ledger.jsonl');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const inputFile = process.argv[2];
  const raw = inputFile ? fs.readFileSync(inputFile, 'utf-8') : fs.readFileSync(0, 'utf-8');
  const existing = new Set();
  if (fs.existsSync(PAPER_LEDGER_PATH)) {
    for (const line of fs.readFileSync(PAPER_LEDGER_PATH, 'utf-8').split('\n').filter(Boolean)) {
      try { existing.add(JSON.parse(line).id); } catch {}
    }
  }
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const jsonPart = trimmed.startsWith('PAPER_LEDGER ') ? trimmed.slice('PAPER_LEDGER '.length) : trimmed;
    let entry;
    try { entry = JSON.parse(jsonPart); } catch { invalid++; continue; }
    if (!entry || entry.paper !== true || !entry.id) { invalid++; continue; }
    if (existing.has(entry.id)) { skipped++; continue; }
    existing.add(entry.id);
    out.push(JSON.stringify(entry));
    added++;
  }
  if (out.length) {
    fs.mkdirSync(path.dirname(PAPER_LEDGER_PATH), { recursive: true });
    fs.appendFileSync(PAPER_LEDGER_PATH, out.join('\n') + '\n', 'utf-8');
  }
  console.log(`🧪 Import paper: ${added} nuevos, ${skipped} ya existían, ${invalid} inválidos. Ledger: data/paper_ledger.jsonl`);
}
