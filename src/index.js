const path = require('path')
const { spawn } = require('child_process')

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
const { createFirstPersonPuppet } = require('./training/firstPersonPuppet')
const { createPuppetMode } = require('./training/puppetMode')

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

gemini?.setSuppressionCheck?.(() => Boolean(bot?.__puppetActive))

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

const trainingRecorder = createTrainingRecorder({
  bot,
  rootDir: path.join(__dirname, '..'),
  sessionMemory,
  enabled: config.trainingEnabled,
  intervalMs: config.trainingIntervalMs,
  liveConsole: config.trainingLiveConsole,
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

const puppetMode = createPuppetMode({
  bot,
  config,
  sessionMemory,
  onActionOutcome: (payload) => trainingRecorder.recordActionOutcome(payload),
})

const firstPersonPuppet = createFirstPersonPuppet({
  bot,
  config,
  sessionMemory,
  onActionOutcome: (payload) => trainingRecorder.recordActionOutcome(payload),
})

if (config.trainingEnabled && config.trainingPopupMonitor) {
  try {
    const monitorPath = path.join(__dirname, 'training', 'liveMonitor.js')
    const command = `node "${monitorPath}"`
    spawn('powershell.exe', ['-NoExit', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref()
  } catch (e) {
    console.log('training popup monitor failed to launch', e)
  }
}

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
  puppetMode.start()
  firstPersonPuppet.start()

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

bot.on('end', () => {
  sessionMemory.addMemory('Session ending (bot disconnected).', 'session')
  firstPersonPuppet.stop()
  puppetMode.stop()
  trainingRecorder.stop()
  sessionMemory.endSession()
  brain.onEnd()
})

bot.on('kicked', (reason) => {
  console.log('Kicked:', reason)
  sessionMemory.addMemory(`Kicked: ${String(reason)}`, 'world')
})

bot.on('error', (err) => {
  console.log('Error:', err)
  sessionMemory.addMemory(`Error: ${String(err?.message || err)}`, 'error')
  firstPersonPuppet.stop()
  puppetMode.stop()
  trainingRecorder.stop()
})

brain.start()
