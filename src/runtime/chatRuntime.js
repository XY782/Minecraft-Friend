function createChatRuntime({
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
  getBrain,
  getLiveProfileContext,
}) {
  const CHAT_BATCH_WINDOW_MS = 800
  const playerChatBuffers = new Map()
  const playerChatTimers = new Map()
  const playerReplyQueue = new Map()

  function remember(playerName, line) {
    const arr = chatWindow.get(playerName) || []
    arr.push(line)
    while (arr.length > 20) arr.shift()
    chatWindow.set(playerName, arr)
    return arr
  }

  function queuePlayerReply(playerName, task) {
    const previous = playerReplyQueue.get(playerName) || Promise.resolve()
    const current = previous
      .then(task)
      .catch((e) => {
        console.log('player reply queue error', e)
      })

    playerReplyQueue.set(playerName, current)

    current.finally(() => {
      if (playerReplyQueue.get(playerName) === current) {
        playerReplyQueue.delete(playerName)
      }
    })
  }

  async function handlePlayerChatBatch(playerName, messages) {
    if (!gemini) return

    const lines = (messages || []).map((entry) => String(entry || '').trim()).filter(Boolean)
    if (!lines.length) return

    const mergedMessage = lines.length === 1
      ? lines[0]
      : lines.map((line, index) => `${index + 1}) ${line}`).join(' | ')

    const lower = mergedMessage.toLowerCase()
    const directlyAddressed = isMention(bot.username, mergedMessage)

    if (directlyAddressed && /\b(stop pvp|stop fighting|don['’]t fight|peace)\b/.test(lower)) {
      bot.__forcePvpUntil = 0
      bot.__forcePvpTarget = null
      bot.__forcedDynamicAction = null
      sendChat('Alright, standing down.')
      sessionMemory.addMemory(`PvP intent cancelled by ${playerName}.`, 'action')
      return
    }

    const explicitPvpIntent = /\b(pvp|duel|fight me|attack me|1v1|spar)\b/.test(lower)
    if (explicitPvpIntent && (directlyAddressed || lines.length === 1)) {
      const now = Date.now()
      bot.__forcePvpUntil = now + 90_000
      bot.__forcePvpTarget = playerName
      bot.__forcedDynamicAction = {
        actionText: 'ATTACK_PLAYER',
        goal: `engage controlled pvp with ${playerName}`,
        until: now + 90_000,
        source: 'chat-pvp-intent',
      }

      sendChat(`Alright ${playerName}, engaging pvp.`)
      sessionMemory.addMemory(`PvP intent received from ${playerName}.`, 'action', { tags: ['pvp', 'chat-intent'] })
      return
    }

    if (directlyAddressed && /\beat\b/.test(lower) && /\bbread\b/.test(lower)) {
      const ateBread = await eatNamedFood({ bot, foodName: 'bread' })
      if (ateBread) {
        sendChat('Eating bread now.')
        sessionMemory.addMemory('Ate bread on player request.', 'action-success', { tags: ['food', 'bread'] })
      } else {
        sendChat('No bread available to eat right now.')
        sessionMemory.addMemory('Could not eat bread on player request (none available or not edible).', 'action-fail', { tags: ['food', 'bread'] })
      }
      return
    }

    if (!shouldRespondToChat(playerName, mergedMessage)) return

    const memory = chatWindow.get(playerName) || []
    const brain = getBrain?.()
    const profileContext = getLiveProfileContext(brain)
    const relevantSessionContext = sessionMemory.getRelevantContextText({
      query: mergedMessage,
      contextText: profileContext,
      tags: ['chat', `player:${String(playerName || '').toLowerCase()}`],
      perSession: 8,
      limit: 16,
    })

    const promptMessage = lines.length === 1
      ? mergedMessage
      : `Recent player messages (chronological): ${mergedMessage}. Reply to the latest intent naturally and keep context coherent.`

    const reply = await gemini.generateReply({
      botName: bot.username,
      playerName,
      message: promptMessage,
      memory,
      sessionContext: relevantSessionContext,
      profileContext,
      avoidPhrases: antiRepeat.hints(5),
    })

    if (!reply) return

    if (config.antiRepeatEnabled && antiRepeat.seen(reply)) {
      const retry = await gemini.generateReply({
        botName: bot.username,
        playerName,
        message: `${promptMessage}\n(Respond differently than before in fresh wording.)`,
        memory,
        sessionContext: relevantSessionContext,
        profileContext,
        avoidPhrases: antiRepeat.hints(8),
      })
      if (retry) {
        remember(playerName, `${bot.username}: ${retry}`)
        sessionMemory.addMemory(`${bot.username}: ${retry}`, 'chat-out')
        antiRepeat.register(retry)
        brain?.onChatSignal?.('out')
        sendChat(retry)
        return
      }
    }

    remember(playerName, `${bot.username}: ${reply}`)
    sessionMemory.addMemory(`${bot.username}: ${reply}`, 'chat-out')
    antiRepeat.register(reply)
    brain?.onChatSignal?.('out')
    sendChat(reply)
  }

  function flushPlayerChatBuffer(playerName) {
    const timer = playerChatTimers.get(playerName)
    if (timer) {
      clearTimeout(timer)
      playerChatTimers.delete(playerName)
    }

    const messages = playerChatBuffers.get(playerName) || []
    playerChatBuffers.delete(playerName)
    if (!messages.length) return

    queuePlayerReply(playerName, async () => {
      try {
        await handlePlayerChatBatch(playerName, messages)
      } catch (e) {
        console.log('gemini error', e)
        sendChat('One sec, I glitched for a moment.')
      }
    })
  }

  function schedulePlayerChatFlush(playerName) {
    const existing = playerChatTimers.get(playerName)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      flushPlayerChatBuffer(playerName)
    }, CHAT_BATCH_WINDOW_MS)

    playerChatTimers.set(playerName, timer)
  }

  function onChat(playerName, message) {
    if (playerName === bot.username) return

    const brain = getBrain?.()
    brain?.onChatSignal?.('in')
    remember(playerName, `${playerName}: ${message}`)
    sessionMemory.addMemory(`${playerName}: ${message}`, 'chat-in')

    const msg = String(message || '').trim()
    if (!msg || !gemini) return

    const pending = playerChatBuffers.get(playerName) || []
    pending.push(msg)
    while (pending.length > 5) pending.shift()
    playerChatBuffers.set(playerName, pending)
    schedulePlayerChatFlush(playerName)
  }

  return {
    remember,
    onChat,
  }
}

module.exports = {
  createChatRuntime,
}
