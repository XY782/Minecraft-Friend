const http = require('http')

const { WebSocketServer } = require('ws')
const { createControlState } = require('./controlState')
const { buildControlHtml } = require('./uiTemplate')
const { tryLoadViewerModule, clamp, openControlWindow } = require('./utils')
const { createMessageHandler } = require('./messageHandler')

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

  const {
    controls,
    applyControlStates,
    applyControlsFromKeySet,
    clearControlStates,
  } = createControlState(bot)

  function reportAction(action, success = true, details = null) {
    onActionOutcome?.({
      action,
      success,
      source: 'first-person-puppet',
      details,
    })
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

  const handleMessage = createMessageHandler({
    bot,
    controls,
    applyControlStates,
    applyControlsFromKeySet,
    clearControlStates,
    setPuppetActive,
    reportAction,
    addLookDelta(dx, dy) {
      pendingLookDx += Number(dx || 0)
      pendingLookDy += Number(dy || 0)
    },
  })

  function startServers() {
    if (httpServer || wss) return

    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildControlHtml({
        viewerUrl: `http://127.0.0.1:${activeViewerPort}`,
        controlPort: activeControlPort,
      }))
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
      openControlWindow(controlUrl, autoOpen)
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
