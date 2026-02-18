const http = require('http')
const { spawn } = require('child_process')

const { WebSocketServer } = require('ws')

let createViewer = null

function tryLoadViewerModule() {
  if (createViewer) return createViewer
  try {
    const viewerPkg = require('prismarine-viewer')
    createViewer = viewerPkg?.mineflayer || null
    return createViewer
  } catch (error) {
    return null
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function createFirstPersonPuppet({
  bot,
  config,
  sessionMemory,
  onActionOutcome = () => {},
}) {
  const enabled = Boolean(config.firstPersonPuppetEnabled)
  const viewerPort = Number(config.firstPersonViewerPort || 3007)
  const controlPort = Number(config.firstPersonControlPort || (viewerPort + 3))
  const autoOpen = Boolean(config.firstPersonAutoOpen)
  const mouseSensitivity = Number(config.firstPersonMouseSensitivity || 0.002)
  const viewDistance = Number(config.firstPersonViewDistance || 7)

  let started = false
  let viewerStarted = false
  let httpServer = null
  let wss = null
  let viewerServer = null
  let activeClients = 0
  let activeViewerPort = viewerPort
  let activeControlPort = controlPort
  let controlKeepAliveTimer = null
  let lookApplyTimer = null
  let pendingLookDx = 0
  let pendingLookDy = 0
  let puppetActive = false

  const controls = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  }

  function reportAction(action, success = true, details = null) {
    onActionOutcome?.({
      action,
      success,
      source: 'first-person-puppet',
      details,
    })
  }

  function applyControlStates() {
    bot.setControlState('forward', controls.forward)
    bot.setControlState('back', controls.back)
    bot.setControlState('left', controls.left)
    bot.setControlState('right', controls.right)
    bot.setControlState('jump', controls.jump)
    bot.setControlState('sprint', controls.sprint)
    bot.setControlState('sneak', controls.sneak)
  }

  function applyControlsFromKeySet(keySet) {
    controls.forward = keySet.has('KeyW')
    controls.back = keySet.has('KeyS')
    controls.left = keySet.has('KeyA')
    controls.right = keySet.has('KeyD')
    controls.sprint = keySet.has('KeyR')
    controls.jump = keySet.has('Space')
    controls.sneak = keySet.has('ShiftLeft') || keySet.has('ShiftRight')
    applyControlStates()
  }

  function clearControlStates() {
    controls.forward = false
    controls.back = false
    controls.left = false
    controls.right = false
    controls.jump = false
    controls.sprint = false
    controls.sneak = false
    applyControlStates()
  }

  function setPuppetActive(next) {
    const isActive = Boolean(next)
    if (puppetActive === isActive) {
      if (isActive) {
        bot.__movementPauseUntil = Date.now() + 2_000
      }
      return
    }

    puppetActive = isActive
    bot.__puppetActive = isActive
    if (!isActive) {
      clearControlStates()
      return
    }

    try {
      bot.clearControlStates?.()
      bot.pvp?.stop?.()
      bot.stopDigging?.()
    } catch {}
    bot.__movementPauseUntil = Date.now() + 2_000
    try {
      bot.pathfinder?.setGoal?.(null)
    } catch {}
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

  function buildControlHtml() {
    const viewerUrl = `http://127.0.0.1:${activeViewerPort}`
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Minecraft Bot FPV Puppet</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #0f1117; color: #e8ecff; font-family: system-ui, sans-serif; overflow: hidden; }
    #shell { display: grid; grid-template-columns: 1fr 340px; width: 100%; height: 100%; }
    #viewerWrap { position: relative; width: 100%; height: 100%; }
    #viewer { border: 0; width: 100%; height: 100%; background: #000; }
    #captureLayer { position: absolute; inset: 0; cursor: crosshair; }
    #reticle {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 14px;
      height: 14px;
      margin-left: -7px;
      margin-top: -7px;
      border: 2px solid rgba(255,255,255,.9);
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0,0,0,.5);
      pointer-events: none;
    }
    #hud { position: absolute; left: 12px; top: 12px; background: rgba(0,0,0,.55); padding: 8px 10px; border-radius: 8px; font-size: 12px; }
    #side { padding: 14px; border-left: 1px solid rgba(255,255,255,.15); background: #161b2a; }
    .k { font-weight: 700; color: #9fd3ff; }
    .row { margin: 8px 0; line-height: 1.4; }
    .warn { color: #ffd17a; }
  </style>
</head>
<body>
  <div id="shell">
    <div id="viewerWrap">
      <iframe id="viewer" src="${viewerUrl}"></iframe>
      <div id="captureLayer"></div>
      <div id="reticle"></div>
      <div id="hud">Click view to lock mouse. ESC unlocks.</div>
    </div>
    <aside id="side">
      <h3>FPV Puppet Controls</h3>
      <div class="row"><span class="k">W/A/S/D</span> move</div>
      <div class="row"><span class="k">Space</span> jump</div>
      <div class="row"><span class="k">R</span> sprint</div>
      <div class="row"><span class="k">Shift</span> sneak</div>
      <div class="row"><span class="k">Mouse</span> look</div>
      <div class="row"><span class="k">Left Click</span> attack nearest</div>
      <div class="row"><span class="k">Right Click</span> use held item</div>
      <div class="row"><span class="warn">Close this window to release control.</span></div>
    </aside>
  </div>
  <script>
    const ws = new WebSocket('ws://127.0.0.1:${activeControlPort}')
    const layer = document.getElementById('captureLayer')

    function send(payload) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload))
      }
    }

    const downKeys = new Set()
    let pendingLookDx = 0
    let pendingLookDy = 0
    let lastSyncSig = ''

    function onKey(ev, isDown) {
      const code = ev.code
      if (!code) return
      if (isDown) downKeys.add(code)
      else downKeys.delete(code)
      send({ type: 'key', code, isDown })
      if ([
        'KeyW','KeyA','KeyS','KeyD','KeyR','Space','ShiftLeft','ShiftRight'
      ].includes(code)) {
        ev.preventDefault()
      }
    }

    window.addEventListener('keydown', (ev) => {
      if (ev.repeat) return
      onKey(ev, true)
    })
    window.addEventListener('keyup', (ev) => onKey(ev, false))

    layer.addEventListener('click', () => {
      if (document.pointerLockElement !== layer) {
        layer.requestPointerLock()
      }
    })

    window.addEventListener('mousemove', (ev) => {
      if (document.pointerLockElement !== layer) return
      pendingLookDx += Number(ev.movementX || 0)
      pendingLookDy += Number(ev.movementY || 0)
    })

    setInterval(() => {
      const keys = Array.from(downKeys).sort()
      const sig = keys.join(',')
      if (sig === lastSyncSig) return
      lastSyncSig = sig
      send({ type: 'sync_keys', keys })
    }, 60)

    setInterval(() => {
      const keys = Array.from(downKeys).sort()
      send({ type: 'sync_keys', keys })
    }, 350)

    setInterval(() => {
      if (document.pointerLockElement !== layer) return
      if (Math.abs(pendingLookDx) < 0.01 && Math.abs(pendingLookDy) < 0.01) return
      const useDx = Math.max(-64, Math.min(64, pendingLookDx))
      const useDy = Math.max(-64, Math.min(64, pendingLookDy))
      pendingLookDx -= useDx
      pendingLookDy -= useDy
      send({ type: 'look', dx: useDx, dy: useDy })
    }, 25)

    window.addEventListener('mousedown', (ev) => {
      if (document.pointerLockElement !== layer) return
      if (ev.button === 0) send({ type: 'attack' })
      if (ev.button === 2) send({ type: 'use_item' })
    })

    window.addEventListener('contextmenu', (ev) => ev.preventDefault())

    function releaseControls() {
      send({ type: 'release_controls' })
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) releaseControls()
    })

    window.addEventListener('beforeunload', () => {
      send({ type: 'release' })
    })
  </script>
</body>
</html>`
  }

  function openControlWindow(url) {
    if (!autoOpen) return
    try {
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      }).unref()
    } catch {}
  }

  async function handleMessage(message) {
    let payload = null
    try {
      payload = JSON.parse(String(message || '{}'))
    } catch {
      return
    }

    if (!payload || typeof payload !== 'object') return

    if (payload.type === 'release') {
      setPuppetActive(false)
      return
    }

    if (payload.type === 'release_controls') {
      clearControlStates()
      return
    }

    setPuppetActive(true)
    bot.__movementPauseUntil = Date.now() + 2_000

    if (payload.type === 'heartbeat') {
      return
    }

    if (payload.type === 'key') {
      const isDown = Boolean(payload.isDown)
      switch (String(payload.code || '')) {
        case 'KeyW': controls.forward = isDown; break
        case 'KeyS': controls.back = isDown; break
        case 'KeyA': controls.left = isDown; break
        case 'KeyD': controls.right = isDown; break
        case 'KeyR': controls.sprint = isDown; break
        case 'Space': controls.jump = isDown; break
        case 'ShiftLeft':
        case 'ShiftRight': controls.sneak = isDown; break
        default: break
      }
      applyControlStates()
      reportAction('EXPLORE', true, { type: 'key', code: String(payload.code || ''), isDown })
      return
    }

    if (payload.type === 'sync_keys') {
      const keys = Array.isArray(payload.keys) ? payload.keys : []
      const keySet = new Set(keys.map((key) => String(key || '')))
      applyControlsFromKeySet(keySet)
      return
    }

    if (payload.type === 'look') {
      pendingLookDx += Number(payload.dx || 0)
      pendingLookDy += Number(payload.dy || 0)
      return
    }

    if (payload.type === 'attack') {
      const target = nearestAttackTarget(4.5)
      if (target) {
        try {
          await bot.attack(target)
          reportAction(target.type === 'player' ? 'ATTACK_PLAYER' : 'ATTACK_MOB', true, {
            targetType: target.type,
            targetName: target.name || target.username || 'unknown',
          })
        } catch {
          reportAction(target.type === 'player' ? 'ATTACK_PLAYER' : 'ATTACK_MOB', false, { reason: 'attack-failed' })
        }
        return
      }

      try {
        const block = bot.blockAtCursor?.(6)
        if (!block || block.name === 'air') {
          reportAction('BREAK', false, { reason: 'no-target-block' })
          return
        }
        const canDig = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true
        if (!canDig) {
          reportAction('BREAK', false, { reason: 'cannot-dig', block: block.name })
          return
        }

        await bot.dig(block)
        reportAction('BREAK', true, { block: block.name })
      } catch {
        reportAction('BREAK', false, { reason: 'dig-failed' })
      }
      return
    }

    if (payload.type === 'use_item') {
      try {
        bot.activateItem()
        setTimeout(() => {
          try { bot.deactivateItem() } catch {}
        }, 120)
        reportAction('USE_ITEM', true, null)
      } catch {
        reportAction('USE_ITEM', false, { reason: 'use-item-failed' })
      }
    }
  }

  function startServers() {
    if (httpServer || wss) return

    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildControlHtml())
    })

    wss = new WebSocketServer({ server: httpServer })

    wss.on('connection', (ws) => {
      activeClients += 1
      setPuppetActive(true)
      if (!controlKeepAliveTimer) {
        controlKeepAliveTimer = setInterval(() => {
          if (activeClients > 0) {
            bot.__movementPauseUntil = Date.now() + 2_000
            applyControlStates()
          }
        }, 150)
      }
      if (!lookApplyTimer) {
        lookApplyTimer = setInterval(() => {
          if (activeClients <= 0) return
          if (Math.abs(pendingLookDx) < 0.01 && Math.abs(pendingLookDy) < 0.01) return
          const useDx = Math.max(-48, Math.min(48, pendingLookDx))
          const useDy = Math.max(-48, Math.min(48, pendingLookDy))
          pendingLookDx -= useDx
          pendingLookDy -= useDy

          const yaw = Number(bot.entity?.yaw || 0) - useDx * mouseSensitivity
          const pitch = clamp(Number(bot.entity?.pitch || 0) - useDy * mouseSensitivity, -Math.PI / 2, Math.PI / 2)
          try {
            void bot.look(yaw, pitch, true)
          } catch {}
        }, 40)
      }
      sessionMemory?.addMemory?.(`FPV puppet connected (clients=${activeClients}).`, 'training')

      ws.on('message', (message) => {
        handleMessage(message).catch(() => {})
      })

      ws.on('close', () => {
        activeClients = Math.max(0, activeClients - 1)
        if (activeClients === 0) {
          if (controlKeepAliveTimer) {
            clearInterval(controlKeepAliveTimer)
            controlKeepAliveTimer = null
          }
          if (lookApplyTimer) {
            clearInterval(lookApplyTimer)
            lookApplyTimer = null
          }
          pendingLookDx = 0
          pendingLookDy = 0
          setPuppetActive(false)
        }
      })
    })

    httpServer.on('error', (error) => {
      if (String(error?.code || '') === 'EADDRINUSE') {
        activeControlPort += 1
        try {
          httpServer.listen(activeControlPort, '127.0.0.1')
          return
        } catch {}
      }

      console.log('[FPV] control server failed', error)
      sessionMemory?.addMemory?.(`FPV control server failed: ${String(error?.message || error)}`, 'error')
      setPuppetActive(false)
    })

    httpServer.listen(activeControlPort, '127.0.0.1', () => {
      const controlUrl = `http://127.0.0.1:${activeControlPort}`
      console.log(`[FPV] Control window: ${controlUrl}`)
      openControlWindow(controlUrl)
    })
  }

  function start() {
    if (!enabled || started) return
    started = true

    const viewerFactory = tryLoadViewerModule()
    if (!viewerFactory) {
      console.log('[FPV] prismarine-viewer unavailable (missing optional dependency like canvas). FPV disabled, bot continues normally.')
      sessionMemory?.addMemory?.('FPV disabled: prismarine-viewer unavailable.', 'error')
      started = false
      return
    }

    try {
      viewerServer = viewerFactory(bot, {
        port: activeViewerPort,
        firstPerson: true,
        viewDistance,
      })

      if (viewerServer && typeof viewerServer.on === 'function') {
        viewerServer.on('error', (error) => {
          if (String(error?.code || '') === 'EADDRINUSE') {
            const nextPort = activeViewerPort + 1
            console.log(`[FPV] Viewer port ${activeViewerPort} in use, retrying on ${nextPort}`)
            sessionMemory?.addMemory?.(`FPV viewer port in use (${activeViewerPort}), retrying ${nextPort}.`, 'training')

            try {
              viewerServer?.close?.()
            } catch {}

            activeViewerPort = nextPort
            viewerStarted = false
            try {
              viewerServer = viewerFactory(bot, {
                port: activeViewerPort,
                firstPerson: true,
                viewDistance,
              })
              viewerStarted = true
              console.log(`[FPV] Viewer started at http://127.0.0.1:${activeViewerPort}`)
              if (!httpServer) startServers()
            } catch (retryError) {
              console.log('[FPV] viewer retry failed', retryError)
              sessionMemory?.addMemory?.('FPV viewer retry failed.', 'error')
              setPuppetActive(false)
            }
            return
          }

          console.log('[FPV] viewer server error', error)
          sessionMemory?.addMemory?.(`FPV viewer error: ${String(error?.message || error)}`, 'error')
          setPuppetActive(false)
        })
      }

      viewerStarted = true
      console.log(`[FPV] Viewer started at http://127.0.0.1:${activeViewerPort}`)
    } catch (e) {
      console.log('[FPV] viewer failed to start', e)
      sessionMemory?.addMemory?.('FPV viewer failed to start.', 'error')
      return
    }

    startServers()
    sessionMemory?.addMemory?.('FPV puppet mode started.', 'training')
  }

  function stop() {
    if (!started) return
    started = false
    setPuppetActive(false)

    if (wss) {
      try { wss.close() } catch {}
      wss = null
    }

    if (httpServer) {
      try { httpServer.close() } catch {}
      httpServer = null
    }

    if (viewerStarted) {
      viewerStarted = false
      try {
        viewerServer?.close?.()
      } catch {}
      viewerServer = null
    }

      if (controlKeepAliveTimer) {
        clearInterval(controlKeepAliveTimer)
        controlKeepAliveTimer = null
      }
    if (lookApplyTimer) {
      clearInterval(lookApplyTimer)
      lookApplyTimer = null
    }
    pendingLookDx = 0
    pendingLookDy = 0
    sessionMemory?.addMemory?.('FPV puppet mode stopped.', 'training')
  }

  return {
    start,
    stop,
    isEnabled: () => enabled,
  }
}

module.exports = {
  createFirstPersonPuppet,
}
