const readline = require('readline')

function createPuppetMode({
  bot,
  config,
  sessionMemory,
  onActionOutcome = () => {},
}) {
  const enabled = Boolean(config.puppetModeEnabled)
  const announce = Boolean(config.puppetModeAnnounce)
  const autoActivate = Boolean(config.puppetModeAutoActivate)

  let attached = false
  let active = false
  let keepAliveTimer = null

  const moveState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    sprint: false,
    sneak: false,
  }

  function nearestAttackTarget(maxDistance = 4.5) {
    const self = bot?.entity
    if (!self?.position) return null

    const entities = Object.values(bot.entities || {})
      .filter((entity) => {
        if (!entity || !entity.position) return false
        if (entity.id === self.id) return false
        if (entity.type !== 'mob' && entity.type !== 'player') return false
        if (entity.type === 'player' && entity.username === bot.username) return false
        return self.position.distanceTo(entity.position) <= maxDistance
      })
      .sort((a, b) => self.position.distanceTo(a.position) - self.position.distanceTo(b.position))

    return entities[0] || null
  }

  function applyMovement() {
    bot.setControlState('forward', moveState.forward)
    bot.setControlState('back', moveState.back)
    bot.setControlState('left', moveState.left)
    bot.setControlState('right', moveState.right)
    bot.setControlState('sprint', moveState.sprint)
    bot.setControlState('sneak', moveState.sneak)
  }

  function clearMovement() {
    moveState.forward = false
    moveState.back = false
    moveState.left = false
    moveState.right = false
    moveState.sprint = false
    moveState.sneak = false
    bot.setControlState('jump', false)
    applyMovement()
  }

  function pauseAutonomyWindow(ms = 1200) {
    bot.__movementPauseUntil = Date.now() + Math.max(300, Number(ms) || 1200)
  }

  function setActive(next) {
    const value = Boolean(next)
    if (active === value) return

    active = value
    bot.__puppetActive = active

    if (active) {
      pauseAutonomyWindow(2000)
      try {
        bot.pathfinder?.setGoal?.(null)
      } catch {}

      if (!keepAliveTimer) {
        keepAliveTimer = setInterval(() => {
          if (active) pauseAutonomyWindow(1500)
        }, 400)
      }

      if (announce) {
        console.log('[PUPPET] active: keyboard control ON (press H for help)')
      }
      sessionMemory?.addMemory?.('Puppet mode activated.', 'training')
    } else {
      clearMovement()
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
        keepAliveTimer = null
      }
      if (announce) {
        console.log('[PUPPET] active: keyboard control OFF')
      }
      sessionMemory?.addMemory?.('Puppet mode deactivated.', 'training')
    }
  }

  function reportAction(action, success = true, details = null) {
    onActionOutcome?.({
      action,
      success,
      source: 'puppet',
      details,
    })
  }

  function printHelp() {
    console.log('[PUPPET] keys: P toggle | H help | W/A/S/D toggle move | Space jump | R sprint toggle | F sneak toggle | T attack nearest | E use item | Q clear movement | Ctrl+C exit')
  }

  async function handleKeypress(str, key = {}) {
    if (!enabled) return
    if (key?.ctrl && key?.name === 'c') {
      stop()
      process.kill(process.pid, 'SIGINT')
      return
    }

    const name = String(key?.name || str || '').toLowerCase()
    if (!name) return

    if (name === 'h') {
      printHelp()
      return
    }

    if (name === 'p') {
      setActive(!active)
      return
    }

    if (!active) return

    pauseAutonomyWindow(1500)

    if (name === 'w') {
      moveState.forward = !moveState.forward
      applyMovement()
      reportAction('EXPLORE', true, { key: 'w', state: moveState.forward })
      return
    }

    if (name === 's') {
      moveState.back = !moveState.back
      applyMovement()
      reportAction('EXPLORE', true, { key: 's', state: moveState.back })
      return
    }

    if (name === 'a') {
      moveState.left = !moveState.left
      applyMovement()
      reportAction('EXPLORE', true, { key: 'a', state: moveState.left })
      return
    }

    if (name === 'd') {
      moveState.right = !moveState.right
      applyMovement()
      reportAction('EXPLORE', true, { key: 'd', state: moveState.right })
      return
    }

    if (name === 'r') {
      moveState.sprint = !moveState.sprint
      applyMovement()
      reportAction('EXPLORE', true, { key: 'r', sprint: moveState.sprint })
      return
    }

    if (name === 'f') {
      moveState.sneak = !moveState.sneak
      applyMovement()
      reportAction('EXPLORE', true, { key: 'f', sneak: moveState.sneak })
      return
    }

    if (name === 'q') {
      clearMovement()
      reportAction('IDLE', true, { key: 'q' })
      return
    }

    if (name === 'space') {
      bot.setControlState('jump', true)
      setTimeout(() => {
        try {
          bot.setControlState('jump', false)
        } catch {}
      }, 150)
      reportAction('EXPLORE', true, { key: 'space' })
      return
    }

    if (name === 't') {
      const target = nearestAttackTarget(4.5)
      if (!target) {
        reportAction('ATTACK_MOB', false, { key: 't', reason: 'no-nearby-target' })
        return
      }

      try {
        await bot.attack(target)
        reportAction(target.type === 'player' ? 'ATTACK_PLAYER' : 'ATTACK_MOB', true, {
          key: 't',
          targetType: target.type,
          targetName: target.name || target.username || 'unknown',
        })
      } catch {
        reportAction(target.type === 'player' ? 'ATTACK_PLAYER' : 'ATTACK_MOB', false, { key: 't', reason: 'attack-failed' })
      }
      return
    }

    if (name === 'e') {
      try {
        bot.activateItem()
        setTimeout(() => {
          try {
            bot.deactivateItem()
          } catch {}
        }, 120)
        reportAction('USE_ITEM', true, { key: 'e' })
      } catch {
        reportAction('USE_ITEM', false, { key: 'e', reason: 'use-item-failed' })
      }
    }
  }

  function start() {
    if (!enabled || attached) return

    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()
    process.stdin.on('keypress', handleKeypress)
    attached = true

    printHelp()
    sessionMemory?.addMemory?.('Puppet mode listener started.', 'training')

    if (autoActivate) {
      setActive(true)
    }
  }

  function stop() {
    if (!attached) return

    setActive(false)
    process.stdin.off('keypress', handleKeypress)
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
    attached = false
    sessionMemory?.addMemory?.('Puppet mode listener stopped.', 'training')
  }

  return {
    start,
    stop,
    setActive,
    isActive: () => active,
    isEnabled: () => enabled,
  }
}

module.exports = {
  createPuppetMode,
}
