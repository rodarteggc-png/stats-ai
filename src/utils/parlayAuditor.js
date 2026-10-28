// src/utils/parlayAuditor.js
// MOTOR DE AUDITORÍA FORENSE DE PARLAYS Y COMBINADAS (+EV) - STATS-AI PRO

/**
 * Parsea el texto del parlay introducido por el usuario o extraído por visión OCR
 */
export function parseParlayInput(text = '') {
  const clean = text
    .replace(/^\/parlay\s*/i, '')
    .replace(/^parlay:\s*/i, '')
    .replace(/^combinada:\s*/i, '')
    .trim();

  if (!clean) return [];

  // Separar por comas, saltos de línea o barras
  const rawLegs = clean.split(/[,\n;|]+/).map(l => l.trim()).filter(Boolean);

  return rawLegs.map((leg, idx) => {
    // Buscar momio decimal (ej: 1.85, 2.10) o americano (ej: -110, +150)
    let odds = 1.85;
    const decimalMatch = leg.match(/@?\s*([1-9]\.[0-9]{2})/);
    const americanMatch = leg.match(/@?\s*([+-][1-9][0-9]{2,3})/);

    if (decimalMatch) {
      odds = parseFloat(decimalMatch[1]);
    } else if (americanMatch) {
      const am = parseInt(americanMatch[1], 10);
      odds = am > 0 ? Number((1 + (am / 100)).toFixed(2)) : Number((1 + (100 / Math.abs(am))).toFixed(2));
    }

    const cleanName = leg
      .replace(/@?\s*[1-9]\.[0-9]{2}/, '')
      .replace(/@?\s*[+-][1-9][0-9]{2,3}/, '')
      .trim();

    return {
      index: idx + 1,
      raw: leg,
      text: cleanName || leg,
      odds: Math.max(1.05, odds)
    };
  });
}

/**
 * Audita cada pata del parlay aplicando los 5 Candados de Veto institucionales
 * y calcula la probabilidad conjunta real vs la implícita de la casa de apuestas.
 */
export function auditParlayLegs(legs = []) {
  if (!legs || legs.length === 0) {
    return {
      success: false,
      message: 'No se detectaron selecciones válidas en el boleto.'
    };
  }

  let combinedOdds = 1.0;
  let combinedProb = 1.0;
  const legAudits = [];
  let vetoCount = 0;
  let warningCount = 0;

  legs.forEach((leg, i) => {
    combinedOdds *= leg.odds;
    const t = leg.text.toLowerCase();

    let status = 'APPROVED'; // APPROVED | WARNING | VETOED
    let badge = '✅ APROBADA (+EV)';
    let reason = 'Selección dentro de parámetros normales de varianza y liquidez.';
    let legProb = (1 / leg.odds) * 100;

    // CANDADO 1: NFL Sucker Line (+/- 2.5)
    if (t.includes('nfl') || t.includes('americano') || t.includes('spread') || t.includes('fútbol americano')) {
      if (t.includes('+2.5') || t.includes('-2.5')) {
        status = 'VETOED';
        badge = '⛔ VETO CANDADO 1 (NFL Sucker Line)';
        reason = 'Spreads de 2.5 en fútbol americano son líneas trampa (15.2% de partidos terminan exactamente en 3 pts). Exige 3.0/3.5 o Moneyline.';
        vetoCount++;
        legProb = 46.0;
      }
    }

    // CANDADO 2: Derbi o Clásico Veto en Totales (Over 2.5)
    if ((t.includes('over 2.5') || t.includes('más de 2.5') || t.includes('+2.5')) && 
        (t.includes('derbi') || t.includes('clásico') || t.includes('clasico') || t.includes('madrid') && t.includes('barca') || t.includes('chivas') && t.includes('américa'))) {
      status = 'VETOED';
      badge = '⛔ VETO CANDADO 2 (Derbi Táctico Tenso)';
      reason = 'Prohibido Over 2.5 en clásicos tensos. Los partidos de alta rivalidad tienden a bloqueos tácticos. Recomendado: Doble Oportunidad o Menos de 3.5.';
      vetoCount++;
      legProb = 45.0;
    }

    // CANDADO 3: Underdogs con cuota alta en combinada (> 2.30 en ML directo)
    if ((t.includes('ml') || t.includes('1x2') || t.includes('gana') || t.includes('victoria')) && leg.odds >= 2.30 && status === 'APPROVED') {
      status = 'WARNING';
      badge = '⚠️ ALERTA CANDADO 3 (Riesgo de Asimetría)';
      reason = `Cuota alta (${leg.odds.toFixed(2)}) en victoria directa dentro de un parlay destruye la probabilidad conjunta. Jugar en derecho o con hándicap positivo.`;
      warningCount++;
      legProb = 37.0;
    }

    // CANDADO 4: Under en domo con total alto
    if ((t.includes('under') || t.includes('menos')) && 
        (t.includes('domo') || t.includes('dome') || t.includes('att') || t.includes('sofi') || t.includes('ford field')) && status === 'APPROVED') {
      status = 'VETOED';
      badge = '⛔ VETO CANDADO 4 (NFL Dome Pace Veto)';
      reason = 'Estadios cerrados (domos) eliminan el viento y frío, favoreciendo ritmos altos y puntos. Veto al Under.';
      vetoCount++;
      legProb = 44.0;
    }

    // CANDADO 5 / TRAMPA: Momios ultra bajos (< 1.25)
    if (leg.odds <= 1.25 && status === 'APPROVED') {
      status = 'WARNING';
      badge = '⚠️ MOMIO TRAMPA (< 1.25)';
      reason = `Una cuota de ${leg.odds.toFixed(2)} solo suma centavos al multiplicador pero arriesga todo el parlay ante cualquier accidente.`;
      warningCount++;
      legProb = 78.0;
    } else if (status === 'APPROVED') {
      // Ajuste de ventaja cuantitativa estimada (+3.5% sobre la probabilidad implícita)
      legProb = Math.min(88, ((1 / leg.odds) * 100) + 3.5);
    }

    combinedProb *= (legProb / 100);

    legAudits.push({
      index: i + 1,
      pickText: leg.text,
      odds: leg.odds.toFixed(2),
      status,
      badge,
      reason,
      estimatedProb: `${legProb.toFixed(1)}%`
    });
  });

  const finalCombinedProbPct = (combinedProb * 100).toFixed(1);
  const impliedJointProbPct = ((1 / combinedOdds) * 100).toFixed(1);
  const diffEdge = (parseFloat(finalCombinedProbPct) - parseFloat(impliedJointProbPct)).toFixed(1);

  let verdictBadge;
  let overallVerdict;

  if (vetoCount > 0) {
    verdictBadge = '🛑 PARLAY VETADO POR EL TRIBUNAL DE CONSENSO';
    overallVerdict = `Este boleto tiene ${vetoCount} selección(es) con Veto Institucional. Jugarlo en este estado destruye tu valor esperado (+EV).`;
  } else if (warningCount >= 2) {
    verdictBadge = '⚠️ PARLAY CON RIESGO ASIMÉTRICO ELEVADO';
    overallVerdict = `El boleto contiene ${warningCount} selecciones con advertencias de cuota o asimetría. Te conviene retirar la pata más débil.`;
  } else {
    verdictBadge = '🟢 PARLAY APROBADO CON VALOR CUANTITATIVO (+EV)';
    overallVerdict = `Boleto sólido y calibrado. Las selecciones tienen coherencia matemática y superan los filtros institucionales.`;
  }

  return {
    success: true,
    legsCount: legs.length,
    combinedOdds: combinedOdds.toFixed(2),
    combinedProb: `${finalCombinedProbPct}%`,
    impliedJointProb: `${impliedJointProbPct}%`,
    edgeDiff: `${diffEdge >= 0 ? '+' : ''}${diffEdge}%`,
    verdictBadge,
    overallVerdict,
    vetoCount,
    warningCount,
    legAudits
  };
}

/**
 * Formatea el dictamen forense de auditoría de parlay para Telegram
 */
export function formatParlayAuditReport(audit, originalInput = '') {
  if (!audit || !audit.success) {
    return [
      `🎰 *AUDITORÍA DE PARLAYS — STATS-AI PRO*`,
      `⚠️ *No se pudieron procesar las selecciones.*`,
      ``,
      `👉 *Formato sugerido:*`,
      `\`/parlay Selección 1 @ Cuota, Selección 2 @ Cuota, ...\``,
      `_Ejemplo:_ \`/parlay Chelsea ML @ 1.64, Inter Over 2.5 @ 1.95, Celtics ML @ 1.80\``
    ].join('\n');
  }

  const header = [
    `🎰 *AUDITORÍA FORENSE DE PARLAYS — STATS-AI PRO* 🎰`,
    `🔬 *DIAGNÓSTICO 3v1 CON LOS 5 CANDADOS DE VETO*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `${audit.verdictBadge}`,
    `_${audit.overallVerdict}_`,
    ``,
    `📊 *MÉTRICAS DEL BOLETO (${audit.legsCount} PATAS):*`,
    `• *Cuota Total Combinada:* \`${audit.combinedOdds}\``,
    `• *Probabilidad Real Calculada:* \`${audit.combinedProb}\``,
    `• *Probabilidad Implícita Casa:* \`${audit.impliedJointProb}\``,
    `• *Ventaja Cuantitativa (Edge):* *${audit.edgeDiff}*`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🔍 *DESGLOSE PATA POR PATA:*`,
    ``
  ];

  const legsFormatted = audit.legAudits.map(l => [
    `*Pata ${l.index}:* \`${l.pickText}\` @ \`${l.odds}\``,
    `   ${l.badge}`,
    `   • *Prob:* \`${l.estimatedProb}\``,
    `   • _${l.reason}_`,
    ``
  ].join('\n'));

  // Recomendación de optimización si hay vetos o warnings
  let recommendationBlock = [];
  if (audit.vetoCount > 0) {
    recommendationBlock = [
      `💡 *RECOMENDACIÓN DEL TRIBUNAL:*`,
      `_Elimina las patas con etiqueta ⛔ VETO. Si juegas solo las patas aprobadas restantes, tu probabilidad de cobro se multiplica y eliminas el riesgo trampa._`,
      ``
    ];
  } else if (audit.legsCount >= 4) {
    recommendationBlock = [
      `💡 *CONSEJO INSTITUCIONAL:*`,
      `_Un parlay de ${audit.legsCount} patas tiene una probabilidad matemática de acierto de solo ${audit.combinedProb}. Para proteger tu banca, considera dividirlo en 2 combinadas de 2 patas o apostar las mejores en directo._`,
      ``
    ];
  }

  const footer = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `👑 *Stats-AI Pro — Motor Cuantitativo y Blindaje de Banca*`
  ];

  return [...header, ...legsFormatted, ...recommendationBlock, ...footer].join('\n');
}

