package com.minecraftfriend.telemetry.runtime;

import org.bukkit.entity.Player;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class ActionTracker {

    private final Map<UUID, ActionState> lastActionByPlayer = new HashMap<>();
    private final long actionTtlMs;

    public ActionTracker(long actionTtlMs) {
        this.actionTtlMs = actionTtlMs;
    }

    public void setAction(Player player, String label, Boolean success, Map<String, Object> metadata) {
        if (player == null) {
            return;
        }
        Map<String, Object> safeMetadata = metadata == null ? new LinkedHashMap<>() : new LinkedHashMap<>(metadata);
        lastActionByPlayer.put(player.getUniqueId(), new ActionState(label, success, safeMetadata, System.currentTimeMillis()));
    }

    public Map<String, Object> resolveAction(UUID playerId) {
        ActionState actionState = lastActionByPlayer.get(playerId);
        String label = "OBSERVER_IDLE";
        String source = "user-telemetry";
        Boolean success = null;
        Map<String, Object> metadata = new LinkedHashMap<>();

        if (actionState != null && (System.currentTimeMillis() - actionState.timestampMs) <= actionTtlMs) {
            label = actionState.label;
            success = actionState.success;
            metadata.putAll(actionState.metadata);
        }

        Map<String, Object> action = new LinkedHashMap<>();
        action.put("label", label);
        action.put("source", source);
        action.put("success", success);
        action.put("metadata", metadata);
        return action;
    }

    private static final class ActionState {
        private final String label;
        private final Boolean success;
        private final Map<String, Object> metadata;
        private final long timestampMs;

        private ActionState(String label, Boolean success, Map<String, Object> metadata, long timestampMs) {
            this.label = label;
            this.success = success;
            this.metadata = metadata;
            this.timestampMs = timestampMs;
        }
    }
}