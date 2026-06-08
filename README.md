# Sistema de Inteligencia Predictiva para Urgencias Médicas en México

Análisis y pronóstico de **31.2 millones de atenciones de urgencia** en 969 unidades médicas mexicanas (2017–2022), con un modelo de Machine Learning entrenado para anticipar demanda hospitalaria a 7–14 días.

> **Demo en vivo:** [luisrobledoit.github.io/PulsoMX](https://luisrobledoit.github.io/PulsoMX/)
>
> **Autor:** [Luis Robledo](https://www.linkedin.com/in/luisrobledoit/) — aspirante a la beca SECIHTI 2026 para el _Máster Universitario en Aplicaciones de la Inteligencia Artificial a la Industria y Comunicaciones_ (M219) en la Universidad de Alcalá.

---

## ¿Por qué importa este proyecto?

Después del COVID, la saturación de servicios de urgencias quedó como una de las heridas estructurales más visibles del sistema de salud mexicano. El problema no es solo de inversión: es de **anticipación**. Los hospitales no saben con certeza cuántos pacientes recibirán mañana, qué perfil tendrán, ni cómo cambia la demanda con la estación o el clima.

Este proyecto demuestra que con **datos abiertos**, herramientas modernas y un modelo de IA bien entrenado, es posible:

- Visualizar en un mapa interactivo la operación de 969 unidades médicas
- Identificar los patrones epidemiológicos estacionales reales del país
- **Pronosticar la demanda esperada por unidad médica** con un horizonte útil para planeación operativa
- Hacer todo esto **abierto, reproducible y desplegable a costo cero** en GitHub Pages

---

## Lo que encontrarás en el dashboard

### 1. Mapa nacional de unidades médicas
Las 969 CLUES (Clave Única de Establecimientos de Salud) representadas como puntos cuyo tamaño refleja el volumen de atenciones. Clustering automático al hacer zoom.

### 2. KPIs en tiempo real con filtros multi-select
- Estado, diagnóstico CIE-10, año, sexo, grupo de edad
- Insight banner dinámico que cambia según los filtros aplicados

### 3. Análisis temporal con impacto COVID visible
La serie diaria muestra con claridad la caída brusca de marzo 2020 y la recuperación gradual hasta 2022.

### 4. Pirámide demográfica y estacionalidad por capítulo CIE-10
- Distribución por edad y sexo
- Cómo varían las enfermedades infecciosas, respiratorias y crónicas mes a mes

### 5. Modelo de pronóstico (LightGBM)
Sección dedicada donde el usuario elige unidad médica, fecha y horizonte, y recibe la predicción con intervalo de confianza al 80%.

---

## Arquitectura técnica

```
┌─────────────────────┐
│ urgenciascomplete   │  11.4 GB · 31.2M filas CSV
│ .csv                │
└──────────┬──────────┘
           │
           ▼ polars (lazy streaming)
┌─────────────────────┐
│ preprocess.py       │  Escanea los 11 GB en ~60 segundos
│                     │  Asignación de estado por nearest-centroid
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────────────┐
│ data/                                            │
│  ├─ meta.json              KPIs ejecutivos       │
│  ├─ clues_meta.json        969 unidades + geo    │
│  ├─ daily_national.json    Serie 2017–2022       │
│  ├─ top_diagnoses.json     Top 80 CIE-10         │
│  ├─ demographics.json      Pirámide edad×sexo    │
│  ├─ seasonal.json          Mes × capítulo CIE    │
│  ├─ state_aggregates.json  32 entidades          │
│  ├─ daily_by_clue.parquet  Input del modelo (8MB)│
│  ├─ model_metrics.json     MAPE, RMSE, features  │
│  └─ predictions.json       Top 50 CLUES × 2022   │
└─────────────────────┬───────────────────────────┘
                      │
                      ├──► train_model.py  (LightGBM)
                      │
                      └──► index.html  (Chart.js + Leaflet)
```

### Stack
- **Procesamiento:** Polars (lazy streaming) — escanea 11 GB en ~60s
- **Modelo:** LightGBM con features de tiempo, lags, rolling means y variables climáticas pre-procesadas (longitud del día, índices estacionales)
- **Frontend:** HTML + JavaScript vanilla + Chart.js 4 + Leaflet (sin frameworks)
- **Despliegue:** GitHub Pages (estático, costo cero, soporta tráfico orgánico ilimitado)

### Modelo: validación temporal honesta

| Split | Periodo | Filas |
|---|---|---|
| Train | 2017–2020 | 648,013 |
| Validación | 2021 | 234,580 |
| Test | 2022 | 212,248 |

Se filtró a **794 CLUES** (de 969) con volumen útil — unidades con menos de 5 atenciones/día promedio aportan más ruido que señal al modelo.

#### Resultados en test 2022 (datos que el modelo nunca vio)

| Métrica | Validación 2021 | Test 2022 |
|---|---:|---:|
| **WMAPE** (métrica principal) | 23.91% | **22.24%** |
| MAE | 5.11 | 5.82 atenciones/día |
| RMSE | 8.48 | 9.77 |
| MAPE | 51.87% | 48.51% |

**¿Por qué WMAPE y no MAPE?** El MAPE clásico explota cuando hay días con pocos casos (errores absolutos pequeños se vuelven porcentajes enormes). WMAPE pondera por volumen real — refleja el impacto operativo verdadero del error. Es la métrica estándar en pronóstico de demanda en retail, energía y salud.

#### Features más importantes (según ganancia LightGBM)

1. `clues_id` (identidad de la unidad) — el efecto fijo por hospital domina
2. `lag_1` (atenciones de ayer)
3. `doy` (día del año — captura estacionalidad)
4. `lag_28`, `lag_7`, `lag_14` (semanalidad y mensualidad)
5. `roll_7` (tendencia reciente)

Esto confirma que el modelo aprende lo que la intuición epidemiológica predice: identidad del hospital + memoria reciente + ciclos estacionales.

### Features (16 total)
- **Temporales:** day-of-week, mes, day-of-year, año, is_weekend
- **Lags:** t-1, t-7, t-14, t-28 (último día, semana, dos semanas, mes)
- **Rolling:** media móvil 7d, 14d, 30d + desviación std 14d
- **Geo/clima:** ID de unidad médica, longitud del día, índice estacional `sf_msd`

---

## Cómo reproducir este proyecto

```bash
# 1. Clonar
git clone https://github.com/TU-USUARIO/emergencias-mexico-ia.git
cd emergencias-mexico-ia

# 2. Instalar
pip install polars lightgbm pyarrow scikit-learn

# 3. Pre-procesar (≈ 1 minuto con polars streaming)
python preprocess.py

# 4. Entrenar modelo (≈ 5-10 minutos)
python train_model.py

# 5. Servir dashboard
python -m http.server 8000
# Abrir http://localhost:8000
```

> El CSV fuente (11.4 GB) no se incluye en el repo por tamaño. Los datos provienen del **Sector Salud Federal mexicano** (datos abiertos).

---

## Hallazgos relevantes

1. **CDMX concentra el 15.7% de las atenciones** con 87 unidades médicas — la mayor densidad del país
2. **Guanajuato sigue de cerca con 11.2%** y solo 56 unidades — alta carga por unidad
3. **Las urgencias caen visible mente en marzo-abril 2020** (inicio de la pandemia) y nunca regresan exactamente al nivel pre-COVID
4. **El 68% de las urgencias son atendidas a mujeres**, en gran parte por causas obstétricas (capítulo O del CIE-10)
5. **Las infecciones respiratorias (capítulos J) muestran el patrón estacional más marcado** — picos invernales claros

---

## Sobre este proyecto y la beca SECIHTI

Soy aspirante a la **beca SECIHTI** para cursar el _Máster en Aplicaciones de IA a la Industria y Comunicaciones_ en la **Universidad de Alcalá** durante 2026.

Este dashboard no es un proyecto académico abstracto: es una prueba de concepto de cómo la **IA aplicada a la industria** —en este caso, salud pública— puede generar herramientas operativas reales sin depender de infraestructura cara ni de licencias propietarias.

Mi compromiso al regresar a México es escalar este tipo de proyectos en colaboración con instituciones del sector público y privado que ya están dando pasos hacia la transformación digital.

**Si trabajas en salud pública, ciencia de datos o IA aplicada — conectemos:**
- LinkedIn: [linkedin.com/in/luisrobledoit](https://www.linkedin.com/in/luisrobledoit/)

---

## Limitaciones honestas

- La asignación de estado por **nearest-centroid** sobre lat/long es una aproximación; un GeoJSON oficial daría mejor precisión
- El modelo de pronóstico es **point estimate + intervalo paramétrico** (no probabilístico bayesiano completo)
- El dashboard utiliza **pre-agregados** para ser servible estáticamente; un backend con queries en vivo permitiría cruces arbitrarios
- Las predicciones del dashboard son **pre-computadas para 50 unidades** (top por volumen); en producción se servirían vía API

---

## Licencia

MIT — Úsalo, modifícalo y compártelo libremente. Si te sirve para investigación, planeación pública o como portfolio piece, una mención es bienvenida pero no obligatoria.
