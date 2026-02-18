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

            gap_required = min_idle_sample_ms if raw_label == 'OBSERVER_IDLE' else min_sample_ms
            if last_kept_ts > 0 and ts_ms > 0 and (ts_ms - last_kept_ts) < gap_required:
                stats.skipped_downsample += 1
                continue

            cleaned_state = _clean_state(
                state,
                remove_chat=remove_chat,
                drop_absolute_position=drop_absolute_position,
            )
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
                    'success': action.get('success'),
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

    return stats


def main() -> None:
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

    args = parser.parse_args()

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
    )

    print(f'Input:  {input_path}')
    print(f'Output: {output_path}')
    print(f'Total rows:                 {stats.total}')
    print(f'Kept rows:                  {stats.kept}')
    print(f'Skipped non-observer:       {stats.skipped_non_observer}')
    print(f'Skipped mixed observer pos: {stats.skipped_mixed_state}')
    print(f'Skipped downsampled:        {stats.skipped_downsample}')
    print(f'Skipped parse errors:       {stats.skipped_parse_error}')


if __name__ == '__main__':
    main()
