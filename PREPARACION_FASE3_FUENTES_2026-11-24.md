# Preparación Fase 3 — Fuentes (Stats-AI Pro)

Fecha: 2026-11-24 ~16:00 CST · Alcance: auditoría de solo lectura + preparación. No se compró nada, no se cambió código, no se subió ni desplegó nada, no se tocó ningún ledger, no se pidió ni guardó ninguna llave. Clon de trabajo: `~/workspace/stats-ai-safe-tier`, HEAD `d38c3a7` (verificado en vivo en `/api/version`).

## 1. Estado en vivo por fuente

| Fuente | Qué cubre | Estado | Evidencia (2026-11-24) | Qué desbloquea al arreglarla |
|---|---|---|---|---|
| The Odds API | Cuotas sharp Pinnacle/Bet365 (NBA, NFL, NCAAF, MLB, fútbol) | **AGOTADA** | Pool 5 llaves, capacidad 2,500, uso 2,502 (−2) desde 2026-11-12; reset 1 dic (mes calendario, UTC). Verificado en código: `sportsApi.js:544` pide `regions=eu,us&markets=h2h,spreads,totals&bookmakers=pinnacle,bet365` = 6 créditos por llamada de deporte; capacidad = `keys.length × 500` (`sportsApi.js:508/515`). Sin llave viva, el 429 marca la llave como agotada en memoria y pasa a la siguiente; sin llaves sanas no hay cuota sharp. | Cuota sharp Pinnacle para deportes americanos; historial de cuotas (solo plan de pago) para llenar el CLV de los 37 picks ya cerrados; cuotas UWCL. |
| API-Sports | Fútbol (Pinnacle, casa 4) — único deporte que funciona en el plan Free | **SANA (última verificación; no re-verificable desde aquí hoy)** | Llave termina en 8205, plan Free hasta 2027-11-10, 100 req/día por llave, caché 3 h (~2–4 req/día para estado). Código lee `APISPORTS_KEYS` (plural, precedencia exclusiva) o `APISPORTS_KEY` (singular) en `apiSports.js:33/37`. API-NFL, API-NBA, API-Basketball y API-Baseball devolvieron errores de conexión el 2026-11-20 (no suscritos). No se pudo re-verificar hoy: `/api/quota` no respondió (ver §6) y la llave no es accesible desde aquí. | Nada pendiente: ya es la fuente sharp primaria de fútbol. El chequeo en vivo se hace con `/cuota` en Telegram (en proceso, sin CRON_SECRET). |
| PropLine | Props de jugador (DraftKings) + totales de equipo; respaldo de líneas | **INTEGRADA Y DESPLEGADA, PRUEBA EN VIVO SIN CONFIRMAR** | Llave en Vercel como `PROPLINE_API_KEY` (puesta por Tavo 2026-11-20). Plan gratis 1,000 req/día, sin tarjeta. Código: `propLine.js` base `https://api.prop-line.com/v1`, timeout 10 s, totalmente fail-safe (sin llave o con cualquier fallo devuelve `[]`/`null`, nunca lanza). Integración en `d51b31c`: `enrichMatchesWithPropLine` corre para NFL, MLB, NCAAF, NBA y fútbol (`alertEngine.js:4360-4364`); builder de props QB NFL (`player_pass_yds`) solo con precio PropLine + yardas por juego del equipo; totales de equipo adjuntos en `match.propLineTeamTotal` (sin picker todavía). Rerun manual 2026-11-21: 19 props QB con precio real, 1 aprobado. **Cero líneas LEDGER con `oddsSource: 'propline'` vistas hasta 2026-11-23.** | Confirmar el primer despacho real con precio PropLine (ver §4). |
| ESPN (gratis) | Cuotas DraftKings open/close (NBA/NFL/NCAAF/MLB por scoreboard; fútbol en summary, incluye empate) | **ACTIVA (no re-verificable desde aquí hoy)** | Sin llave ni cuota. Solo DraftKings (no Pinnacle); el "cierre" es la línea al momento de la consulta, así que hay que capturar ANTES del inicio. **No se pudo verificar en vivo en esta corrida: el dominio `site.api.espn.com` está bloqueado por política en este entorno** (browser.open rechazado; no se reintentó). Última verificación en vivo: 2026-11-24, corridas locales del motor con partidos UCL y cuotas DraftKings reales. | Nada pendiente: es la base de líneas. Su límite es estructural (solo DraftKings, sin Pinnacle, sin historial). |

Verificaciones en vivo de esta corrida: `/api/version` por curl — `d38c3a7`, producción, 2026-11-24T21:59:09Z. `/api/quota` por navegador — la lectura falló en el origen (sin estado HTTP); **no se pudo verificar en vivo hoy**; el mecanismo conocido es 503 por falta de `CRON_SECRET` (ver §6). ESPN no se pudo verificar hoy por bloqueo de dominio (ver tabla).

## 2. Huecos por deporte: quién da el precio sharp hoy

| Deporte | Precio sharp hoy | Qué falta |
|---|---|---|
| Fútbol | API-Sports (Pinnacle) ✅ primaria; PropLine respaldo ✅; ESPN DraftKings ✅ base | Odds API (agotada) como respaldo. **UWCL: sin llave de deporte en el código** — el mapeo (`sportsApi.js:617`) solo cubre la Champions varonil (`soccer_uefa_champs_league`); no existe mapeo para la femenil. UWCL hoy solo tiene cuotas DraftKings de ESPN. |
| NBA | Nadie ❌ | Odds API (Pinnacle) agotada. PropLine cubre líneas y props como respaldo; ESPN cubre DraftKings. Sin Pinnacle hasta 1 dic. |
| NFL | Nadie ❌ | Odds API (Pinnacle) agotada. PropLine cubre props QB + totales de equipo; ESPN cubre DraftKings. Sin Pinnacle hasta 1 dic. |
| NCAAF | Nadie ❌ | Igual que NFL. |
| MLB | Fuera de temporada (0 eventos) | Igual que NFL cuando vuelva la temporada. |

Prioridad de fuentes vigente (código): líneas de juego ESPN → Odds API (Pinnacle, cuando hay cuota) → PropLine (respaldo); fútbol sharp sigue en API-Sports; props y totales de equipo PropLine primaria, Odds API respaldo después del 1 dic. El enriquecimiento corre primero con Odds API (`enrichMatchesWithSharpOdds`) y después con PropLine; `resolveOddsProvenance` decide el tier final y el candado P4 admite `propline` con la misma regla de frescura de 15 min (`propLineFetchedAt`).

## 3. Checklist de compra 1 dic — plan The Odds API $30/mes

| Punto | Detalle |
|---|---|
| Qué comprar | Plan $30/mes de The Odds API: **20,000 créditos/mes**, reseteo el 1 de cada mes (UTC, no 30 días rodantes). |
| Consumo actual | ~230 créditos/día (registrado 10–13 nov). 6 créditos por llamada de deporte (3 mercados × 2 regiones). A ese ritmo: ~6,900/mes → el plan cubre **~2.9× el consumo actual**. Aun al doble de uso (460/día = 13,800/mes) sigue dentro de 20,000. |
| Qué desbloquea | Cuota sharp Pinnacle para NBA/NFL/NCAAF/MLB; respaldo sharp para fútbol; historial de cuotas (plan de pago) para llenar el CLV de los 37 picks ya cerrados (hoy imposible: el historial es solo de pago y el CLV de esos picks está en null); cuotas UWCL (ver paso siguiente). |
| Pregunta a resolver al comprar | Las 5 llaves actuales suman 2,500 (5 × 500 gratis). El plan de $30 es **por cuenta**: hay que confirmar en el checkout a qué cuenta/llave se le aplica el plan y si las demás llaves quedan en 500 gratis o se reemplazan. No asumir que las 5 llaves pasan a 20,000. |
| Paso 1 tras la compra | Verificar la cuota con `/cuota` en Telegram (en proceso, no necesita CRON_SECRET) y confirmar que el uso restante refleja los 20,000. Si `/api/quota` sigue en 503, es por S2 (§6), no por la compra. |
| Paso 2 (UWCL) | Confirmar la llave de deporte femenil con una llave viva: `GET https://api.the-odds-api.com/v4/sports/` y buscar la Champions femenil (la esperada es `soccer_uefa_champions_league_women`; **verificar, no asumir**). Luego un cambio de código: añadir el mapeo en `sportsApi.js:617` (liga con "women"/"femenil" → esa llave). Hoy ese mapeo no existe. |
| Paso 3 | Re-verificar un scan con cuota sharp americana (NBA/NFL/NCAAF) y confirmar que `oddsSource: 'market'` + `isPinnacle: true` vuelven a aparecer en las líneas LEDGER. |

## 4. Plan de verificación de la primera prueba real de PropLine

**Qué buscar en las líneas LEDGER del próximo scan** (el espejo de Telegram es el registro en producción; la línea LEDGER es un JSON por pick):

- `"oddsSource":"propline"` — es la señal inequívoca. Antes del R7 el código fabricaba `'market'`; desde `d38c3a7` un pick sin procedencia queda en `null`, así que `propline` solo aparece si el precio vino de PropLine.
- Para props QB: el texto del pick muestra jugador y línea (ej. "Baker Mayfield Menos de 215.5 yardas") y el tipo es player prop. `propMeta` (jugador/mercado/línea/lado) **no** se escribe en el ledger; solo el texto del pick y `oddsSource`.
- `sharpBook` / `isPinnacle`: en picks PropLine quedan en `null`/`false` (PropLine trae DraftKings, no Pinnacle) — no es un fallo.
- Totales de equipo: **no esperarlos como picks** — no existe picker todavía; solo van adjuntos al partido (`match.propLineTeamTotal`).

**Cuándo puede aparecer:** el próximo scan que cubra partidos NFL/NCAAF con props disponibles (turno 23:00 de viernes/sábado o 15:30 de fin de semana). Hoy (martes 24 nov) no hay NFL, así que no es esperable hoy. La primera oportunidad real es el fin de semana del 28–29 nov.

**Si no aparece:**
1. Descartar lo normal primero: que el builder no tuvo precio PropLine para ese partido, o que los props generados murieron en candados normales (`ev_below_min`, `consensus_votes`, `rlm_trap`) y no por la cuota. Eso significa que PropLine funcionó pero el pick no pasó, no que PropLine falló.
2. Revisar los logs de Vercel del scan buscando errores de PropLine (timeout 10 s, `fetchPropLineJson` → null).
3. Verificar que `PROPLINE_API_KEY` sigue configurada en Vercel (Tavo la puso el 2026-11-20; si se borró o rotó, el fetcher devuelve `[]` en silencio por diseño fail-safe).
4. Correr el diagnóstico local (como el rerun del 2026-11-21) para confirmar que el enriquecimiento sigue adjuntando precios; si adjunta en local y no en producción, el problema es la llave en Vercel, no el código.

## 5. Hueco de la captura de cierre (CLV)

**El hueco, verificado:** el cron corre `scripts/captureClosingOdds.mjs` en `~/workspace/stats-ai-repo`, cuyo ledger local tiene **38 líneas** (37 cerrados + 1 PENDING) frente a **64 picks** en GitHub (clon safe-tier, HEAD `d38c3a7`). El único PENDING es el prop de Krstovic (Atalanta vs Parma, 2 nov, cuota 1.65, prob 84.4) — partido ya jugado, así que `duePicks` (PENDING con inicio en el futuro) es **0 en cada corrida**. Los picks despachados son invisibles para la captura salvo que Tavo pegue las líneas LEDGER.

| Opción | Qué implica | Pros | Contras / qué requiere de Tavo |
|---|---|---|---|
| A. Seguir como hoy (Tavo pega las líneas LEDGER) | Sin cambio de código. | Funciona hoy; cero riesgo. | Manual; depende de Tavo; el CLV del 17 nov ya se perdió y se seguirá perdiendo si no se pega a tiempo. |
| B. Copiar el ledger actual (64 líneas) al clon del cron | Una copia manual del ledger del clon safe-tier (HEAD actual) a `~/workspace/stats-ai-repo`. | La captura vería los 64 picks y sus PENDING reales. | Se vuelve a desactualizar con el siguiente despacho (Vercel no escribe de vuelta). Hay que repetirlo. **No copiar el ledger del clon fix-batch** (obsoleto, ~43 archivos modificados). Y el contexto de la tarea del cron dice que solo el script de captura toca el ledger: la copia sería una acción manual aparte, no del cron. |
| C. Que el script lea el ledger desde GitHub | Cambio de código en `captureClosingOdds.mjs`: leer `data/pick_ledger.jsonl` desde el repo público de GitHub (sin autenticación) en vez del archivo local, y seguir escribiendo los cierres en `data/closing_ledger.jsonl` local. | Arregla el hueco de raíz y para siempre: cada corrida ve el ledger actual sin copias manuales. | Requiere un cambio de código + aprobación de Tavo (el cron es suyo y su contexto limita qué toca el ledger). La captura seguiría sin ver picks despachados hace más de la ventana si no se corre a tiempo. |
| D. Que el script lea el espejo de Telegram | El script leería las líneas LEDGER del canal espejo vía API de Telegram. | Usa el registro de producción tal cual. | Cambio grande: necesita el token del bot en el entorno local, paginación del historial y parseo. Más frágil que C. |
| E. Aceptar el hueco | No hacer nada. | Cero esfuerzo. | Sin CLV medible: el sistema no puede demostrar que bate el cierre, que es la métrica que separa un tipster real de uno que no. |

**Recomendación:** C es la correcta a largo plazo; B es el parche inmediato si se quiere CLV en los próximos scans; A sigue siendo el respaldo. **No re-activar GitHub Actions** (decisión de Tavo 2026-11-13).

## 6. S2 — `PORTAL_ACCESS_TOKEN` + `CRON_SECRET` (Vercel)

**Qué desbloquea:**
- `CRON_SECRET`: `/api/quota` deja de dar 503 y responde con la cuota real (con `Authorization: Bearer <CRON_SECRET>`); `/api/scan` pasa de fail-open a exigir el Bearer (seguridad real del endpoint que dispara los scans).
- `PORTAL_ACCESS_TOKEN`: el proxy `/api/gemini` del portal web (el simulador) vuelve a funcionar con el token del portal (`x-portal-token`).

**Estado verificado en código:** `api/scan.js:10` usa `requireCronAuth` (fail-open si no hay secreto); `api/_lib/security.js:35-38` `requireCronAuthStrict` da **503 si `CRON_SECRET` no está configurada** (es el 503 actual de `/api/quota`); `api/quota.js` solo se consulta a mano con el Bearer o vía `/cuota` en Telegram (que calcula en proceso y **no** necesita el secreto — esa es la vía que funciona hoy).

**Pasos exactos para Tavo en Vercel (proyecto stats-ai-pi → Settings → Environment Variables):**
1. Crear `CRON_SECRET` con un valor aleatorio largo (generador de contraseñas) en Production (y Preview/Development si quiere).
2. Crear `PORTAL_ACCESS_TOKEN` con otro valor aleatorio largo, mismo sitio.
3. Redeploy (Deployments → Redeploy del último despliegue, o un push).
4. En el navegador donde usa el portal, poner el valor de `PORTAL_ACCESS_TOKEN` en `localStorage` como `fstats_portal_token` (el simulador lo lee de ahí).

**Advertencia (orden importa):** al crear `CRON_SECRET`, `/api/scan` empieza a exigir el Bearer. Si el trabajo de cron-job.org no lleva el header, los scans devuelven **401 y no se despacha nada**. El orden seguro es: **primero** añadir el header `Authorization: Bearer <CRON_SECRET>` al trabajo de cron-job.org (mientras el secreto no exista el header se ignora, fail-open), **después** crear el secreto en Vercel y redeplegar. Así no hay ventana sin scans.

## 7. Qué se puede hacer ahora vs qué espera al 1 dic vs qué necesita a Tavo

| Cuándo | Acción |
|---|---|
| **AHORA (antes del 1 dic)** | 1. Verificación PropLine: vigilar el próximo scan de fin de semana y buscar `"oddsSource":"propline"` en las líneas LEDGER (§4). 2. Decidir la opción del hueco de captura (§5: parche B o diseño C). 3. Confirmar con `/cuota` en Telegram el estado de API-Sports (única vía que funciona sin CRON_SECRET). 4. Vigilar los scans con el código afinado (la validación en vivo de la Fase 2). |
| **1 DIC** | 5. Comprar el plan The Odds API $30/mes (20,000 créditos) y resolver a qué cuenta/llave aplica (§3). 6. Confirmar la llave de deporte UWCL vía `GET /v4/sports` y añadir su mapeo en código. 7. Re-verificar `/cuota` y un scan con cuota sharp americana (`oddsSource: 'market'`, `isPinnacle: true`). |
| **NECESITA A TAVO (Vercel / su cuenta)** | Comprar el plan $30 (su cuenta y su pago); crear `CRON_SECRET` + `PORTAL_ACCESS_TOKEN` en Vercel y redeplegar; añadir el header Bearer al trabajo de cron-job.org **antes** del redeploy; verificar que `PROPLINE_API_KEY` sigue en Vercel si la prueba en vivo no aparece; pegar líneas LEDGER si se sigue la opción A de captura. |

## Pendientes que NO se resuelven en esta fase

- Revocación de la llave vieja de Gemini en AI Studio (pendiente desde 2026-11-10; solo Tavo puede hacerlo; la llave sigue viva en Google).
- Auditoría de acceso Vercel/Telegram (C1).
- Watchdog externo para cron-job.org (pasos pendientes de entregar a Tavo).
- Decisión del plan de respaldo si el $30/mes no alcanza (TheRundown Starter $49/mes recomendado; Tavo no ha elegido).
