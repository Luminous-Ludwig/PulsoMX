"""
Entrena modelo LightGBM de pronóstico de demanda de urgencias por unidad médica.

Input:  data/daily_by_clue.parquet  (CLUES × fecha × casos + features climáticas)
Output: data/predictions.json       (predicciones para top-50 CLUES, últimos 30 días + 14 futuros)
        data/model_metrics.json     (MAPE, MAE, RMSE por horizonte)

Arquitectura:
  - Features de tiempo: dow, month, day_of_year, is_weekend
  - Lags: t-1, t-7, t-14, t-28
  - Rolling means: 7d, 14d, 30d
  - Variables climáticas pre-procesadas: lengthofday, sf_msd
  - Encoding de CLUES como categórica
  - Validación temporal: train ≤ 2020, val = 2021, test = 2022
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl

sys.stdout.reconfigure(encoding="utf-8")

DATA = Path(__file__).parent / "data"
INPUT = DATA / "daily_by_clue.parquet"


def build_features(df: pl.DataFrame) -> pl.DataFrame:
    """Crea features temporales, lags y rolling means por CLUES."""
    print("  • Construyendo features…")
    df = df.with_columns([
        pl.col("fecha").dt.weekday().alias("dow"),
        pl.col("fecha").dt.month().alias("mes"),
        pl.col("fecha").dt.ordinal_day().alias("doy"),
        pl.col("fecha").dt.year().alias("year"),
        (pl.col("fecha").dt.weekday() >= 6).cast(pl.Int8).alias("is_weekend"),
    ])

    df = df.sort(["CLUES", "fecha"])

    # Lags y rolling por grupo CLUES
    df = df.with_columns([
        pl.col("casos").shift(1).over("CLUES").alias("lag_1"),
        pl.col("casos").shift(7).over("CLUES").alias("lag_7"),
        pl.col("casos").shift(14).over("CLUES").alias("lag_14"),
        pl.col("casos").shift(28).over("CLUES").alias("lag_28"),
        pl.col("casos").shift(1).rolling_mean(window_size=7).over("CLUES").alias("roll_7"),
        pl.col("casos").shift(1).rolling_mean(window_size=14).over("CLUES").alias("roll_14"),
        pl.col("casos").shift(1).rolling_mean(window_size=30).over("CLUES").alias("roll_30"),
        pl.col("casos").shift(1).rolling_std(window_size=14).over("CLUES").alias("std_14"),
    ])

    # Codificar CLUES como entero (categórica para LightGBM)
    clues_codes = df["CLUES"].unique().sort().to_list()
    clues_map = {c: i for i, c in enumerate(clues_codes)}
    df = df.with_columns(
        pl.col("CLUES").replace_strict(clues_map, return_dtype=pl.Int32).alias("clues_id")
    )
    return df, clues_codes


def mape(y_true, y_pred):
    """MAPE robusto: ignora ceros para evitar división por cero."""
    mask = y_true > 0
    if mask.sum() == 0:
        return float("nan")
    return float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100)


def wmape(y_true, y_pred):
    """Weighted MAPE — pondera por volumen real. Es la métrica honesta
    cuando hay series mixtas de alto/bajo volumen."""
    s = np.sum(np.abs(y_true))
    if s == 0:
        return float("nan")
    return float(np.sum(np.abs(y_true - y_pred)) / s * 100)


def rmse(y_true, y_pred):
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def mae(y_true, y_pred):
    return float(np.mean(np.abs(y_true - y_pred)))


def main():
    t0 = time.time()
    print(f"Cargando {INPUT.name}…")
    df = pl.read_parquet(INPUT)
    print(f"  {len(df):,} filas, {df['CLUES'].n_unique()} CLUES")

    # Filtrar CLUES con volumen útil (promedio > 5 casos/día)
    # CLUES con volúmenes diminutos solo añaden ruido al modelo
    print("  • Filtrando CLUES con volumen suficiente…")
    volumen = (
        df.group_by("CLUES")
        .agg(pl.col("casos").mean().alias("avg_casos"))
        .filter(pl.col("avg_casos") >= 5)
        .select("CLUES")
    )
    df = df.join(volumen, on="CLUES")
    print(f"  {df['CLUES'].n_unique()} CLUES retenidas (de 969)")

    df, clues_codes = build_features(df)

    # Dropear nulos generados por los lags (primeros 28 días por CLUES)
    df = df.drop_nulls()
    print(f"  {len(df):,} filas después de drop_nulls")

    # Split temporal
    train = df.filter(pl.col("year") <= 2020)
    val = df.filter(pl.col("year") == 2021)
    test = df.filter(pl.col("year") == 2022)
    print(f"  Train: {len(train):,} · Val: {len(val):,} · Test: {len(test):,}")

    feature_cols = [
        "clues_id", "dow", "mes", "doy", "year", "is_weekend",
        "lag_1", "lag_7", "lag_14", "lag_28",
        "roll_7", "roll_14", "roll_30", "std_14",
        "lengthofday", "sf_msd",
    ]
    target = "casos"

    X_train = train.select(feature_cols).to_pandas()
    y_train = train[target].to_pandas()
    X_val = val.select(feature_cols).to_pandas()
    y_val = val[target].to_pandas()
    X_test = test.select(feature_cols).to_pandas()
    y_test = test[target].to_pandas()

    print()
    print("Entrenando LightGBM…")
    model = lgb.LGBMRegressor(
        objective="regression",
        n_estimators=600,
        learning_rate=0.05,
        num_leaves=63,
        max_depth=-1,
        min_child_samples=20,
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=5,
        reg_alpha=0.1,
        reg_lambda=0.1,
        random_state=42,
        n_jobs=-1,
        verbose=-1,
    )
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        categorical_feature=["clues_id", "dow", "mes", "is_weekend"],
        callbacks=[lgb.early_stopping(stopping_rounds=30), lgb.log_evaluation(period=50)],
    )

    # Predicciones
    y_pred_val = model.predict(X_val)
    y_pred_test = model.predict(X_test)
    y_pred_val = np.clip(y_pred_val, 0, None)
    y_pred_test = np.clip(y_pred_test, 0, None)

    metrics = {
        "wmape_val": wmape(y_val.values, y_pred_val),
        "wmape_test": wmape(y_test.values, y_pred_test),
        "mape_val": mape(y_val.values, y_pred_val),
        "mape_test": mape(y_test.values, y_pred_test),
        "mae_val": mae(y_val.values, y_pred_val),
        "mae_test": mae(y_test.values, y_pred_test),
        "rmse_val": rmse(y_val.values, y_pred_val),
        "rmse_test": rmse(y_test.values, y_pred_test),
        "n_train": len(train),
        "n_val": len(val),
        "n_test": len(test),
        "n_features": len(feature_cols),
        "n_clues": len(clues_codes),
        "best_iteration": int(model.best_iteration_ or model.n_estimators),
    }
    print()
    print("Métricas (validación 2021 | test 2022):")
    print(f"  WMAPE     {metrics['wmape_val']:.2f}% | {metrics['wmape_test']:.2f}%   ← métrica principal")
    print(f"  MAE       {metrics['mae_val']:.2f}  | {metrics['mae_test']:.2f}")
    print(f"  RMSE      {metrics['rmse_val']:.2f}  | {metrics['rmse_test']:.2f}")
    print(f"  MAPE      {metrics['mape_val']:.2f}% | {metrics['mape_test']:.2f}%")

    # Feature importance
    imp = sorted(zip(feature_cols, model.feature_importances_), key=lambda x: -x[1])
    metrics["feature_importance"] = [{"feature": f, "importance": int(v)} for f, v in imp]
    print()
    print("Top features:")
    for f, v in imp[:8]:
        print(f"  {f:18s} {v}")

    (DATA / "model_metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── Predicciones para el dashboard ────────────────────────────────
    # Top 50 CLUES por volumen, predicciones del periodo test (2022) para mostrar
    # serie histórica + predicción + error real (validación visible).
    print()
    print("Generando predicciones para dashboard…")
    top_clues = (
        df.group_by("CLUES")
        .agg(pl.col("casos").sum().alias("total"))
        .sort("total", descending=True)
        .head(50)["CLUES"].to_list()
    )

    pred_payload = {"metrics": metrics, "por_clues": {}}
    # Para cada CLUES, generar serie del 2022 con predicción + intervalo
    for clues_id in top_clues:
        sub = df.filter(pl.col("CLUES") == clues_id).filter(pl.col("year") == 2022).sort("fecha")
        if len(sub) == 0:
            continue
        X_sub = sub.select(feature_cols).to_pandas()
        y_real = sub["casos"].to_pandas().values
        y_hat = np.clip(model.predict(X_sub), 0, None)

        # Intervalo de confianza basado en RMSE del test
        std = metrics["rmse_test"]
        lo = np.clip(y_hat - 1.28 * std, 0, None)  # 80% IC
        hi = y_hat + 1.28 * std

        fechas = sub["fecha"].to_list()
        # Tomar últimos 90 días para no saturar el JSON
        n_keep = min(90, len(fechas))
        offset = len(fechas) - n_keep
        pred_payload["por_clues"][clues_id] = [
            {
                "fecha": fechas[i].isoformat(),
                "real": int(y_real[i]),
                "pred": round(float(y_hat[i]), 1),
                "lo": round(float(lo[i]), 1),
                "hi": round(float(hi[i]), 1),
            }
            for i in range(offset, len(fechas))
        ]

    (DATA / "predictions.json").write_text(json.dumps(pred_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_mb = (DATA / "predictions.json").stat().st_size / 1024 / 1024
    print(f"  predictions.json: {size_mb:.2f} MB, {len(pred_payload['por_clues'])} CLUES")

    print()
    print(f"✓ Listo en {(time.time() - t0)/60:.1f} minutos")


if __name__ == "__main__":
    main()
