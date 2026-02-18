function buildControlHtml({ viewerUrl, controlPort }) {
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
    const ws = new WebSocket('ws://127.0.0.1:${controlPort}')
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

module.exports = {
  buildControlHtml,
}
