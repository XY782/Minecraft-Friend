import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from dataset_utils import ACTION_VOCAB, load_dataset, load_dataset_sequences


class BehaviorMLP(nn.Module):
    def __init__(self, in_features: int, num_actions: int, dropout: float = 0.2):
        super().__init__()
        p = min(0.8, max(0.0, float(dropout)))
        self.net = nn.Sequential(
            nn.Linear(in_features, 128),
            nn.ReLU(),
            nn.Dropout(p),
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Dropout(p),
            nn.Linear(128, num_actions),
        )

    def forward(self, x):
        return self.net(x)


class BehaviorLSTM(nn.Module):
    def __init__(self, in_features: int, num_actions: int, hidden_size: int = 128, num_layers: int = 1, dropout: float = 0.2):
        super().__init__()
        p = min(0.8, max(0.0, float(dropout)))
        self.lstm = nn.LSTM(
            input_size=in_features,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=p if num_layers > 1 else 0.0,
        )
        self.head = nn.Sequential(
            nn.Linear(hidden_size, 128),
            nn.ReLU(),
            nn.Dropout(p),
            nn.Linear(128, num_actions),
        )

    def forward(self, x):
        output, _ = self.lstm(x)
        last_step = output[:, -1, :]
        return self.head(last_step)


def train(args):
    if args.baseline_mlp:
        args.model_type = 'mlp'
        args.sequence_length = 1
        args.dropout = 0.0
        args.normalize_features = False
        args.class_weighted_loss = False

    dataset_path = Path(args.dataset)
    model_type = str(args.model_type).strip().lower()
    if model_type == 'lstm':
        x, y = load_dataset_sequences(dataset_path, sequence_length=args.sequence_length)
    else:
        x, y = load_dataset(dataset_path)

    np.random.seed(int(args.seed))
    torch.manual_seed(int(args.seed))

    permutation = np.random.permutation(len(x))
    x = x[permutation]
    y = y[permutation]

    n = len(x)
    split_idx = max(1, int(n * 0.8))
    x_train, x_val = x[:split_idx], x[split_idx:]
    y_train, y_val = y[:split_idx], y[split_idx:]
    if len(x_val) == 0:
        x_val, y_val = x_train, y_train

    if model_type == 'lstm':
        raw_feature_mean = x_train.reshape(-1, x_train.shape[-1]).mean(axis=0)
        raw_feature_std = x_train.reshape(-1, x_train.shape[-1]).std(axis=0) + 1e-6
    else:
        raw_feature_mean = x_train.mean(axis=0)
        raw_feature_std = x_train.std(axis=0) + 1e-6

    if args.normalize_features:
        feature_mean = raw_feature_mean
        feature_std = raw_feature_std
        x_train = (x_train - feature_mean) / feature_std
        x_val = (x_val - feature_mean) / feature_std
    else:
        feature_mean = np.zeros_like(raw_feature_mean, dtype=np.float32)
        feature_std = np.ones_like(raw_feature_std, dtype=np.float32)

    x_train_t = torch.tensor(x_train, dtype=torch.float32)
    y_train_t = torch.tensor(y_train, dtype=torch.long)
    x_val_t = torch.tensor(x_val, dtype=torch.float32)
    y_val_t = torch.tensor(y_val, dtype=torch.long)

    train_loader = DataLoader(TensorDataset(x_train_t, y_train_t), batch_size=args.batch_size, shuffle=True)

    in_features = int(x.shape[-1])
    if model_type == 'lstm':
        model = BehaviorLSTM(
            in_features=in_features,
            num_actions=len(ACTION_VOCAB),
            hidden_size=int(args.hidden_size),
            num_layers=int(args.lstm_layers),
            dropout=args.dropout,
        )
    else:
        model = BehaviorMLP(in_features=in_features, num_actions=len(ACTION_VOCAB), dropout=args.dropout)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    train_counts = np.bincount(y_train, minlength=len(ACTION_VOCAB)).astype(np.float32)
    train_counts = np.maximum(train_counts, 1.0)
    class_weights = train_counts.sum() / (len(ACTION_VOCAB) * train_counts)
    if args.class_weighted_loss:
        class_weights_t = torch.tensor(class_weights, dtype=torch.float32)
        loss_fn = nn.CrossEntropyLoss(weight=class_weights_t)
    else:
        loss_fn = nn.CrossEntropyLoss()

    print(
        f'dataset_records={n} in_features={in_features} model_type={model_type} '
        f'normalize={args.normalize_features} class_weighted_loss={args.class_weighted_loss} dropout={args.dropout}'
    )
    print('label_distribution=' + json.dumps({ACTION_VOCAB[i]: int(c) for i, c in enumerate(np.bincount(y, minlength=len(ACTION_VOCAB)))}, ensure_ascii=False))

    for epoch in range(1, args.epochs + 1):
        model.train()
        losses = []
        for xb, yb in train_loader:
            optimizer.zero_grad()
            logits = model(xb)
            loss = loss_fn(logits, yb)
            loss.backward()
            optimizer.step()
            losses.append(loss.item())

        model.eval()
        with torch.no_grad():
            val_logits = model(x_val_t)
            val_loss = loss_fn(val_logits, y_val_t).item()
            pred = val_logits.argmax(dim=1)
            val_acc = (pred == y_val_t).float().mean().item()

        print(f'epoch={epoch} train_loss={np.mean(losses):.4f} val_loss={val_loss:.4f} val_acc={val_acc:.4f}')

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / 'behavior_model.pt'
    meta_path = out_dir / 'behavior_model.meta.json'

    torch.save(
        {
            'model_state_dict': model.state_dict(),
            'in_features': int(in_features),
            'action_vocab': ACTION_VOCAB,
            'seed': int(args.seed),
            'dropout': float(args.dropout),
            'feature_mean': feature_mean.tolist(),
            'feature_std': feature_std.tolist(),
            'model_type': model_type,
            'sequence_length': int(args.sequence_length),
            'hidden_size': int(args.hidden_size),
            'lstm_layers': int(args.lstm_layers),
            'normalize_features': bool(args.normalize_features),
            'class_weighted_loss': bool(args.class_weighted_loss),
        },
        model_path,
    )

    with meta_path.open('w', encoding='utf-8') as f:
        json.dump(
            {
                'dataset': str(dataset_path),
                'records': int(n),
                'in_features': int(in_features),
                'actions': ACTION_VOCAB,
                'epochs': int(args.epochs),
                'batch_size': int(args.batch_size),
                'lr': float(args.lr),
                'seed': int(args.seed),
                'dropout': float(args.dropout),
                'model_type': model_type,
                'sequence_length': int(args.sequence_length),
                'hidden_size': int(args.hidden_size),
                'lstm_layers': int(args.lstm_layers),
                'class_weights': [float(v) for v in class_weights.tolist()] if args.class_weighted_loss else None,
                'feature_mean': [float(v) for v in feature_mean.tolist()],
                'feature_std': [float(v) for v in feature_std.tolist()],
                'normalize_features': bool(args.normalize_features),
                'class_weighted_loss': bool(args.class_weighted_loss),
                'baseline_mlp': bool(args.baseline_mlp),
            },
            f,
            indent=2,
        )

    print(f'saved model: {model_path}')
    print(f'saved metadata: {meta_path}')


def parse_args():
    parser = argparse.ArgumentParser(description='Train behavior cloning model from Minecraft JSONL dataset.')
    parser.add_argument('--dataset', required=True, help='Path to Training/datasets/state-action-YYYY-MM-DD.jsonl')
    parser.add_argument('--out-dir', default='../models', help='Output directory for model artifacts')
    parser.add_argument('--model-type', choices=['mlp', 'lstm'], default='lstm')
    parser.add_argument('--sequence-length', type=int, default=8)
    parser.add_argument('--epochs', type=int, default=12)
    parser.add_argument('--batch-size', type=int, default=128)
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--dropout', type=float, default=0.2)
    parser.add_argument('--hidden-size', type=int, default=128)
    parser.add_argument('--lstm-layers', type=int, default=1)
    parser.add_argument('--baseline-mlp', action='store_true', help='Quick sanity baseline: mlp + no normalization + no class weights + dropout=0.0')
    parser.add_argument('--normalize-features', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--class-weighted-loss', action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


if __name__ == '__main__':
    train(parse_args())
