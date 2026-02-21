function boolEnv(name, fallback = false) {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

function numEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(process.env[name] ?? fallback)
  const safe = Number.isFinite(parsed) ? parsed : Number(fallback)
  return Math.min(max, Math.max(min, safe))
}

function strEnv(name, fallback = '') {
  const value = process.env[name]
  return value == null || value === '' ? fallback : String(value)
}

const pinVersion = boolEnv('MC_PIN_VERSION', false)

const mc = {
  host: strEnv('MC_HOST', 'localhost'),
  port: numEnv('MC_PORT', 25565),
  username: strEnv('MC_USERNAME', 'BotFriend'),
  password: process.env.MC_PASSWORD || undefined,
  auth: process.env.MC_AUTH || undefined,
  version: pinVersion ? (process.env.MC_VERSION || undefined) : undefined,
}

const config = {
  botAnnounce: boolEnv('BOT_ANNOUNCE', true),
  chatRate: numEnv('BOT_CHAT_RATE', 5, { min: 1 }),
  replyMode: strEnv('BOT_REPLY_MODE', 'nearby').toLowerCase(),
  replyCooldownMs: numEnv('BOT_REPLY_COOLDOWN_MS', 2_500, { min: 500 }),
  replyMentionCooldownMs: numEnv('BOT_REPLY_MENTION_COOLDOWN_MS', 900, { min: 250 }),
  replyDistance: numEnv('BOT_REPLY_DISTANCE', 18, { min: 0 }),
  antiRepeatEnabled: boolEnv('BOT_ANTI_REPEAT_ENABLED', true),
  antiRepeatWindow: numEnv('BOT_ANTI_REPEAT_WINDOW', 8, { min: 3, max: 20 }),
  autoExploreOnSpawn: boolEnv('BOT_AUTO_EXPLORE', false),
  exploreRadius: numEnv('BOT_EXPLORE_RADIUS', 0, { min: 0 }),
  explorePauseMs: numEnv('BOT_EXPLORE_PAUSE_MS', 3_000, { min: 800 }),
  humanizeBehavior: boolEnv('BOT_HUMANIZE', false),
  minReplyDelayMs: numEnv('BOT_REPLY_MIN_MS', 180, { min: 100 }),
  maxReplyDelayMs: numEnv('BOT_REPLY_MAX_MS', 900, { min: 120 }),
  lookAroundIntervalMs: numEnv('BOT_LOOK_AROUND_MS', 8_000, { min: 2_000 }),
  autonomousMode: boolEnv('BOT_AUTONOMY', true),
  decisionIntervalMs: numEnv('BOT_DECISION_MS', 1_000, { min: 500 }),
  decisionMinGapMs: numEnv('BOT_DECISION_MIN_GAP_MS', 250, { min: 150 }),
  actionRepeatCooldownMs: numEnv('BOT_ACTION_REPEAT_COOLDOWN_MS', 1_200, { min: 300 }),
  maxConcurrentActions: numEnv('BOT_MAX_CONCURRENT_ACTIONS', 3, { min: 1, max: 3 }),
  socialChance: numEnv('BOT_SOCIAL_CHANCE', 0.4, { min: 0, max: 1 }),
  proactiveChatChance: numEnv('BOT_PROACTIVE_CHAT_CHANCE', 0.3, { min: 0, max: 1 }),
  followPlayers: boolEnv('BOT_FOLLOW_PLAYERS', true),
  followMaxDist: numEnv('BOT_FOLLOW_MAX_DIST', 20, { min: 6 }),
  collectItemRadius: numEnv('BOT_ITEM_COLLECT_RADIUS', 12, { min: 4 }),
  dangerRadius: numEnv('BOT_DANGER_RADIUS', 12, { min: 4 }),
  enchantSearchRadius: numEnv('BOT_ENCHANT_SEARCH_RADIUS', 20, { min: 4 }),
  lowFoodThreshold: numEnv('BOT_LOW_FOOD', 10, { min: 0, max: 20 }),
  equipEnabled: boolEnv('BOT_EQUIP_ENABLED', true),
  preferElytra: boolEnv('BOT_PREFER_ELYTRA', true),
  allowCreativeFlight: boolEnv('BOT_ALLOW_CREATIVE_FLIGHT', false),
  creativeFlightStage: numEnv('BOT_CREATIVE_FLIGHT_STAGE', 1, { min: 0, max: 2 }),
  attackEnabled: boolEnv('BOT_ATTACK_ENABLED', true),
  attackDistance: numEnv('BOT_ATTACK_DISTANCE', 3.2, { min: 2 }),
  attackPlayers: boolEnv('BOT_ATTACK_PLAYERS', false),
  attackPlayerChance: numEnv('BOT_ATTACK_PLAYER_CHANCE', 0.12, { min: 0, max: 1 }),
  attackPlayerRange: numEnv('BOT_ATTACK_PLAYER_RANGE', 8, { min: 3 }),
  sleepEnabled: boolEnv('BOT_SLEEP_ENABLED', true),
  sleepSearchRadius: numEnv('BOT_SLEEP_SEARCH_RADIUS', 20, { min: 4 }),
  craftEnabled: boolEnv('BOT_CRAFT_ENABLED', true),
  craftingSearchRadius: numEnv('BOT_CRAFTING_SEARCH_RADIUS', 20, { min: 4 }),
  furnaceEnabled: boolEnv('BOT_FURNACE_ENABLED', true),
  furnaceSearchRadius: numEnv('BOT_FURNACE_SEARCH_RADIUS', 20, { min: 4 }),
  plannerUseGemini: true,
  policyAutonomyEnabled: boolEnv('BOT_POLICY_AUTONOMY_ENABLED', true),
  policyServerUrl: strEnv('BOT_POLICY_SERVER_URL', 'http://127.0.0.1:8765/predict'),
  policyTimeoutMs: numEnv('BOT_POLICY_TIMEOUT_MS', 1200, { min: 200, max: 10_000 }),
  policyMinConfidence: numEnv('BOT_POLICY_MIN_CONFIDENCE', 0.25, { min: 0, max: 1 }),
  allowCheats: boolEnv('BOT_ALLOW_CHEATS', false),
  localLlmDetectorEnabled: boolEnv('BOT_LOCAL_LLM_DETECTOR_ENABLED', false),
  planIntervalMs: numEnv('BOT_PLAN_INTERVAL_MS', 20_000, { min: 5_000 }),
  planMaxSteps: numEnv('BOT_PLAN_MAX_STEPS', 5, { min: 2, max: 8 }),
  trainingEnabled: boolEnv('BOT_TRAINING_ENABLED', true),
  trainingIntervalMs: numEnv('BOT_TRAINING_INTERVAL_MS', 450, { min: 250 }),
  trainingAdaptiveInterval: boolEnv('BOT_TRAINING_ADAPTIVE_INTERVAL', true),
  trainingTargetFps: numEnv('BOT_TRAINING_TARGET_FPS', 3, { min: 1, max: 30 }),
  trainingMinIntervalMs: numEnv('BOT_TRAINING_MIN_INTERVAL_MS', 300, { min: 150, max: 2000 }),
  trainingMaxIntervalMs: numEnv('BOT_TRAINING_MAX_INTERVAL_MS', 700, { min: 200, max: 5000 }),
  trainingLineOfSightMaxDistance: numEnv('BOT_TRAINING_LOS_MAX_DISTANCE', 8, { min: 3, max: 24 }),
  trainingActionHistorySize: numEnv('BOT_TRAINING_ACTION_HISTORY_SIZE', 12, { min: 3, max: 64 }),
  trainingBlockCompressionMode: strEnv('BOT_TRAINING_BLOCK_COMPRESSION', 'air-rle').toLowerCase(),
  trainingDeduplicateFrames: boolEnv('BOT_TRAINING_DEDUPLICATE_FRAMES', true),
  trainingMinPositionDelta: numEnv('BOT_TRAINING_MIN_POSITION_DELTA', 0.22, { min: 0.02, max: 2.0 }),
  trainingMinYawDelta: numEnv('BOT_TRAINING_MIN_YAW_DELTA', 0.12, { min: 0.01, max: 1.57 }),
  trainingMinPitchDelta: numEnv('BOT_TRAINING_MIN_PITCH_DELTA', 0.08, { min: 0.01, max: 1.57 }),
  trainingMinVelocityDelta: numEnv('BOT_TRAINING_MIN_VELOCITY_DELTA', 0.12, { min: 0.01, max: 2.0 }),
  trainingForceRecordMs: numEnv('BOT_TRAINING_FORCE_RECORD_MS', 2200, { min: 300, max: 15000 }),
  trainingLogDedupSkips: boolEnv('BOT_TRAINING_LOG_DEDUP_SKIPS', false),
  trainingDedupLogIntervalMs: numEnv('BOT_TRAINING_DEDUP_LOG_INTERVAL_MS', 10000, { min: 1000, max: 120000 }),
  trainingLiveConsole: boolEnv('BOT_TRAINING_LIVE_CONSOLE', true),
  observerModeEnabled: boolEnv('BOT_OBSERVER_MODE', false),
  observerUsername: strEnv('BOT_OBSERVER_USERNAME', ''),
  observerFollowEnabled: boolEnv('BOT_OBSERVER_FOLLOW_ENABLED', true),
  observerFollowDistance: numEnv('BOT_OBSERVER_FOLLOW_DISTANCE', 3.5, { min: 1.5, max: 12 }),
  observerFollowRefreshMs: numEnv('BOT_OBSERVER_FOLLOW_REFRESH_MS', 700, { min: 250, max: 5_000 }),
  userTelemetryEnabled: boolEnv('BOT_USER_TELEMETRY_ENABLED', false),
  userTelemetryFile: strEnv('BOT_USER_TELEMETRY_FILE', ''),
  userTelemetryMaxAgeMs: numEnv('BOT_USER_TELEMETRY_MAX_AGE_MS', 2000, { min: 250, max: 60000 }),
}

config.autonomousModeDefault = config.autonomousMode
config.trainingMaxIntervalMs = Math.max(config.trainingMinIntervalMs, config.trainingMaxIntervalMs)

config.maxReplyDelayMs = Math.max(config.minReplyDelayMs, config.maxReplyDelayMs)

if (config.observerModeEnabled) {
  config.autonomousMode = false
  config.autoExploreOnSpawn = false
}

module.exports = {
  mc,
  config,
}
