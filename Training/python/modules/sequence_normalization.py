from pathlib import Path
from typing import Optional, Tuple

import numpy as np


def sanitize_features(x: np.ndarray) -> np.ndarray:
    arr = np.asarray(x, dtype=np.float32)
    return np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def _flatten_features_for_stats(x: np.ndarray, model_type: str) -> np.ndarray:
    arr = sanitize_features(x)
    if str(model_type).strip().lower() == 'lstm' and arr.ndim >= 3:
        return arr.reshape(-1, arr.shape[-1])
    return arr


def infer_binary_feature_mask(x: np.ndarray, model_type: str, tol: float = 1e-6) -> np.ndarray:
    base = _flatten_features_for_stats(x, model_type=model_type)
    is_zero = np.isclose(base, 0.0, atol=tol)
    is_one = np.isclose(base, 1.0, atol=tol)
    return np.all(is_zero | is_one, axis=0)


def log_scale_signed(x: np.ndarray) -> np.ndarray:
    arr = sanitize_features(x)
    return (np.sign(arr) * np.log1p(np.abs(arr))).astype(np.float32)


def compute_feature_stats(
    x: np.ndarray,
    model_type: str,
    min_feature_std: float,
    preserve_binary_features: bool = True,
) -> Tuple[np.ndarray, np.ndarray]:
    base = _flatten_features_for_stats(x, model_type=model_type)

    mean = base.mean(axis=0).astype(np.float32)
    std = base.std(axis=0).astype(np.float32)
    safe_std = np.maximum(std, float(min_feature_std)).astype(np.float32)

    if bool(preserve_binary_features):
        binary_mask = infer_binary_feature_mask(base, model_type='mlp')
        mean[binary_mask] = 0.0
        safe_std[binary_mask] = 1.0

    return mean, safe_std


def apply_feature_normalization(
    x: np.ndarray,
    feature_mean: np.ndarray,
    feature_std: np.ndarray,
    clip_value: Optional[float] = None,
) -> np.ndarray:
    arr = sanitize_features(x)
    mean = np.asarray(feature_mean, dtype=np.float32)
    safe_std = np.maximum(np.asarray(feature_std, dtype=np.float32), 1e-8).astype(np.float32)
    normalized = ((arr - mean) / safe_std).astype(np.float32)
    if clip_value is not None and float(clip_value) > 0:
        c = float(clip_value)
        normalized = np.clip(normalized, -c, c).astype(np.float32)
    return normalized


def preprocess_and_normalize_sequences(
    train_x: np.ndarray,
    val_x: np.ndarray,
    model_type: str,
    normalize: bool,
    min_feature_std: float,
    clip_value: Optional[float] = 10.0,
    preserve_binary_features: bool = True,
    log_scale: bool = False,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    train_arr = sanitize_features(train_x)
    val_arr = sanitize_features(val_x)

    if bool(log_scale):
        train_arr = log_scale_signed(train_arr)
        val_arr = log_scale_signed(val_arr)

    feature_mean, feature_std = compute_feature_stats(
        train_arr,
        model_type=model_type,
        min_feature_std=min_feature_std,
        preserve_binary_features=preserve_binary_features,
    )
    if not bool(normalize):
        zeros = np.zeros_like(feature_mean, dtype=np.float32)
        ones = np.ones_like(feature_std, dtype=np.float32)
        return train_arr, val_arr, zeros, ones

    train_norm = apply_feature_normalization(train_arr, feature_mean, feature_std, clip_value=clip_value)
    val_norm = apply_feature_normalization(val_arr, feature_mean, feature_std, clip_value=clip_value)
    return train_norm, val_norm, feature_mean.astype(np.float32), feature_std.astype(np.float32)


def save_feature_stats(stats_path: Path, feature_mean: np.ndarray, feature_std: np.ndarray) -> None:
    path = Path(stats_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, mean=np.asarray(feature_mean, dtype=np.float32), std=np.asarray(feature_std, dtype=np.float32))


def load_feature_stats(stats_path: Path) -> Tuple[np.ndarray, np.ndarray]:
    payload = np.load(Path(stats_path))
    return np.asarray(payload['mean'], dtype=np.float32), np.asarray(payload['std'], dtype=np.float32)
