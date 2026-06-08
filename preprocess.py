"""
Preprocesa urgenciascomplete.csv (11.4 GB, 31.2M filas) y genera agregados
para alimentar el dashboard y el modelo de pronóstico.

Outputs (carpeta data/):
  - clues_meta.json         Metadata de las 969 unidades médicas
  - daily_national.json     Total nacional por día (tendencia, impacto COVID)
  - top_diagnoses.json      Top 60 diagnósticos CIE-10 + perfil demográfico
  - demographics.json       Pirámide de edad por sexo
  - seasonal.json           Patrones mes × diagnóstico
  - state_aggregates.json   Agregados por estado mexicano
  - daily_by_clue.parquet   Serie diaria por unidad médica (input del modelo)
  - meta.json               Resumen ejecutivo (KPIs)
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import polars as pl

sys.stdout.reconfigure(encoding="utf-8")

SRC = Path("C:/Users/Luminous/Desktop/Workspace/ML  dashboard Emergencias/urgenciascomplete.csv")
OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)


# ─── Reparación de mojibake ───────────────────────────────────────────────
# El CSV tiene filas con doble codificación: la vocal acentuada se reportó
# como "ã" + byte de control donde el byte es el código Latin-1 de la
# mayúscula con tilde MENOS 0x40 (artefacto de un sistema legacy del IMSS).
# Patrón: 0xC1 (Á) → 0x81, 0xD3 (Ó) → 0x93, etc.
MOJIBAKE_MAP_KEYS = [
    "ã\x81", "ã\x82", "ã\x89", "ã\x8a",
    "ã\x8d", "ã\x91", "ã\x93", "ã\x94",
    "ã\x9a", "ã\x9c",
]
MOJIBAKE_MAP_VALS = ["á", "â", "é", "ê", "í", "ñ", "ó", "ô", "ú", "ü"]


# ─── Asignación de estado por bounding box ────────────────────────────────
# Bounding boxes aproximados de los 32 estados mexicanos.
# Para puntos en zona de traslape se asigna por proximidad al centroide.
STATE_BBOX = {
    "AGUASCALIENTES": (21.65, 22.45, -102.86, -101.85),
    "BAJA CALIFORNIA": (28.0, 32.72, -117.30, -112.75),
    "BAJA CALIFORNIA SUR": (22.87, 28.05, -115.20, -109.40),
    "CAMPECHE": (17.81, 20.85, -92.50, -89.10),
    "CHIAPAS": (14.53, 17.99, -94.16, -90.37),
    "CHIHUAHUA": (25.55, 31.78, -109.07, -103.30),
    "CIUDAD DE MEXICO": (19.05, 19.59, -99.36, -98.94),
    "COAHUILA": (24.55, 29.88, -103.96, -99.84),
    "COLIMA": (18.69, 19.52, -104.71, -103.46),
    "DURANGO": (22.33, 26.83, -107.18, -102.46),
    "GUANAJUATO": (19.91, 21.85, -102.08, -99.68),
    "GUERRERO": (16.30, 18.92, -102.20, -98.00),
    "HIDALGO": (19.66, 21.40, -99.86, -97.96),
    "JALISCO": (18.92, 22.75, -105.70, -101.50),
    "MEXICO": (18.36, 20.29, -100.59, -98.61),
    "MICHOACAN": (17.91, 20.39, -103.74, -100.06),
    "MORELOS": (18.33, 19.13, -99.51, -98.62),
    "NAYARIT": (20.62, 23.08, -105.74, -103.71),
    "NUEVO LEON": (23.18, 27.81, -101.20, -98.43),
    "OAXACA": (15.65, 18.66, -98.53, -93.86),
    "PUEBLA": (17.90, 20.84, -99.07, -96.71),
    "QUERETARO": (20.02, 21.67, -100.59, -99.04),
    "QUINTANA ROO": (17.88, 21.61, -89.50, -86.71),
    "SAN LUIS POTOSI": (21.16, 24.53, -102.30, -98.32),
    "SINALOA": (22.47, 27.04, -109.45, -105.39),
    "SONORA": (26.32, 32.49, -115.06, -108.42),
    "TABASCO": (17.25, 18.65, -94.13, -91.00),
    "TAMAULIPAS": (22.21, 27.68, -100.15, -97.13),
    "TLAXCALA": (19.05, 19.72, -98.71, -97.62),
    "VERACRUZ": (17.15, 22.46, -98.65, -93.61),
    "YUCATAN": (19.55, 21.62, -90.42, -87.53),
    "ZACATECAS": (21.04, 25.13, -104.36, -100.81),
}


def assign_state_expr() -> pl.Expr:
    """Asigna estado al centroide más cercano (entre los bboxes definidos).

    El enfoque secuencial por bbox falla cuando los rectángulos se solapan
    (Veracruz captura Puebla, Hidalgo, etc.). Usar el centroide más cercano
    da una asignación más fiel a la realidad geográfica mexicana.
    """
    # Calcular distancia al centroide de cada estado
    dist_cols = []
    for state, (lat_min, lat_max, long_min, long_max) in STATE_BBOX.items():
        c_lat = (lat_min + lat_max) / 2
        c_long = (long_min + long_max) / 2
        dist_cols.append(
            ((pl.col("lat") - c_lat) ** 2 + (pl.col("long") - c_long) ** 2)
            .alias(f"_d_{state}")
        )
    # Construir expresión: la columna con menor distancia gana
    # Encadenamos when/then comparando contra todas las demás
    states = list(STATE_BBOX.keys())
    # Para evitar O(n^2), usamos un truco: stack las distancias y argmin manual
    expr = pl.lit(states[0])
    min_so_far = pl.col(f"_d_{states[0]}")
    for s in states[1:]:
        d = pl.col(f"_d_{s}")
        expr = pl.when(d < min_so_far).then(pl.lit(s)).otherwise(expr)
        min_so_far = pl.min_horizontal(min_so_far, d)
    return expr.alias("estado"), dist_cols


def main() -> None:
    t0 = time.time()
    print(f"Leyendo {SRC.name} (11.4 GB) con polars lazy scan…")

    # Solo columnas que necesitamos — reduce I/O dramáticamente
    cols = [
        "ID", "CLUES", "date_st", "HORASESTANCIA", "age", "SEXO",
        "AFECPRIN", "desc", "lat", "long", "year", "dayofyear",
        "lengthofday", "sf_msd",
    ]
    lf = pl.scan_csv(SRC, infer_schema_length=10000, ignore_errors=True).select(cols)

    # Limpieza base y parsing de fecha (sin estado todavía)
    lf = (
        lf.with_columns([
            pl.col("date_st").str.slice(0, 10).str.strptime(pl.Date, "%Y-%m-%d", strict=False).alias("fecha"),
            pl.col("age").clip(0, 110),
            pl.col("HORASESTANCIA").clip(0, 720),
            # Reparar mojibake: reemplazo de patrones "ã" + byte → vocal acentuada
            pl.col("desc").str.replace_many(MOJIBAKE_MAP_KEYS, MOJIBAKE_MAP_VALS),
        ])
        .with_columns(
            # Capitalizar primera letra de la descripción
            (
                pl.col("desc").str.slice(0, 1).str.to_uppercase()
                + pl.col("desc").str.slice(1)
            ).alias("desc")
        )
        .filter(pl.col("fecha").is_not_null())
        .filter(pl.col("lat").is_between(14.0, 33.0))
        .filter(pl.col("long").is_between(-118.0, -86.0))
        .with_columns([
            pl.col("fecha").dt.month().alias("mes"),
            pl.col("fecha").dt.weekday().alias("dow"),
            pl.col("AFECPRIN").str.slice(0, 1).alias("cie_capitulo"),
        ])
    )

    # Asignar estado UNA VEZ a nivel CLUES (no a nivel row) — evita ruido lat/long
    print("  • Asignando estado por CLUES (lat/long promedio)…")
    clues_coords = (
        lf.group_by("CLUES")
        .agg([pl.col("lat").mean().alias("lat"), pl.col("long").mean().alias("long")])
        .collect(engine="streaming")
    )
    state_expr, dist_cols = assign_state_expr()
    clues_with_state = (
        clues_coords.lazy()
        .with_columns(dist_cols)
        .with_columns(state_expr)
        .drop([c.meta.output_name() for c in dist_cols])
        .select(["CLUES", "estado"])
        .collect()
    )
    # Mapa CLUES → estado para inyectar al lazy frame
    lf = lf.join(clues_with_state.lazy(), on="CLUES", how="left")

    # ── 1. CLUES metadata ───────────────────────────────────────────────
    print("  • CLUES metadata…")
    clues = (
        lf.group_by("CLUES")
        .agg([
            pl.col("lat").mean().alias("lat"),
            pl.col("long").mean().alias("long"),
            pl.col("estado").first().alias("estado"),  # ya único por CLUES (join previo)
            pl.len().alias("total_casos"),
            pl.col("age").mean().alias("edad_promedio"),
            pl.col("HORASESTANCIA").mean().alias("horas_promedio"),
            pl.col("AFECPRIN").mode().first().alias("diagnostico_top"),
            pl.col("fecha").min().alias("fecha_min"),
            pl.col("fecha").max().alias("fecha_max"),
        ])
        .sort("total_casos", descending=True)
        .collect(engine="streaming")
    )
    clues_payload = []
    for row in clues.iter_rows(named=True):
        clues_payload.append({
            "clues": row["CLUES"],
            "lat": round(row["lat"], 5),
            "lng": round(row["long"], 5),
            "estado": row["estado"],
            "casos": int(row["total_casos"]),
            "edad_prom": round(row["edad_promedio"], 1),
            "horas_prom": round(row["horas_promedio"], 2),
            "diag_top": row["diagnostico_top"],
        })
    (OUT / "clues_meta.json").write_text(json.dumps(clues_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"    {len(clues_payload)} unidades médicas")

    # ── 2. Serie diaria nacional ────────────────────────────────────────
    print("  • Serie diaria nacional…")
    daily_nat = (
        lf.group_by("fecha")
        .agg([
            pl.len().alias("casos"),
            pl.col("age").mean().alias("edad_prom"),
            pl.col("HORASESTANCIA").mean().alias("horas_prom"),
        ])
        .sort("fecha")
        .collect(engine="streaming")
    )
    daily_payload = []
    for row in daily_nat.iter_rows(named=True):
        if row["fecha"] is None:
            continue
        daily_payload.append({
            "fecha": row["fecha"].isoformat(),
            "casos": int(row["casos"]),
            "edad_prom": round(row["edad_prom"] or 0, 1),
            "horas_prom": round(row["horas_prom"] or 0, 2),
        })
    (OUT / "daily_national.json").write_text(json.dumps(daily_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"    {len(daily_payload)} días")

    # ── 3. Top diagnósticos ─────────────────────────────────────────────
    print("  • Top diagnósticos…")
    diag = (
        lf.group_by(["AFECPRIN", "desc"])
        .agg([
            pl.len().alias("casos"),
            pl.col("age").mean().alias("edad_prom"),
            (pl.col("SEXO") == 1).mean().alias("pct_hombres"),
            pl.col("HORASESTANCIA").mean().alias("horas_prom"),
        ])
        .sort("casos", descending=True)
        .limit(80)
        .collect(engine="streaming")
    )
    diag_payload = []
    for row in diag.iter_rows(named=True):
        diag_payload.append({
            "codigo": row["AFECPRIN"],
            "descripcion": (row["desc"] or "").strip(),
            "casos": int(row["casos"]),
            "edad_prom": round(row["edad_prom"] or 0, 1),
            "pct_hombres": round((row["pct_hombres"] or 0) * 100, 1),
            "horas_prom": round(row["horas_prom"] or 0, 2),
        })
    (OUT / "top_diagnoses.json").write_text(json.dumps(diag_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"    {len(diag_payload)} diagnósticos")

    # ── 4. Pirámide demográfica ────────────────────────────────────────
    print("  • Pirámide demográfica…")
    age_bins = (
        lf.with_columns(
            pl.when(pl.col("age") < 1).then(pl.lit("0"))
            .when(pl.col("age") < 5).then(pl.lit("1-4"))
            .when(pl.col("age") < 10).then(pl.lit("5-9"))
            .when(pl.col("age") < 15).then(pl.lit("10-14"))
            .when(pl.col("age") < 20).then(pl.lit("15-19"))
            .when(pl.col("age") < 30).then(pl.lit("20-29"))
            .when(pl.col("age") < 40).then(pl.lit("30-39"))
            .when(pl.col("age") < 50).then(pl.lit("40-49"))
            .when(pl.col("age") < 60).then(pl.lit("50-59"))
            .when(pl.col("age") < 70).then(pl.lit("60-69"))
            .when(pl.col("age") < 80).then(pl.lit("70-79"))
            .otherwise(pl.lit("80+"))
            .alias("grupo_edad")
        )
        .group_by(["grupo_edad", "SEXO"])
        .agg(pl.len().alias("casos"))
        .collect(engine="streaming")
    )
    demo_payload: dict[str, dict[str, int]] = {}
    for row in age_bins.iter_rows(named=True):
        g = row["grupo_edad"]
        sx = "hombres" if row["SEXO"] == 1 else "mujeres"
        demo_payload.setdefault(g, {"hombres": 0, "mujeres": 0})
        demo_payload[g][sx] = int(row["casos"])
    (OUT / "demographics.json").write_text(json.dumps(demo_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ── 5. Patrón estacional (mes × capítulo CIE) ──────────────────────
    print("  • Patrón estacional por capítulo CIE-10…")
    seas = (
        lf.group_by(["mes", "cie_capitulo"])
        .agg(pl.len().alias("casos"))
        .collect(engine="streaming")
    )
    seasonal_payload: dict[str, list[int]] = {}
    for row in seas.iter_rows(named=True):
        cap = row["cie_capitulo"] or "?"
        seasonal_payload.setdefault(cap, [0] * 12)
        m = int(row["mes"]) - 1
        if 0 <= m < 12:
            seasonal_payload[cap][m] = int(row["casos"])
    (OUT / "seasonal.json").write_text(json.dumps(seasonal_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ── 6. Agregados por estado ────────────────────────────────────────
    print("  • Agregados por estado…")
    state_agg = (
        lf.group_by("estado")
        .agg([
            pl.len().alias("casos"),
            pl.col("CLUES").n_unique().alias("unidades"),
            pl.col("age").mean().alias("edad_prom"),
            pl.col("HORASESTANCIA").mean().alias("horas_prom"),
            (pl.col("SEXO") == 1).mean().alias("pct_hombres"),
        ])
        .sort("casos", descending=True)
        .collect(engine="streaming")
    )
    state_payload = []
    for row in state_agg.iter_rows(named=True):
        state_payload.append({
            "estado": row["estado"],
            "casos": int(row["casos"]),
            "unidades": int(row["unidades"]),
            "edad_prom": round(row["edad_prom"] or 0, 1),
            "horas_prom": round(row["horas_prom"] or 0, 2),
            "pct_hombres": round((row["pct_hombres"] or 0) * 100, 1),
        })
    (OUT / "state_aggregates.json").write_text(json.dumps(state_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ── 7. Serie diaria por CLUES (parquet — input del modelo) ─────────
    print("  • Serie diaria por CLUES (parquet)…")
    daily_clue = (
        lf.group_by(["CLUES", "fecha"])
        .agg([
            pl.len().alias("casos"),
            pl.col("lengthofday").first().alias("lengthofday"),
            pl.col("sf_msd").first().alias("sf_msd"),
        ])
        .sort(["CLUES", "fecha"])
        .collect(engine="streaming")
    )
    daily_clue.write_parquet(OUT / "daily_by_clue.parquet", compression="zstd")
    print(f"    {len(daily_clue):,} filas")

    # ── 8. Meta ejecutivo ─────────────────────────────────────────────
    total = sum(d["casos"] for d in daily_payload)
    meta = {
        "total_casos": int(total),
        "total_unidades": len(clues_payload),
        "total_dias": len(daily_payload),
        "fecha_min": daily_payload[0]["fecha"] if daily_payload else None,
        "fecha_max": daily_payload[-1]["fecha"] if daily_payload else None,
        "estados_cubiertos": len([s for s in state_payload if s["estado"] != "OTRO"]),
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    elapsed = time.time() - t0
    print()
    print(f"✓ Listo en {elapsed/60:.1f} minutos")
    print(f"  Total casos:    {total:,}")
    print(f"  Unidades:       {len(clues_payload)}")
    print(f"  Estados:        {meta['estados_cubiertos']}")
    print(f"  Periodo:        {meta['fecha_min']} → {meta['fecha_max']}")
    print()
    print("Archivos generados:")
    for f in sorted(OUT.glob("*")):
        size_kb = f.stat().st_size / 1024
        unit = f"{size_kb/1024:.1f} MB" if size_kb >= 1024 else f"{size_kb:.0f} KB"
        print(f"  {f.name:30s} {unit}")


if __name__ == "__main__":
    main()
