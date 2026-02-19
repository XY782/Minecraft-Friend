from typing import Dict

import numpy as np

from dataset_utils import ACTION_VOCAB


ACTION_TO_ID = {name: idx for idx, name in enumerate(ACTION_VOCAB)}
DEFAULT_ACTION_WEIGHT_BOOSTS = {}


def compute_stable_class_weights(
    labels: np.ndarray,
    num_classes: int,
    min_weight: float = 0.25,
    max_weight: float = 8.0,
    power: float = 0.5,
) -> np.ndarray:
    counts_raw = np.bincount(labels, minlength=num_classes).astype(np.float32)
    total = float(np.maximum(1.0, counts_raw.sum()))
    frequencies = counts_raw / total
    observed = counts_raw > 0

    weights = np.ones(num_classes, dtype=np.float32)
    if np.any(observed):
        ref_freq = float(np.median(frequencies[observed]))
        ref_freq = max(ref_freq, 1e-8)
        ratio = ref_freq / np.maximum(frequencies, 1e-8)
        stabilized = np.power(ratio, max(0.0, float(power))).astype(np.float32)
        weights[observed] = stabilized[observed]

    weights = np.clip(weights, float(min_weight), float(max_weight)).astype(np.float32)
    weights = weights / np.maximum(1e-8, float(weights.mean()))
    return weights.astype(np.float32)


def parse_action_boosts(custom_entries) -> Dict[str, float]:
    boosts = dict(DEFAULT_ACTION_WEIGHT_BOOSTS)
    for entry in custom_entries or []:
        text = str(entry or '').strip()
        if not text or '=' not in text:
            continue
        key, value = text.split('=', 1)
        action = str(key or '').strip().upper()
        if action not in ACTION_TO_ID:
            continue
        try:
            boost = float(value)
        except ValueError:
            continue
        boosts[action] = max(0.1, boost)
    return boosts
