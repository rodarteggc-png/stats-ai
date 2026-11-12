// scripts/realImport.test.mjs — el importador real nunca debe corromper el ledger:
// solo agrega ids nuevos, jamás toca una línea existente y rechaza paper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMirrorLine, normalizeRealEntry, importRealEntries } from './realImport.mjs';

const mirrorLine = (entry) => `LEDGER ${JSON.stringify(entry)}`;
const realEntry = (over = {}) => ({
  id: 'test-real-1',
  timestamp: '2026-11-11T21:30:00.000Z',
  sport: 'Baloncesto',
  league: 'NBA',
  game: 'Lakers vs Celtics',
  gameDate: '2026-11-11T23:00:00.000Z',
  pick: 'Lakers OVER 224.5',
  tier: 'TIER_2_ACTION',
  type: 'Total',
  placedOdds: 1.91,
  prob: 57.2,
  stakeUnits: 1.0,
  status: 'PENDING',
  ...over
});

test('realImport: acepta una línea LEDGER válida', () => {
  const { entry, invalid } = parseMirrorLine(mirrorLine(realEntry()));
  assert.equal(invalid, undefined);
  assert.equal(entry.id, 'test-real-1');
});

test('realImport: acepta JSON sin prefijo', () => {
  const { entry } = parseMirrorLine(JSON.stringify(realEntry()));
  assert.equal(entry.id, 'test-real-1');
});

test('realImport: rechaza líneas paper (prefijo y paper:true)', () => {
  const byPrefix = parseMirrorLine(`PAPER_LEDGER ${JSON.stringify({ ...realEntry(), paper: true })}`);
  assert.equal(byPrefix.invalid, true);
  const byFlag = parseMirrorLine(JSON.stringify({ ...realEntry(), paper: true }));
  assert.equal(byFlag.invalid, true);
});

test('realImport: rechaza sin id, sin pick o sin cuota válida', () => {
  assert.equal(parseMirrorLine(mirrorLine({ ...realEntry(), id: undefined })).invalid, true);
  assert.equal(parseMirrorLine(mirrorLine({ ...realEntry(), pick: '' })).invalid, true);
  assert.equal(parseMirrorLine(mirrorLine({ ...realEntry(), placedOdds: 0.5 })).invalid, true);
  assert.equal(parseMirrorLine('no es json').invalid, true);
});

test('realImport: rechaza status distinto de PENDING', () => {
  const { invalid, reason } = parseMirrorLine(mirrorLine({ ...realEntry(), status: 'CLOSED' }));
  assert.equal(invalid, true);
  assert.match(reason, /PENDING/);
});

test('realImport: normaliza el espejo reducido de Vercel sin inventar datos', () => {
  const reduced = { id: 'x', game: 'A vs B', pick: 'A ML', placedOdds: 1.8, status: 'PENDING' };
  const norm = normalizeRealEntry(reduced);
  assert.equal(norm.sport, 'Sin clasificar');
  assert.equal(norm.status, 'PENDING');
  assert.equal(norm.result, null);
  assert.equal(norm.closingOdds, null);
  assert.equal(norm.source, 'telegram_mirror');
});

test('realImport: agrega solo ids nuevos y jamás toca los existentes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realimport-'));
  const ledger = path.join(dir, 'pick_ledger.jsonl');
  const graded = { ...realEntry({ id: 'old-1' }), status: 'CLOSED', result: 'WON', pnlUnits: 0.91 };
  fs.writeFileSync(ledger, JSON.stringify(graded) + '\n', 'utf-8');

  const lines = [
    mirrorLine(realEntry({ id: 'old-1', pick: 'OTRO PICK' })),
    mirrorLine(realEntry({ id: 'new-1' })),
    mirrorLine(realEntry({ id: 'new-1' })),
    'PAPER_LEDGER {"id":"paper-1","paper":true}'
  ];
  const res = importRealEntries(lines, ledger);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 2);
  assert.equal(res.invalid, 1);

  const rows = fs.readFileSync(ledger, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pick, 'Lakers OVER 224.5');
  assert.equal(rows[0].result, 'WON');
  assert.equal(rows[0].pnlUnits, 0.91);
  assert.equal(rows[1].id, 'new-1');
  assert.equal(rows[1].status, 'PENDING');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('realImport: dry-run no escribe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realimport-dry-'));
  const ledger = path.join(dir, 'pick_ledger.jsonl');
  const res = importRealEntries([mirrorLine(realEntry())], ledger, { dryRun: true });
  assert.equal(res.added, 1);
  assert.equal(fs.existsSync(ledger), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
