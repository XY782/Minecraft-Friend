const path = require('path')

process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true'
require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
})

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const { createGeminiClient } = require('./gemini')
const { createBrain } = require('./skills/brain')
const { eatNamedFood } = require('./skills/eating')
const { createSessionMemory } = require('./memory/sessionMemory')
const { buildProfileContext } = require('./context/profile')
const { mc, config } = require('./config')
const { detectLocalLlm } = require('./services/localLlmDetector')
const { createAntiRepeatMemory } = require('./chat/antiRepeat')
const { isFlightAllowedMode, enforceNoCreativeFlight } = require('./utils/gamemode')
const { createChatSender } = require('./runtime/chatSender')
const { createChatRuntime } = require('./runtime/chatRuntime')
const { createAntiFlightGuard } = require('./runtime/antiFlight')
const { createTrainingRecorder } = require('./training/dataRecorder')

const gemini = createGeminiClient({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
})

const sessionMemory = createSessionMemory({
  filePath: path.join(__dirname, '..', 'data', 'session-memory.json'),
  maxSessions: 5,
  decays: [1.0, 0.9, 0.75, 0.5, 0.25],
  flushIntervalMs: 30_000,
  consolidationIntervalMs: 120_000,
  workingWindowMs: 180_000,
})

sessionMemory.addMemory('Session started (bot rebooted into world).', 'session')

const bot = mineflayer.createBot({
  host: mc.host,
  port: mc.port,
  username: mc.username,
  password: mc.password,
  auth: mc.auth,
  version: mc.version,
})

bot.loadPlugin(pathfinder)

const chatWindow = new Map()
const lastReplyByPlayer = new Map()
const antiRepeat = createAntiRepeatMemory({
  enabled: config.antiRepeatEnabled,
  windowSize: config.antiRepeatWindow,
})

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const { sendChat } = createChatSender({
  bot,
  config,
  randInt,
  wait,
})

async function executeCommand(command) {
  if (!config.allowCheats) return false
  const cmd = String(command || '').trim().replace(/^\//, '')
  if (!cmd) return false
  sendChat('/' + cmd)
  sessionMemory.addMemory(`Executed command: /${cmd}`, 'command')
  return true
}

function remember(playerName, line) {
  const arr = chatWindow.get(playerName) || []
  arr.push(line)
  while (arr.length > 20) arr.shift()
  chatWindow.set(playerName, arr)
  return arr
}

function isMention(botName, message) {
  const m = String(message || '').toLowerCase()
  const n = String(botName || '').toLowerCase()
  if (!m || !n) return false

  if (m.startsWith(n + ':') || m.startsWith(n + ',') || m.startsWith('@' + n)) return true

  const escapedName = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mentionPattern = new RegExp(`\\b${escapedName}\\b`, 'i')
  return mentionPattern.test(m)
}

function isPlayerNearby(playerName, maxDistance = config.replyDistance) {
  if (maxDistance <= 0) return true
  if (!bot.entity || !playerName) return false
  const playerEntity = Object.values(bot.entities).find((entity) =>
    entity && entity.type === 'player' && entity.username === playerName
  )
  if (!playerEntity) return false
  return bot.entity.position.distanceTo(playerEntity.position) <= maxDistance
}

function shouldRespondToChat(playerName, message) {
  const mode = String(config.replyMode || 'nearby').toLowerCase()
  const mentioned = isMention(bot.username, message)
  const nearby = isPlayerNearby(playerName, config.replyDistance)

  let allowed = false
  if (mode === 'all') allowed = true
  else if (mode === 'mention') allowed = mentioned
  else allowed = mentioned || nearby

  if (!allowed) return false

  const now = Date.now()
  const lastAt = lastReplyByPlayer.get(playerName) || 0
  const cooldownMs = mentioned ? config.replyMentionCooldownMs : config.replyCooldownMs
  if (now - lastAt < cooldownMs) return false

  lastReplyByPlayer.set(playerName, now)
  return true
}

function getLiveProfileContext(brainRef) {
  return buildProfileContext(bot, {
    behaviorMode: brainRef?.getMode?.() || 'idle',
    lastAction: brainRef?.getLastAction?.() || null,
    autonomyGoal: brainRef?.getGoal?.() || 'stay adaptive',
    internalState: brainRef?.getInternalState?.() || null,
  })
}
const antiFlight = createAntiFlightGuard({
  bot,
  isFlightAllowedMode,
  enforceNoCreativeFlight,
})

let brain = null
let lastDisconnectReason = 'unknown'
let observerFollowTimer = null
let runtimeObserverModeEnabled = Boolean(config.observerModeEnabled)

bot.__observerModeActive = runtimeObserverModeEnabled

function getObserverEntity() {
  const observerName = String(config.observerUsername || '').trim().toLowerCase()
  if (!observerName) return null
  const entities = Object.values(bot.entities || {})
  return entities.find((entity) =>
    entity &&
    entity.type === 'player' &&
    String(entity.username || '').trim().toLowerCase() === observerName
  ) || null
}

function stopObserverFollow() {
  if (!observerFollowTimer) return
  clearInterval(observerFollowTimer)
  observerFollowTimer = null
}

function startObserverFollow() {
  if (!runtimeObserverModeEnabled || !config.observerFollowEnabled) return
  if (observerFollowTimer) return
  observerFollowTimer = setInterval(() => {
    if (!bot?.entity) return
    const observerEntity = getObserverEntity()
    if (!observerEntity?.position) {
      try {
        bot.pathfinder?.setGoal?.(null)
      } catch {}
      return
    }

    const followDistance = Math.max(1.5, Number(config.observerFollowDistance || 3.5))
    const distance = bot.entity.position.distanceTo(observerEntity.position)
    if (!Number.isFinite(distance)) return

    try {
      if (distance <= followDistance) {
        bot.pathfinder?.setGoal?.(null)
      } else {
        const followGoal = new goals.GoalFollow(observerEntity, followDistance)
        bot.pathfinder?.setGoal?.(followGoal, true)
      }
    } catch {}
  }, Math.max(250, Number(config.observerFollowRefreshMs || 700)))

  sessionMemory.addMemory(`Observer follow enabled for ${String(config.observerUsername || 'observer')}.`, 'training')
}

function normalizeModeCommandText(text) {
  return String(text || '').trim().toLowerCase().replace(/^\//, '')
}

function isTrainingController(playerName) {
  const expected = String(config.observerUsername || '').trim().toLowerCase()
  if (!expected) return true
  return String(playerName || '').trim().toLowerCase() === expected
}

function setRuntimeObserverMode(nextEnabled, source = 'chat') {
  const enabled = Boolean(nextEnabled)
  if (runtimeObserverModeEnabled === enabled) return false

  runtimeObserverModeEnabled = enabled
  bot.__observerModeActive = enabled
  config.observerModeEnabled = enabled

  trainingRecorder.setObserverModeEnabled(enabled)

  if (enabled) {
    trainingRecorder.setEnabled(true)
    config.autonomousMode = false
    brain.stop?.()
    startObserverFollow()
    sessionMemory.addMemory(`Observer mode enabled at runtime (${source}).`, 'training')
  } else {
    stopObserverFollow()
    trainingRecorder.setEnabled(false)
    config.autonomousMode = Boolean(config.autonomousModeDefault)
    if (config.autonomousMode) {
      brain.start?.()
    }
    sessionMemory.addMemory(`Observer mode disabled at runtime (${source}).`, 'training')
  }

  return true
}

function handleRuntimeModeCommand(playerName, message) {
  const text = normalizeModeCommandText(message)
  if (!text) return false

  const commandMatch = text.match(/^!(mode|train|training)\s+(observer|play|on|off|status)$/i)
  if (!commandMatch) return false
  if (!isTrainingController(playerName)) return false

  const command = String(commandMatch[1] || '').toLowerCase()
  const arg = String(commandMatch[2] || '').toLowerCase()

  if (arg === 'status') {
    const modeText = runtimeObserverModeEnabled ? 'observer-training' : 'playing'
    const recorderText = trainingRecorder.isEnabled?.() ? 'on' : 'off'
    sendChat(`mode=${modeText} recorder=${recorderText}`)
    return true
  }

  const enableObserver = arg === 'observer' || arg === 'on'
  const didChange = setRuntimeObserverMode(enableObserver, `${command}:${arg}`)

  if (enableObserver) {
    sendChat(didChange ? 'Observer training mode ON. Use !mode play to switch back.' : 'Observer training mode is already ON.')
  } else {
    sendChat(didChange ? 'Playing mode ON (observer training OFF).' : 'Playing mode is already ON.')
  }

  return true
}

const trainingRecorder = createTrainingRecorder({
  bot,
  rootDir: path.join(__dirname, '..'),
  sessionMemory,
  enabled: config.trainingEnabled,
  intervalMs: config.trainingIntervalMs,
  adaptiveInterval: config.trainingAdaptiveInterval,
  targetFps: config.trainingTargetFps,
  minIntervalMs: config.trainingMinIntervalMs,
  maxIntervalMs: config.trainingMaxIntervalMs,
  lineOfSightMaxDistance: config.trainingLineOfSightMaxDistance,
  actionHistorySize: config.trainingActionHistorySize,
  blockCompressionMode: config.trainingBlockCompressionMode,
  deduplicateFrames: config.trainingDeduplicateFrames,
  minPositionDelta: config.trainingMinPositionDelta,
  minYawDelta: config.trainingMinYawDelta,
  minPitchDelta: config.trainingMinPitchDelta,
  minVelocityDelta: config.trainingMinVelocityDelta,
  forceRecordMs: config.trainingForceRecordMs,
  logDedupSkips: config.trainingLogDedupSkips,
  dedupLogIntervalMs: config.trainingDedupLogIntervalMs,
  liveConsole: config.trainingLiveConsole,
  observerModeEnabled: config.observerModeEnabled,
  observerUsername: config.observerUsername,
  observerCaptureRadius: config.observerCaptureRadius,
  observerSampleMinMs: config.observerSampleMinMs,
  observerIdleSampleMinMs: config.observerIdleSampleMinMs,
  observerMoveSampleMinDistance: config.observerMoveSampleMinDistance,
  getObserverEntity,
  getIntent: () => brain?.getGoal?.() || '',
  getMode: () => brain?.getMode?.() || 'idle',
  getLastAction: () => brain?.getLastAction?.() || null,
  getRecentChat: () => {
    const lines = []
    for (const [playerName, entries] of chatWindow.entries()) {
      const recent = Array.isArray(entries) ? entries.slice(-2) : []
      for (const entry of recent) {
        lines.push(`${playerName}: ${String(entry || '')}`)
      }
    }
    return lines.slice(-10)
  },
})

const chatRuntime = createChatRuntime({
  bot,
  gemini,
  config,
  sessionMemory,
  chatWindow,
  antiRepeat,
  sendChat,
  eatNamedFood,
  isMention,
  shouldRespondToChat,
  getBrain: () => brain,
  getLiveProfileContext,
})

brain = createBrain({
  bot,
  goals,
  gemini,
  config,
  chatWindow,
  remember: chatRuntime.remember,
  sessionMemory,
  getProfileContext: () => getLiveProfileContext(brain),
  executeCommand,
  antiRepeat,
  safeChat: sendChat,
  onActionOutcome: (payload) => trainingRecorder.recordActionOutcome(payload),
})

if (config.localLlmDetectorEnabled) {
  detectLocalLlm()
    .then((info) => {
      if (info?.detected) {
        console.log(`Local LLM detected: ${info.provider} @ ${info.endpoint}`)
        sessionMemory.addMemory(`Local LLM detected: ${info.provider} (${(info.models || []).join(', ')})`, 'local-llm')
      } else {
        console.log('Local LLM not detected on default localhost endpoints.')
        sessionMemory.addMemory('Local LLM not detected.', 'local-llm')
      }
    })
    .catch((e) => {
      console.log('local llm detector error', e)
    })
}

bot.once('spawn', () => {
  try {
    const defaultMovements = new Movements(bot)
    defaultMovements.allowSprinting = true
    bot.pathfinder.setMovements(defaultMovements)
    bot.setControlState('jump', false)
  } catch {}

  sessionMemory.addMemory('Spawned into Minecraft world.', 'world')
  antiFlight.enforceSurvivalNoFlight('spawn')
  trainingRecorder.start()
  startObserverFollow()

  brain.onSpawn()
})

bot.on('game', () => {
  antiFlight.hardResetFlightState('game-mode-update')
})

bot.on('entityHurt', (entity) => {
  antiFlight.onEntityHurt(entity)
})

bot.on('physicsTick', () => {
  antiFlight.onPhysicsTick()
})

bot.on('chat', (playerName, message) => {
  if (handleRuntimeModeCommand(playerName, message)) return
  if (runtimeObserverModeEnabled) return
  chatRuntime.onChat(playerName, message)
})

bot.on('goal_reached', () => {
  brain.onGoalReached()
})

bot.on('death', () => {
  sessionMemory.addMemory('Bot died.', 'world')
  brain.onDeath()
})

bot.on('wake', () => {
  sessionMemory.addMemory('Bot woke up from bed.', 'world')
  brain.onWake()
})

bot.on('end', (reason) => {
  const reasonText = String(reason || lastDisconnectReason || 'unknown')
  console.log('Disconnected:', reasonText)
  sessionMemory.addMemory(`Disconnected: ${reasonText}`, 'world')
  sessionMemory.addMemory('Session ending (bot disconnected).', 'session')
  trainingRecorder.stop()
  stopObserverFollow()
  sessionMemory.endSession()
  brain.onEnd()
})

bot.on('kicked', (reason) => {
  lastDisconnectReason = String(reason || 'kicked')
  console.log('Kicked:', reason)
  sessionMemory.addMemory(`Kicked: ${String(reason)}`, 'world')
})

bot.on('error', (err) => {
  console.log('Error:', err)
  sessionMemory.addMemory(`Error: ${String(err?.message || err)}`, 'error')
  trainingRecorder.stop()
  stopObserverFollow()
})

if (!runtimeObserverModeEnabled) {
  brain.start()
}
