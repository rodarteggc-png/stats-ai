#!/usr/bin/env node
// scripts/learnFromLedger.mjs
// LOOP DE APRENDIZAJE: la IA (Gemini, la ya configurada) genera criterio desde
// el récord verificado del ledger.
//
// Lee data/pick_ledger.jsonl, calcula el reporte (computeLedgerReport) y le
// pide a Gemini que genere: criterios en lenguaje claro y propuestas de
// afinación con evidencia (qué cambiar, por qué, con cuántos picks detrás y
// qué riesgo tiene). NUNCA aplica cambios: solo escribe
// data/learning_report.json (+ .md legible) para que Tavo apruebe antes de
// tocar el modelo. El algoritmo está congelado v1.0 (AGENTS.md): ni los 5
// candados ni la matemática del modelo se tocan sin aprobación explícita.
//
// Sin GEMINI_API_KEY: escribe el reporte con el análisis numérico y marca la
// parte de IA como no disponible (no falla; exit 0).
//
// Uso:
//   node scripts/learnFromLedger.mjs
//   GEMINI_API_KEY=... node scripts/learnFromLedger.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeLedgerReport, readLedgerRows } from './ledgerReport.mjs';
import { getPlattCoefficients } from '../src/utils/calibration.js';
import { BANKROLL } from '../src/utils/bankroll.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_JSON_PATH = path.join(__dirname, '..', 'data', 'learning_report.json');
const REPORT_MD_PATH = path.join(__dirname, '..', 'data', 'learning_report.md');
const GEMINI_MODEL = 'gemini-2.5-flash';

// Afinación vigente (se lee del código cuando se puede; el fallback es el
// valor aprobado 2026-11-10 y debe actualizarse si cambia la afinación).
function readCurrentTuning() {
  const platt = getPlattCoefficients();
  let nbaSigma = 14.7;
  let spreadsPaused = true;
  try {
    const hoops = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'hoops.js'), 'utf-8');
    const m = hoops.match(/spreadStdDev\s*=\s*([\d.]+)/);
    if (m) nbaSigma = Number(m[1]);
  } catch {}
  try {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'alertEngine.js'), 'utf-8');
    const m = engine.match(/SPREADS_PAUSED\s*=\s*(true|false)/);
    if (m) spreadsPaused = m[1] === 'true';
  } catch {}
  return {
    platt,
    nbaSigma,
    spreadsPaused,
    drawdownStopUnits: BANKROLL.drawdownStopUnits,
    maxDailyExposureUnits: BANKROLL.maxDailyExposureUnits,
    internalQualityTargetUnits30d: 6.0
  };
}

/**
 * Condensa el reporte a lo que la IA necesita: números, no picks sueltos.
 * Pura y testeable.
 */
export function summarizeForAi(report) {
  const row = (g) => `${g.key}: ${g.n} picks, ${g.wins}W-${g.losses}L, acierto ${g.hitRate}%, ROI ${g.roiPct}%, prob. modelo ${g.avgProbPct}%, brecha ${g.calibrationGapPts} pts`;
  return {
    overall: report.overall,
    clv: report.clv,
    drawdown: report.drawdown,
    bySport: (report.bySport || []).map(row),
    byMarket: (report.byMarket || []).map(row),
    byProbBucket: (report.byProbBucket || []).map(row),
    recentForm: (report.recentForm || []).map((r) => `${r.result === 'WON' ? 'W' : r.result === 'LOST' ? 'L' : 'P'} ${r.game} (${r.pick}, ${r.pnlUnits}u)`),
    streaks: report.streaks,
    warnings: report.warnings || []
  };
}

/**
 * Prompt en español para Gemini. Pura y testeable.
 */
export function buildLearningPrompt(summary, tuning) {
  return [
    'Eres el analista cuantitativo de Stats-AI Pro, un sistema de picks deportivos.',
    'Analiza ÚNICAMENTE los números de abajo (récord verificado, picks reales calificados con marcador final).',
    'No inventes partidos, cuotas ni resultados que no estén en los números.',
    '',
    '## Afinación vigente',
    `- Platt por deporte: ${JSON.stringify(tuning.platt)}`,
    `- Sigma NBA (margen): ${tuning.nbaSigma}`,
    `- Spreads en pausa: ${tuning.spreadsPaused}`,
    `- Freno de drawdown: ${tuning.drawdownStopUnits}u (red de seguridad, no objetivo)`,
    `- Objetivo interno de calidad: no perder más de ${tuning.internalQualityTargetUnits30d}u en 30 días`,
    `- Exposición máxima diaria: ${tuning.maxDailyExposureUnits}u`,
    '',
    '## Récord verificado',
    JSON.stringify(summary, null, 2),
    '',
    '## Lo que debes devolver (JSON, sin texto fuera del JSON)',
    '{',
    '  "criteria": [{"rule": "criterio en una frase", "evidence": "qué número lo sostiene", "appliesTo": "deporte/mercado/cubo"}],',
    '  "proposals": [{"change": "qué cambiar", "area": "calibración Spreads NBA / umbral EV / etc.", "evidence": "números que lo sostienen y tamaño de muestra", "expectedEffect": "qué se espera", "risk": "qué puede salir mal", "minSample": "muestra mínima para aplicarlo"}],',
    '  "verdict": "una frase: qué está funcionando, qué no, y si conviene tocar algo ya o seguir midiendo"',
    '}',
    '',
    '## Reglas',
    '- Con menos de 20 picks en un segmento, di que la muestra es insuficiente y propón SEGUIR MIDIENDO, no cambiar nada.',
    '- Nunca propongas tocar los 5 candados de veto ni la matemática base del modelo; solo calibración, umbrales, pausas por segmento y gestión de banca.',
    '- Cada propuesta debe citar su evidencia numérica. Sin evidencia, no hay propuesta.',
    '- Sé escéptico con rachas cortas: 2-3 picks no prueban nada.'
  ].join('\n');
}

/**
 * Parsea la respuesta de Gemini. Si no es JSON válido, guarda el texto crudo
 * para no perder el análisis. Pura y testeable.
 */
export function parseAiResponse(text) {
  const raw = (text || '').trim();
  if (!raw) return { ok: false, error: 'respuesta vacía', raw };
  try {
    return { ok: true, ...JSON.parse(raw) };
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, ...JSON.parse(raw.slice(start, end + 1)) };
      } catch {}
    }
    return { ok: false, error: 'la IA no devolvió JSON válido', raw };
  }
}

export async function callGeminiLearning(prompt, { apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) return { available: false, reason: 'Sin GEMINI_API_KEY en el entorno.' };
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              criteria: { type: 'ARRAY', items: { type: 'OBJECT', properties: { rule: { type: 'STRING' }, evidence: { type: 'STRING' }, appliesTo: { type: 'STRING' } } } },
              proposals: { type: 'ARRAY', items: { type: 'OBJECT', properties: { change: { type: 'STRING' }, area: { type: 'STRING' }, evidence: { type: 'STRING' }, expectedEffect: { type: 'STRING' }, risk: { type: 'STRING' }, minSample: { type: 'STRING' } } } },
              verdict: { type: 'STRING' }
            }
          }
        }
      })
    }
  );
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!res.ok) return { available: false, reason: `Gemini HTTP ${res.status}: ${(data?.error?.message || '').slice(0, 200)}` };
  return { available: true, ...parseAiResponse(text) };
}

function renderMarkdown(report) {
  const lines = [
    '# Aprendizaje del ledger — Stats-AI Pro',
    '',
    `Generado: ${report.generatedAt}`,
    `Picks cerrados: ${report.summary.overall.n} (${report.summary.overall.wins}W-${report.summary.overall.losses}L, ROI ${report.summary.overall.roiPct}%)`,
    ''
  ];
  if (report.ai?.available === false) {
    lines.push(`> IA no disponible: ${report.ai.reason}`);
    lines.push('> El análisis numérico de abajo sigue siendo válido; las propuestas de la IA quedan pendientes.');
    lines.push('');
  }
  if (report.ai?.verdict) {
    lines.push(`## Veredicto de la IA`, '', report.ai.verdict, '');
  }
  if (report.ai?.criteria?.length) {
    lines.push('## Criterios generados', '');
    for (const c of report.ai.criteria) lines.push(`- **${c.rule}** — ${c.evidence} (${c.appliesTo || 'general'})`);
    lines.push('');
  }
  if (report.ai?.proposals?.length) {
    lines.push('## Propuestas de afinación (NO aplicadas: requieren aprobación)', '');
    for (const p of report.ai.proposals) {
      lines.push(`- **${p.change}** (${p.area})`);
      lines.push(`  - Evidencia: ${p.evidence}`);
      lines.push(`  - Efecto esperado: ${p.expectedEffect}`);
      lines.push(`  - Riesgo: ${p.risk}`);
    }
    lines.push('');
  } else if (report.ai?.available) {
    lines.push('## Propuestas de afinación', '', 'Ninguna: la IA recomienda seguir midiendo con la muestra actual.', '');
  }
  lines.push('## Números que vio la IA', '');
  lines.push('```json', JSON.stringify(report.summary, null, 2).slice(0, 6000), '```');
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const rows = readLedgerRows();
  const ledgerReport = computeLedgerReport(rows);
  const tuning = readCurrentTuning();
  const summary = summarizeForAi(ledgerReport);
  const prompt = buildLearningPrompt(summary, tuning);
  console.log(`📊 Ledger: ${ledgerReport.closed} cerrados, ROI ${ledgerReport.overall.roiPct}%. Pidiendo criterio a Gemini...`);
  const ai = await callGeminiLearning(prompt);
  const report = {
    generatedAt: new Date().toISOString(),
    model: GEMINI_MODEL,
    tuning,
    summary,
    ai
  };
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(REPORT_MD_PATH, renderMarkdown(report) + '\n', 'utf-8');
  if (ai.available) {
    console.log(`🧠 IA: ${ai.verdict || '(sin veredicto)'}`);
    console.log(`   criterios: ${(ai.criteria || []).length} · propuestas: ${(ai.proposals || []).length} (ninguna aplicada)`);
  } else {
    console.log(`⚠️ IA no disponible: ${ai.reason}`);
    console.log('   El reporte numérico quedó guardado; las propuestas quedan pendientes.');
  }
  console.log('Reporte guardado en data/learning_report.json y data/learning_report.md');
}
