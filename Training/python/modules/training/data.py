import json
from pathlib import Path

import numpy as np
import torch

from dataset_utils import (
    ACTION_VOCAB,
    load_dataset_hybrid,
    load_dataset_sequences_hybrid,
    load_dataset_sequences_hybrid_dense,
)
from modules.sequence_normalization import preprocess_and_normalize_sequences


def _resolve_cache_dir(dataset_path: Path, args) -> Path:
    custom_dir = str(getattr(args, 'dataset_cache_dir', '') or '').strip()
    return Path(custom_dir).resolve() if custom_dir else (dataset_path.parent / 'cache').resolve()


def _cache_file_path(dataset_path: Path, args, model_type: str, sequence_length: int) -> Path:
    cache_dir = _resolve_cache_dir(dataset_path, args)
    seq_mode = 'dense' if bool(getattr(args, 'sequence_supervision', False)) else 'last'
    name = (
        f'{dataset_path.stem}.model-{model_type}.seq-{int(sequence_length)}.'
        f'seqmode-{seq_mode}.cache.npz'
    )
    return cache_dir / name


def _try_load_cached_arrays(cache_path: Path, dataset_path: Path):
    if not cache_path.exists() or not dataset_path.exists():
        return None
    if cache_path.stat().st_mtime < dataset_path.stat().st_mtime:
        return None

    try:
        payload = np.load(cache_path, allow_pickle=False)
        x = payload['x'].astype(np.float32)
        y = payload['y']
        intent_y = payload['intent_y'].astype(np.float32)
        control_y = payload['control_y'].astype(np.float32)
        print(f'dataset_cache=hit path={cache_path}')
        return x, y, intent_y, control_y
    except Exception as exc:
        print(f'dataset_cache=invalid path={cache_path} reason={exc}')
        return None


def _save_cached_arrays(cache_path: Path, x, y, intent_y, control_y):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        cache_path,
        x=np.asarray(x, dtype=np.float32),
        y=np.asarray(y),
        intent_y=np.asarray(intent_y, dtype=np.float32),
        control_y=np.asarray(control_y, dtype=np.float32),
    )
    print(f'dataset_cache=saved path={cache_path}')


def _estimate_array_mb(x, y, intent_y, control_y) -> float:
    total = int(np.asarray(x).nbytes + np.asarray(y).nbytes + np.asarray(intent_y).nbytes + np.asarray(control_y).nbytes)
    return float(total / (1024 ** 2))


def _warn_if_large_dataset(x, y, intent_y, control_y, mb_threshold: int = 8192):
    estimated_mb = _estimate_array_mb(x, y, intent_y, control_y)
    if estimated_mb >= float(mb_threshold):
        print(
            f'warning=large_dataset_in_memory estimated_mb={estimated_mb:.1f} '
            f'suggestion=reduce_batch_or_sequence_or_enable_chunking'
        )


def _count_jsonl_rows(jsonl_path: Path) -> int:
    count = 0
    with jsonl_path.open('r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def _suggest_sequence_length(row_count: int) -> int:
    if row_count < 2_000:
        return 16
    if row_count < 10_000:
        return 24
    return 32


def _choose_effective_sequence_length(args, dataset_path: Path) -> int:
    requested = max(2, int(args.sequence_length))
    strategy = str(getattr(args, 'sequence_length_strategy', 'adaptive')).strip().lower()
    min_seq = max(2, int(getattr(args, 'sequence_length_min', 8)))
    max_seq = max(min_seq, int(getattr(args, 'sequence_length_max', 64)))
    min_windows = max(1, int(getattr(args, 'min_train_windows', 512)))

    if strategy == 'fixed':
        effective = min(max(requested, min_seq), max_seq)
        args.sequence_length = int(effective)
        return int(effective)

    row_count = _count_jsonl_rows(dataset_path)
    max_for_windows = max(2, row_count - min_windows)
    suggested = _suggest_sequence_length(row_count)
    candidate = requested if requested > 0 else suggested
    bounded = min(max(candidate, min_seq), max_seq)
    effective = min(bounded, max_for_windows)
    effective = max(2, effective)

    if effective != requested:
        print(
            f'sequence_length_adjusted requested={requested} effective={effective} '
            f'rows={row_count} strategy={strategy} min_windows={min_windows}'
        )

    args.sequence_length = int(effective)
    return int(effective)


def apply_baseline_overrides(args):
    if args.baseline_mlp:
        args.model_type = 'mlp'
        args.sequence_length = 1
        args.sequence_supervision = False
        args.dropout = 0.0
        args.normalize_features = False
        args.class_weighted_loss = False


def is_sequence_targets(y) -> bool:
    return isinstance(y, np.ndarray) and y.ndim == 2


def flatten_actions(y):
    return y.reshape(-1).astype(np.int64) if is_sequence_targets(y) else y.astype(np.int64)


def flatten_intents(intent):
    return intent.reshape(-1, intent.shape[-1]) if intent.ndim == 3 else intent


def load_dataset(args):
    dataset_path = Path(args.dataset)
    model_type = str(args.model_type).strip().lower()
    use_cache = bool(getattr(args, 'dataset_cache_enabled', True))

    if model_type == 'lstm':
        effective_seq_len = _choose_effective_sequence_length(args, dataset_path)
        cache_path = _cache_file_path(dataset_path, args, model_type=model_type, sequence_length=effective_seq_len)
        if use_cache:
            cached = _try_load_cached_arrays(cache_path, dataset_path)
            if cached is not None:
                x, y, intent_y, control_y = cached
                _warn_if_large_dataset(x, y, intent_y, control_y)
                return dataset_path, model_type, x, y, intent_y, control_y

        if bool(args.sequence_supervision):
            x, y, intent_y, control_y = load_dataset_sequences_hybrid_dense(dataset_path, sequence_length=effective_seq_len)
        else:
            x, y, intent_y, control_y = load_dataset_sequences_hybrid(dataset_path, sequence_length=effective_seq_len)

        if use_cache:
            _save_cached_arrays(cache_path, x, y, intent_y, control_y)
    else:
        cache_path = _cache_file_path(dataset_path, args, model_type=model_type, sequence_length=1)
        if use_cache:
            cached = _try_load_cached_arrays(cache_path, dataset_path)
            if cached is not None:
                x, y, intent_y, control_y = cached
                _warn_if_large_dataset(x, y, intent_y, control_y)
                return dataset_path, model_type, x, y, intent_y, control_y

        x, y, intent_y, control_y = load_dataset_hybrid(dataset_path)
        if use_cache:
            _save_cached_arrays(cache_path, x, y, intent_y, control_y)

    _warn_if_large_dataset(x, y, intent_y, control_y)
    return dataset_path, model_type, x, y, intent_y, control_y


def shuffle_dataset(x, y, intent_y, control_y, seed: int):
    np.random.seed(int(seed))
    torch.manual_seed(int(seed))
    idx = np.random.permutation(len(x))
    return x[idx], y[idx], intent_y[idx], control_y[idx]


def split_train_val(x, y, intent_y, control_y):
    split_idx = max(1, int(len(x) * 0.8))
    train = (x[:split_idx], y[:split_idx], intent_y[:split_idx], control_y[:split_idx])
    val = (x[split_idx:], y[split_idx:], intent_y[split_idx:], control_y[split_idx:])
    if len(val[0]) == 0:
        val = train
    return train, val


def normalize_features(train_x, val_x, model_type: str, args):
    return preprocess_and_normalize_sequences(
        train_x=train_x,
        val_x=val_x,
        model_type=model_type,
        normalize=bool(args.normalize_features),
        min_feature_std=float(args.min_feature_std),
        clip_value=float(args.normalize_clip_value),
        preserve_binary_features=bool(args.normalize_preserve_binary),
        log_scale=bool(args.normalize_log_scale),
    )


def to_tensors(train, val):
    (x_train, y_train, intent_train, control_train), (x_val, y_val, intent_val, control_val) = train, val
    return {
        'x_train': torch.tensor(x_train, dtype=torch.float32),
        'y_train': torch.tensor(y_train, dtype=torch.long),
        'intent_train': torch.tensor(intent_train, dtype=torch.float32),
        'control_train': torch.tensor(control_train, dtype=torch.float32),
        'x_val': torch.tensor(x_val, dtype=torch.float32),
        'y_val': torch.tensor(y_val, dtype=torch.long),
        'intent_val': torch.tensor(intent_val, dtype=torch.float32),
        'control_val': torch.tensor(control_val, dtype=torch.float32),
    }


def print_dataset_summary(args, n, in_features, model_type, y):
    flat_y = flatten_actions(y)
    print(
        f'dataset_records={n} in_features={in_features} model_type={model_type} '
        f'normalize={args.normalize_features} class_weighted_loss={args.class_weighted_loss} dropout={args.dropout} '
        f'sequence_supervision={args.sequence_supervision} intent_loss_weight={args.intent_loss_weight} control_loss_weight={args.control_loss_weight}'
    )
    counts = np.bincount(flat_y, minlength=len(ACTION_VOCAB))
    print('label_distribution=' + json.dumps({ACTION_VOCAB[i]: int(c) for i, c in enumerate(counts)}, ensure_ascii=False))
    dominant_idx = int(np.argmax(counts))
    dominant_ratio = float(counts[dominant_idx] / max(1, int(counts.sum())))
    print(f'dominant_label={ACTION_VOCAB[dominant_idx]} dominant_ratio={dominant_ratio:.3f}')
    if dominant_ratio > 0.70:
        print('warning=class_imbalance dominant label exceeds 70%')
