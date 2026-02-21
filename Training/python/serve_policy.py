from pathlib import Path
from typing import Any, Dict, Optional
from collections import deque
import time

import numpy as np
import torch
from fastapi import FastAPI
from pydantic import BaseModel

from dataset_utils import (
    ACTION_TO_ID,
    ID_TO_ACTION,
    INTENT_VOCAB,
    augment_feature_with_temporal_context,
    safe_timestamp_seconds,
    state_to_feature_vector,
)
from modules.model_heads import CONTROL_KEYS
from modules.policy_bundle import load_model
from modules.sequence_normalization import apply_feature_normalization, log_scale_signed


class PredictRequest(BaseModel):
    state: Dict[str, Any]
    agent_id: str = 'default'
    timestamp: Optional[Any] = None
    temperature: Optional[float] = None


MODEL_PATH = Path(__file__).resolve().parents[1] / 'models' / 'behavior_model.pt'
MODEL_BUNDLE = load_model(MODEL_PATH) if MODEL_PATH.exists() else None
SEQUENCE_BUFFERS: Dict[str, deque] = {}
LAST_ACTION_BY_AGENT: Dict[str, str] = {}
LAST_TS_BY_AGENT: Dict[str, float] = {}
LAST_BASE_FEATURE_BY_AGENT: Dict[str, np.ndarray] = {}
LAST_SEEN_BY_AGENT: Dict[str, float] = {}
ACTION_INERTIA_THRESHOLD = 0.6
AGENT_STATE_TTL_SECONDS = 1800.0
MAX_TRACKED_AGENTS = 4096
PREDICT_COUNTER = 0
DEFAULT_ACTION_TEMPERATURE = 0.8
MIN_TEMPERATURE = 1e-3

app = FastAPI(title='Minecraft Policy Server', version='0.1.0')


def _drop_agent_state(agent_key: str):
    SEQUENCE_BUFFERS.pop(agent_key, None)
    LAST_ACTION_BY_AGENT.pop(agent_key, None)
    LAST_TS_BY_AGENT.pop(agent_key, None)
    LAST_BASE_FEATURE_BY_AGENT.pop(agent_key, None)
    LAST_SEEN_BY_AGENT.pop(agent_key, None)


def _cleanup_agent_state(now_ts: float):
    expiration_cutoff = float(now_ts) - float(AGENT_STATE_TTL_SECONDS)
    expired_keys = [agent_key for agent_key, last_seen in LAST_SEEN_BY_AGENT.items() if float(last_seen) < expiration_cutoff]
    for agent_key in expired_keys:
        _drop_agent_state(agent_key)

    excess = len(LAST_SEEN_BY_AGENT) - int(MAX_TRACKED_AGENTS)
    if excess > 0:
        oldest = sorted(LAST_SEEN_BY_AGENT.items(), key=lambda item: float(item[1]))[:excess]
        for agent_key, _ in oldest:
            _drop_agent_state(agent_key)


def _resolve_temperature(raw_temperature: Optional[float]) -> float:
    if raw_temperature is None:
        return float(DEFAULT_ACTION_TEMPERATURE)
    try:
        value = float(raw_temperature)
    except (TypeError, ValueError):
        return float(DEFAULT_ACTION_TEMPERATURE)
    if not np.isfinite(value):
        return float(DEFAULT_ACTION_TEMPERATURE)
    return max(float(MIN_TEMPERATURE), value)


def _select_action(action_logits: torch.Tensor, temperature: float) -> tuple[int, torch.Tensor]:
    if float(temperature) <= float(MIN_TEMPERATURE):
        probs = torch.softmax(action_logits, dim=1).squeeze(0)
        return int(torch.argmax(probs).item()), probs
    scaled_logits = action_logits / float(temperature)
    probs = torch.softmax(scaled_logits, dim=1).squeeze(0)
    sampled_id = int(torch.multinomial(probs, num_samples=1).item())
    return sampled_id, probs


@app.get('/health')
def health():
    return {
        'ok': True,
        'model_loaded': MODEL_BUNDLE is not None,
        'model_path': str(MODEL_PATH),
        'model_type': MODEL_BUNDLE.get('model_type') if MODEL_BUNDLE else None,
        'sequence_length': MODEL_BUNDLE.get('sequence_length') if MODEL_BUNDLE else None,
        'hybrid_enabled': MODEL_BUNDLE.get('hybrid_enabled') if MODEL_BUNDLE else None,
        'action_selection': 'temperature_sampling',
        'default_temperature': float(DEFAULT_ACTION_TEMPERATURE),
    }


@app.post('/predict')
def predict(request: PredictRequest):
    global PREDICT_COUNTER
    if MODEL_BUNDLE is None:
        return {
            'ok': False,
            'error': f'Model not found at {MODEL_PATH}',
            'fallback_action': 'EXPLORE',
        }

    agent_key = str(request.agent_id or 'default')
    current_ts = safe_timestamp_seconds(request.timestamp if request.timestamp is not None else request.state.get('timestamp'))
    observed_ts = float(current_ts) if current_ts > 0.0 else float(time.time())
    LAST_SEEN_BY_AGENT[agent_key] = observed_ts
    PREDICT_COUNTER += 1
    if len(LAST_SEEN_BY_AGENT) > int(MAX_TRACKED_AGENTS) or (PREDICT_COUNTER % 128 == 0):
        _cleanup_agent_state(observed_ts)

    previous_ts = LAST_TS_BY_AGENT.get(agent_key, 0.0)
    delta_time = max(0.0, current_ts - previous_ts) if current_ts > 0.0 and previous_ts > 0.0 else 0.0
    if current_ts > 0.0:
        LAST_TS_BY_AGENT[agent_key] = current_ts

    base_x = state_to_feature_vector(request.state, delta_time=delta_time)
    prev_base = LAST_BASE_FEATURE_BY_AGENT.get(agent_key)
    prev_action_name = LAST_ACTION_BY_AGENT.get(agent_key)
    prev_action_id = ACTION_TO_ID.get(str(prev_action_name or '').upper()) if prev_action_name else None

    if bool(MODEL_BUNDLE.get('temporal_context_features', False)):
        x = augment_feature_with_temporal_context(base_x, prev_base, prev_action_id)
    else:
        x = base_x

    LAST_BASE_FEATURE_BY_AGENT[agent_key] = base_x
    if (
        MODEL_BUNDLE.get('normalize_features', True)
        and MODEL_BUNDLE['feature_mean'] is not None
        and MODEL_BUNDLE['feature_std'] is not None
    ):
        if bool(MODEL_BUNDLE.get('normalize_log_scale', False)):
            x = log_scale_signed(x)
        x = apply_feature_normalization(
            x,
            MODEL_BUNDLE['feature_mean'],
            MODEL_BUNDLE['feature_std'],
            clip_value=float(MODEL_BUNDLE.get('normalize_clip_value', 10.0)),
        )

    model_type = MODEL_BUNDLE.get('model_type', 'mlp')
    seq_len = int(MODEL_BUNDLE.get('sequence_length', 1))

    if model_type == 'lstm':
        key = agent_key
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
        model_out = MODEL_BUNDLE['model'](xt)
        if isinstance(model_out, tuple) and len(model_out) == 3:
            action_logits, intent_logits, control_pred = model_out
            hybrid_runtime = True
        else:
            action_logits = model_out
            intent_logits = None
            control_pred = None
            hybrid_runtime = False
        action_temperature = _resolve_temperature(request.temperature)
        action_id, probs = _select_action(action_logits, action_temperature)

    action_name = ID_TO_ACTION.get(action_id, 'IDLE')
    confidence = float(probs[action_id].item())

    if hybrid_runtime and intent_logits is not None and control_pred is not None:
        explicit_intent_supervision = bool(MODEL_BUNDLE.get('explicit_intent_supervision', True))
        if explicit_intent_supervision:
            intent_probs = torch.sigmoid(intent_logits).squeeze(0)
            intent_vocab = MODEL_BUNDLE.get('intent_vocab') or INTENT_VOCAB
            intent_scores = {
                str(intent_vocab[idx]): float(intent_probs[idx].item())
                for idx in range(min(len(intent_vocab), int(intent_probs.shape[0])))
            }
            active_intents = [name for name, score in intent_scores.items() if score >= 0.5]
        else:
            intent_scores = {}
            active_intents = []

        control_values = control_pred.squeeze(0).detach().cpu().numpy().tolist()
        continuous_control = {
            CONTROL_KEYS[idx]: float(control_values[idx])
            for idx in range(min(len(CONTROL_KEYS), len(control_values)))
        }
    else:
        intent_scores = {}
        active_intents = []
        continuous_control = {}

    previous_action = LAST_ACTION_BY_AGENT.get(agent_key)
    if previous_action and confidence < ACTION_INERTIA_THRESHOLD:
        action_name = previous_action
    else:
        LAST_ACTION_BY_AGENT[agent_key] = action_name

    hybrid_action = [action_name] + [intent for intent in active_intents if intent != action_name]

    return {
        'ok': True,
        'action': action_name,
        'confidence': confidence,
        'agent_id': agent_key,
        'model_type': model_type,
        'hybrid_enabled': bool(MODEL_BUNDLE.get('hybrid_enabled', False) and hybrid_runtime),
        'action_temperature': float(action_temperature),
        'explicit_intent_supervision': bool(MODEL_BUNDLE.get('explicit_intent_supervision', True)),
        'intent_scores': intent_scores,
        'active_intents': active_intents,
        'continuous_control': continuous_control,
        'hybrid_action': hybrid_action,
    }
