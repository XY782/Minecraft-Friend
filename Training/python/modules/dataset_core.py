import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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
    'MOVE',
    'COMBAT',
    'INTERACT',
    'DEFENSE',
    'SOCIAL',
]
INTENT_TO_ID = {name: idx for idx, name in enumerate(INTENT_VOCAB)}

HOSTILE_ENTITY_HINTS = [
    'zombie',
    'skeleton',
    'creeper',
    'spider',
    'witch',
    'pillager',
    'vindicator',
    'evoker',
    'enderman',
    'blaze',
    'ghast',
    'slime',
    'drowned',
]

ACTION_INTENT_MAP = {
    'IDLE': ['DEFENSE'],
    'DEFEND': ['DEFENSE'],
    'ATTACK_MOB': ['COMBAT', 'MOVE'],
    'ATTACK_PLAYER': ['COMBAT', 'MOVE'],
    'EAT': ['INTERACT', 'DEFENSE'],
    'EQUIP': ['INTERACT', 'DEFENSE'],
    'FLY': ['MOVE'],
    'GET_ITEMS': ['MOVE', 'INTERACT'],
    'USE_ITEM': ['INTERACT'],
    'USE_TRIDENT': ['COMBAT', 'INTERACT'],
    'ENCHANT': ['INTERACT'],
    'USE_ANVIL': ['INTERACT'],
    'BUILD': ['INTERACT', 'MOVE'],
    'BREAK': ['INTERACT', 'MOVE'],
    'SLEEP': ['DEFENSE'],
    'USE_FURNACE': ['INTERACT'],
    'CRAFT': ['INTERACT'],
    'COLLECT': ['MOVE', 'INTERACT'],
    'HELP_PLAYER': ['SOCIAL', 'MOVE', 'INTERACT'],
    'SOCIAL': ['SOCIAL'],
    'TOGGLE_OFFHAND': ['INTERACT'],
    'EXPLORE': ['MOVE'],
    'RECOVER': ['DEFENSE', 'MOVE'],
    'COMMAND': ['SOCIAL', 'INTERACT'],
    'CHAT': ['SOCIAL'],
}

OBSERVER_LIKELY_ACTION_WEIGHTS = {
    'BREAK': 1.0,
    'BUILD': 0.95,
    'COLLECT': 0.9,
    'ATTACK_MOB': 0.9,
    'ATTACK_PLAYER': 0.85,
    'HELP_PLAYER': 0.85,
    'USE_ITEM': 0.8,
    'CRAFT': 0.8,
    'USE_FURNACE': 0.8,
    'ENCHANT': 0.75,
    'USE_ANVIL': 0.75,
    'SOCIAL': 0.7,
    'CHAT': 0.65,
    'EXPLORE': 0.55,
    'RECOVER': 0.5,
    'DEFEND': 0.45,
    'IDLE': 0.1,
}

TEMPORAL_DELTA_CLIP = 5.0


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


def safe_timestamp_seconds(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 1e12:
            return ts / 1000.0
        if ts > 1e10:
            return ts / 1000.0
        return ts

    text = _safe_str(value, '')
    if not text:
        return 0.0
    try:
        ts = float(text)
        if ts > 1e12:
            return ts / 1000.0
        if ts > 1e10:
            return ts / 1000.0
        return ts
    except ValueError:
        pass

    try:
        return float(datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp())
    except ValueError:
        return 0.0


def _angle_wrap(delta: float) -> float:
    tau = 6.283185307179586
    d = float(delta)
    while d > np.pi:
        d -= tau
    while d < -np.pi:
        d += tau
    return d


def action_to_intent_vector(action_label: str) -> np.ndarray:
    label = _safe_str(action_label, 'IDLE').upper()
    intents = ACTION_INTENT_MAP.get(label, ['DEFENSE'])
    vec = np.zeros(len(INTENT_VOCAB), dtype=np.float32)
    for intent in intents:
        idx = INTENT_TO_ID.get(intent)
        if idx is not None:
            vec[idx] = 1.0
    return vec


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


def _inventory_bucket(name: str) -> str:
    n = _safe_str(name, '').lower()
    if not n or n == 'none':
        return 'OTHER'
    if any(k in n for k in ['sword', 'axe', 'trident', 'bow', 'crossbow']):
        return 'WEAPON'
    if any(k in n for k in ['pickaxe', 'shovel', 'hoe', 'shears', 'fishing_rod']):
        return 'TOOL'
    if any(k in n for k in ['bread', 'beef', 'pork', 'chicken', 'carrot', 'potato', 'apple', 'food']):
        return 'FOOD'
    if any(k in n for k in ['plank', 'stone', 'dirt', 'cobblestone', 'sand', 'glass', 'brick', 'block']):
        return 'BLOCK'
    if any(k in n for k in ['torch', 'table', 'furnace', 'bed', 'chest', 'anvil']):
        return 'UTILITY'
    return 'OTHER'


def _inventory_features(inventory: List[Dict]) -> List[float]:
    slots_used = 0
    total_count = 0.0
    max_stack = 0.0
    unique_items = set()
    bucket_counts = {
        'TOOL': 0.0,
        'FOOD': 0.0,
        'BLOCK': 0.0,
        'WEAPON': 0.0,
        'UTILITY': 0.0,
        'OTHER': 0.0,
    }

    for item in inventory:
        if not isinstance(item, dict):
            continue
        name = _safe_str(item.get('name'), 'none').lower()
        count = max(0.0, _safe_float(item.get('count'), 0.0))
        if name and name != 'none':
            slots_used += 1
            unique_items.add(name)
        total_count += count
        max_stack = max(max_stack, count)
        bucket_counts[_inventory_bucket(name)] += count

    return [
        float(slots_used),
        float(total_count),
        float(len(unique_items)),
        float(max_stack),
        float(bucket_counts['TOOL']),
        float(bucket_counts['FOOD']),
        float(bucket_counts['BLOCK']),
        float(bucket_counts['WEAPON']),
        float(bucket_counts['UTILITY']),
        float(bucket_counts['OTHER']),
    ]


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


def _entity_type_one_hot(entity_type: str) -> List[float]:
    et = _safe_str(entity_type, 'other').lower()
    if et == 'player':
        return [1.0, 0.0, 0.0, 0.0, 0.0]
    if et == 'mob':
        return [0.0, 1.0, 0.0, 0.0, 0.0]
    if et == 'object':
        return [0.0, 0.0, 1.0, 0.0, 0.0]
    if et == 'other':
        return [0.0, 0.0, 0.0, 1.0, 0.0]
    return [0.0, 0.0, 0.0, 0.0, 1.0]


def _player_position(state: Dict):
    pos = state.get('position') or {}
    if pos:
        return (
            _safe_float(pos.get('x')),
            _safe_float(pos.get('y')),
            _safe_float(pos.get('z')),
        )
    observer = state.get('observer') or {}
    observer_pos = observer.get('position') or {}
    if observer_pos:
        return (
            _safe_float(observer_pos.get('x')),
            _safe_float(observer_pos.get('y')),
            _safe_float(observer_pos.get('z')),
        )
    return None


def _entity_relative_direction(entity: Dict, state: Dict) -> List[float]:
    ex = _safe_float(entity.get('dx'))
    ey = _safe_float(entity.get('dy'))
    ez = _safe_float(entity.get('dz'))
    if ex or ey or ez:
        norm = max(1e-6, float(np.sqrt(ex * ex + ey * ey + ez * ez)))
        return [float(ex / norm), float(ey / norm), float(ez / norm)]

    player_pos = _player_position(state)
    entity_pos = (entity.get('position') or {}) if isinstance(entity.get('position'), dict) else {}
    if player_pos and entity_pos:
        ex = _safe_float(entity_pos.get('x')) - player_pos[0]
        ey = _safe_float(entity_pos.get('y')) - player_pos[1]
        ez = _safe_float(entity_pos.get('z')) - player_pos[2]
        norm = max(1e-6, float(np.sqrt(ex * ex + ey * ey + ez * ez)))
        return [float(ex / norm), float(ey / norm), float(ez / norm)]

    return [0.0, 0.0, 0.0]


def _top_k_entity_features(entities: List[Dict], state: Dict, k: int = 3) -> List[float]:
    sorted_entities = sorted(entities, key=lambda e: _safe_float(e.get('distance'), 99.0)) if entities else []
    features: List[float] = []

    for idx in range(k):
        if idx < len(sorted_entities):
            entity = sorted_entities[idx]
            dist = max(0.0, _safe_float(entity.get('distance'), 99.0))
            inv_dist = 1.0 / (1.0 + dist)
            rel = _entity_relative_direction(entity, state)
            features.extend([
                1.0,
                float(dist),
                float(inv_dist),
            ])
            features.extend(_entity_type_one_hot(entity.get('type')))
            features.extend(rel)
        else:
            features.extend([
                0.0,
                99.0,
                0.0,
            ])
            features.extend([0.0, 0.0, 0.0, 0.0, 0.0])
            features.extend([0.0, 0.0, 0.0])

    return features


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


def _nearby_blocks_features(nearby_blocks: List[Dict], nearby_blocks_stats: Dict = None) -> List[float]:
    keys = ['UNKNOWN', 'AIR', 'WATER', 'LAVA', 'PLANT', 'UTILITY', 'SOLID']
    bucket_counts = {k: 0.0 for k in keys}
    layer_non_air = {-1: 0.0, 0: 0.0, 1: 0.0}
    layer_total = {-1: 0.0, 0: 0.0, 1: 0.0}
    non_air_weighted_dy = 0.0
    non_air_count = 0.0

    for entry in nearby_blocks:
        if not isinstance(entry, dict):
            continue
        count = max(1.0, _safe_float(entry.get('count'), 1.0))
        name = _safe_str(entry.get('block'), 'unknown')
        bucket = _block_bucket(name)
        bucket_counts[bucket] += count
        dy = int(_safe_float(entry.get('dy'), 0.0))
        has_explicit_dy = 'dy' in entry
        if has_explicit_dy and dy in layer_total:
            layer_total[dy] += count
            if bucket != 'AIR':
                layer_non_air[dy] += count
        if bucket != 'AIR':
            non_air_weighted_dy += float(dy) * count
            non_air_count += count

    if isinstance(nearby_blocks_stats, dict):
        stats_bucket = nearby_blocks_stats.get('bucketCounts', {})
        if isinstance(stats_bucket, dict):
            for key in keys:
                bucket_counts[key] = max(0.0, _safe_float(stats_bucket.get(key), bucket_counts[key]))

        stats_layer_total = nearby_blocks_stats.get('layerTotals', {})
        stats_layer_non_air = nearby_blocks_stats.get('layerNonAir', {})
        if isinstance(stats_layer_total, dict):
            for layer in [-1, 0, 1]:
                layer_total[layer] = max(0.0, _safe_float(stats_layer_total.get(str(layer)), layer_total[layer]))
        if isinstance(stats_layer_non_air, dict):
            for layer in [-1, 0, 1]:
                layer_non_air[layer] = max(0.0, _safe_float(stats_layer_non_air.get(str(layer)), layer_non_air[layer]))

        non_air_count = max(0.0, _safe_float(nearby_blocks_stats.get('nonAirCount'), non_air_count))
        if non_air_count > 0:
            mean_non_air_dy_stats = _safe_float(nearby_blocks_stats.get('meanNonAirDy'), non_air_weighted_dy / max(1.0, non_air_count))
            non_air_weighted_dy = mean_non_air_dy_stats * non_air_count

    total = max(1.0, sum(bucket_counts.values()))
    bucket_distribution = [float(bucket_counts[k] / total) for k in keys]
    layer_density = [
        float(layer_non_air[-1] / max(1.0, layer_total[-1])),
        float(layer_non_air[0] / max(1.0, layer_total[0])),
        float(layer_non_air[1] / max(1.0, layer_total[1])),
    ]
    overall_non_air = float(non_air_count / total)
    mean_non_air_dy = float(non_air_weighted_dy / max(1.0, non_air_count))

    return bucket_distribution + layer_density + [overall_non_air, mean_non_air_dy]


def _threat_features(entities: List[Dict]) -> List[float]:
    mob_count = 0.0
    hostile_count = 0.0
    nearest_hostile_dist = 99.0
    player_count = 0.0

    for entity in entities:
        if not isinstance(entity, dict):
            continue
        entity_type = _safe_str(entity.get('type'), 'other').lower()
        entity_name = _safe_str(entity.get('name'), '').lower()
        dist = max(0.0, _safe_float(entity.get('distance'), 99.0))

        if entity_type == 'mob':
            mob_count += 1.0
        if entity_type == 'player':
            player_count += 1.0

        is_hostile = entity_type == 'mob' or any(hint in entity_name for hint in HOSTILE_ENTITY_HINTS)
        if is_hostile:
            hostile_count += 1.0
            nearest_hostile_dist = min(nearest_hostile_dist, dist)

    hostile_pressure = float(hostile_count / max(1.0, float(len(entities))))
    return [
        float(mob_count),
        float(hostile_count),
        float(player_count),
        float(nearest_hostile_dist),
        float(hostile_pressure),
    ]


def state_to_feature_vector(state: Dict, delta_time: float = 0.0) -> np.ndarray:
    velocity = state.get('velocity', {})
    entities = state.get('nearbyEntities', [])
    inventory = state.get('inventory', [])
    nearby_blocks = state.get('nearbyBlocks', [])
    nearby_blocks_stats = state.get('nearbyBlocksStats', {})
    held_item = state.get('heldItem', {})
    observer = state.get('observer') or {}
    if not isinstance(observer, dict):
        observer = {}

    entity_features = _top_k_entity_features(entities, state, k=3)
    inventory_features = _inventory_features(inventory)
    nearby_blocks_features = _nearby_blocks_features(nearby_blocks, nearby_blocks_stats)
    threat_features = _threat_features(entities)
    held_item_features = _item_type_one_hot(_safe_str(held_item.get('name', 'none'), 'none'))
    block_below_features = _block_one_hot(_safe_str(state.get('blockBelow', 'unknown'), 'unknown'))
    block_front_features = _block_one_hot(_safe_str(state.get('blockFront', 'unknown'), 'unknown'))

    vx = _safe_float(velocity.get('vx'))
    vy = _safe_float(velocity.get('vy'))
    vz = _safe_float(velocity.get('vz'))
    horizontal_speed = float(np.sqrt(vx * vx + vz * vz))
    yaw = _safe_float(state.get('yaw'), _safe_float(observer.get('yaw')))
    pitch = _safe_float(state.get('pitch'), _safe_float(observer.get('pitch')))
    yaw_sin = float(np.sin(yaw))
    yaw_cos = float(np.cos(yaw))
    pitch_sin = float(np.sin(pitch))
    pitch_cos = float(np.cos(pitch))

    feature = [
        vx,
        vy,
        vz,
        horizontal_speed,
        float(max(0.0, min(5.0, _safe_float(delta_time, 0.0)))),
        yaw_sin,
        yaw_cos,
        pitch_sin,
        pitch_cos,
        _safe_bool(state.get('onGround')),
        _safe_bool(state.get('inAir')),
        _safe_float(state.get('health'), 20.0),
        _safe_float(state.get('hunger'), 20.0),
        _safe_float(state.get('selectedHotbarSlot'), -1.0),
        float(len(entities)),
    ]

    feature.extend(inventory_features)
    feature.extend(held_item_features)
    feature.extend(entity_features)
    feature.extend(block_below_features)
    feature.extend(block_front_features)
    feature.extend(nearby_blocks_features)
    feature.extend(threat_features)

    return np.array(feature, dtype=np.float32)


def normalize_action_label(action: Dict) -> str:
    label = str(action.get('label', 'IDLE') or 'IDLE').strip().upper()
    if label in ACTION_TO_ID:
        return label

    if label.startswith('OBSERVER_'):
        observer_suffix = label[len('OBSERVER_'):]
        observer_map = {
            'IDLE': 'IDLE',
            'MOVE': 'EXPLORE',
            'SPRINT': 'EXPLORE',
            'JUMP': 'EXPLORE',
            'LOOK': 'SOCIAL',
            'CHAT': 'CHAT',
            'BREAK': 'BREAK',
            'BUILD': 'BUILD',
            'COLLECT': 'COLLECT',
            'ATTACK': 'ATTACK_MOB',
            'CRAFT': 'CRAFT',
            'USE_FURNACE': 'USE_FURNACE',
            'ENCHANT': 'ENCHANT',
            'USE_ANVIL': 'USE_ANVIL',
            'EAT': 'EAT',
            'DEFEND': 'DEFEND',
        }
        mapped = observer_map.get(observer_suffix)
        if mapped is not None and mapped in ACTION_TO_ID:
            return mapped

        metadata = action.get('metadata') if isinstance(action, dict) else None
        likely_actions = metadata.get('likelyActions') if isinstance(metadata, dict) else None
        if isinstance(likely_actions, list):
            best_candidate = None
            best_score = -1.0
            for candidate in likely_actions:
                candidate_label = str(candidate or '').strip().upper()
                if candidate_label in ACTION_TO_ID:
                    score = float(OBSERVER_LIKELY_ACTION_WEIGHTS.get(candidate_label, 0.4))
                    if score > best_score:
                        best_score = score
                        best_candidate = candidate_label
            if best_candidate is not None:
                return best_candidate

        return 'EXPLORE'

    return label


def _action_one_hot(action_id: Optional[int]) -> np.ndarray:
    vec = np.zeros(len(ACTION_VOCAB), dtype=np.float32)
    if action_id is not None and 0 <= int(action_id) < len(ACTION_VOCAB):
        vec[int(action_id)] = 1.0
    return vec


def augment_feature_with_temporal_context(
    current_feature: np.ndarray,
    prev_feature: Optional[np.ndarray],
    prev_action_id: Optional[int],
) -> np.ndarray:
    current = np.array(current_feature, dtype=np.float32)
    if prev_feature is None:
        previous = np.array(current, dtype=np.float32)
    else:
        previous = np.array(prev_feature, dtype=np.float32)
    delta = np.clip(current - previous, -float(TEMPORAL_DELTA_CLIP), float(TEMPORAL_DELTA_CLIP))
    prev_action = _action_one_hot(prev_action_id)
    return np.concatenate([current, delta, prev_action], axis=0).astype(np.float32)


def _augment_temporal_stream(features: List[np.ndarray], labels: List[int]) -> np.ndarray:
    augmented: List[np.ndarray] = []
    prev_feature: Optional[np.ndarray] = None
    prev_action_id: Optional[int] = None
    for idx, feature in enumerate(features):
        augmented.append(augment_feature_with_temporal_context(feature, prev_feature, prev_action_id))
        prev_feature = feature
        prev_action_id = int(labels[idx]) if idx < len(labels) else None
    return np.stack(augmented).astype(np.float32)


def _read_jsonl_rows(jsonl_path: Path) -> List[Dict]:
    rows: List[Dict] = []
    with jsonl_path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _rows_to_features_and_labels(rows: List[Dict]) -> Tuple[List[np.ndarray], List[int]]:
    features: List[np.ndarray] = []
    labels: List[int] = []
    prev_ts = 0.0
    for row in rows:
        state = row.get('state', {})
        action = row.get('action', {})
        ts = safe_timestamp_seconds(row.get('timestamp', state.get('timestamp')))
        delta_time = max(0.0, ts - prev_ts) if prev_ts > 0.0 and ts > 0.0 else 0.0
        if ts > 0.0:
            prev_ts = ts
        label_name = normalize_action_label(action)
        labels.append(ACTION_TO_ID[label_name])
        features.append(state_to_feature_vector(state, delta_time=delta_time))
    return features, labels


def _build_sequences(x: np.ndarray, y: np.ndarray, sequence_length: int, name: str, jsonl_path: Path):
    seq_len = max(2, int(sequence_length))
    if len(x) < seq_len:
        raise ValueError(f'Not enough records for {name}={seq_len}. Found {len(x)} in dataset: {jsonl_path}')
    x_sequences: List[np.ndarray] = []
    y_targets: List[int] = []
    for end_idx in range(seq_len - 1, len(x)):
        start_idx = end_idx - seq_len + 1
        x_sequences.append(np.stack(x[start_idx:end_idx + 1]))
        y_targets.append(int(y[end_idx]))
    return np.stack(x_sequences).astype(np.float32), np.array(y_targets, dtype=np.int64)


def load_dataset(jsonl_path: Path) -> Tuple[np.ndarray, np.ndarray]:
    rows = _read_jsonl_rows(jsonl_path)
    features, labels = _rows_to_features_and_labels(rows)
    if not features:
        raise ValueError(f'No records found in dataset: {jsonl_path}')
    x = _augment_temporal_stream(features, labels)
    return x, np.array(labels, dtype=np.int64)


def load_dataset_sequences(jsonl_path: Path, sequence_length: int = 8) -> Tuple[np.ndarray, np.ndarray]:
    x, y = load_dataset(jsonl_path)
    return _build_sequences(x, y, sequence_length, 'sequence_length', jsonl_path)


def _control_target_from_states(current_state: Dict, next_state: Dict) -> np.ndarray:
    current_velocity = current_state.get('velocity', {})
    next_velocity = next_state.get('velocity', {})

    next_vx = _safe_float(next_velocity.get('vx'))
    next_vy = _safe_float(next_velocity.get('vy'))
    next_vz = _safe_float(next_velocity.get('vz'))
    current_yaw = _safe_float(current_state.get('yaw'))
    next_yaw = _safe_float(next_state.get('yaw'))
    current_pitch = _safe_float(current_state.get('pitch'))
    next_pitch = _safe_float(next_state.get('pitch'))

    if not current_yaw and isinstance(current_state.get('observer'), dict):
        current_yaw = _safe_float((current_state.get('observer') or {}).get('yaw'))
    if not next_yaw and isinstance(next_state.get('observer'), dict):
        next_yaw = _safe_float((next_state.get('observer') or {}).get('yaw'))
    if not current_pitch and isinstance(current_state.get('observer'), dict):
        current_pitch = _safe_float((current_state.get('observer') or {}).get('pitch'))
    if not next_pitch and isinstance(next_state.get('observer'), dict):
        next_pitch = _safe_float((next_state.get('observer') or {}).get('pitch'))

    current_speed = float(np.sqrt(_safe_float(current_velocity.get('vx')) ** 2 + _safe_float(current_velocity.get('vz')) ** 2))
    next_speed = float(np.sqrt(next_vx * next_vx + next_vz * next_vz))

    dyaw = _angle_wrap(next_yaw - current_yaw)
    dpitch = _angle_wrap(next_pitch - current_pitch)
    jump_like = 1.0 if (next_vy > 0.08 or bool(next_state.get('inAir'))) else 0.0

    target = np.array([
        float(np.clip(next_vx, -1.5, 1.5)),
        float(np.clip(next_vz, -1.5, 1.5)),
        float(np.clip(next_vy, -1.5, 1.5)),
        float(np.clip(next_speed, 0.0, 2.0)),
        float(np.clip(next_speed - current_speed, -1.0, 1.0)),
        float(np.clip(dyaw, -np.pi, np.pi)),
        float(np.clip(dpitch, -1.6, 1.6)),
        float(jump_like),
    ], dtype=np.float32)
    return target


def load_dataset_hybrid(jsonl_path: Path) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rows = _read_jsonl_rows(jsonl_path)

    if len(rows) < 2:
        raise ValueError(f'Not enough records for hybrid dataset. Need at least 2 rows in {jsonl_path}')

    features: List[np.ndarray] = []
    labels: List[int] = []
    intents: List[np.ndarray] = []
    controls: List[np.ndarray] = []
    prev_ts = 0.0

    for idx in range(len(rows) - 1):
        row = rows[idx]
        next_row = rows[idx + 1]
        state = row.get('state', {})
        action = row.get('action', {})
        next_state = next_row.get('state', {})

        ts = safe_timestamp_seconds(row.get('timestamp', state.get('timestamp')))
        delta_time = max(0.0, ts - prev_ts) if prev_ts > 0.0 and ts > 0.0 else 0.0
        if ts > 0.0:
            prev_ts = ts

        label_name = normalize_action_label(action)
        features.append(state_to_feature_vector(state, delta_time=delta_time))
        labels.append(ACTION_TO_ID[label_name])
        intents.append(action_to_intent_vector(label_name))
        controls.append(_control_target_from_states(state, next_state))

    x = _augment_temporal_stream(features, labels)
    return x, np.array(labels, dtype=np.int64), np.stack(intents).astype(np.float32), np.stack(controls).astype(np.float32)


def load_dataset_sequences_hybrid(
    jsonl_path: Path,
    sequence_length: int = 8,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    x, y, intent, control = load_dataset_hybrid(jsonl_path)
    seq_len = max(2, int(sequence_length))
    if len(x) < seq_len:
        raise ValueError(f'Not enough records for hybrid sequence_length={seq_len}. Found {len(x)} in dataset: {jsonl_path}')

    x_sequences: List[np.ndarray] = []
    y_targets: List[int] = []
    intent_targets: List[np.ndarray] = []
    control_targets: List[np.ndarray] = []

    for end_idx in range(seq_len - 1, len(x)):
        start_idx = end_idx - seq_len + 1
        x_sequences.append(np.stack(x[start_idx:end_idx + 1]))
        y_targets.append(int(y[end_idx]))
        intent_targets.append(intent[end_idx])
        control_targets.append(control[end_idx])

    return np.stack(x_sequences).astype(np.float32), np.array(y_targets, dtype=np.int64), np.stack(intent_targets).astype(np.float32), np.stack(control_targets).astype(np.float32)


def load_dataset_sequences_hybrid_dense(
    jsonl_path: Path,
    sequence_length: int = 8,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    seq_len = max(2, int(sequence_length))
    x, y, intent, control = load_dataset_hybrid(jsonl_path)
    if len(x) < seq_len:
        raise ValueError(f'Not enough records for hybrid sequence_length={seq_len}. Found {len(x)} in dataset: {jsonl_path}')

    x_sequences: List[np.ndarray] = []
    y_sequences: List[np.ndarray] = []
    intent_sequences: List[np.ndarray] = []
    control_sequences: List[np.ndarray] = []

    for end_idx in range(seq_len - 1, len(x)):
        start_idx = end_idx - seq_len + 1
        x_sequences.append(np.stack(x[start_idx:end_idx + 1]))
        y_sequences.append(np.array(y[start_idx:end_idx + 1], dtype=np.int64))
        intent_sequences.append(np.stack(intent[start_idx:end_idx + 1]).astype(np.float32))
        control_sequences.append(np.stack(control[start_idx:end_idx + 1]).astype(np.float32))

    return (
        np.stack(x_sequences).astype(np.float32),
        np.stack(y_sequences).astype(np.int64),
        np.stack(intent_sequences).astype(np.float32),
        np.stack(control_sequences).astype(np.float32),
    )
