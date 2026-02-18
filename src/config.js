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
  autoExploreOnSpawn: boolEnv('BOT_AUTO_EXPLORE', true),
  exploreRadius: numEnv('BOT_EXPLORE_RADIUS', 48, { min: 8 }),
  explorePauseMs: numEnv('BOT_EXPLORE_PAUSE_MS', 5_000, { min: 1_500 }),
  humanizeBehavior: boolEnv('BOT_HUMANIZE', true),
  minReplyDelayMs: numEnv('BOT_REPLY_MIN_MS', 180, { min: 100 }),
  maxReplyDelayMs: numEnv('BOT_REPLY_MAX_MS', 900, { min: 120 }),
  lookAroundIntervalMs: numEnv('BOT_LOOK_AROUND_MS', 8_000, { min: 2_000 }),
  autonomousMode: boolEnv('BOT_AUTONOMY', true),
  decisionIntervalMs: numEnv('BOT_DECISION_MS', 2_200, { min: 700 }),
  decisionMinGapMs: numEnv('BOT_DECISION_MIN_GAP_MS', 450, { min: 200 }),
  actionRepeatCooldownMs: numEnv('BOT_ACTION_REPEAT_COOLDOWN_MS', 4_000, { min: 500 }),
  maxConcurrentActions: numEnv('BOT_MAX_CONCURRENT_ACTIONS', 3, { min: 1, max: 3 }),
  socialChance: numEnv('BOT_SOCIAL_CHANCE', 0.32, { min: 0, max: 1 }),
  proactiveChatChance: numEnv('BOT_PROACTIVE_CHAT_CHANCE', 0.2, { min: 0, max: 1 }),
  followPlayers: boolEnv('BOT_FOLLOW_PLAYERS', true),
  followMaxDist: numEnv('BOT_FOLLOW_MAX_DIST', 20, { min: 6 }),
  collectItemRadius: numEnv('BOT_ITEM_COLLECT_RADIUS', 12, { min: 4 }),
  dangerRadius: numEnv('BOT_DANGER_RADIUS', 10, { min: 4 }),
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
  plannerUseGemini: boolEnv('BOT_PLANNER_USE_GEMINI', true),
  policyAutonomyEnabled: boolEnv('BOT_POLICY_AUTONOMY_ENABLED', false),
  policyServerUrl: strEnv('BOT_POLICY_SERVER_URL', 'http://127.0.0.1:8765/predict'),
  policyTimeoutMs: numEnv('BOT_POLICY_TIMEOUT_MS', 1200, { min: 200, max: 10_000 }),
  policyMinConfidence: numEnv('BOT_POLICY_MIN_CONFIDENCE', 0.35, { min: 0, max: 1 }),
  allowCheats: boolEnv('BOT_ALLOW_CHEATS', false),
  localLlmDetectorEnabled: boolEnv('BOT_LOCAL_LLM_DETECTOR_ENABLED', false),
  planIntervalMs: numEnv('BOT_PLAN_INTERVAL_MS', 20_000, { min: 5_000 }),
  planMaxSteps: numEnv('BOT_PLAN_MAX_STEPS', 5, { min: 2, max: 8 }),
  trainingEnabled: boolEnv('BOT_TRAINING_ENABLED', true),
  trainingIntervalMs: numEnv('BOT_TRAINING_INTERVAL_MS', 1000, { min: 250 }),
  trainingLiveConsole: boolEnv('BOT_TRAINING_LIVE_CONSOLE', true),
  trainingPopupMonitor: boolEnv('BOT_TRAINING_POPUP_MONITOR', false),
  observerModeEnabled: boolEnv('BOT_OBSERVER_MODE', false),
  observerUsername: strEnv('BOT_OBSERVER_USERNAME', ''),
  observerCaptureRadius: numEnv('BOT_OBSERVER_CAPTURE_RADIUS', 24, { min: 0, max: 128 }),
  observerSampleMinMs: numEnv('BOT_OBSERVER_SAMPLE_MIN_MS', 2000, { min: 150, max: 60_000 }),
  observerIdleSampleMinMs: numEnv('BOT_OBSERVER_IDLE_SAMPLE_MIN_MS', 4000, { min: 250, max: 60_000 }),
  observerFollowEnabled: boolEnv('BOT_OBSERVER_FOLLOW_ENABLED', true),
  observerFollowDistance: numEnv('BOT_OBSERVER_FOLLOW_DISTANCE', 3.5, { min: 1.5, max: 12 }),
  observerFollowRefreshMs: numEnv('BOT_OBSERVER_FOLLOW_REFRESH_MS', 700, { min: 250, max: 5_000 }),
  observerMoveSampleMinDistance: numEnv('BOT_OBSERVER_MOVE_MIN_DISTANCE', 1.0, { min: 0.1, max: 8 }),
  firstPersonPuppetEnabled: boolEnv('BOT_FPV_PUPPET_ENABLED', false),
  firstPersonViewerPort: numEnv('BOT_FPV_VIEWER_PORT', 3007, { min: 1024, max: 65535 }),
  firstPersonControlPort: numEnv('BOT_FPV_CONTROL_PORT', 3010, { min: 1024, max: 65535 }),
  firstPersonAutoOpen: boolEnv('BOT_FPV_AUTO_OPEN', true),
  firstPersonViewDistance: numEnv('BOT_FPV_VIEW_DISTANCE', 6, { min: 2, max: 10 }),
  firstPersonMouseSensitivity: numEnv('BOT_FPV_MOUSE_SENSITIVITY', 0.002, { min: 0.0002, max: 0.02 }),
  puppetModeEnabled: boolEnv('BOT_PUPPET_MODE', false),
  puppetModeAutoActivate: boolEnv('BOT_PUPPET_AUTO_ACTIVATE', true),
  puppetModeAnnounce: boolEnv('BOT_PUPPET_ANNOUNCE', true),
}

config.maxReplyDelayMs = Math.max(config.minReplyDelayMs, config.maxReplyDelayMs)

if (config.firstPersonPuppetEnabled) {
  config.puppetModeEnabled = false
}

if (config.observerModeEnabled) {
  config.puppetModeEnabled = false
  config.firstPersonPuppetEnabled = false
  config.autonomousMode = false
  config.autoExploreOnSpawn = false
}

module.exports = {
  mc,
  config,
}
