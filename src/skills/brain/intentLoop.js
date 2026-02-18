function createIntentLoop({ bot, dynamicAgent, sessionMemory }) {
  const ENABLE_INTENT_HIERARCHY = true
  const ENABLE_DYNAMIC_SUBGOAL_EXPANSION = true

  let state = {
    strategicIntent: '',
    subgoals: [],
    actionQueue: [],
    progressNotes: [],
    refreshedAt: 0,
    currentSubgoalAttempts: 0,
    disabled: false,
    refreshInFlight: false,
    expansionInFlight: false,
    expansionSubgoal: '',
  }

  function now() {
    return Date.now()
  }

  function normalizeStep(step) {
    return String(step || '').trim()
  }

  function pushProgress(note) {
    const text = String(note || '').trim()
    if (!text) return
    state.progressNotes.push(text)
    if (state.progressNotes.length > 12) state.progressNotes = state.progressNotes.slice(-12)
  }

  function shouldRefreshIntent() {
    if (!ENABLE_INTENT_HIERARCHY) return false
    if (state.disabled) return false
    if (!state.strategicIntent) return true
    if (!state.subgoals.length) return true
    return (now() - Number(state.refreshedAt || 0)) >= 15_000
  }

  async function refreshIntentIfNeeded() {
    if (!shouldRefreshIntent()) return false
    if (state.refreshInFlight) return false

    state.refreshInFlight = true

    try {
      const proposal = await dynamicAgent.proposeStrategicPlan({
        currentIntent: state.strategicIntent,
        progressNotes: state.progressNotes.slice(-4),
      })

      const nextIntent = String(proposal?.strategicIntent || '').trim()
      const nextSubgoals = Array.isArray(proposal?.subgoals)
        ? proposal.subgoals.map(normalizeStep).filter(Boolean).slice(0, 8)
        : []

      if (!nextIntent || !nextSubgoals.length) return false

      state.strategicIntent = nextIntent
      state.subgoals = nextSubgoals
      state.actionQueue = []
      state.progressNotes = state.progressNotes.slice(-4)
      state.refreshedAt = now()
      state.currentSubgoalAttempts = 0

      sessionMemory?.addMemory?.(
        `Strategic intent selected: ${state.strategicIntent} | Subgoals: ${state.subgoals.join(' -> ')}`,
        'plan',
        { tags: ['intent-layer1', 'intent-layer2', 'autonomy'] }
      )

      return true
    } finally {
      state.refreshInFlight = false
    }
  }

  function getCurrentIntent() {
    return state.strategicIntent || ''
  }

  function getCurrentSubgoal() {
    return state.subgoals[0] || ''
  }

  function ensureActionQueue() {
    const currentSubgoal = getCurrentSubgoal()
    if (!currentSubgoal) return false
    if (state.actionQueue.length) return true

    state.actionQueue = [currentSubgoal]
    sessionMemory?.addMemory?.(
      `Subgoal expanded: ${currentSubgoal} | Actions: ${state.actionQueue.join(' -> ')}`,
      'plan',
      { tags: ['intent-layer2', 'intent-layer3', 'autonomy'] }
    )

    if (ENABLE_DYNAMIC_SUBGOAL_EXPANSION && !state.expansionInFlight) {
      state.expansionInFlight = true
      state.expansionSubgoal = currentSubgoal

      Promise.resolve()
        .then(() => dynamicAgent.expandSubgoalPlan({
          strategicIntent: state.strategicIntent,
          subgoal: currentSubgoal,
        }))
        .then((expanded) => {
          const actions = Array.isArray(expanded)
            ? expanded.map(normalizeStep).filter(Boolean).slice(0, 6)
            : []

          const sameSubgoal = getCurrentSubgoal() === currentSubgoal
          const queueIsFallbackOnly = state.actionQueue.length <= 1 && state.actionQueue[0] === currentSubgoal
          if (!sameSubgoal || !queueIsFallbackOnly || !actions.length) return

          state.actionQueue = actions
          sessionMemory?.addMemory?.(
            `Subgoal refined asynchronously: ${currentSubgoal} | Actions: ${state.actionQueue.join(' -> ')}`,
            'plan',
            { tags: ['intent-layer3', 'async-refine'] }
          )
        })
        .catch(() => {})
        .finally(() => {
          state.expansionInFlight = false
          state.expansionSubgoal = ''
        })
    }

    return true
  }

  function getNextAction() {
    if (!ENABLE_INTENT_HIERARCHY) return ''
    ensureActionQueue()
    return state.actionQueue[0] || ''
  }

  function onActionResult({ success, executedAction }) {
    const currentSubgoal = getCurrentSubgoal()
    const currentAction = state.actionQueue[0] || ''
    if (!currentSubgoal || !currentAction) return

    if (success) {
      pushProgress(`done: ${currentAction}`)
      state.actionQueue.shift()

      if (!state.actionQueue.length) {
        state.subgoals.shift()
        state.currentSubgoalAttempts = 0
        sessionMemory?.addMemory?.(
          `Subgoal completed: ${currentSubgoal}`,
          'action-success',
          { tags: ['intent-layer2', 'complete'] }
        )
      }

      sessionMemory?.addMemory?.(
        `Intent action completed: ${currentAction}`,
        'action-success',
        { tags: ['intent-layer3', 'step'] }
      )

      if (!state.subgoals.length) {
        sessionMemory?.addMemory?.(
          `Strategic intent completed: ${state.strategicIntent}`,
          'summary',
          { tags: ['intent-layer1', 'complete'] }
        )
        state.strategicIntent = ''
      }
      return
    }

    state.currentSubgoalAttempts += 1
    pushProgress(`failed: ${currentAction} (${String(executedAction || 'no-action')})`)
    state.actionQueue.shift()

    if (state.currentSubgoalAttempts >= 3) {
      sessionMemory?.addMemory?.(
        `Subgoal dropped after retries: ${currentSubgoal}`,
        'action-fail',
        { tags: ['intent-layer2', 'replan'] }
      )
      state.subgoals.shift()
      state.actionQueue = []
      state.currentSubgoalAttempts = 0
    }
  }

  function disable() {
    state.disabled = true
  }

  function enable() {
    state.disabled = false
  }

  return {
    refreshIntentIfNeeded,
    getCurrentIntent,
    getCurrentSubgoal,
    getNextAction,
    onActionResult,
    disable,
    enable,
  }
}

module.exports = {
  createIntentLoop,
}
