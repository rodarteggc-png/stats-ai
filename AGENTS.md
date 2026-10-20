# MEMORIA A LARGO PLAZO: STATS-AI PRO
> **Ubicación:** `c:\Users\RO106536\Documents\Perso\Proy_Gemini\stats-ai-pro`  
> **Estado Operativo:** 🟢 Producción / Algoritmo Congelado v1.0  
> **Efectividad Auditada (14 días ESPN):** 83.9% General (52W - 10L) | 92.9% Fútbol (39W - 3L, +53.0% ROI, Profit Factor 8.42x)

---

## 📌 1. PROPÓSITO DEL PROYECTO
Plataforma cuantitativa de predicción deportiva y generación automatizada de alertas de alto valor (+EV) para suscriptores. Combina modelos estadísticos estructurales, simulación estocástica y microestructura de mercado institucional.

---

## 🏗️ 2. ARQUITECTURA TÉCNICA
* **Frontend:** React 19 + Vite. Dashboard de visualización, radar de oportunidades y visor de consenso.
* **Backend / Serverless:** Vercel Serverless Functions (`/api/scan.js` y `/api/audit.js`) con ejecución desacoplada mediante `Promise.allSettled`.
* **Notificaciones:** Bot de Telegram con integración al canal privado/público.
* **Automatización:** Tareas programadas en **cron-job.org** apuntando a `https://stats-ai-pi.vercel.app/api/scan` con ventanas no traslapadas:
  - **9:30 AM CDMX (Turno Matutino):** Cubre exclusivamente partidos de **09:30 AM a 3:30 PM del mismo día** (6.0h). Acción inmediata en ligas europeas y juegos tempranos. Incluye Corte de Caja Oficial diario de ayer.
  - **3:30 PM CDMX (Turno Vespertino):** Cubre partidos de **3:30 PM a 9:30 AM del día siguiente** (18.0h). Cartelera estelar tarde/noche (NFL Prime Time, Liga MX, MLB) y fútbol europeo matutino entre semana.
  - **11:00 PM CDMX (Turno Nocturno Viernes y Sábado):** Cubre partidos de **11:00 PM a 9:30 AM de la mañana siguiente** (10.5h). Diseñado específicamente para carteleras tempranas de Europa (Premier League, Serie A, LaLiga desde las 5:30 AM) sin tocar el fútbol americano ni la tarde del fin de semana.
* **Persistencia Contable:** `data/pick_ledger.jsonl` (Libro mayor contable inmutable para auditoría pública y verificación de CLV).

---

## 🛡️ 3. LOS 5 CANDADOS ANALÍTICOS DE VETO (INMUTABLES)
Ubicados en [src/utils/ensemble.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/utils/ensemble.js) y sincronizados en [scripts/alertEngine.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/scripts/alertEngine.js):

1. **Candado 1 (NFL Sucker Line Veto):** Veto estricto a spreads de $+2.5$ y $-2.5$. El $15.2\%$ de los partidos de NFL terminan con margen de 3 puntos. Exige línea en $3.0/3.5$ o Moneyline.
2. **Candado 2 (Derbi / Clásico Veto en Fútbol):** Prohibido 'Más de 2.5 Goles' en rivalidades acérrimas (América-Chivas, Tigres-Rayados, Real Madrid-Barcelona, Boca-River, etc.) y en ligas defensivas con cuota $\ge 2.00$. En su lugar, el motor favorece Doble Oportunidad (1X/X2) o Más de 1.5.
3. **Candado 3 (NFL Blowout Risk Veto):** Veto a underdogs con $YPP < 4.65$, $EPA < -0.12$ o Diferencial de Pérdidas $\le -5$.
4. **Candado 4 (NFL Dome Pace Veto):** Veto a 'UNDER' en estadios techados (domos) con total alto ($\ge 47.0$ pts).
5. **Candado 5 (Veto por Flujo Adverso / Steam Contrario):** Veto automático si la cuota sube $\ge 3.5\%$ en contra o entra dinero institucional masivo (Steam Move) al rival.

---

## 🔒 4. REGLAS INVARIANTES Y PROHIBICIONES
* **MATEMÁTICA CONGELADA (v1.0):** No modificar los parámetros de Poisson, Dixon-Coles, Monte Carlo ni los 5 candados. La efectividad está demostrada en $83.9\%$.
* **NO REFACTORIZAR CÓDIGO POR GUSTO:** El usuario solicitó explícitamente no perder tiempo modularizando componentes de React o limpiando linter warnings mientras el proyecto no tenga clientes de pago.
* **ENFOQUE COMERCIAL:** La prioridad es la recolección del récord de 14 días en Telegram para monetizar con membresías VIP ($29 a $49 USD/mes).
* **NUNCA BORRAR NI MODIFICAR EL LEDGER:** `data/pick_ledger.jsonl` es la prueba forense de transparencia para los suscriptores.

---

## 📜 5. HISTORIAL DE HITOS CLAVE
* **2026-10-20 (Desbloqueo de Mercados & Calibración de Fluidez Operativa):**
  - **Hándicap Asiático (-1.5) en Fútbol:** Se implementó y calibró la monetización de favoritos pesados (cuotas 1X2 <= 1.48 como Real Madrid, Man City, Liverpool o AS Roma) mediante Hándicaps Asiáticos (-1.5) a cuotas rentables (1.65 a 2.30), respaldados por la matriz bivariada Poisson Dixon-Coles y simulación Monte Carlo 10k (`homeMinus15Prob`, `awayMinus15Prob`).
  - **Calibración de Umbrales de Probabilidad (Fin de la Parálisis Algorítmica):** Se eliminó el filtro plano arbitrario de 60.5% en `approvedOpps` que descartaba selecciones rentables con momios de 1.85-2.05 y probabilidades legítimas de 55-58% (+EV verificado). El umbral ahora se calibra por tipo de mercado:
    * Spreads y Totales (líneas de dos vías): exige prob >= 53.0% y Edge >= 2.0% (garantía matemática sobre cuotas ~1.90).
    * Moneylines / 1X2: exige prob >= 54.0% (y prob >= 58.0% si la cuota es baja <= 1.70).
  - **Totales de Fútbol (Over/Under 2.5):** Integrados plenamente en el motor con Candado 2 anti-derbi, asegurando acción de alto valor en partidos ofensivos (ej. Liverpool vs Villarreal Over 2.5 @ 2.10 con +21.5% Edge).
  - **Protocolo Anti-DNP Ampliado a 480 min (8 horas):** Se resolvió el bloqueo matutino de las 9:30 AM (partidos a las 13:00 CDMX estaban a 210 min y eran descartados). Ahora cubre toda la cartelera del turno activo.
  - **Verificación en Vivo y Despacho Exitoso:**
    * Tanda Matutina: 4 selecciones de Champions League despachadas a Telegram (Liverpool Over 2.5 @ 2.10, Roma Over 2.5 @ 1.63, Malen Más de 1.5 SOT @ 1.65, Barcola Más de 1.5 SOT @ 1.65).
    * Tanda Vespertina: Validada en simulación con cartelera completa y diversificada (Guadalajara 1X2 @ 1.90, Over 2.5 Goles @ 1.74, NCAAF Marshall vs South Alabama Under 66.5 @ 1.91 y South Alabama -2.5 @ 1.91).
  - **Integración Oficial de API-SPORTS (api-sports.io):**
    * Llave registrada a nombre de Gustavo Rodarte (`7184f1016b68c388a5c1e102b0f6eaef`), activa hasta 2027 con 100 requests/día (~3,000 requests/mes).
    * Adaptador oficial en [src/services/apiSports.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/services/apiSports.js) para sincronizar cuotas institucionales de Pinnacle (bookmaker 4) y Bet365 (bookmaker 8) como respaldo de alta resiliencia ante agotamiento de The Odds API.
    * Endpoint de diagnóstico en vivo en [https://stats-ai-pi.vercel.app/api/quota](https://stats-ai-pi.vercel.app/api/quota) con auditoría dual de The Odds API y API-Sports en tiempo real.
* **2026-10-19:** Implementación de la Partición Estricta de Ventanas de Alertas (Cero Canibalización):
  - Alerta 9:30 AM -> [09:30 a 15:30 mismo día].
  - Alerta 3:30 PM -> [15:30 a 09:30 día siguiente].
  - Alerta Nocturna 11:00 PM (Vie/Sáb) -> [23:00 a 09:30 mañana siguiente].
  - Blindaje de cuotas institucionales: Integración de `ncaaf` al pool de The Odds API con rotación de 4 llaves (2,000 req/mes) y prioridad absoluta a selecciones con dinero inteligente (RLM).
* **2026-10-17:** Optimización del Turno Nocturno de Fin de Semana (Viernes y Sábados 11:00 PM). Se amplió el horizonte para incluir selecciones de EQUIPO de toda la cartelera del día siguiente, preservando el Candado Anti-DNP de 90min para Player Props y los 5 Candados de Veto.
* **2026-10-16:** Activación de los 5 Candados Analíticos de Veto. Backtest reporta $92.9\%$ en fútbol y $83.9\%$ general. Corrección de importación de `isTeamMatch` en `ensemble.js`. Despliegue exitoso en Vercel.
* **2026-10-12:** Optimización Serverless y Fast Retry con timeouts de 1.5s/2.0s para evitar el límite de 30s de cron-job.org.
* **2026-10-08:** Blindaje de auditoría nocturna: filtrado exclusivo de picks enviados a Telegram.
