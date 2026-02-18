import json
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np


ACTION_VOCAB = [
    'IDLE',
    'DEFEND',
    'ATTACK_MOB',
    'ATTACK_PLAYER',
    'EAT',
    'EQUIP',
    'FLY',
    'GET_ITEMS',
    'USE_ITEM',
    'USE_TRIDENT',
    'ENCHANT',
    'USE_ANVIL',
    'BUILD',
    'BREAK',
    'SLEEP',
    'USE_FURNACE',
    'CRAFT',
    'COLLECT',
    'HELP_PLAYER',
    'SOCIAL',
    'TOGGLE_OFFHAND',
    'EXPLORE',
    'RECOVER',
    'COMMAND',
    'CHAT',
]

ACTION_TO_ID = {name: idx for idx, name in enumerate(ACTION_VOCAB)}
ID_TO_ACTION = {idx: name for name, idx in ACTION_TO_ID.items()}

INTENT_VOCAB = [
    'NONE',
    'EXPLORE',
    'BUILD',
    'COLLECT',
    'CRAFT',
    'COMBAT',
    'SOCIAL',
    'RECOVER',
    'SLEEP',
]

INTENT_TO_ID = {name: idx for idx, name in enumerate(INTENT_VOCAB)}


def _safe_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _safe_bool(value) -> float:
    return 1.0 if bool(value) else 0.0


def _safe_str(value, default='') -> str:
    if value is None:
        return default
    return str(value).strip()


def _contains_any(text: str, words: List[str]) -> bool:
    line = text.lower()
    return any(word in line for word in words)


def _categorize_item_name(name: str) -> str:
    n = _safe_str(name, '').lower()
    if not n or n == 'none':
        return 'NONE'
    if any(k in n for k in ['sword', 'axe', 'pickaxe', 'shovel', 'hoe']):
        return 'TOOL'
    if any(k in n for k in ['bow', 'crossbow', 'trident']):
        return 'RANGED'
    if any(k in n for k in ['bread', 'beef', 'pork', 'chicken', 'carrot', 'potato', 'apple', 'food']):
        return 'FOOD'
    if any(k in n for k in ['plank', 'stone', 'dirt', 'cobblestone', 'sand', 'glass', 'brick', 'block']):
        return 'BLOCK'
    return 'OTHER'


def _item_type_one_hot(name: str) -> List[float]:
    bucket = _categorize_item_name(name)
    keys = ['NONE', 'TOOL', 'RANGED', 'FOOD', 'BLOCK', 'OTHER']
    return [1.0 if bucket == key else 0.0 for key in keys]


def _closest_entity_features(entities: List[Dict]) -> List[float]:
    if not entities:
        return [0.0, 0.0, 0.0, 0.0, 99.0]

    nearest = min(entities, key=lambda e: _safe_float(e.get('distance'), 99.0))
    entity_type = _safe_str(nearest.get('type'), 'unknown').lower()

    is_player = 1.0 if entity_type == 'player' else 0.0
    is_mob = 1.0 if entity_type == 'mob' else 0.0
    is_object = 1.0 if entity_type == 'object' else 0.0
    is_other = 1.0 if not (is_player or is_mob or is_object) else 0.0
    nearest_dist = _safe_float(nearest.get('distance'), 99.0)

    return [is_player, is_mob, is_object, is_other, nearest_dist]


def _block_bucket(name: str) -> str:
    n = _safe_str(name, 'unknown').lower()
    if not n or n == 'unknown':
        return 'UNKNOWN'
    if n == 'air' or 'air' in n:
        return 'AIR'
    if 'water' in n or 'bubble_column' in n:
        return 'WATER'
    if 'lava' in n:
        return 'LAVA'
    if any(k in n for k in ['grass', 'flower', 'leaves', 'vine', 'sapling']):
        return 'PLANT'
    if any(k in n for k in ['crafting_table', 'furnace', 'chest', 'anvil', 'enchanting_table', 'bed']):
        return 'UTILITY'
    return 'SOLID'


def _block_one_hot(name: str) -> List[float]:
    bucket = _block_bucket(name)
    keys = ['UNKNOWN', 'AIR', 'WATER', 'LAVA', 'PLANT', 'UTILITY', 'SOLID']
    return [1.0 if bucket == key else 0.0 for key in keys]


def normalize_intent(intent_text: str) -> str:
    text = _safe_str(intent_text, '').lower()
    if not text:
        return 'NONE'
    if _contains_any(text, ['build', 'construct', 'hall', 'house', 'base']):
        return 'BUILD'
    if _contains_any(text, ['collect', 'gather', 'loot', 'pickup', 'resource']):
        return 'COLLECT'
    if _contains_any(text, ['craft', 'smelt', 'furnace', 'recipe']):
        return 'CRAFT'
    if _contains_any(text, ['attack', 'fight', 'defend', 'combat', 'mob', 'pvp']):
        return 'COMBAT'
    if _contains_any(text, ['chat', 'talk', 'social', 'help player']):
        return 'SOCIAL'
    if _contains_any(text, ['recover', 'escape', 'stabilize', 'water']):
        return 'RECOVER'
    if _contains_any(text, ['sleep', 'bed', 'night']):
        return 'SLEEP'
    if _contains_any(text, ['explore', 'wander', 'scout', 'move']):
        return 'EXPLORE'
    return 'NONE'


def _intent_one_hot(intent_text: str) -> List[float]:
    intent_name = normalize_intent(intent_text)
    return [1.0 if intent_name == key else 0.0 for key in INTENT_VOCAB]


def state_to_feature_vector(state: Dict, intent_override: str = '') -> np.ndarray:
    velocity = state.get('velocity', {})
    controls = state.get('controls', {})
    entities = state.get('nearbyEntities', [])
    inventory = state.get('inventory', [])
    held_item = state.get('heldItem', {})

    closest_entity = _closest_entity_features(entities)
    held_item_features = _item_type_one_hot(_safe_str(held_item.get('name', 'none'), 'none'))
    block_below_features = _block_one_hot(_safe_str(state.get('blockBelow', 'unknown'), 'unknown'))
    block_front_features = _block_one_hot(_safe_str(state.get('blockFront', 'unknown'), 'unknown'))
    intent_text = _safe_str(intent_override, '') or _safe_str(state.get('activeIntent', ''), '')
    intent_features = _intent_one_hot(intent_text)

    vx = _safe_float(velocity.get('vx'))
    vy = _safe_float(velocity.get('vy'))
    vz = _safe_float(velocity.get('vz'))
    horizontal_speed = float(np.sqrt(vx * vx + vz * vz))

    feature = [
        vx,
        vy,
        vz,
        horizontal_speed,
        _safe_bool(state.get('onGround')),
        _safe_bool(state.get('inAir')),
        _safe_bool(controls.get('forward')),
        _safe_bool(controls.get('back')),
        _safe_bool(controls.get('left')),
        _safe_bool(controls.get('right')),
        _safe_bool(controls.get('jump')),
        _safe_bool(controls.get('sprint')),
        _safe_bool(controls.get('sneak')),
        _safe_float(state.get('health'), 20.0),
        _safe_float(state.get('hunger'), 20.0),
        _safe_float(state.get('selectedHotbarSlot'), -1.0),
        float(len(entities)),
        float(len(inventory)),
        float(sum(int(item.get('count', 0)) for item in inventory if isinstance(item, dict))),
    ]

    feature.extend(held_item_features)
    feature.extend(closest_entity)
    feature.extend(block_below_features)
    feature.extend(block_front_features)
    feature.extend(intent_features)

    return np.array(feature, dtype=np.float32)


def normalize_action_label(action: Dict) -> str:
    label = str(action.get('label', 'IDLE') or 'IDLE').strip().upper()
    if label not in ACTION_TO_ID:
        return 'IDLE'
    return label


def load_dataset(jsonl_path: Path) -> Tuple[np.ndarray, np.ndarray]:
    features: List[np.ndarray] = []
    labels: List[int] = []

    with jsonl_path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            state = row.get('state', {})
            action = row.get('action', {})
            label_name = normalize_action_label(action)
            labels.append(ACTION_TO_ID[label_name])
            features.append(state_to_feature_vector(state, intent_override=_safe_str(state.get('activeIntent', ''), '')))

    if not features:
        raise ValueError(f'No records found in dataset: {jsonl_path}')

    x = np.stack(features)
    y = np.array(labels, dtype=np.int64)
    return x, y


def load_dataset_sequences(jsonl_path: Path, sequence_length: int = 8) -> Tuple[np.ndarray, np.ndarray]:
    seq_len = max(2, int(sequence_length))
    features: List[np.ndarray] = []
    labels: List[int] = []

    with jsonl_path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            state = row.get('state', {})
            action = row.get('action', {})
            label_name = normalize_action_label(action)
            labels.append(ACTION_TO_ID[label_name])
            features.append(state_to_feature_vector(state, intent_override=_safe_str(state.get('activeIntent', ''), '')))

    if len(features) < seq_len:
        raise ValueError(f'Not enough records for sequence_length={seq_len}. Found {len(features)} in dataset: {jsonl_path}')

    x_sequences: List[np.ndarray] = []
    y_targets: List[int] = []

    for end_idx in range(seq_len - 1, len(features)):
        start_idx = end_idx - seq_len + 1
        seq = np.stack(features[start_idx:end_idx + 1])
        x_sequences.append(seq)
        y_targets.append(labels[end_idx])

    x = np.stack(x_sequences).astype(np.float32)
    y = np.array(y_targets, dtype=np.int64)
    return x, y
