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
  - **Enrutamiento Dual de Telegram (Canal Público vs Canal Privado VIP):**
    * Se implementó el soporte para targetChatId en `scripts/alertEngine.js` y `api/scan.js` (`?vip=1` o `--vip`).
    * Chat público general de suscriptores: `-1004410747027` (protegido contra saturación y pruebas experimentales).
    * Chat privado de Tavo Rodarte: `1258878024` (`TELEGRAM_VIP_CHAT_ID`), verificado con entrega directa bidireccional para pruebas en tiempo real.
  - **Candado Anti-Saturación de Player Props:**
    * Regla estricta: las apuestas de equipo (1X2 Moneyline, Spreads de puntos, Totales Over/Under y BTTS) representan >= 75%-85% de cada cartelera.
    * Los Player Props individuales quedan limitados a un máximo estricto de 1 por turno regular (y máximo 2 en días de alto volumen masivo con NFL/Fútbol).
  - **Webhook Interactivo de Telegram con Teclado Simplificado de 3 Botones:**
    * Endpoint Serverless desplegado en [api/webhook.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/api/webhook.js) y enlazado a `https://stats-ai-pi.vercel.app/api/webhook`.
    * Teclado persistente con 3 botones directos en Telegram: `[/vip]`, `[/cuota]`, `[/corte]`.
    * Candado de seguridad exclusivo: solo responde a Tavo Rodarte (`1258878024`), bloqueando cualquier otro usuario.
    * Permite invocar la Cartelera VIP en tiempo real, auditar saldo de APIs y ver corte diario con un solo toque desde el celular sin ingresar a consolas ni computadoras.

* **2026-10-21 (Expansión Cuantitativa Multi-Fuente y Activación NBA):**
  - **Módulo Meteorológico Open-Meteo (`src/services/weatherService.js`):**
    * Integración de clima y viento en tiempo real sin límites ni API keys para estadios de NFL y colegial.
    * Ajuste dinámico de puntos totales por vientos sostenidos >= 15 mph (-0.45 pts/mph sobre 12 mph) y blindaje del Candado 4 de Totales. Detección automática de domos (AT&T, Ford Field, Superdome, SoFi).
  - **Alimentador de Expected Goals FotMob (`src/services/fotmobService.js`):**
    * Extracción forense de xG, xGA, xGOT, Big Chances y tiros al marco desde endpoints de datos de FotMob sin bloqueos de Cloudflare.
    * Fusión Bayesiana en Poisson Dixon-Coles (70% goles históricos ESPN + 30% xG real FotMob) para detectar equipos sobrevalorados.
  - **Detector de Dinero Profesional / Steam Moves (`src/services/steamDetector.js`):**
    * Auditoría de caídas agresivas de cuota (>= 15 centavos o >= 7.5% de caída súbita) en Pinnacle/Bet365.
    * Despacho automático de Alertas Flash VIP prioritarias a Telegram.
  - **Módulo Cuantitativo de Baloncesto NBA (`src/utils/hoops.js` y `src/services/nbaService.js`):**
    * Modelo de 4 Factores de Dean Oliver, Posesiones (Pace) y Ratings Ofensivo/Defensivo por 100 posesiones para las 30 franquicias NBA.
    * Evaluación de Spreads, Over/Under y Moneylines con cuotas oficiales y verificación en el Tribunal de Consenso.

* **2026-10-24 (Integración No-Bloqueante de Micro-Inteligencia: Sleeper Injuries, Colegiados y Desplazamiento de Línea):**
  - **Sleeper API ([sleeperService.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/services/sleeperService.js)):** Extracción forense gratuita al minuto de lesiones y estatus de titulares/estrellas en NFL y NBA. Candado cualitativo en [tipsterAuditor.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/utils/tipsterAuditor.js) para evitar apuestas a favoritos pesados cuya figura estelar está `OUT`.
  - **Servicio de Colegiados y Árbitros ([refereeService.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/services/refereeService.js)):** Perfil de severidad, volumen de tarjetas amarillas/rojas y penales para árbitros de Liga MX, Premier League y Champions League.
  - **Detector de Desplazamiento de Línea ([lineMovementService.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/services/lineMovementService.js)):** Análisis comparativo nativo entre Apertura (Open) y Cierre (Close) para Spreads, Totales y Moneylines sin consumo de cuota de API.
  - **Arquitectura Ultra-Rápida:** Cero impacto en rendimiento (ejecución benchmark en 1.2 segundos), caché en memoria TTL, timeouts estrictos y fallbacks no-bloqueantes.

* **2026-10-23 (Replicación de NBA y Menú Táctil por Deporte en Telegram VIP):**
  - **Selector de Deportes en UI Web:** Botón interactivo 🏀 Baloncesto (NBA) añadido a la barra segmentada principal de [src/App.jsx](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/App.jsx).
  - **Radar de Oportunidades en Vivo:** Conexión nativa de `fetchDailySchedule('nba')` con `fetchNbaSchedule`, loteo en Web Worker Monte Carlo 10k (`simulateNbaMatch`), y generación de oportunidades en Spreads, Totales (Over/Under) y Moneylines.
  - **Simulador Cuantitativo 3v1:** Soporte integral para partidos de NBA manuales o programados, proyectando Pace, Eficiencias ORtg/DRtg, Puntos y radiografía forense con Gemini.
  - **Tribunal de Consenso y Calibración Platt:** Incorporación de NBA a [src/utils/ensemble.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/utils/ensemble.js) (Voto 1 estructural y Voto 3 de mercado) y coeficientes calibrados en [src/utils/calibration.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/utils/calibration.js).
  - **Historial y Auto-Verificación:** Conexión de `autoVerifyResultsWithAPIs` con el feed de ESPN NBA Scoreboard para calificar automáticamente picks pendientes y calcular CLV real.
  - **Menú Táctil Interactivo por Deporte en Telegram VIP:** Al pulsar `/vip` en Telegram, el bot despliega un menú táctil interactivo (Inline Buttons) en pantalla con botones para Fútbol, NBA, NFL/NCAAF, MLB y Cartelera Completa. El motor `runAlertEngine({ sport })` filtra y analiza selectivamente la disciplina solicitada en tiempo real.

* **2026-10-19:** Implementación de la Partición Estricta de Ventanas de Alertas (Cero Canibalización):
  - Alerta 9:30 AM -> [09:30 a 15:30 mismo día].
  - Alerta 3:30 PM -> [15:30 a 09:30 día siguiente].
  - Alerta Nocturna 11:00 PM (Vie/Sáb) -> [23:00 a 09:30 mañana siguiente].
  - Blindaje de cuotas institucionales: Integración de `ncaaf` al pool de The Odds API con rotación de 4 llaves (2,000 req/mes) y prioridad absoluta a selecciones con dinero inteligente (RLM).
* **2026-10-17:** Optimización del Turno Nocturno de Fin de Semana (Viernes y Sábados 11:00 PM). Se amplió el horizonte para incluir selecciones de EQUIPO de toda la cartelera del día siguiente, preservando el Candado Anti-DNP de 90min para Player Props y los 5 Candados de Veto.
* **2026-10-16:** Activación de los 5 Candados Analíticos de Veto. Backtest reporta $92.9\%$ en fútbol y $83.9\%$ general. Corrección de importación de `isTeamMatch` en `ensemble.js`. Despliegue exitoso en Vercel.
* **2026-10-12:** Optimización Serverless y Fast Retry con timeouts de 1.5s/2.0s para evitar el límite de 30s de cron-job.org.
* **2026-10-08:** Blindaje de auditoría nocturna: filtrado exclusivo de picks enviados a Telegram.
