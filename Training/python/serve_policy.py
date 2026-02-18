from pathlib import Path
from typing import Any, Dict
from collections import deque

import numpy as np
import torch
import torch.nn as nn
from fastapi import FastAPI
from pydantic import BaseModel

from dataset_utils import ACTION_VOCAB, ID_TO_ACTION, state_to_feature_vector


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


class PredictRequest(BaseModel):
    state: Dict[str, Any]
    agent_id: str = 'default'


def load_model(model_path: Path):
    payload = torch.load(model_path, map_location='cpu')
    in_features = int(payload['in_features'])
    dropout = float(payload.get('dropout', 0.2))
    model_type = str(payload.get('model_type', 'mlp')).strip().lower()
    sequence_length = int(payload.get('sequence_length', 1))

    if model_type == 'lstm':
        model = BehaviorLSTM(
            in_features=in_features,
            num_actions=len(ACTION_VOCAB),
            hidden_size=int(payload.get('hidden_size', 128)),
            num_layers=int(payload.get('lstm_layers', 1)),
            dropout=dropout,
        )
    else:
        model = BehaviorMLP(in_features=in_features, num_actions=len(ACTION_VOCAB), dropout=dropout)

    model.load_state_dict(payload['model_state_dict'])
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
        'model_type': model_type,
        'sequence_length': max(1, sequence_length),
        'normalize_features': bool(payload.get('normalize_features', True)),
    }


MODEL_PATH = Path(__file__).resolve().parents[1] / 'models' / 'behavior_model.pt'
MODEL_BUNDLE = load_model(MODEL_PATH) if MODEL_PATH.exists() else None
SEQUENCE_BUFFERS: Dict[str, deque] = {}
LAST_ACTION_BY_AGENT: Dict[str, str] = {}
ACTION_INERTIA_THRESHOLD = 0.6

app = FastAPI(title='Minecraft Policy Server', version='0.1.0')


@app.get('/health')
def health():
    return {
        'ok': True,
        'model_loaded': MODEL_BUNDLE is not None,
        'model_path': str(MODEL_PATH),
        'model_type': MODEL_BUNDLE.get('model_type') if MODEL_BUNDLE else None,
        'sequence_length': MODEL_BUNDLE.get('sequence_length') if MODEL_BUNDLE else None,
    }


@app.post('/predict')
def predict(request: PredictRequest):
    if MODEL_BUNDLE is None:
        return {
            'ok': False,
            'error': f'Model not found at {MODEL_PATH}',
            'fallback_action': 'EXPLORE',
        }

    x = state_to_feature_vector(request.state)
    if (
        MODEL_BUNDLE.get('normalize_features', True)
        and MODEL_BUNDLE['feature_mean'] is not None
        and MODEL_BUNDLE['feature_std'] is not None
    ):
        x = (x - MODEL_BUNDLE['feature_mean']) / (MODEL_BUNDLE['feature_std'] + 1e-6)

    model_type = MODEL_BUNDLE.get('model_type', 'mlp')
    seq_len = int(MODEL_BUNDLE.get('sequence_length', 1))

    if model_type == 'lstm':
        key = str(request.agent_id or 'default')
        if key not in SEQUENCE_BUFFERS:
            SEQUENCE_BUFFERS[key] = deque(maxlen=seq_len)

        buffer = SEQUENCE_BUFFERS[key]
        buffer.append(x)

        while len(buffer) < seq_len:
            buffer.appendleft(x)

        seq_array = np.stack(list(buffer)).astype(np.float32)
        xt = torch.tensor(seq_array, dtype=torch.float32).unsqueeze(0)
    else:
        xt = torch.tensor(x, dtype=torch.float32).unsqueeze(0)

    with torch.no_grad():
        logits = MODEL_BUNDLE['model'](xt)
        probs = torch.softmax(logits, dim=1).squeeze(0)

    action_id = int(torch.argmax(probs).item())
    action_name = ID_TO_ACTION.get(action_id, 'IDLE')
    confidence = float(probs[action_id].item())

    agent_key = str(request.agent_id or 'default')
    previous_action = LAST_ACTION_BY_AGENT.get(agent_key)
    if previous_action and confidence < ACTION_INERTIA_THRESHOLD:
        action_name = previous_action
    else:
        LAST_ACTION_BY_AGENT[agent_key] = action_name

    return {
        'ok': True,
        'action': action_name,
        'confidence': confidence,
        'agent_id': agent_key,
        'model_type': model_type,
    }
