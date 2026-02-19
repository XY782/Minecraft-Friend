from pathlib import Path

import numpy as np
import torch

from dataset_utils import ACTION_VOCAB, INTENT_VOCAB
from modules.model_heads import (
    CONTROL_KEYS,
    BehaviorLSTM,
    BehaviorMLP,
    LegacyBehaviorLSTM,
    LegacyBehaviorMLP,
)


def load_model(model_path: Path):
    payload = torch.load(model_path, map_location='cpu')
    in_features = int(payload['in_features'])
    dropout = float(payload.get('dropout', 0.2))
    model_type = str(payload.get('model_type', 'mlp')).strip().lower()
    sequence_length = int(payload.get('sequence_length', 1))
    intent_vocab = payload.get('intent_vocab') or INTENT_VOCAB
    control_dim = int(payload.get('control_dim', len(CONTROL_KEYS)))
    state_dict = payload.get('model_state_dict', {})
    has_hybrid_heads = any('intent_head' in key or 'control_head' in key for key in state_dict.keys())
    hybrid_enabled = bool(payload.get('hybrid_enabled', False) or has_hybrid_heads)

    if model_type == 'lstm' and hybrid_enabled:
        model = BehaviorLSTM(
            in_features=in_features,
            num_actions=len(ACTION_VOCAB),
            num_intents=len(intent_vocab),
            control_dim=control_dim,
            hidden_size=int(payload.get('hidden_size', 128)),
            num_layers=int(payload.get('lstm_layers', 1)),
            dropout=dropout,
            bidirectional=bool(payload.get('lstm_bidirectional', False)),
            layer_norm=bool(payload.get('lstm_layer_norm', False)),
        )
    elif model_type == 'lstm':
        model = LegacyBehaviorLSTM(
            in_features=in_features,
            num_actions=len(ACTION_VOCAB),
            hidden_size=int(payload.get('hidden_size', 128)),
            num_layers=int(payload.get('lstm_layers', 1)),
            dropout=dropout,
        )
    elif hybrid_enabled:
        model = BehaviorMLP(
            in_features=in_features,
            num_actions=len(ACTION_VOCAB),
            num_intents=len(intent_vocab),
            control_dim=control_dim,
            dropout=dropout,
        )
    else:
        model = LegacyBehaviorMLP(in_features=in_features, num_actions=len(ACTION_VOCAB), dropout=dropout)

    model.load_state_dict(state_dict)
    model.eval()
    feature_mean = payload.get('feature_mean')
    feature_std = payload.get('feature_std')

    if feature_mean is not None and feature_std is not None:
        mean_arr = np.array(feature_mean, dtype=np.float32)
        std_arr = np.array(feature_std, dtype=np.float32)
    else:
        mean_arr = None
        std_arr = None

    return {
        'model': model,
        'in_features': in_features,
        'feature_mean': mean_arr,
        'feature_std': std_arr,
        'min_feature_std': float(payload.get('min_feature_std', 1e-3)),
        'model_type': model_type,
        'sequence_length': max(1, sequence_length),
        'normalize_features': bool(payload.get('normalize_features', True)),
        'normalize_clip_value': float(payload.get('normalize_clip_value', 10.0)),
        'normalize_log_scale': bool(payload.get('normalize_log_scale', False)),
        'intent_vocab': intent_vocab,
        'control_dim': control_dim,
        'hybrid_enabled': hybrid_enabled,
        'sequence_supervision': bool(payload.get('sequence_supervision', False)),
        'temporal_context_features': bool(payload.get('temporal_context_features', False)),
    }
