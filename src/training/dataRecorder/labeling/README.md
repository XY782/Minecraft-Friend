# Data Recorder Labeling

- `ground-truth-outcome`: action labels that come from `recordActionOutcome(...)` (best supervision source).
- `heuristic-inferred`: observer-derived action labels inferred from state deltas (useful bootstrap, weaker than direct control logs).
- `observer-motion`: pure observer movement labels (`OBSERVER_MOVE`, `OBSERVER_SPRINT`, etc.).
- `state-fallback`: fallback labels when no fresh explicit action outcome exists.

Use observer-derived labels to expand behavior diversity quickly, but prioritize ground-truth outcome logging for stronger autonomy learning.