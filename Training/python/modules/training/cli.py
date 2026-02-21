import argparse

from training_config import TRAINING_CONFIG


def build_parser(config=None):
    config = config or TRAINING_CONFIG
    parser = argparse.ArgumentParser(description='Train behavior cloning model from Minecraft JSONL dataset.')
    parser.add_argument('--dataset', default=config['dataset'], help='Path to Training/datasets/state-action-YYYY-MM-DD.jsonl')
    parser.add_argument('--dataset-cache-dir', default=str(config.get('dataset_cache_dir', '')), help='Optional cache directory for preprocessed binary dataset arrays')
    parser.add_argument('--out-dir', default=config['out_dir'], help='Output directory for model artifacts')
    parser.add_argument('--model-type', choices=['mlp', 'lstm'], default=config['model_type'])
    parser.add_argument('--device', choices=['auto', 'cpu', 'cuda'], default=str(config.get('device', 'auto')))

    int_args = [
        ('--sequence-length', 'sequence_length'),
        ('--sequence-length-min', 'sequence_length_min'),
        ('--sequence-length-max', 'sequence_length_max'),
        ('--min-train-windows', 'min_train_windows'),
        ('--epochs', 'epochs'),
        ('--batch-size', 'batch_size'),
        ('--eval-batch-size', 'eval_batch_size'),
        ('--seed', 'seed'),
        ('--hidden-size', 'hidden_size'),
        ('--lstm-layers', 'lstm_layers'),
        ('--early-stopping-patience', 'early_stopping_patience'),
        ('--lr-scheduler-patience', 'lr_scheduler_patience'),
    ]
    float_args = [
        ('--lr', 'lr'),
        ('--weight-decay', 'weight_decay'),
        ('--dropout', 'dropout'),
        ('--normalize-clip-value', 'normalize_clip_value'),
        ('--class-weight-min', 'class_weight_min'),
        ('--class-weight-max', 'class_weight_max'),
        ('--class-weight-power', 'class_weight_power'),
        ('--intent-pos-weight-max', 'intent_pos_weight_max'),
        ('--min-feature-std', 'min_feature_std'),
        ('--intent-loss-weight', 'intent_loss_weight'),
        ('--control-loss-weight', 'control_loss_weight'),
        ('--grad-clip-norm', 'grad_clip_norm'),
        ('--lr-scheduler-factor', 'lr_scheduler_factor'),
        ('--lr-scheduler-min-lr', 'lr_scheduler_min_lr'),
        ('--early-stopping-min-delta', 'early_stopping_min_delta'),
    ]
    for flag, key in int_args:
        parser.add_argument(flag, type=int, default=int(config[key]))
    for flag, key in float_args:
        parser.add_argument(flag, type=float, default=float(config[key]))

    parser.add_argument('--baseline-mlp', action='store_true', help='Quick sanity baseline: mlp + no normalization + no class weights + dropout=0.0')
    parser.add_argument('--action-weight-boost', action='append', default=[], help='Repeatable: ACTION=multiplier (e.g. ATTACK_MOB=2.0)')
    parser.add_argument('--sequence-length-strategy', choices=['fixed', 'adaptive'], default=str(config.get('sequence_length_strategy', 'adaptive')))

    for flag, key in [
        ('--normalize-features', 'normalize_features'),
        ('--normalize-preserve-binary', 'normalize_preserve_binary'),
        ('--normalize-log-scale', 'normalize_log_scale'),
        ('--class-weighted-loss', 'class_weighted_loss'),
        ('--oversample-meaningful', 'oversample_meaningful'),
        ('--intent-balanced-loss', 'intent_balanced_loss'),
        ('--explicit-intent-supervision', 'explicit_intent_supervision'),
        ('--sequence-supervision', 'sequence_supervision'),
        ('--lstm-bidirectional', 'lstm_bidirectional'),
        ('--lstm-layer-norm', 'lstm_layer_norm'),
        ('--use-lr-scheduler', 'use_lr_scheduler'),
        ('--non-blocking-transfer', 'non_blocking_transfer'),
        ('--dataset-cache-enabled', 'dataset_cache_enabled'),
    ]:
        parser.add_argument(flag, action=argparse.BooleanOptionalAction, default=bool(config[key]))

    return parser


def parse_args(config=None):
    return build_parser(config=config).parse_args()
