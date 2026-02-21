# Player POV Recorder (Paper Plugin)

This plugin writes a **single latest telemetry snapshot** from your player POV to disk.  
Your Node recorder (`minecraft/src/training/dataRecorder`) reads this snapshot and uses it for observer-mode state/action logging.

## Build

```bash
cd minecraft/paper-plugin/player-pov-recorder
mvn clean package
```

Output jar: `target/player-pov-recorder-1.0.0.jar`

## Install

1. Copy jar into your Paper server `plugins/` folder.
2. Start server once to generate config.
3. Edit `plugins/PlayerPovRecorder/config.yml`.
4. Restart server.

## Default config

- `target-player`: player username to record (blank = first online player)
- `output-file`: file path to write latest snapshot
- `sample-interval-ticks`: write interval (2 ticks ~= 10Hz)
- `line-of-sight-max-distance`: raytrace distance
- `nearby-block-radius`: block cube radius around player
- `nearby-entity-distance`: nearby entity capture distance
- `action-ttl-ms`: how long to keep latest action label

## Node side env

Point your bot to this plugin output:

```dotenv
BOT_OBSERVER_MODE=true
BOT_USER_TELEMETRY_ENABLED=true
BOT_USER_TELEMETRY_FILE=Training/datasets/latest-user-telemetry.json
BOT_USER_TELEMETRY_MAX_AGE_MS=2000
```

Then observer-mode samples are recorded from your POV telemetry first.
