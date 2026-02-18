function createChatSender({ bot, config, randInt, wait }) {
  const sentTimestamps = []
  let chatQueue = Promise.resolve()

  function canSendChatNow() {
    const now = Date.now()
    while (sentTimestamps.length && now - sentTimestamps[0] > 10_000) sentTimestamps.shift()
    return sentTimestamps.length < config.chatRate
  }

  function sendChat(text) {
    if (!text) return
    const msg = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (!msg) return

    const sendNow = () => {
      if (!canSendChatNow()) return
      sentTimestamps.push(Date.now())
      bot.chat(msg.slice(0, 240))
    }

    if (!config.humanizeBehavior) {
      sendNow()
      return
    }

    const delay = randInt(config.minReplyDelayMs, config.maxReplyDelayMs)
    chatQueue = chatQueue
      .then(() => wait(delay))
      .then(() => {
        sendNow()
        return wait(randInt(100, 450))
      })
      .catch((e) => {
        console.log('chat queue error', e)
      })
  }

  return {
    sendChat,
  }
}

module.exports = {
  createChatSender,
}
