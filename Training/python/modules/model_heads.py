import torch.nn as nn


CONTROL_DIM = 8
CONTROL_KEYS = [
    'target_vx',
    'target_vz',
    'target_vy',
    'target_speed',
    'target_accel',
    'target_delta_yaw',
    'target_delta_pitch',
    'target_jump_prob',
]


class BehaviorMLP(nn.Module):
    def __init__(self, in_features: int, num_actions: int, num_intents: int, control_dim: int = CONTROL_DIM, dropout: float = 0.2):
        super().__init__()
        p = min(0.8, max(0.0, float(dropout)))
        self.backbone = nn.Sequential(
            nn.Linear(in_features, 128),
            nn.ReLU(),
            nn.Dropout(p),
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Dropout(p),
        )
        self.action_head = nn.Linear(128, num_actions)
        self.intent_head = nn.Linear(128, num_intents)
        self.control_head = nn.Linear(128, control_dim)

    def forward(self, x):
        hidden = self.backbone(x)
        return self.action_head(hidden), self.intent_head(hidden), self.control_head(hidden)


class BehaviorLSTM(nn.Module):
    def __init__(
        self,
        in_features: int,
        num_actions: int,
        num_intents: int,
        control_dim: int = CONTROL_DIM,
        hidden_size: int = 128,
        num_layers: int = 1,
        dropout: float = 0.2,
        bidirectional: bool = False,
        layer_norm: bool = True,
    ):
        super().__init__()
        p = min(0.8, max(0.0, float(dropout)))
        self.bidirectional = bool(bidirectional)
        out_hidden = int(hidden_size) * (2 if self.bidirectional else 1)
        self.lstm = nn.LSTM(
            input_size=in_features,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=p if num_layers > 1 else 0.0,
            bidirectional=self.bidirectional,
        )
        self.norm = nn.LayerNorm(out_hidden) if layer_norm else nn.Identity()
        self.shared_head = nn.Sequential(
            nn.Linear(out_hidden, 128),
            nn.ReLU(),
            nn.Dropout(p),
        )
        self.action_head = nn.Linear(128, num_actions)
        self.intent_head = nn.Linear(128, num_intents)
        self.control_head = nn.Linear(128, control_dim)

    def forward(self, x, return_sequence: bool = False):
        output, _ = self.lstm(x)
        if return_sequence:
            shared_seq = self.shared_head(self.norm(output))
            return self.action_head(shared_seq), self.intent_head(shared_seq), self.control_head(shared_seq)

        last_step = self.norm(output[:, -1, :])
        shared = self.shared_head(last_step)
        return self.action_head(shared), self.intent_head(shared), self.control_head(shared)


class LegacyBehaviorMLP(nn.Module):
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


class LegacyBehaviorLSTM(nn.Module):
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
        return self.head(output[:, -1, :])
