import json
from pathlib import Path

import torch

from dataset_utils import ACTION_VOCAB, INTENT_VOCAB
from modules.model_heads import CONTROL_DIM
from modules.sequence_normalization import save_feature_stats


def build_artifact_meta(args, dataset_path, n, in_features, model_type, class_weights, feature_mean, feature_std, best_val_loss=None, best_epoch=None):
    return {
        'dataset': str(dataset_path),
        'records': int(n),
        'in_features': int(in_features),
        'actions': ACTION_VOCAB,
        'epochs': int(args.epochs),
        'batch_size': int(args.batch_size),
        'lr': float(args.lr),
        'weight_decay': float(args.weight_decay),
        'seed': int(args.seed),
        'dropout': float(args.dropout),
        'model_type': model_type,
        'sequence_length': int(args.sequence_length),
        'sequence_supervision': bool(args.sequence_supervision),
        'hidden_size': int(args.hidden_size),
        'lstm_layers': int(args.lstm_layers),
        'lstm_bidirectional': bool(args.lstm_bidirectional),
        'lstm_layer_norm': bool(args.lstm_layer_norm),
        'class_weights': [float(v) for v in class_weights.tolist()] if args.class_weighted_loss else None,
        'feature_mean': [float(v) for v in feature_mean.tolist()],
        'feature_std': [float(v) for v in feature_std.tolist()],
        'normalize_features': bool(args.normalize_features),
        'normalize_clip_value': float(args.normalize_clip_value),
        'normalize_preserve_binary': bool(args.normalize_preserve_binary),
        'normalize_log_scale': bool(args.normalize_log_scale),
        'class_weighted_loss': bool(args.class_weighted_loss),
        'class_weight_min': float(args.class_weight_min),
        'class_weight_max': float(args.class_weight_max),
        'class_weight_power': float(args.class_weight_power),
        'min_feature_std': float(args.min_feature_std),
        'baseline_mlp': bool(args.baseline_mlp),
        'intent_vocab': INTENT_VOCAB,
        'control_dim': int(CONTROL_DIM),
        'hybrid_enabled': True,
        'temporal_context_features': True,
        'intent_loss_weight': float(args.intent_loss_weight),
        'control_loss_weight': float(args.control_loss_weight),
        'grad_clip_norm': float(args.grad_clip_norm),
        'use_lr_scheduler': bool(args.use_lr_scheduler),
        'lr_scheduler_factor': float(args.lr_scheduler_factor),
        'lr_scheduler_patience': int(args.lr_scheduler_patience),
        'lr_scheduler_min_lr': float(args.lr_scheduler_min_lr),
        'early_stopping_patience': int(args.early_stopping_patience),
        'best_val_loss': None if best_val_loss is None else float(best_val_loss),
        'best_epoch': None if best_epoch is None else int(best_epoch),
        'device': str(args.device),
    }


def save_artifacts(args, model, dataset_path, n, in_features, model_type, class_weights, feature_mean, feature_std, best_val_loss=None, best_epoch=None):
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / 'behavior_model.pt'
    meta_path = out_dir / 'behavior_model.meta.json'
    stats_path = out_dir / 'feature_stats.npz'

    meta = build_artifact_meta(
        args,
        dataset_path,
        n,
        in_features,
        model_type,
        class_weights,
        feature_mean,
        feature_std,
        best_val_loss=best_val_loss,
        best_epoch=best_epoch,
    )
    torch.save({'model_state_dict': model.state_dict(), **meta}, model_path)
    with meta_path.open('w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)
    save_feature_stats(stats_path, feature_mean=feature_mean, feature_std=feature_std)

    print(f'saved model: {model_path}')
    print(f'saved metadata: {meta_path}')
    print(f'saved feature stats: {stats_path}')
