const { buildWorldSnapshot } = require('./worldSnapshot')
const { parsePlanText } = require('./parsing')
const { heuristicCandidates, buildBundleFromRanked } = require('./heuristics')

function createChooserSkill({ bot, gemini, config, utils, sessionMemory, getProfileContext }) {
  const recentActions = []
  const actionStats = new Map()
  let currentIntent = 'stay adaptive'
  let plannerOfflineUntil = 0
  let lastPlannerErrorAt = 0

  function shouldUseGeminiPlanner() {
    if (!config.plannerUseGemini) return false
    if (!gemini?.generatePlan) return false
    return Date.now() >= plannerOfflineUntil
  }

  function markPlannerError(error) {
    const msg = String(error?.message || '')
    const networkish =
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT')

    if (networkish) {
      plannerOfflineUntil = Date.now() + 60_000
    }

    const now = Date.now()
    if (now - lastPlannerErrorAt >= 30_000) {
      lastPlannerErrorAt = now
      console.log('chooser gemini error', error)
    }
  }

  function registerOutcome(action, success) {
    if (!action) return
    recentActions.push(action)
    while (recentActions.length > 8) recentActions.shift()

    const prev = actionStats.get(action) || { success: 0, fail: 0 }
    if (success) prev.success += 1
    else prev.fail += 1
    actionStats.set(action, prev)
  }

  function rankActions(actions) {
    return Array.from(new Set(actions.filter(Boolean)))
      .map((action) => {
        const stat = actionStats.get(action) || { success: 0, fail: 0 }
        const recentPenalty = recentActions.slice(-2).includes(action) ? 1.35 : 0
        const score = (stat.success * 1.05) - (stat.fail * 1.2) - recentPenalty
        return { action, score }
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.action)
  }

  async function chooseAction({ exclude = [] } = {}) {
    const excluded = new Set(exclude.map((x) => String(x || '').toUpperCase()))
    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const heuristics = heuristicCandidates(snapshot, config).filter((a) => !excluded.has(a))
    const profileContext = getProfileContext?.() || ''
    const sessionContext = sessionMemory?.getRelevantContextText?.({
      query: `intent:${currentIntent} actions:${heuristics.join(' ')}`,
      contextText: profileContext,
      tags: ['planner'],
      perSession: 8,
      limit: 14,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 5 }) || ''

    let aiChosen = null
    if (shouldUseGeminiPlanner()) {
      try {
        const response = await gemini.generatePlan({
          botName: bot.username,
          worldState: snapshot,
          allowedActions: heuristics,
          maxSteps: 1,
          sessionContext,
          profileContext,
        })

        aiChosen = parsePlanText(response).find((action) => action && !excluded.has(action)) || null
      } catch (e) {
        markPlannerError(e)
      }
    }

    const ranked = rankActions(heuristics)
    const chosen = aiChosen || ranked[0] || null
    currentIntent = chosen ? `try ${chosen.toLowerCase()}` : 'stay adaptive'
    return chosen
  }

  async function chooseActionBundle({ exclude = [], maxActions = config.maxConcurrentActions || 3 } = {}) {
    const excluded = new Set(exclude.map((x) => String(x || '').toUpperCase()))
    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const heuristics = heuristicCandidates(snapshot, config).filter((a) => !excluded.has(a))
    const profileContext = getProfileContext?.() || ''
    const sessionContext = sessionMemory?.getRelevantContextText?.({
      query: `bundle:${heuristics.join(' ')}`,
      contextText: `${profileContext}\n${JSON.stringify(snapshot)}`,
      tags: ['planner', 'autonomy'],
      perSession: 8,
      limit: 16,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 5 }) || ''

    let aiActions = []
    if (shouldUseGeminiPlanner()) {
      try {
        const response = await gemini.generatePlan({
          botName: bot.username,
          worldState: snapshot,
          allowedActions: heuristics,
          maxSteps: Math.max(1, Math.min(3, maxActions)),
          sessionContext,
          profileContext,
        })

        aiActions = parsePlanText(response).filter((action) => action && !excluded.has(action))
      } catch (e) {
        markPlannerError(e)
      }
    }

    const ranked = rankActions([...aiActions, ...heuristics])
    const bundle = buildBundleFromRanked(ranked, maxActions)
    currentIntent = bundle.length ? `do ${bundle.join(' + ').toLowerCase()}` : 'stay adaptive'
    return bundle
  }

  function getGoal() {
    return currentIntent
  }

  function reset() {
    recentActions.length = 0
    currentIntent = 'stay adaptive'
  }

  return {
    chooseAction,
    chooseActionBundle,
    registerOutcome,
    getGoal,
    reset,
  }
}

module.exports = {
  createChooserSkill,
}
