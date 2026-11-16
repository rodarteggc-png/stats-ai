# Diseño: recuperación del récord — cloud ledger → `data/pick_ledger.jsonl`

**Estado: SOLO DISEÑO (lote 2, S4). No implementado. No se ha leído Telegram
(no hay token disponible) ni tocado el ledger real.**

Fecha: 2026-11-16. Autor: Muse (subagente lote 2).

## 1. El problema

El récord verificado está congelado en **38 picks** (37 cerrados, 1 pendiente:
prop Krstovic, 2026-11-02). Los picks despachados el **11 y 12 de noviembre**
nunca entraron a `data/pick_ledger.jsonl` porque:

- El disco de Vercel es de solo lectura: el ledger del deploy no persiste.
- El único registro autoritativo de picks reales es el espejo del canal de
  Telegram (`LEDGER {json}`), y esas líneas nunca se entregaron.
- Tavo cerró ese camino el 2026-11-13: *"el ledger olvídalo, ya lo perdí"*.
  **No volver a pedir las líneas LEDGER.**

Consecuencia: freno de drawdown ciego (lee el ledger congelado), CLV n=0,
captura de cierre sin nada que capturar, y el aprendizaje sin datos nuevos.

## 2. Fuentes de recuperación disponibles (sin pedir nada nuevo)

### Fuente A — Cloud ledger del bot (la que diseña este documento)

El bot guarda su caché de picks enviados en sus propios comandos de Telegram:

- `loadCloudLedger()` / `saveCloudLedger()` en `scripts/alertEngine.js:560/616`.
- Mecanismo: `GET https://api.telegram.org/bot<TOKEN>/getMyCommands?language_code=eo`
  (`CLOUD_LANG_CODE = 'eo'`, línea 88). Los comandos `s_0…s_N` llevan en su
  `description` fragmentos base64 (ordenados por sufijo numérico) que,
  concatenados, son un JSON comprimido con `zlib.inflateRawSync`.
- Cada entrada es un `sentCache` por id de pick con: `id, sport, league, type,
  game, gameDate, pick, prob, rawProb, odds, stakeUnits, homeName, awayName,
  argument, votesPassed, source, dispatchedToTelegram, status, audited,
  reportedInTelegram, timestamp` (+ desde el lote 1/2: `ratingsSource`,
  `oddsSource, oddsProvider, evNoVig, fairOdds`).
- **Límites que condicionan el diseño:**
  - `pruneCache()` (línea 707): conserva solo los últimos **8 días** y
    descarta entradas auditadas en silencio para que el payload quepa en
    **95 comandos × 250 caracteres ≈ 23,7 KB** base64.
  - Hoy es 2026-11-16: los picks del 11–12 de noviembre tienen 4–5 días,
    **dentro de la ventana de 8 días**, pero cada turno nuevo y cada
    auditoría pueden podarlos. **La ventana se cierra ~19–20 de noviembre.**
  - El cloud ledger **no guarda** el resultado del partido ni la cuota de
    cierre; solo guarda `status` (`pending`/`audited`) y `audited`.

### Fuente B — Canal espejo LEDGER (ya existe el importador, cerrado por Tavo)

- `mirrorLedgerEntryToTelegram()` (`alertEngine.js:447`) escribe
  `LEDGER {json}` en `TELEGRAM_LEDGER_CHAT_ID` por cada pick real.
- `scripts/realImport.mjs` (`npm run ledger:import`) ya sabe leer esas líneas
  y fusionarlas append-only. **No se usa porque Tavo dijo que las perdió.**
  Si alguna vez aparecen, el importador está listo; no hay que construir nada.

### Fuente C — Reconstrucción desde mensajes pegados (en curso, fuera de este diseño)

- Tavo pegó el 2026-11-16 los 5 slates del 9–13 nov. La reconstrucción corre
  en `~/workspace/stats-ai-recovered-picks-2026-11-09_13.jsonl` (archivo
  separado, **sin tocar el ledger real**), calificando con ESPN por curl.
- Los mensajes traen fecha, deporte, equipos, mercado, línea, cuota, prob y
  stake (salvo el resumen del 12 vespertino y el del 13, sin prob/stake).
- Este diseño **no duplica** esa vía: si la reconstrucción C produce picks
  verificados, entran al ledger por el mismo merge append-only (§4), con
  `source: 'recovered-telegram'` para distinguirlos del cloud ledger.

## 3. Qué leería el sync (Fuente A)

Un script nuevo, p. ej. `scripts/recoverFromCloud.mjs` (no creado en este lote),
que:

1. **Lee el cloud ledger** reutilizando `loadCloudLedger()` tal cual (no
   reimplementar el protocolo `s_`): necesita `TELEGRAM_BOT_TOKEN` en el
   entorno. Es la única credencial que necesita, y solo de lectura
   (`getMyCommands` no modifica nada).
2. **Lee el ledger local** `data/pick_ledger.jsonl` y construye el conjunto
   de ids existentes.
3. **Compara por id**: todo id del cloud que no esté en el ledger local es
   candidato a recuperar. Los ids ya presentes **no se tocan jamás**.
4. **Clasifica cada candidato**:
   - `audited: true` en el cloud → el pick ya fue calificado por el Corte
     (tiene `status` y resultado implícito en el flujo de auditoría, pero
     **el cloud no guarda W/L ni marcador**). Para estos, el sync solo puede
     registrar el pick como **PENDING** con `source: 'cloud-ledger'` y dejar
     que `scripts/gradeLedger.mjs` lo califique después contra ESPN (el
     grader ya sabe calificar por fecha+equipos; los props de jugador quedan
     PENDING para siempre, como Krstovic).
   - `audited: false` / `status: 'pending'` → candidato directo, mismo
     tratamiento: se registra PENDING y lo califica el grader.
5. **Escribe un reporte** (`data/recovery_report.json` + `.md`) con, por
   candidato: id, fecha, deporte, pick, cuota, stake, `oddsSource` y si el
   grader lo pudo calificar. **Nunca escribe al ledger sin `--apply`.**
   El modo por defecto es `--dry-run`: solo informe.

## 4. Cómo fusionaría sin tocar las líneas existentes

Reglas inviolables (las mismas que `realImport.mjs`):

1. **Append-only**: el script solo añade líneas nuevas al final de
   `data/pick_ledger.jsonl`. Nunca reescribe, reordena ni edita una línea
   existente. Verificación previa: hash del archivo antes y después; si
   cambia cualquier byte de las líneas viejas, abortar.
2. **Dedup por id**: si el id ya existe en el ledger, se salta (y se reporta
   como `already-present`).
3. **Campos que el cloud NO tiene y cómo se rellenan**:
   - `result` / `profitUnits`: no se inventan. El pick entra `PENDING` y lo
     califica `gradeLedger.mjs` (ESPN scoreboard, gratis). Si el grader no
     puede calificarlo (prop de jugador, partido sin marcador), queda
     `PENDING` y se reporta como tal.
   - `closingOdds` / `clvPct`: `null` (la captura de cierre no corría esos
     días; no se reconstruye un cierre que no existe).
   - `oddsSource` / `oddsProvider`: se copian del cloud si existen (lote 2);
     si no existen (picks anteriores al lote 2), se dejan en `null` con
     `oddsSourceNote: 'unknown-pre-lot2'` — nunca se afirma `'market'`
     sin evidencia.
   - `timestamp`: el del cloud (`sentCache.timestamp`).
4. **Idempotencia**: correr el sync dos veces no duplica nada (dedup por id).
5. **El sync no toca el cloud ledger**: solo lee (`getMyCommands`). No llama
   a `saveCloudLedger`, no reordena comandos, no escribe en Telegram.

## 5. Riesgos y límites honestos

- **La ventana se está cerrando**: `pruneCache` borra entradas de más de 8
  días y poda auditadas para caber en ~23,7 KB. Los picks del 11–12 nov
  pueden ya no estar si el caché se llenó con los turnos del 13–16 nov.
  **Si el sync se ejecuta y el cloud ya no los tiene, la Fuente A está
  muerta** y solo queda la Fuente C (reconstrucción desde mensajes).
- **El cloud no guarda resultados**: incluso recuperando los picks, el W/L
  depende del grader ESPN. Partidos del 11–12 nov: el grader los califica
  por scoreboard (funciona días después), salvo props de jugador.
- **El cloud puede no tener los picks del 11–12 nov aunque estén en ventana**:
  si esos turnos se despacharon con el código viejo y el caché local de la
  instancia se perdió antes de persistir, nunca llegaron a la nube. No hay
  forma de saberlo sin leer el cloud (un `getMyCommands`).
- **No recupera el 9–10 nov**: esos picks sí están en el ledger (el último
  es del 2 nov… en realidad el ledger cubre hasta el 2 nov; los del 9–10 nov
  tampoco están). La Fuente C es la única que cubre 9–10 nov.
- **La cuota del cloud es la publicada, no el cierre**: el CLV de esos picks
  quedará en `null` salvo que exista captura de cierre (no existe).

## 6. Lo que se necesita de Tavo (una sola vez)

**Opción 1 (recomendada, 2 minutos, sin instalar nada):**
compartir el token del bot **una sola vez, por el canal que él elija**, para
ejecutar el sync en local. Uso: solo `GET getMyCommands` (lectura). El token
**no se guarda** en ningún archivo, no se commitea y no se reutiliza después
del sync. (Es el mismo procedimiento transitorio que ya se usó el 2026-11-16
para reparar el webhook.)

**Opción 2 (sin compartir el token):**
que Tavo (o quien tenga el bot) ejecute en su máquina:
`TELEGRAM_BOT_TOKEN=<token> node scripts/recoverFromCloud.mjs --dry-run`
y comparta el `data/recovery_report.md` resultante. El script aún no existe;
se construye cuando Tavo elija la opción.

**Lo que NO se necesita:** las líneas LEDGER del canal (cerrado el 13 nov),
acceso a Vercel, ni cambios en el bot.

## 7. Secuencia propuesta (cuando Tavo lo apruebe)

1. Construir `scripts/recoverFromCloud.mjs` + tests (reutiliza
   `loadCloudLedger` y el merge append-only de `realImport.mjs`).
2. `--dry-run` con el token (opción 1) o con el reporte de Tavo (opción 2):
   listar candidatos y qué calificaría el grader. **Revisión de Tavo.**
3. `--apply`: append-only al ledger + correr `gradeLedger.mjs` sobre los
   nuevos PENDING.
4. Verificar: `npm run ledger:report` (el récord debe crecer solo con los
   picks recuperados y calificados; el resto queda PENDING y visible).
5. Si la Fuente A viene vacía, el informe lo dice y se sigue solo con la
   Fuente C.

## 8. Decisión pendiente

Tavo debe elegir **Opción 1 o Opción 2** (o rechazar la recuperación y dejar
el récord en 38 picks con el hueco del 11–12 nov como permanente). **Sin el
token no se puede ni siquiera comprobar si el cloud todavía tiene los picks**:
el `--dry-run` es el primer paso y no escribe nada.
