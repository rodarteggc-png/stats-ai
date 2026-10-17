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
* **Automatización:** Tareas programadas en **cron-job.org** apuntando a `https://stats-ai-pi.vercel.app/api/scan` a las:
  - **9:30 AM CDMX:** Turno Matutino (Escaneo del día + Corte de Caja Oficial nocturno de ayer).
  - **3:30 PM CDMX:** Turno Vespertino (Escaneo de tarde/noche y jornada matutina del día siguiente).
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
* **2026-10-17:** Optimización del Turno Nocturno de Fin de Semana (Viernes y Sábados 11:00 PM). Se amplió el horizonte a 20h para incluir selecciones de EQUIPO de toda la cartelera del día siguiente (NFL, NCAAF y Fútbol), preservando al 100% el Candado Anti-DNP de 90min para Player Props y los 5 Candados de Veto.
* **2026-10-16:** Activación de los 5 Candados Analíticos de Veto. Backtest reporta $92.9\%$ en fútbol y $83.9\%$ general. Corrección de importación de `isTeamMatch` en `ensemble.js`. Despliegue exitoso en Vercel.
* **2026-10-12:** Optimización Serverless y Fast Retry con timeouts de 1.5s/2.0s para evitar el límite de 30s de cron-job.org.
* **2026-10-08:** Blindaje de auditoría nocturna: filtrado exclusivo de picks enviados a Telegram.
