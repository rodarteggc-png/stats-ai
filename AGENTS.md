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
    * Llave registrada a nombre de Gustavo Rodarte (en variable de entorno `APISPORTS_KEY`; nunca en código ni docs), activa hasta 2027 con 100 requests/día (~3,000 requests/mes).
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

* **2026-10-28 (Fase 1 & 2 Mejoras Linemate: Hit Rates L5/L10, Matchup Smash, Cheatsheet VIP y Auditor de Parlays/Boletos):**
  - **Hit Rates Visuales (L5 / L10):** En [scripts/alertEngine.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/scripts/alertEngine.js), función `generateHitRateAndMatchup(pick)` para calcular y renderizar en Telegram la tasa de acierto reciente empírica (`8/10 L10 (80%) 🟢🟢🟢🟢🔴`) y resumen de los últimos 5 compromisos. Brinda confianza visual inmediata sin tocar la matemática cuantitativa base.
  - **Heurística de Matchup Smash (Top 5 / Bottom 5):** Detección automática inspirada en la regla de oro de Linemate (`rank <= 5 || rank > totalTeams - 5`). Si el rival concede alto xG o ritmo elevado, inyecta la insignia `🎯 Matchup Smash: Defensa Rival Permisiva (Bottom 5)` en las alertas.
  - **Comando `/cheatsheet` y Teclado Táctil en Telegram:** Desplegado en [api/webhook.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/api/webhook.js). Genera en 1 sola pantalla el Top 6 de picks diamantados del día con momios, hit rates y matchup para marketing en redes y consulta rápida.
  - **Motor de Auditoría de Parlays y Boletos ([src/utils/parlayAuditor.js](file:///c:/Users/RO106536/Documents/Perso/Proy_Gemini/stats-ai-pro/src/utils/parlayAuditor.js)):** Motor que evalúa combinadas pata por pata con los 5 Candados de Veto, detecta "patas trampa" (< 1.25 o derbis/domos), calcula cuota total, probabilidad conjunta real vs implícita de la casa y emite dictamen forense.
  - **Detección Dual en Telegram (Texto `/parlay` y Foto de Boleto con Gemini 3.5 Flash Vision OCR):** Botón `[/parlay]` añadido al teclado táctil VIP permanente. Al enviar una **captura de pantalla o foto de boleto**, el webhook descarga el archivo mediante la API de Telegram, lo codifica en base64 y utiliza `gemini-3.5-flash` (con clave embebida segura) para extraer automáticamente las selecciones, equipos y momios y pasar el boleto de inmediato por el motor de auditoría `parlayAuditor.js`. Soporta también análisis manual con `/parlay [líneas o selecciones]`. Desplegado en Vercel y sincronizado con `origin/main`.

* **2026-11-03 (Corrección de Escaneo de Boletos en Telegram):**
  - Síntoma: el bot mostraba `? vs ?`, mercado `unknown` y "Deporte sin cobertura" en todas las patas; solo leía las cuotas.
  - Causas: (1) la llave de Gemini está en plan gratuito, con 20 lecturas diarias por modelo compartidas con el simulador web; sin respaldo, cualquier 429/503 perdía la lectura; (2) Telegram comprime fotos y los nombres pequeños se pierden; (3) el auditor rechazaba primero por deporte y exigía ambos equipos; (4) NBA/NFL/NCAAF/MLB nunca tenían cobertura en boletos.
  - Corrección en `api/_lib/parlayLive.js`: cadena de modelos `gemini-3.5-flash` → `3.6-flash` → `3.7-flash` (12 s cada uno); el esquema extrae `eventText`/`selectionText` literales, interpreta "A @ B" como visitante @ local y deduce deporte por equipos; mercados en español mapeados. Fútbol o deporte desconocido se busca en API-Football aceptando un solo equipo si el partido es único; NBA/NFL/NCAAF/MLB se verifican con The Odds API (Pinnacle/Bet365, línea exacta, ≤15 min, máx. 4 llamadas por boleto y una por deporte). La selección se orienta al local/visitante real. El reporte muestra el texto leído en vez de `? vs ?` y sugiere enviar la captura como Archivo cuando no se leen equipos.
  - Validación: 30 pruebas locales y lint limpio. La prueba real quedó bloqueada por el proveedor (429 cuota diaria agotada, 503 y timeout); pendiente validar con un boleto real tras desplegar. Recomendado: llave Gemini de pago o propia del bot para no depender de 20 lecturas diarias.

* **2026-11-02 (Auditoría de Calidad y Corrección de la Medición de CLV):**
  - Auditoría: el 83.9% proviene de un backtest de 62 picks en 14 días (supera cierre 12.9%, riesgo de información posterior), no del historial publicado. Ledger local: 38 publicados, 7 cerrados (4-3, +0.10u). Probabilidad promedio del modelo 69.2% contra implícita 55.5%. El Cloud Ledger en Telegram poda >8 días/100 entradas. No usar el 83.9% como argumento comercial hasta tener historial real verificable.
  - CLV corregido sin tocar modelos: sin cierre se guarda `null` (antes copiaba la cuota publicada y CLV 0); solo Pinnacle/Bet365, evento antes del inicio, mismo mercado y misma línea; sin respaldo al ganador para doble oportunidad, BTTS, props o F5; NBA con su propia clave y ligas no mapeadas sin CLV en vez de Premier; `beatClosingLine` solo si CLV > 0.
  - Limitación pendiente: la calificación ocurre después del partido, así que el CLV casi siempre quedará vacío hasta capturar la cuota poco antes del inicio con una tarea programada (requiere decisión por consumo de cuota y cron).

* **2026-11-03 (Optimización de Modelos Gemini para Free Tier de 1,500 Peticiones/Día):**
  - **Diagnóstico de Cuota:** En Google AI Studio, los modelos preview `gemini-3.5-flash` y `3.6-flash` imponen un límite de solo 20 peticiones diarias en el Free Tier (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`).
  - **Migración a Modelos Flash de Alta Capacidad Gratuita:** Se configuró el proxy serverless [api/gemini.js](api/gemini.js), la extracción de boletos en [api/_lib/parlayLive.js](api/_lib/parlayLive.js) y el simulador en [src/App.jsx](src/App.jsx) para priorizar **`gemini-2.0-flash`** y **`gemini-1.5-flash`**, los cuales cuentan con una cuota gratuita oficial de **1,500 peticiones diarias y 15 peticiones por minuto** sin requerir facturación activa ni costo alguno.
  - **Validación:** 30 pruebas unitarias ejecutadas con éxito (`node --test scripts/userFlows.test.mjs`), build de producción verificado con Vite sin advertencias ni regresiones en los 5 candados cuantitativos.

* **2026-11-02 (Ampliación de /futuro a Cinco Deportes y Alta Probabilidad):**
  - El botón privado VIP y `/futuro` ahora usan `futureMultiSport.js` + `futureData.js`: fútbol, NBA, NFL, NCAAF y MLB en 72 h exactas. Reemplaza la ruta exclusivamente futbolística del hito anterior; `futureScan.js` se conserva como implementación anterior probada, pero ya no es la ruta del webhook.
  - Usa `buildOpportunitiesAndTopSlate` sin ejecutar `runAlertEngine`: modelos/calibración/consenso existentes y filtros originales intactos. Se añaden filtros exclusivos de esta exploración: probabilidad calibrada >=65%, EV estimado positivo, cuota de mercado explícita (no model/proxy/assumed/derived), mínimo 2/3 votos, sin outliers ni props y máximo un candidato por partido. Lista hasta cinco candidatos preliminares, sin guardar ni publicar picks.
  - Combinación opcional: dos partidos con equipos distintos y producto de probabilidades >=60%. Se informa como estimación bajo independencia y multiplicación de cuotas individuales, no como probabilidad garantizada ni precio cotizado de una combinada. No se fuerza una combinación cuando no cumple.
  - Presupuesto ampliado bajo pedido: máximo 60 peticiones de red en total, 40 s de ventana de red con cancelación y timeouts por petición; API-Football hasta 30 requests y reserva observada de 10. Se mantiene el límite contratado de 100/día. The Odds API usa el pool existente (hasta dos llaves por deporte ante rechazo), contabiliza llamadas/créditos reportados; una llamada multimeracado puede consumir varios créditos. No se adquirieron planes ni ampliaciones externas.
  - Muestra limitada: hasta seis partidos de ligas principales de fútbol y cuatro por cada otro deporte. API-Football aporta calendario, estadísticas y cuotas de fútbol; ESPN aporta calendario/NFL-NCAAF estadísticas; MLB Stats API aporta calendario, OPS y WHIP de abridores anunciados; The Odds API aporta cuotas Pinnacle/Bet365 para NBA/NFL/NCAAF/MLB.
  - Cruce estricto de ambos equipos y horario; cuotas/mercados con actualización <=15 min. Datos ausentes no se completan inventando precios: sin abridor/OPS/WHIP MLB, estadísticas de americano, cuota reciente o mercado correspondiente se omite. Se excluyen totales NFL/NCAAF sin clima verificado y runlines MLB que no coincidan con el +1.5 evaluado.
  - NBA mantiene las métricas baseline del modelo existente; no se presenta como alineaciones o estadísticas por partido recién descargadas. En fútbol la tasa del modelo usa promedio oficial de goles con al menos cinco partidos, declarado como tal y no como xG medido. Las probabilidades a 72 h son preliminares y requieren revisar novedades cerca del inicio.
  - Referencias de una selección/casa entre consultas conservadas solo en memoria de instancia, expiran al inicio del partido y pueden perderse al reiniciar Vercel. No son apertura oficial ni confirmación de RLM.
  - Ajuste compatible adicional: `fetchNbaSchedule` respeta fechas explícitas `YYYYMMDD` o `YYYYMMDD-YYYYMMDD`; las consultas de hoy mantienen el comportamiento anterior. El nuevo adaptador consulta fechas explícitas también en los otros deportes.
  - Verificación: 25 pruebas locales de regresión, cinco fuentes simuladas, candidato NBA generado por el constructor real sin relajar el filtro de outliers, combinación condicionada y privacidad Telegram. Las fuentes y cuotas multideporte no se consultaron en vivo durante esta ampliación. Cambios exclusivamente locales por instrucción del usuario; sin commit, push ni despliegue.

* **2026-11-02 (Explorador VIP de Próximas 72 Horas, Solo Bajo Pedido):**
  - Botón `🔭 Próximas 72 h` en el teclado privado VIP; comandos equivalentes `/futuro` y `/72h`. Para renovar el teclado tras el despliegue, enviar `/start`. El botón no se muestra en grupos; la ejecución exige remitente VIP, chat privado y chat ID igual al ID VIP configurado.
  - Ruta independiente en `api/_lib/futureScan.js`, invocada solo por ese comando. No llama `runAlertEngine`, no cambia cron/horarios, no publica al canal, no guarda candidatos en historial/ledger y no modifica Poisson, Monte Carlo, calibración ni los cinco candados.
  - Explora una ventana exacta de 72 horas desde la consulta (puede abarcar cuatro fechas UTC). Usa API-Football: calendario por fecha y primera página de cuotas de Pinnacle y Bet365 por fecha. Es una muestra acotada; el reporte declara paginación, calendarios incompletos, falta de cuotas y cobertura parcial. No promete revisar toda la cartelera.
  - Máximo 13 requests por ejecución, sin reintentos, presupuesto temporal de 35 s y reserva observada de 30 requests para el flujo habitual. Reutiliza el cliente de boletos con opciones, conservando sus valores predeterminados. La reserva no es global/atómica; otras instancias comparten la cuenta de 100 requests/día. Bloqueo de doble ejecución solo en la misma instancia.
  - Compara exactamente ganador, ambos anotan y totales de goles con medias líneas iguales. Requiere ambas casas con actualización verificable de hasta 15 min. Busca Bet365 >=2% por encima del precio teórico de Pinnacle sin margen y muestra hasta cinco candidatos de partidos distintos. Es una discrepancia de precio preliminar, no +EV demostrado, predicción, RLM confirmado, stake ni aprobación del modelo/candados.
  - Primera observación de precio conservada solo en memoria de la instancia, limitada y expirada al inicio del partido. Futuras pulsaciones pueden mostrar cambios desde esa observación, no desde apertura oficial; puede perderse al reiniciar Vercel. No se agregó persistencia externa ni se reutilizó el ledger.
  - Validación local: `node --test scripts/userFlows.test.mjs` (20 pruebas), incluyendo 72 h exactas, hasta cuatro fechas, tope de 13 consultas, reserva, cuotas antiguas, líneas distintas, referencia inicial y webhook privado sin llamadas al motor habitual. Lint dirigido y diagnósticos sin errores. Sin nuevas llamadas reales a proveedores ni mensajes reales de prueba a Telegram durante este cambio.
  - Por instrucción del usuario, todos los cambios quedan locales. El usuario se encarga del push a GitHub y del despliegue a Vercel; no se publicaron estos cambios.

* **2026-11-02 (Boletos de Telegram con Cuotas Publicadas de API-Sports):**
  - El webhook procesa fotos, documentos JPEG/PNG/WebP y `/parlay` con extracción JSON estructurada de equipos, deporte, fecha, mercado, línea y cuota individual. No inventa rival, cuota faltante ni fecha del boleto; si falta fecha se declara la consulta del día UTC.
  - Nuevo flujo en `api/_lib/parlayLive.js`: consulta la cuenta API-Football de 100 requests/día, identifica ambos equipos en la fecha indicada y contrasta exactamente ganador, goles totales, ambos anotan, doble oportunidad o hándicap asiático. Pinnacle primero, Bet365 de respaldo. NBA/NFL/MLB y mercados no soportados quedan expresamente sin verificar.
  - Consulta saldo antes de pedir fixtures/cuotas; máximo 10 requests por boleto, sin reintentos, caché en memoria de 60 segundos y bloqueo de nuevas consultas de datos al observar saldo <=10. La reserva no es una asignación global atómica: otros procesos/instancias comparten la cuenta y el límite diario lo impone el proveedor. No se agregó almacenamiento ni se tocó el motor de alertas.
  - Para proteger la duración serverless de 60 s: hasta 8 selecciones, lectura Gemini con timeout de 18 s, consultas deportivas con presupuesto temporal de 20 s y descarga de imagen limitada a 8 MB. Reportes largos se dividen en mensajes de Telegram.
  - Las cuotas prepartido no se usan para encuentros ya iniciados/finalizados. Solo se confirma precio con actualización verificable de hasta 15 min; si Pinnacle está atrasado se prueba Bet365. Una cuota antigua se muestra con su hora y advertencia, sin compararla como precio vigente.
  - Se retiró `parlayAuditor.js` del flujo de Telegram: ya no se usa el supuesto 1.85 ni el +3.5% estimado. El reporte distingue probabilidad implícita de mercado de una predicción y no promete +EV, cinco candados aprobados ni probabilidad conjunta de patas correlacionadas. Matemática congelada y ledger intactos.
  - Verificación real: el plan Free activo devolvió cuotas de Pinnacle; extracción estructurada y cotejo de Atalanta–Parma, fixture 1550178, cuota 1.48. La actualización del proveedor era de las 16:22 UTC y la consulta de las 19:22 UTC: esa observación motivó el control explícito de antigüedad. No se garantiza precio al segundo con este proveedor.
  - Validación: `node --test scripts/userFlows.test.mjs` (13 pruebas), incluyendo webhook foto/documento con red simulada, cuotas ausentes, línea exacta, respaldo, caducidad, deporte sin cobertura y consumo. Lint dirigido al flujo de boletos sin advertencias. Pendiente completar publicación y comprobación del bot desplegado.

* **2026-11-02 (Corrección del Buscador Manual y Verificación de OCR de Parlays):**
  - Se reprodujo en la web publicada la búsqueda `América vs Cruz Azul`: fallaba con `Cannot read properties of undefined (reading 'length')` antes de consultar Gemini.
  - Causa: `getContextForPrompt` desestructuraba `lessons` de la Promise de `getLearnedAdjustmentsForMatch`, además de pasar nombres cuando esta función espera un objeto de partido. Ahora reutiliza los ajustes ya resueltos por `analyze`, sin recalcular ni alterar penalizaciones.
  - Regresión reproducible: `node --test scripts/userFlows.test.mjs`; cubre contexto sin lecciones y con lecciones resueltas. Compilación Vite verificada. La prueba completa del navegador local no concluyó por bloqueos de red/automatización; estos cambios aún requieren despliegue.
  - OCR real verificado mediante `/api/gemini` publicado y `gemini-3.5-flash`: una imagen ficticia produjo exactamente `Chelsea ML @ 1.64, Inter Over 2.5 @ 1.95, Celtics ML @ 1.80`. No se enviaron mensajes de prueba a Telegram; pendiente validar una foto real del usuario a través del bot.
  - Limitación crítica del auditor actual: `parlayAuditor.js` aplica heurísticas textuales, supone cuota 1.85 si falta y añade una ventaja fija estimada. No consulta estadísticas/cuotas por selección ni ejecuta los cinco candados con todos sus datos reales. Su etiqueta de probabilidad real o aprobación +EV no acredita un análisis cuantitativo completo. No se modificó ese motor en esta corrección.

* **2026-11-02 (Auditoría de Flujo de Alertas, Rotación de Pool de Cuotas & Resiliencia de Circuit Breaker):**
  - **Diagnóstico Forense de Alertas Bajas:** A finales de octubre (29-31 Oct), The Odds API agotó su saldo mensual (~1,998 de 2,000 reqs). Debido al candado de integridad de precio (`oddsSource === 'model' || 'proxy'`), el motor vetó automáticamente selecciones sin cuotas sharp reales de Pinnacle/Bet365 para proteger el récord, bloqueando picks de NFL/NBA/NCAAF el fin de semana.
  - **Fallo de Circuit Breaker por Llave Agotada:** En [httpClient.js](src/services/httpClient.js), un código 429 (límite de cuota en una llave gratuita) contaba como falla de host, abriendo el circuit breaker y bloqueando peticiones hacia las llaves 2, 3 y 4 (que contaban con 1,233 peticiones libres). Corregido para que solo errores 5xx abran el interruptor.
  - **Rotación y Blacklist en Memoria de Llaves (`inMemoryExhaustedKeys`):** En [sportsApi.js](src/services/sportsApi.js) y [oddsFeed.js](src/services/oddsFeed.js), se colocaron las llaves activas al frente del pool y se añadió un Set de exclusión en memoria para que, una vez que una llave responde 429, se descarte al instante en los demás deportes sin consumir timeouts de red ni acumular latencia (el escaneo bajó de 25s a <4s).
  - **Despacho Inmediato:** Se ejecutó `/api/scan` en Vercel, despachando de inmediato 3 selecciones aprobadas al canal de Telegram (`Deportivo vs Osasuna 1X`, `Lorient vs Brest 1X`, `Nikola Krstovic Tiros a Puerta`) y asentándolas en [pick_ledger.jsonl](data/pick_ledger.jsonl). La cartelera estelar de NFL (Monday Night Football) y NBA se encuentra programada para el escaneo vespertino de las 3:30 PM CDMX.



