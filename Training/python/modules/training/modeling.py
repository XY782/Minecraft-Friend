import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler

from dataset_utils import ACTION_VOCAB, INTENT_VOCAB
from modules.model_heads import CONTROL_DIM, BehaviorLSTM, BehaviorMLP
from modules.train_helpers import ACTION_TO_ID, compute_stable_class_weights, parse_action_boosts
from modules.training.data import flatten_actions, flatten_intents, is_sequence_targets


def build_model(model_type: str, in_features: int, args):
    if model_type == 'lstm':
        return BehaviorLSTM(
            in_features=in_features,
            num_actions=len(ACTION_VOCAB),
            num_intents=len(INTENT_VOCAB),
            control_dim=CONTROL_DIM,
            hidden_size=int(args.hidden_size),
            num_layers=int(args.lstm_layers),
            dropout=float(args.dropout),
            bidirectional=bool(args.lstm_bidirectional),
            layer_norm=bool(args.lstm_layer_norm),
        )
    return BehaviorMLP(
        in_features=in_features,
        num_actions=len(ACTION_VOCAB),
        num_intents=len(INTENT_VOCAB),
        control_dim=CONTROL_DIM,
        dropout=float(args.dropout),
    )


def compute_class_weights(y_train, args):
    y_flat = flatten_actions(y_train)
    weights = compute_stable_class_weights(
        labels=y_flat,
        num_classes=len(ACTION_VOCAB),
        min_weight=float(args.class_weight_min),
        max_weight=float(args.class_weight_max),
        power=float(args.class_weight_power),
    )
    counts = np.bincount(y_flat, minlength=len(ACTION_VOCAB)).astype(np.float32)
    for action, multiplier in parse_action_boosts(args.action_weight_boost).items():
        idx = ACTION_TO_ID.get(action)
        if idx is not None and counts[idx] > 0:
            weights[idx] *= float(multiplier)
    weights = np.clip(weights, float(args.class_weight_min), float(args.class_weight_max)).astype(np.float32)
    return weights / np.maximum(1e-8, float(weights.mean()))


def build_train_loader(tensors, y_train, class_weights, batch_size: int, oversample_meaningful: bool):
    train_dataset = TensorDataset(tensors['x_train'], tensors['y_train'], tensors['intent_train'], tensors['control_train'])
    if not oversample_meaningful:
        return DataLoader(train_dataset, batch_size=batch_size, shuffle=True)

    sampler_labels = y_train[:, -1] if is_sequence_targets(y_train) else y_train
    sample_weights = torch.tensor(class_weights[sampler_labels], dtype=torch.float32)
    sampler = WeightedRandomSampler(weights=sample_weights, num_samples=len(sample_weights), replacement=True)
    return DataLoader(train_dataset, batch_size=batch_size, sampler=sampler)


def build_loss_functions(args, intent_train, class_weights):
    action_loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(class_weights, dtype=torch.float32)) if args.class_weighted_loss else nn.CrossEntropyLoss()
    if args.intent_balanced_loss:
        flat_intent = flatten_intents(intent_train)
        intent_pos = np.clip(flat_intent.sum(axis=0), 1.0, None)
        intent_neg = np.clip(float(flat_intent.shape[0]) - intent_pos, 1.0, None)
        pos_weight = np.clip(intent_neg / intent_pos, 1.0, float(args.intent_pos_weight_max)).astype(np.float32)
        intent_loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(pos_weight, dtype=torch.float32))
    else:
        intent_loss_fn = nn.BCEWithLogitsLoss()
    return action_loss_fn, intent_loss_fn, nn.SmoothL1Loss()


def resolve_device(device_arg: str) -> torch.device:
    value = str(device_arg or 'auto').strip().lower()
    if value == 'auto':
        return torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    if value == 'cuda' and not torch.cuda.is_available():
        print('warning=device cuda requested but unavailable, falling back to cpu')
        return torch.device('cpu')
    return torch.device(value)


def build_optimizer(model, args):
    return torch.optim.AdamW(model.parameters(), lr=float(args.lr), weight_decay=float(args.weight_decay))


def build_scheduler(optimizer, args):
    if not bool(args.use_lr_scheduler):
        return None
    return torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer,
        mode='min',
        factor=float(args.lr_scheduler_factor),
        patience=int(args.lr_scheduler_patience),
        min_lr=float(args.lr_scheduler_min_lr),
    )


def compute_losses(model, xb, yb, intent_b, control_b, action_loss_fn, intent_loss_fn, control_loss_fn, args):
    explicit_intent_supervision = bool(getattr(args, 'explicit_intent_supervision', True))
    sequence_supervision = bool(args.sequence_supervision) and yb.dim() == 2
    if sequence_supervision:
        action_logits, intent_logits, control_pred = model(xb, return_sequence=True)
        action_loss = action_loss_fn(action_logits.reshape(-1, action_logits.shape[-1]), yb.reshape(-1))
        if explicit_intent_supervision:
            intent_loss = intent_loss_fn(intent_logits.reshape(-1, intent_logits.shape[-1]), intent_b.reshape(-1, intent_b.shape[-1]))
        else:
            intent_loss = torch.zeros((), dtype=action_loss.dtype, device=action_loss.device)
        control_loss = control_loss_fn(control_pred.reshape(-1, control_pred.shape[-1]), control_b.reshape(-1, control_b.shape[-1]))
        predictions = action_logits.argmax(dim=-1)
        intent_binary = (torch.sigmoid(intent_logits) >= 0.5).float()
    else:
        action_logits, intent_logits, control_pred = model(xb)
        action_loss = action_loss_fn(action_logits, yb)
        if explicit_intent_supervision:
            intent_loss = intent_loss_fn(intent_logits, intent_b)
        else:
            intent_loss = torch.zeros((), dtype=action_loss.dtype, device=action_loss.device)
        control_loss = control_loss_fn(control_pred, control_b)
        predictions = action_logits.argmax(dim=1)
        intent_binary = (torch.sigmoid(intent_logits) >= 0.5).float()

    effective_intent_weight = float(args.intent_loss_weight) if explicit_intent_supervision else 0.0
    total = action_loss + effective_intent_weight * intent_loss + float(args.control_loss_weight) * control_loss
    action_acc = (predictions == yb).float().mean()
    intent_acc = (intent_binary == intent_b).float().mean() if explicit_intent_supervision else torch.zeros((), dtype=action_loss.dtype, device=action_loss.device)
    return total, action_loss, intent_loss, control_loss, action_acc, intent_acc
