function createControlState(bot) {
  const controls = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
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

  return {
    controls,
    applyControlStates,
    applyControlsFromKeySet,
    clearControlStates,
  }
}

module.exports = {
  createControlState,
}
