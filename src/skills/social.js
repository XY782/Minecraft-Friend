function createSocialSkill({
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
}) {
  function shouldInitiateChat({ nearbyCount, mode, recentMemory }) {
    if (!nearbyCount) return false

    const recentBotLines = (recentMemory || [])
      .slice(-3)
      .filter((line) => String(line || '').startsWith(`${bot.username}:`))

    if (recentBotLines.length >= 2) return false

    const baseChance = mode === 'follow' ? 0.78 : mode === 'idle' ? 0.62 : 0.42
    return utils.chance(baseChance)
  }

  async function maybeProactiveChat() {
    if (!gemini) return

    const nearby = utils.getNearbyPlayers(bot, 14)
    if (!nearby.length) return false

    const target = nearby[0].entity
    const memory = chatWindow.get(target.username) || []
    if (!shouldInitiateChat({ nearbyCount: nearby.length, mode: state.getMode(), recentMemory: memory })) {
      return false
    }

    try {
      const profileContext = getProfileContext?.() || ''
      const sessionContext = sessionMemory?.getRelevantContextText?.({
        query: `social chat near ${target.username}`,
        contextText: profileContext,
        tags: ['chat', 'social', `player:${String(target.username || '').toLowerCase()}`],
        perSession: 8,
        limit: 12,
      }) || sessionMemory?.getDecayedContextText?.({ perSession: 4 }) || ''

      const opener = await gemini.generateReply({
        botName: bot.username,
        playerName: target.username,
        message: 'Start a natural, short conversation line based on what is happening nearby in Minecraft. Keep it casual and under 16 words.',
        memory,
        sessionContext,
        profileContext,
        avoidPhrases: antiRepeat?.hints?.(5) || [],
      })

      if (!opener) return false
      if (antiRepeat?.seen?.(opener)) return false
      remember(target.username, `${bot.username}: ${opener}`)
      antiRepeat?.register?.(opener)
      safeChat(opener)
      return true
    } catch (e) {
      console.log('proactive chat error', e)
      return false
    }
  }

  async function runSocialDecision() {
    const nearbyPlayers = utils.getNearbyPlayers(bot, config.followMaxDist)

    if (
      nearbyPlayers.length &&
      state.getMode() !== 'follow'
    ) {
      const followed = movement.startFollowingPlayer(nearbyPlayers[0].entity)
      if (followed) {
        const chatted = await maybeProactiveChat()
        return chatted || true
      }
    }

    const chatted = await maybeProactiveChat()
    return chatted
  }

  return {
    runSocialDecision,
  }
}

module.exports = {
  createSocialSkill,
}
