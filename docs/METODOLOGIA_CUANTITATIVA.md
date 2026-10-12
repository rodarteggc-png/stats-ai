# 📐 Metodología Cuantitativa y Workflow Oficial — Stats-AI Pro

Este documento define el marco de reglas cuantitativas, modelos matemáticos por deporte y el flujo de trabajo operativo de Stats-AI Pro.

---

## 4.2 — PROBABILIDAD DE VICTORIA (Modelos separados por deporte)

### [SOLO BÉISBOL / MERCADOS 2 VÍAS] — Regresión y Log5
* **Regresión Bayesiana hacia la media con Prior $N=50, W=25$:**
  $$p_{A,\text{reg}} = \frac{\text{wins}_A + 25}{\text{games}_A + 50}, \quad p_{B,\text{reg}} = \frac{\text{wins}_B + 25}{\text{games}_B + 50}$$
* **Fórmula Log5 de Bill James (Campo Neutral):**
  $$p_{\text{neutral}} = \frac{p_A - (p_A \times p_B)}{p_A + p_B - 2(p_A \times p_B)}$$
* **Ventaja de Localía Dinámica ($\text{HFA}_{\text{dinámico}}$):**
  $$p_{\text{local}} = p_{\text{neutral}} + \text{HFA}_{\text{dinámico}} \quad (+0.02 \text{ a } +0.04 \text{ según factor de parque})$$
* **Ensamble:** 55% Matriz Sabermétrica (WHIP/FIP abridores, bullpen y OPS) + 45% Log5 Bayesiano.

### [SOLO FÚTBOL] — Conversión xG (Aproximación Poisson Dixon-Coles)
* **Prohibición de Log5:** Nunca usar Log5 en fútbol porque ignora la masa de empate.
* **Modelo Estructural:** xG esperado vs promedio de la liga para estimar fuerza de ataque/defensa. El modelo **DEBE contemplar probabilidad de EMPATE** (Dixon-Coles bivariado).
* **Fallback Asiático Vig-Free:** Si no hay modelo Poisson disponible, derivar la probabilidad real del mercado asiático (Hándicap 0 / Draw No Bet) removiendo el vig:
  $$\text{fairHome}_{\text{DNB}} = \frac{1/\text{odds}_H}{(1/\text{odds}_H) + (1/\text{odds}_A)}$$
  Reintegrar masa de empate ($\approx 26\%$ de la liga) para reconstruir el mercado 1X2.

---

## 4.7 — FILTRO DE VETO (MICROESTRUCTURA DE MERCADO)

Antes de confirmar el PICK, revisar movimiento de cuotas de apertura vs actuales.
* **REGLA DE VETO POR DRIFT:** Si el modelo dice "Apostar Local", pero la cuota del Local ha SUBIDO desde la apertura ($\ge 3.5\%$) o el mercado institucional está apostando al Visitante ($\text{awayDropPct} \ge 5.0\%$), **EL PICK SE CANCELA AUTOMÁTICAMENTE**.
* **Simetría:** Si el modelo dice "Apostar Visitante", pero la cuota del Visitante SUBIÓ ($\ge 3.5\%$) o la del Local cayó ($\ge 5.0\%$), **PICK CANCELADO**.
* **Principio Sharp:** *No peleamos contra el dinero inteligente ni contra el flujo de órdenes institucional.*

---

## 9.3 — TRAMPAS DE ESTADIOS EXTREMOS (Coors Field, Estadio Alfredo Harp Helú)

* **Prohibición de Overs Automáticos:** NO hay "Overs automáticos". El mercado ya ajustó la línea a la altitud por defecto (abriendo en 11.5, 12.0 o hasta 15.5 en CDMX).
* **Detección de Valor Contrario (Under Inflado):** Buscar el valor contrario (Unders) cuando la línea se infla irracionalmente por dinero público (ej. líneas de 12.5+ con viento soplando hacia adentro $\ge 7\text{ mph}$).
* **Principio Rector:** *Apostar la cuota y el precio, no la narrativa del estadio.*

---

## Fase 10 — HERRAMIENTAS PROPIAS Y GESTIÓN CUANTITATIVA

1. **Motores Estructurales Propios:**
   - Poisson Bivariado con corrección Dixon-Coles (`poisson.js`).
   - Sabermetría F5 y Log5 Bayesiano (`sabermetrics.js`).
   - Gridiron EPA Net y Números Clave (`gridiron.js`).
2. **Simulador Monte Carlo:** 10,000 iteraciones en Web Worker (`monteCarlo.js`).
3. **Detector RLM:** Análisis de apertura vs cierre y flujo de sindicatos (`rlmDetector.js`).
4. **Auditor Tipster Pro:** Filtros cualitativos de clima, fatiga, vestidor y microestructura (`tipsterAuditor.js`).
5. **Medición Obligatoria de CLV (Closing Line Value):**
   - El objetivo principal del sistema no es solo ganar la apuesta, es **GANARLE A LA LÍNEA DE CIERRE (vencer la cuota Pinnacle de cierre sin vig)**.
   - Fórmula:
     $$\text{CLV} = \left(\frac{\text{Cuota Apostada}}{\text{Cuota Cierre sin Vig}} - 1\right) \times 100$$
   - Si $\text{CLV} > 0$, la selección tiene valor esperado positivo comprobado independientemente de la varianza en cancha.

---

## Fase 11 — WORKFLOW INTEGRAL DE OPERACIÓN

1. **Extracción de Calendario y Cuotas de Apertura:** Ingestión de líneas DraftKings / The Odds API / ESPN.
2. **Cálculo de Probabilidad Estructural:** Modelos separados por deporte (Fase 4.2).
3. **Simulación Estocástica:** 10,000 mundos en Monte Carlo para medir Tail Risk.
4. **Filtro de Microestructura (Veto RLM / Drift):** Revisión de apertura vs actual (Fase 4.7).
5. **Auditoría Cualitativa Tipster Pro:** Clima, fatiga, incentivos y estadios extremos (Fase 9.3).
6. **Tribunal de Consenso 3v1:** Mínimo 2 de 3 votos aprobatorios requeridos.
7. **Calibración Bayesiana de Platt:** Ajuste sigmoide contra sesgos de cola.
8. **Asignación de Stake con Criterio de Kelly:** Quarter Kelly con límite estricto de banca.
9. **Despacho de Alerta Oficial:** Envío a canal VIP con radiografía cuantitativa.
10. **Persistencia en Cloud Ledger:** Almacenamiento comprimido resiliente a reinicios.
11. **POST-PARTIDO (Auditoría Forense y Cierre):**
    - El usuario registra el resultado Y la **Cuota de Cierre (Closing Line / Pinnacle)**.
    - Si la cuota de cierre sin vig fue menor a la cuota apostada ($\text{CLV} > 0$), **el sistema fue exitoso**, independientemente del resultado en la cancha.
    - En caso de fallo con CLV negativo, se genera un diagnóstico forense con IA y penalización correctiva en la memoria del equipo.
