const { GoogleGenerativeAI } = require('@google/generative-ai')

function createGeminiClient({ apiKey, model, shouldSuppress = () => false }) {
  if (!apiKey) return null

  const genAI = new GoogleGenerativeAI(apiKey)
  const geminiModel = genAI.getGenerativeModel({
    model: model || 'gemini-3-flash'
  })

  let suppressCheck = typeof shouldSuppress === 'function' ? shouldSuppress : () => false
  let disabledReason = ''
  let lastDisableLogAt = 0
  let lastTransientLogAt = 0

  function setSuppressionCheck(nextCheck) {
    suppressCheck = typeof nextCheck === 'function' ? nextCheck : () => false
  }

  function isSuppressed() {
    try {
      return Boolean(suppressCheck?.())
    } catch {
      return false
    }
  }

  function markDisabled(reason) {
    if (disabledReason) return
    disabledReason = String(reason || 'unknown')
    const now = Date.now()
    if (now - lastDisableLogAt > 10_000) {
      lastDisableLogAt = now
      console.warn(`[gemini] disabled for this session (${disabledReason}). Using fallback responses until restart.`)
    }
  }

  function isAuthOrLeakedKeyError(error) {
    const status = Number(error?.status || 0)
    const statusText = String(error?.statusText || '').toLowerCase()
    const message = String(error?.message || '').toLowerCase()
    const forbidden = status === 401 || status === 403 || statusText.includes('forbidden')
    if (!forbidden) return false
    return message.includes('api key was reported as leaked') || message.includes('api key') || message.includes('forbidden')
  }

  function isTransientServiceError(error) {
    const status = Number(error?.status || 0)
    const statusText = String(error?.statusText || '').toLowerCase()
    const message = String(error?.message || '').toLowerCase()
    return (
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      statusText.includes('service unavailable') ||
      message.includes('high demand') ||
      message.includes('service unavailable')
    )
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function safeGenerateContent(request, { fallback = '' } = {}) {
    if (isSuppressed() || disabledReason) return fallback
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await geminiModel.generateContent(request)
        return String(result?.response?.text?.() || '').trim()
      } catch (error) {
        if (isAuthOrLeakedKeyError(error)) {
          markDisabled(error?.message || 'auth_error')
          return fallback
        }

        if (!isTransientServiceError(error)) {
          throw error
        }

        if (attempt >= maxAttempts) {
          const now = Date.now()
          if (now - lastTransientLogAt > 10_000) {
            lastTransientLogAt = now
            console.warn('[gemini] transient service issue (high demand). Falling back for now.')
          }
          return fallback
        }

        const backoffMs = 350 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 120)
        await wait(backoffMs)
      }
    }
    return fallback
  }

  async function generateReply({ botName, playerName, message, memory, sessionContext, profileContext, avoidPhrases }) {
    if (isSuppressed() || disabledReason) return ''

    const system = `
  You are ${botName}, chatting as a normal Minecraft player in multiplayer.

  Style rules:
  - Sound natural, casual, and in-the-moment.
  - Keep replies short (usually 1 sentence, max 2 unless asked).
  - No role labels, no prefixes, no markdown, no stage directions.
  - Avoid repetitive phrasing and avoid mentioning system behavior.
  - Stay context-aware to nearby gameplay and recent conversation.

  Behavior rules:
  - If asked to break server rules, refuse briefly and casually.
  - Never claim hidden powers you cannot do in-game.
  - Never claim an action is already done unless it was clearly observed in recent context.
  `

    const historyText = (memory || [])
      .slice(-12)
      .map((t) => `- ${t}`)
      .join('\n')

    const prompt = [
      system.trim(),
      historyText ? `Recent conversation:\n${historyText}` : '',
      sessionContext ? `Session memory with decay weights:\n${sessionContext}` : '',
      profileContext ? `Current Minecraft profile context:\n${profileContext}` : '',
      avoidPhrases?.length ? `Avoid repeating these exact phrases:\n${avoidPhrases.map((p) => `- ${p}`).join('\n')}` : '',
      `${playerName}: ${message}`,
      `Reply as ${botName}:`
    ]
      .filter(Boolean)
      .join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.5,
        topP: 0.95,
        topK: 56
      }
    }, { fallback: '' })
  }

  async function generatePlan({ botName, worldState, allowedActions, maxSteps = 5, sessionContext, profileContext }) {
    if (isSuppressed() || disabledReason) return '{"plan":[]}'
    const system = `
You are the autonomous planner for ${botName}, a Minecraft bot.

Return ONLY valid JSON in this exact shape:
{"plan":["ACTION1","ACTION2"]}

Rules:
- Use only allowed actions.
- Choose up to ${Math.max(1, Math.min(8, maxSteps))} actions.
- Prefer survival first, then progression, then social behavior.
- Keep actions high-value and non-redundant.
- Decide actions fully autonomously from world/profile/session context.
- Do not wait for user-provided options or toggles.
`

    const prompt = [
      system.trim(),
      `Allowed actions: ${JSON.stringify(allowedActions || [])}`,
      `World state: ${JSON.stringify(worldState || {}, null, 2)}`,
      sessionContext ? `Session memory with decay weights:\n${sessionContext}` : '',
      profileContext ? `Current Minecraft profile context:\n${profileContext}` : '',
    ].join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 0.9,
        topK: 28,
      }
    }, { fallback: '{"plan":[]}' })
  }

  async function generateCreativeTarget({ botName, profileContext, sessionContext }) {
    if (isSuppressed() || disabledReason) return ''
    const prompt = [
      `You are choosing one Minecraft item/block id for ${botName} to obtain in creative mode.`,
      'Return exactly one valid Minecraft identifier like: firework_rocket, enchanting_table, diamond_sword, oak_log.',
      'No explanation, no punctuation, one token only.',
      profileContext ? `Profile context:\n${profileContext}` : '',
      sessionContext ? `Session context:\n${sessionContext}` : '',
    ].filter(Boolean).join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 0.9,
        topK: 20,
      }
    }, { fallback: '' })
  }

  async function generateDynamicAction({ botName, worldState, drives, missionGoal, recentMemory, profileContext }) {
    if (isSuppressed() || disabledReason) return ''
    const prompt = [
      `You are the autonomous decision core for ${botName}, a Minecraft bot.`,
      'Decide one immediate next step based on the world snapshot, internal drives, and recent memory.',
      missionGoal ? `Current self-directed mission goal: ${missionGoal}` : '',
      'Return ONLY valid JSON in this shape:',
      '{"action":"...","why":"..."}',
      'Action can be either:',
      '- a short Minecraft behavior phrase (examples: "eat food", "defend from mob", "explore nearby cave", "help nearest player", "collect dropped item", "equip better gear")',
      '- or a command string starting with "/" when needed.',
      'Rules:',
      '- Prefer survival and safety first.',
      '- Keep the action aligned with the current mission goal unless immediate danger overrides it.',
      '- Keep it to one actionable step only.',
      '- Do not include markdown or extra keys.',
      `World snapshot:\n${JSON.stringify(worldState || {}, null, 2)}`,
      `Internal drives:\n${JSON.stringify(drives || {}, null, 2)}`,
      recentMemory ? `Recent memory:\n${recentMemory}` : '',
      profileContext ? `Profile context:\n${profileContext}` : '',
    ].filter(Boolean).join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 0.93,
        topK: 44,
      },
    }, { fallback: '' })
  }

  async function generateUrgency({ botName, worldState, drives, recentMemory, profileContext }) {
    if (isSuppressed() || disabledReason) return '{"urgent":[],"why":"manual control active"}'
    const prompt = [
      `You are the urgency evaluator for ${botName}, a Minecraft bot.`,
      'Return ONLY valid JSON in this shape:',
      '{"urgent":["ACTION_TEXT_1","ACTION_TEXT_2"],"why":"..."}',
      'Rules:',
      '- Return up to 2 urgent immediate actions.',
      '- Prioritize survival-critical actions first.',
      '- If no urgent action, return an empty array.',
      '- Keep each action short and executable.',
      `World snapshot:\n${JSON.stringify(worldState || {}, null, 2)}`,
      `Internal drives:\n${JSON.stringify(drives || {}, null, 2)}`,
      recentMemory ? `Recent memory:\n${recentMemory}` : '',
      profileContext ? `Profile context:\n${profileContext}` : '',
    ].filter(Boolean).join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 0.9,
        topK: 30,
      },
    }, { fallback: '{"urgent":[],"why":"gemini unavailable"}' })
  }

  async function generateIntentPlan({ botName, worldState, drives, currentIntent, progressNotes, recentMemory, profileContext }) {
    if (isSuppressed() || disabledReason) return '{"intent":"","steps":[]}'
    const prompt = [
      `You are the autonomous intent planner for ${botName}, a Minecraft bot.`,
      'Pick one clear high-level intent and a short ordered step list.',
      'Return ONLY valid JSON in this exact shape:',
      '{"intent":"...","steps":["...","...","..."]}',
      'Rules:',
      '- Intent must be practical for current world state.',
      '- Steps must be executable one-by-one by a Minecraft bot.',
      '- Keep steps concise and action-focused (max 6 steps).',
      '- Prioritize survival and safety before progression.',
      currentIntent ? `Current active intent: ${currentIntent}` : '',
      progressNotes?.length ? `Recent progress notes: ${JSON.stringify(progressNotes)}` : '',
      `World snapshot:\n${JSON.stringify(worldState || {}, null, 2)}`,
      `Internal drives:\n${JSON.stringify(drives || {}, null, 2)}`,
      recentMemory ? `Recent memory:\n${recentMemory}` : '',
      profileContext ? `Profile context:\n${profileContext}` : '',
    ].filter(Boolean).join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 0.9,
        topK: 28,
      },
    }, { fallback: '{"intent":"","steps":[]}' })
  }

  async function generateSubgoalActions({ botName, strategicIntent, subgoal, worldState, drives, recentMemory, profileContext }) {
    if (isSuppressed() || disabledReason) return '{"actions":[]}'
    const prompt = [
      `You are decomposing one tactical subgoal for ${botName}, a Minecraft bot.`,
      'Return ONLY valid JSON in this exact shape:',
      '{"actions":["...","...","..."]}',
      'Rules:',
      '- Convert subgoal into short executable action texts.',
      '- 2 to 6 actions max.',
      '- Use practical Minecraft actions the bot can execute now.',
      '- Prefer safe actions first if risk is present.',
      strategicIntent ? `Strategic intent: ${strategicIntent}` : '',
      `Subgoal: ${String(subgoal || '').trim()}`,
      `World snapshot:\n${JSON.stringify(worldState || {}, null, 2)}`,
      `Internal drives:\n${JSON.stringify(drives || {}, null, 2)}`,
      recentMemory ? `Recent memory:\n${recentMemory}` : '',
      profileContext ? `Profile context:\n${profileContext}` : '',
    ].filter(Boolean).join('\n\n')

    return safeGenerateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 1.0,
        topK: 24,
      },
    }, { fallback: '{"actions":[]}' })
  }

  return {
    setSuppressionCheck,
    generateReply,
    generatePlan,
    generateCreativeTarget,
    generateDynamicAction,
    generateUrgency,
    generateIntentPlan,
    generateSubgoalActions,
  }
}

module.exports = { createGeminiClient }
