import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Tuple


OBSERVER_ACTION_MAP = {
    'OBSERVER_IDLE': 'IDLE',
    'OBSERVER_LOOK': 'EXPLORE',
    'OBSERVER_MOVE': 'EXPLORE',
    'OBSERVER_SPRINT': 'EXPLORE',
    'OBSERVER_JUMP': 'EXPLORE',
}


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _safe_bool(value) -> bool:
    return bool(value)


def _safe_ts_ms(timestamp: str) -> int:
    text = str(timestamp or '').strip()
    if not text:
        return 0
    try:
        return int(datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return 0


def _distance(a: Dict, b: Dict) -> float:
    dx = _safe_float(a.get('x')) - _safe_float(b.get('x'))
    dy = _safe_float(a.get('y')) - _safe_float(b.get('y'))
    dz = _safe_float(a.get('z')) - _safe_float(b.get('z'))
    return (dx * dx + dy * dy + dz * dz) ** 0.5


def _angle_delta(a: float, b: float) -> float:
    delta = abs(_safe_float(a) - _safe_float(b))
    tau = 6.283185307179586
    if delta > tau:
        delta = delta % tau
    return min(delta, tau - delta)


def _normalize_action(action_label: str, remap_observer_actions: bool) -> str:
    label = str(action_label or 'IDLE').strip().upper()
    if remap_observer_actions:
        return OBSERVER_ACTION_MAP.get(label, label)
    return label


def _clean_state(raw_state: Dict, remove_chat: bool, drop_absolute_position: bool) -> Dict:
    observer = raw_state.get('observer') or None
    yaw = _safe_float(raw_state.get('yaw'))
    pitch = _safe_float(raw_state.get('pitch'))
    if not yaw and observer:
        yaw = _safe_float(observer.get('yaw'))
    if not pitch and observer:
        pitch = _safe_float(observer.get('pitch'))

    state = {
        'velocity': {
            'vx': _safe_float((raw_state.get('velocity') or {}).get('vx')),
            'vy': _safe_float((raw_state.get('velocity') or {}).get('vy')),
            'vz': _safe_float((raw_state.get('velocity') or {}).get('vz')),
        },
        'yaw': yaw,
        'pitch': pitch,
        'onGround': _safe_bool(raw_state.get('onGround')),
        'inAir': _safe_bool(raw_state.get('inAir')),
        'health': _safe_float(raw_state.get('health'), 20.0),
        'hunger': _safe_float(raw_state.get('hunger'), 20.0),
        'selectedHotbarSlot': int(_safe_float(raw_state.get('selectedHotbarSlot'), -1)),
        'heldItem': {
            'name': str(((raw_state.get('heldItem') or {}).get('name') or 'none')).strip() or 'none',
            'type': int(_safe_float((raw_state.get('heldItem') or {}).get('type'), -1)),
        },
        'blockBelow': str(raw_state.get('blockBelow') or 'unknown'),
        'blockFront': str(raw_state.get('blockFront') or 'unknown'),
        'nearbyBlocks': list(raw_state.get('nearbyBlocks') or []),
        'nearbyEntities': list(raw_state.get('nearbyEntities') or []),
        'inventory': list(raw_state.get('inventory') or []),
    }

    if not drop_absolute_position:
        state['position'] = {
            'x': _safe_float((raw_state.get('position') or {}).get('x')),
            'y': _safe_float((raw_state.get('position') or {}).get('y')),
            'z': _safe_float((raw_state.get('position') or {}).get('z')),
        }

    if observer:
        observer_clean = {
            'username': str(observer.get('username') or '').strip(),
            'distance': _safe_float(observer.get('distance'), 0.0),
            'velocity': {
                'vx': _safe_float((observer.get('velocity') or {}).get('vx')),
                'vy': _safe_float((observer.get('velocity') or {}).get('vy')),
                'vz': _safe_float((observer.get('velocity') or {}).get('vz')),
            },
            'yaw': _safe_float(observer.get('yaw')),
            'pitch': _safe_float(observer.get('pitch')),
            'onGround': _safe_bool(observer.get('onGround')),
        }
        if not drop_absolute_position:
            observer_clean['position'] = {
                'x': _safe_float((observer.get('position') or {}).get('x')),
                'y': _safe_float((observer.get('position') or {}).get('y')),
                'z': _safe_float((observer.get('position') or {}).get('z')),
            }
        state['observer'] = observer_clean

    if not remove_chat:
        state['lastChatMessages'] = list(raw_state.get('lastChatMessages') or [])

    return state


@dataclass
class CleanStats:
    total: int = 0
    kept: int = 0
    skipped_non_observer: int = 0
    skipped_mixed_state: int = 0
    skipped_downsample: int = 0
    skipped_parse_error: int = 0
    skipped_unsuccessful: int = 0
    skipped_fallback_source: int = 0
    skipped_state_only_source: int = 0
    skipped_idle: int = 0
    skipped_no_state_change: int = 0


def _is_meaningful_state_change(
    current_state: Dict,
    previous_state: Optional[Dict],
    min_pos_delta: float,
    min_vel_delta: float,
    min_yaw_pitch_delta: float,
) -> bool:
    if previous_state is None:
        return True

    current_pos = current_state.get('position') or {}
    previous_pos = previous_state.get('position') or {}
    pos_delta = _distance(current_pos, previous_pos)

    current_vel = current_state.get('velocity') or {}
    previous_vel = previous_state.get('velocity') or {}
    vel_delta = _distance(
        {'x': current_vel.get('vx'), 'y': current_vel.get('vy'), 'z': current_vel.get('vz')},
        {'x': previous_vel.get('vx'), 'y': previous_vel.get('vy'), 'z': previous_vel.get('vz')},
    )

    yaw_delta = _angle_delta(current_state.get('yaw'), previous_state.get('yaw'))
    pitch_delta = _angle_delta(current_state.get('pitch'), previous_state.get('pitch'))
    look_delta = max(yaw_delta, pitch_delta)

    if pos_delta >= max(0.01, float(min_pos_delta)):
        return True
    if vel_delta >= max(0.001, float(min_vel_delta)):
        return True
    if look_delta >= max(0.001, float(min_yaw_pitch_delta)):
        return True

    if bool(current_state.get('onGround')) != bool(previous_state.get('onGround')):
        return True
    if bool(current_state.get('inAir')) != bool(previous_state.get('inAir')):
        return True

    current_below = str(current_state.get('blockBelow') or '')
    previous_below = str(previous_state.get('blockBelow') or '')
    if current_below != previous_below:
        return True

    current_front = str(current_state.get('blockFront') or '')
    previous_front = str(previous_state.get('blockFront') or '')
    if current_front != previous_front:
        return True

    current_entities = len(current_state.get('nearbyEntities') or [])
    previous_entities = len(previous_state.get('nearbyEntities') or [])
    if current_entities != previous_entities:
        return True

    current_slot = int(_safe_float(current_state.get('selectedHotbarSlot'), -1))
    previous_slot = int(_safe_float(previous_state.get('selectedHotbarSlot'), -1))
    if current_slot != previous_slot:
        return True

    current_item = str(((current_state.get('heldItem') or {}).get('name') or '')).strip()
    previous_item = str(((previous_state.get('heldItem') or {}).get('name') or '')).strip()
    if current_item != previous_item:
        return True

    return False


def clean_jsonl(
    input_path: Path,
    output_path: Path,
    observer_only: bool,
    max_state_observer_delta: float,
    min_sample_ms: int,
    min_idle_sample_ms: int,
    min_move_distance: float,
    remap_observer_actions: bool,
    remove_chat: bool,
    drop_absolute_position: bool,
    only_successful_actions: bool,
    drop_fallback_sources: bool,
    drop_state_only_sources: bool,
    drop_idle_actions: bool,
    state_change_only: bool,
    min_state_change_pos: float,
    min_state_change_vel: float,
    min_state_change_yaw_pitch: float,
) -> CleanStats:
    stats = CleanStats()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    last_kept_ts = 0
    last_kept_label = ''
    last_kept_pos: Optional[Tuple[float, float, float]] = None
    last_kept_vel: Optional[Tuple[float, float, float]] = None
    last_kept_yaw = 0.0
    last_kept_pitch = 0.0
    last_kept_ground: Optional[Tuple[bool, bool]] = None
    last_kept_state: Optional[Dict] = None

    with input_path.open('r', encoding='utf-8') as source, output_path.open('w', encoding='utf-8') as target:
        for line in source:
            line = line.strip()
            if not line:
                continue

            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                stats.skipped_parse_error += 1
                continue

            stats.total += 1
            state = row.get('state') or {}
            action = row.get('action') or {}
            source_name = str(action.get('source') or '').strip().lower()

            if observer_only and source_name != 'observer-mode':
                stats.skipped_non_observer += 1
                continue

            observer = state.get('observer') or {}
            observer_pos = observer.get('position') or {}
            state_pos = state.get('position') or {}
            has_observer_pos = bool(observer_pos)

            if observer_only and not has_observer_pos:
                stats.skipped_mixed_state += 1
                continue

            if observer_only:
                delta = _distance(state_pos, observer_pos)
                if delta > max_state_observer_delta:
                    stats.skipped_mixed_state += 1
                    continue

            timestamp = str(row.get('timestamp') or '').strip()
            ts_ms = _safe_ts_ms(timestamp)
            raw_label = str(action.get('label') or 'IDLE').strip().upper()
            label = _normalize_action(raw_label, remap_observer_actions)
            action_success = action.get('success')

            if drop_fallback_sources and source_name.startswith('fallback'):
                stats.skipped_fallback_source += 1
                continue

            if drop_state_only_sources and source_name == 'state-only':
                stats.skipped_state_only_source += 1
                continue

            if only_successful_actions and action_success is not True:
                stats.skipped_unsuccessful += 1
                continue

            if drop_idle_actions and label == 'IDLE':
                stats.skipped_idle += 1
                continue

            gap_required = min_idle_sample_ms if raw_label == 'OBSERVER_IDLE' else min_sample_ms
            if last_kept_ts > 0 and ts_ms > 0 and (ts_ms - last_kept_ts) < gap_required:
                stats.skipped_downsample += 1
                continue

            cleaned_state = _clean_state(
                state,
                remove_chat=remove_chat,
                drop_absolute_position=drop_absolute_position,
            )

            if state_change_only and not _is_meaningful_state_change(
                cleaned_state,
                last_kept_state,
                min_pos_delta=float(min_state_change_pos),
                min_vel_delta=float(min_state_change_vel),
                min_yaw_pitch_delta=float(min_state_change_yaw_pitch),
            ):
                stats.skipped_no_state_change += 1
                continue

            pos_tuple = (
                _safe_float(state_pos.get('x')),
                _safe_float(state_pos.get('y')),
                _safe_float(state_pos.get('z')),
            )
            vel = cleaned_state.get('velocity') or {}
            vel_tuple = (
                _safe_float(vel.get('vx')),
                _safe_float(vel.get('vy')),
                _safe_float(vel.get('vz')),
            )
            yaw_value = _safe_float(cleaned_state.get('yaw'))
            pitch_value = _safe_float(cleaned_state.get('pitch'))
            ground_tuple = (_safe_bool(cleaned_state.get('onGround')), _safe_bool(cleaned_state.get('inAir')))

            if (
                raw_label == 'OBSERVER_IDLE'
                and last_kept_label == raw_label
                and last_kept_pos is not None
                and _distance(
                    {'x': pos_tuple[0], 'y': pos_tuple[1], 'z': pos_tuple[2]},
                    {'x': last_kept_pos[0], 'y': last_kept_pos[1], 'z': last_kept_pos[2]},
                ) < 0.12
            ):
                stats.skipped_downsample += 1
                continue

            if (
                last_kept_label == label
                and last_kept_vel is not None
                and last_kept_ground is not None
                and _distance(
                    {'x': vel_tuple[0], 'y': vel_tuple[1], 'z': vel_tuple[2]},
                    {'x': last_kept_vel[0], 'y': last_kept_vel[1], 'z': last_kept_vel[2]},
                ) < 0.035
                and _distance(
                    {'x': pos_tuple[0], 'y': pos_tuple[1], 'z': pos_tuple[2]},
                    {'x': last_kept_pos[0], 'y': last_kept_pos[1], 'z': last_kept_pos[2]},
                ) < 0.08
                and _angle_delta(yaw_value, last_kept_yaw) < 0.03
                and _angle_delta(pitch_value, last_kept_pitch) < 0.02
                and ground_tuple == last_kept_ground
            ):
                stats.skipped_downsample += 1
                continue

            horizontal_pos_delta = _distance(
                {'x': pos_tuple[0], 'y': 0.0, 'z': pos_tuple[2]},
                {'x': last_kept_pos[0], 'y': 0.0, 'z': last_kept_pos[2]},
            ) if last_kept_pos is not None else 0.0
            velocity_delta = _distance(
                {'x': vel_tuple[0], 'y': vel_tuple[1], 'z': vel_tuple[2]},
                {'x': last_kept_vel[0], 'y': last_kept_vel[1], 'z': last_kept_vel[2]},
            ) if last_kept_vel is not None else 0.0
            if (
                last_kept_label == label
                and label in {'IDLE', 'EXPLORE', 'OBSERVER_IDLE', 'OBSERVER_LOOK'}
                and last_kept_ground is not None
                and horizontal_pos_delta < 0.16
                and velocity_delta < 0.06
                and _angle_delta(yaw_value, last_kept_yaw) < 0.06
                and _angle_delta(pitch_value, last_kept_pitch) < 0.04
                and ground_tuple == last_kept_ground
            ):
                stats.skipped_downsample += 1
                continue

            move_like_label = label in {'EXPLORE', 'OBSERVER_MOVE', 'OBSERVER_SPRINT'}
            if (
                move_like_label
                and last_kept_pos is not None
                and horizontal_pos_delta < max(0.1, float(min_move_distance))
                and velocity_delta < 0.18
                and _angle_delta(yaw_value, last_kept_yaw) < 0.25
            ):
                stats.skipped_downsample += 1
                continue

            cleaned_row = {
                'timestamp': timestamp,
                'state': cleaned_state,
                'action': {
                    'label': label,
                    'success': action_success,
                    'source': source_name or action.get('source'),
                    'metadata': action.get('metadata') or {},
                },
            }

            target.write(json.dumps(cleaned_row, ensure_ascii=False) + '\n')
            stats.kept += 1
            last_kept_ts = ts_ms if ts_ms > 0 else last_kept_ts
            last_kept_label = label
            last_kept_pos = pos_tuple
            last_kept_vel = vel_tuple
            last_kept_yaw = yaw_value
            last_kept_pitch = pitch_value
            last_kept_ground = ground_tuple
            last_kept_state = cleaned_state

    return stats


def build_clean_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Clean Minecraft state-action JSONL for training.')
    parser.add_argument('--input', required=True, help='Path to input JSONL dataset')
    parser.add_argument('--output', default='', help='Path to output cleaned JSONL (default: <input>.clean.jsonl)')
    parser.add_argument('--observer-only', action='store_true', default=True, help='Keep only observer-mode rows')
    parser.add_argument('--keep-all-sources', action='store_true', help='Keep all action sources (disables --observer-only)')
    parser.add_argument('--max-state-observer-delta', type=float, default=0.6, help='Max allowed distance between state.position and state.observer.position')
    parser.add_argument('--min-sample-ms', type=int, default=300, help='Minimum gap between kept non-idle samples')
    parser.add_argument('--min-idle-sample-ms', type=int, default=900, help='Minimum gap between kept idle samples')
    parser.add_argument('--min-move-distance', type=float, default=1.0, help='Minimum horizontal movement for move-like labels')
    parser.add_argument('--no-remap-observer-actions', action='store_true', help='Keep OBSERVER_* labels instead of remapping to existing action vocab')
    parser.add_argument('--keep-chat', action='store_true', help='Keep state.lastChatMessages')
    parser.add_argument('--keep-absolute-position', action='store_true', help='Keep state.position and observer.position fields')
    parser.add_argument('--only-successful-actions', action='store_true', help='Keep only rows where action.success is true')
    parser.add_argument('--drop-fallback-sources', action='store_true', help='Drop rows where action.source starts with fallback')
    parser.add_argument('--drop-state-only-sources', action='store_true', help='Drop rows where action.source is state-only')
    parser.add_argument('--drop-idle-actions', action='store_true', help='Drop rows where normalized action label is IDLE')
    parser.add_argument('--state-change-only', action='store_true', help='Keep only rows with meaningful state changes vs last kept row')
    parser.add_argument('--min-state-change-pos', type=float, default=0.18, help='Minimum 3D position delta for state-change filter')
    parser.add_argument('--min-state-change-vel', type=float, default=0.07, help='Minimum velocity delta for state-change filter')
    parser.add_argument('--min-state-change-yaw-pitch', type=float, default=0.08, help='Minimum yaw/pitch delta for state-change filter')
    return parser


def run_cleaning(args) -> Tuple[Path, Path, CleanStats]:
    input_path = Path(args.input).resolve()
    if not input_path.exists():
        raise FileNotFoundError(f'Input dataset not found: {input_path}')

    if args.output:
        output_path = Path(args.output).resolve()
    else:
        output_path = input_path.with_suffix('').with_name(input_path.stem + '.clean.jsonl')

    observer_only = False if args.keep_all_sources else bool(args.observer_only)
    stats = clean_jsonl(
        input_path=input_path,
        output_path=output_path,
        observer_only=observer_only,
        max_state_observer_delta=float(args.max_state_observer_delta),
        min_sample_ms=max(0, int(args.min_sample_ms)),
        min_idle_sample_ms=max(0, int(args.min_idle_sample_ms)),
        min_move_distance=max(0.1, float(args.min_move_distance)),
        remap_observer_actions=not bool(args.no_remap_observer_actions),
        remove_chat=not bool(args.keep_chat),
        drop_absolute_position=not bool(args.keep_absolute_position),
        only_successful_actions=bool(args.only_successful_actions),
        drop_fallback_sources=bool(args.drop_fallback_sources),
        drop_state_only_sources=bool(args.drop_state_only_sources),
        drop_idle_actions=bool(args.drop_idle_actions),
        state_change_only=bool(args.state_change_only),
        min_state_change_pos=max(0.0, float(args.min_state_change_pos)),
        min_state_change_vel=max(0.0, float(args.min_state_change_vel)),
        min_state_change_yaw_pitch=max(0.0, float(args.min_state_change_yaw_pitch)),
    )
    return input_path, output_path, stats
