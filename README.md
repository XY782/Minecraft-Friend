# minecraft-friend

A small Mineflayer-based Minecraft bot with optional Gemini-powered chat.

## Important
- Many servers forbid bots/automation. Only use this where you have permission.

## Setup
1. Install Node.js (LTS recommended).
2. Create your config:
   - Copy `.env.example` to `.env`
   - Fill in `MC_HOST`, `MC_PORT`, `MC_USERNAME`
   - Optional: set `MC_PIN_VERSION=true` and `MC_VERSION=...` to force a specific version
   - Add `GEMINI_API_KEY` if you want AI chat
   - Optional explore tuning: `BOT_AUTO_EXPLORE`, `BOT_EXPLORE_RADIUS`, `BOT_EXPLORE_PAUSE_MS`
   - Optional human-like tuning: `BOT_HUMANIZE`, `BOT_REPLY_MIN_MS`, `BOT_REPLY_MAX_MS`, `BOT_LOOK_AROUND_MS`
   - Optional autonomy tuning:
     - `BOT_AUTONOMY=true` enables independent decision-making loop
     - `BOT_DECISION_MS=6000` base delay between decisions
     - `BOT_DANGER_RADIUS=10` threat detection distance
     - `BOT_ITEM_COLLECT_RADIUS=12` dropped-item pickup range
     - `BOT_FOLLOW_PLAYERS=true` allow autonomous player-following
     - `BOT_FOLLOW_MAX_DIST=20` max distance for social following
     - `BOT_SOCIAL_CHANCE=0.32` chance to choose social actions each decision step
     - `BOT_PROACTIVE_CHAT_CHANCE=0.2` chance to start conversations on its own
     - `BOT_LOW_FOOD=10` hunger threshold for autonomous eating
       - `BOT_EQUIP_ENABLED=true` and `BOT_PREFER_ELYTRA=true` for autonomous gear handling
          - `BOT_ALLOW_CREATIVE_FLIGHT=false` keeps creative flight disabled by default
          - `BOT_CREATIVE_FLIGHT_STAGE=1` gradual rollout for creative flight:
             - `0` = off
             - `1` = short lift only (safer)
             - `2` = full flight navigation (`flyTo`)
       - `BOT_SLEEP_ENABLED=true` and `BOT_SLEEP_SEARCH_RADIUS=20` for autonomous bed sleep at night
       - `BOT_CRAFT_ENABLED=true` and `BOT_CRAFTING_SEARCH_RADIUS=20` for autonomous crafting
       - `BOT_FURNACE_ENABLED=true` and `BOT_FURNACE_SEARCH_RADIUS=20` for autonomous smelting
       - `BOT_ATTACK_ENABLED=true` for hostile combat, `BOT_ATTACK_DISTANCE=3.2` melee distance
       - `BOT_ATTACK_PLAYERS=false` to allow PvP, plus `BOT_ATTACK_PLAYER_CHANCE` and `BOT_ATTACK_PLAYER_RANGE`
       - Planner tuning:
          - `BOT_PLANNER_USE_GEMINI=true` lets the bot generate its own action plans with Gemini
          - `BOT_PLAN_INTERVAL_MS=20000` controls how often it refreshes its goals
          - `BOT_PLAN_MAX_STEPS=5` controls plan length
   - Training recorder (hybrid prep):
     - `BOT_TRAINING_ENABLED=true` writes state-action samples to `Training/datasets/*.jsonl`
       - `BOT_TRAINING_INTERVAL_MS=350` base capture frequency
      - `BOT_TRAINING_TARGET_FPS=4` hard cap for recorder frame rate (downsampling floor)
       - `BOT_TRAINING_ADAPTIVE_INTERVAL=true` adaptively samples around `BOT_TRAINING_MIN_INTERVAL_MS`..`BOT_TRAINING_MAX_INTERVAL_MS` (default `200..500` ms)
       - `BOT_TRAINING_LOS_MAX_DISTANCE=8` line-of-sight trace distance for camera context
          - `BOT_TRAINING_ACTION_HISTORY_SIZE=12` number of past actions stored in each sample
      - `BOT_TRAINING_BLOCK_COMPRESSION=air-rle` nearby-block encoding mode: `air-rle`, `non-air-surface`, or `all`
     - `BOT_TRAINING_LIVE_CONSOLE=true` prints live recording lines in terminal
3. Install dependencies:
   - `npm install`

## Run
- `npm start`

Autonomy:
- The bot explores automatically on spawn and keeps roaming on its own.
- No manual `!` commands are required.
- Human-like pacing is enabled by default (reply delay, movement jitter, look-around behavior).
- It now makes prioritized choices each cycle: evade danger, eat when hungry, collect nearby dropped items, follow players, then explore.
- With Gemini enabled, it can also start short proactive chat messages near players.
- It can sleep in nearby beds at night, craft basic supplies, and run nearby furnaces for food smelting.
- It can attack hostiles by default and optionally attack players when PvP is enabled.
- It can auto-equip armor and optionally prefer elytra when available.
- It chooses what to do directly each decision cycle (no fixed multi-step action queue), using current world state, memory, and profile context.
- Chat/planning prompts include live profile context (location, height, biome, weather, inventory summary, nearby blocks, date/time, nearby players, what players hold, and what they wear).
- In creative mode, it can acquire useful items and use held items; flight is stage-gated and disabled by default unless `BOT_ALLOW_CREATIVE_FLIGHT=true`.
- It can attack hostile mobs proactively and enchant gear when an enchanting table + lapis are available.
- Cheats/command usage can be toggled with env (`BOT_ALLOW_CHEATS`), and optional local LLM endpoint detection can be toggled with `BOT_LOCAL_LLM_DETECTOR_ENABLED`.
- Anti-repeat response memory can be toggled/tuned with `BOT_ANTI_REPEAT_ENABLED` and `BOT_ANTI_REPEAT_WINDOW`.
- Chat range/cooldown behavior can be tuned with `BOT_REPLY_MODE`, `BOT_REPLY_DISTANCE`, `BOT_REPLY_COOLDOWN_MS`, and `BOT_REPLY_MENTION_COOLDOWN_MS`.
- Brain orchestration is modularized under `src/skills/brain/` for cleaner components.

Session memory (persistent across reboots):
- The bot stores up to 5 sessions in `data/session-memory.json`.
- Memory engine is modularized under `src/memory/system/` and runs in RAM first, with periodic JSON backup flushes.
- A new session starts each time the bot process starts (reboot/reload into world).
- Decay profile by recency is fixed to:
   - Session 1 (current/newest): `1.0`
   - Session 2: `0.9`
   - Session 3: `0.75`
   - Session 4: `0.5`
   - Session 5: `0.25`
- Each memory now carries tags, importance, emotion, context hints, and associative references.
- Retrieval is context-driven (query + profile context), not only chronological recency.
- Periodic abstraction adds summary memories from repeated patterns.

Training data + hybrid architecture:
- The bot now records supervised training samples (state + action + success/failure metadata) every interval.
- Recorder now includes richer state: local velocity, acceleration, angular velocity, movement flags (swim/climb/sneak/sprint/fly), armor/saturation/effects/xp, full held item + inventory durability/enchantments.
- Environment capture now includes detailed nearby block metadata (hardness/fluid/light/tags), LOS samples, camera target, weather/time/biome/dimension/chunk info, redstone/crops/interactables/fluids/trap hints.
- Temporal context now includes `frameDelta`, `lastAction`, `actionSequence`, event triggers, and projectile/entity context for imitation learning.
- Files are stored in `Training/datasets/` as JSONL, suitable for Python model training.
- Python-side training/inference files live in `Training/python/`.
- Recommended flow: Node.js handles live Minecraft I/O, Python trains/serves policy models via local API.

Chat without commands:
- Mention the bot name in chat (e.g. `BotFriend: hello`) to get a Gemini reply.

Observer mode (real Minecraft client teaching):
- Use this when you want to play in a real Minecraft client and have the bot record your behavior as training data.
- Set in `.env`:
   - `BOT_OBSERVER_MODE=true`
   - `BOT_OBSERVER_USERNAME=<your-real-client-username>`
   - `BOT_OBSERVER_CAPTURE_RADIUS=24` (`0` disables local radius cap)
   - `BOT_OBSERVER_FOLLOW_ENABLED=true` to keep bot near you while traveling
   - `BOT_OBSERVER_FOLLOW_DISTANCE=3.5` desired follow distance
   - `BOT_OBSERVER_FOLLOW_REFRESH_MS=700` follow update rate
- Run bot with `npm start`, then join the same server/world from your real client account.
- Recorder adds `state.observer` and labels actions like `OBSERVER_MOVE`, `OBSERVER_SPRINT`, `OBSERVER_JUMP`, `OBSERVER_LOOK`.
- In observer mode, bot autonomy/chat reactions are disabled so it focuses on follow + observe.
- Observer samples drop bot-thought/chat noise (`activeIntent`, `activeMode`, `lastBrainAction`, `lastChatMessages`).

Runtime toggle (no restart needed):
- In game chat, use:
   - `!train on` or `!mode observer` → enable observer training mode (follow + observer capture on)
   - `!train off` or `!mode play` → switch to playing mode (observer capture off)
   - `!mode status` → show current mode and recorder state
- If `BOT_OBSERVER_USERNAME` is set, only that player can run these mode commands.

## Notes
This is an MVP “companion” bot with autonomous choice behavior (movement + simple survival + social chat). Beating the game end-to-end autonomously is a much larger project (advanced combat, crafting pipelines, long-horizon planning, nether/end routing, etc.).
