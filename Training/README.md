# Training Workspace

This folder stores all training-related assets:

- `datasets/` state-action logs from runtime recording (bot or player-POV observer telemetry) (JSONL)
- `models/` trained model artifacts (`.pt`, `.onnx` later)
- `logs/` optional training/runtime logs
- `python/` Python training + inference code

For hybrid architecture:

- JavaScript bot collects data and controls Minecraft in real time
- Python trains and serves decision models
