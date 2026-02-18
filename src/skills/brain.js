const utils = require('./utils')
const { createMovementSkill } = require('./movement')
const { createSocialSkill } = require('./social')
const { createActionRunner } = require('./brain/actionRunner')
const { createDecisionEngine } = require('./brain/decisionEngine')
const { createInternalStateController } = require('../context/internalState')
const { createDynamicAgent } = require('./brain/dynamicAgent')

function createBrain({ bot, goals, gemini, config, chatWindow, remember, sessionMemory, getProfileContext, executeCommand, antiRepeat, safeChat = () => {}, onActionOutcome = () => {} }) {
  let mode = 'idle'
  let lastAction = null
  let currentGoal = 'stay adaptive'
  let decisionTimer = null

  const state = {
    getMode: () => mode,
    setMode: (nextMode) => {
      mode = nextMode
    },
    getLastAction: () => lastAction,
    setLastAction: (action) => {
      lastAction = action || null
    },
    getGoal: () => currentGoal,
    setGoal: (goal) => {
      currentGoal = String(goal || '').trim() || 'stay adaptive'
    },
  }

  const internalState = createInternalStateController({ bot })

  const movement = createMovementSkill({
    bot,
    goals,
    config,
    safeChat,
    randInt: utils.randInt,
    chance: utils.chance,
    wait: utils.wait,
    state,
  })

  const social = createSocialSkill({
    bot,
    gemini,
    config,
    chatWindow,
    remember,
    safeChat,
    utils,
    movement,
    state,
    sessionMemory,
    getProfileContext,
    antiRepeat,
  })

  const dynamicAgent = createDynamicAgent({
    bot,
    config,
    gemini,
    utils,
    sessionMemory,
    getProfileContext,
    getInternalState: internalState.getSnapshot,
  })

  const actionRunner = createActionRunner({
    bot,
    goals,
    config,
    state,
    utils,
    movement,
    social,
    executeCommand,
    gemini,
    getProfileContext,
    sessionMemory,
    safeChat,
  })

  const decisionEngine = createDecisionEngine({
    bot,
    config,
    dynamicAgent,
    runAction: actionRunner.runAction,
    runDynamicAction: actionRunner.runDynamicAction,
    sessionMemory,
    onActionChosen: state.setLastAction,
    onGoalChosen: state.setGoal,
    internalState,
    onActionOutcome,
  })

  function clearDecisionTimer() {
    if (!decisionTimer) return
    clearTimeout(decisionTimer)
    decisionTimer = null
  }

  function scheduleDecisionLoop() {
    clearDecisionTimer()
    if (!config.autonomousMode) return

    function hasNearbyThreatOrTarget() {
      if (!bot.entity) return false
      const entities = Object.values(bot.entities || {})
      return entities.some((entity) => {
        if (!entity || !entity.position) return false
        if (entity.type !== 'mob' && entity.type !== 'player') return false
        if (entity.type === 'player' && entity.username === bot.username) return false
        return bot.entity.position.distanceTo(entity.position) <= Math.max(12, config.attackPlayerRange || 8)
      })
    }

    function computeDelayMs() {
      const currentMode = state.getMode()
      const inCombatMode = ['attack', 'attack-mob', 'attack-player', 'evade', 'help-player', 'follow'].includes(currentMode)
      const actionCombatLike = ['DEFEND', 'ATTACK_MOB', 'ATTACK_PLAYER', 'HELP_PLAYER'].includes(String(state.getLastAction() || '').toUpperCase())
      const nearbyThreat = hasNearbyThreatOrTarget()

      if (inCombatMode || actionCombatLike || nearbyThreat) {
        return 280 + utils.randInt(0, 300)
      }

      const base = Math.max(800, Number(config.decisionIntervalMs) || 2_200)
      return base + utils.randInt(0, 500)
    }

    decisionTimer = setTimeout(async () => {
      try {
        if (!bot.entity || bot.isSleeping) return

        if (bot?.__puppetActive) {
          movement.stopExploring()
          return
        }

        const nearbyEntities = Object.values(bot.entities || {})
        const nearbyPlayers = nearbyEntities.filter((entity) =>
          entity && entity.type === 'player' && entity.username !== bot.username && bot.entity.position.distanceTo(entity.position) <= 12
        ).length
        const nearbyHostiles = nearbyEntities.filter((entity) =>
          entity && entity.type === 'mob' && bot.entity.position.distanceTo(entity.position) <= (config.dangerRadius || 10)
        ).length

        internalState.onTick({
          mode: state.getMode(),
          lastAction: state.getLastAction(),
          nearbyPlayers,
          nearbyHostiles,
        })
        await decisionEngine.runDecisionStep()
      } finally {
        scheduleDecisionLoop()
      }
    }, computeDelayMs())
  }

  function onSpawn() {
    state.setGoal('scan immediate area')
    if (config.autoExploreOnSpawn) {
      movement.startExploring(false)
    }
  }

  function onGoalReached() {
    movement.handleGoalReached()
  }

  function onDeath() {
    state.setGoal('recover after death')
    movement.onDeath()
  }

  function onWake() {
    state.setMode('idle')
    movement.resumeExploreSoon(600)
  }

  function onEnd() {
    state.setGoal('session ended')
    clearDecisionTimer()
    movement.shutdown()
  }

  function start() {
    movement.scheduleLookAround()
    scheduleDecisionLoop()
  }

  return {
    start,
    onSpawn,
    onGoalReached,
    onDeath,
    onWake,
    onEnd,
    getMode: state.getMode,
    getGoal: state.getGoal,
    getLastAction: state.getLastAction,
    getInternalState: internalState.getSnapshot,
    onChatSignal: internalState.onChatSignal,
  }
}

module.exports = {
  createBrain,
}
