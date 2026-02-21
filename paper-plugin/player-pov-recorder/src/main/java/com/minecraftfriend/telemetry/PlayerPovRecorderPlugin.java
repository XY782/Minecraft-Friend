package com.minecraftfriend.telemetry;

import com.minecraftfriend.telemetry.runtime.ActionTracker;
import com.minecraftfriend.telemetry.runtime.JsonStringifier;
import com.minecraftfriend.telemetry.runtime.TelemetrySnapshotBuilder;
import org.bukkit.Bukkit;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerItemConsumeEvent;
import org.bukkit.event.player.PlayerToggleSneakEvent;
import org.bukkit.event.player.PlayerToggleSprintEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class PlayerPovRecorderPlugin extends JavaPlugin implements Listener {

    private Path outputPath;
    private String targetPlayer;
    private long actionTtlMs;

    private ActionTracker actionTracker;
    private TelemetrySnapshotBuilder snapshotBuilder;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        reloadSettings();

        Bukkit.getPluginManager().registerEvents(this, this);

        long intervalTicks = Math.max(1L, getConfig().getLong("sample-interval-ticks", 2L));
        Bukkit.getScheduler().runTaskTimer(this, this::writeLatestSnapshot, 1L, intervalTicks);

        getLogger().info("PlayerPovRecorder enabled. Writing telemetry to " + outputPath);
    }

    @Override
    public void onDisable() {
        getLogger().info("PlayerPovRecorder disabled.");
    }

    private void reloadSettings() {
        FileConfiguration cfg = getConfig();
        targetPlayer = cfg.getString("target-player", "").trim();

        String outputFile = cfg.getString("output-file", "Training/datasets/latest-user-telemetry.json").trim();
        outputPath = resolveOutputPath(outputFile);

        int lineOfSightMaxDistance = Math.max(1, cfg.getInt("line-of-sight-max-distance", 8));
        int nearbyBlockRadius = Math.max(1, cfg.getInt("nearby-block-radius", 2));
        int nearbyEntityDistance = Math.max(2, cfg.getInt("nearby-entity-distance", 10));
        actionTtlMs = Math.max(250L, cfg.getLong("action-ttl-ms", 1500L));

        actionTracker = new ActionTracker(actionTtlMs);
        snapshotBuilder = new TelemetrySnapshotBuilder(lineOfSightMaxDistance, nearbyBlockRadius, nearbyEntityDistance);
    }

    private Path resolveOutputPath(String outputFile) {
        Path configured = Paths.get(outputFile);
        if (configured.isAbsolute()) {
            return configured;
        }
        return getServer().getWorldContainer().toPath().resolve(outputFile).normalize();
    }

    private Player resolveObservedPlayer() {
        if (!targetPlayer.isEmpty()) {
            Player named = Bukkit.getPlayerExact(targetPlayer);
            if (named != null && named.isOnline()) {
                return named;
            }
        }
        List<Player> online = new ArrayList<>(Bukkit.getOnlinePlayers());
        return online.isEmpty() ? null : online.get(0);
    }

    private void writeLatestSnapshot() {
        Player player = resolveObservedPlayer();
        if (player == null || snapshotBuilder == null || actionTracker == null) {
            return;
        }

        Map<String, Object> action = actionTracker.resolveAction(player.getUniqueId());
        Map<String, Object> payload = snapshotBuilder.buildTelemetryPayload(player, action);
        String json = JsonStringifier.toJson(payload);

        try {
            Path parent = outputPath.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.writeString(outputPath, json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            getLogger().warning("Failed to write telemetry file: " + e.getMessage());
        }
    }

    @EventHandler(ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("block", TelemetrySnapshotBuilder.normalizeBlockName(event.getBlock().getType()));
        actionTracker.setAction(event.getPlayer(), "BREAK_BLOCK", true, metadata);
    }

    @EventHandler(ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("block", TelemetrySnapshotBuilder.normalizeBlockName(event.getBlockPlaced().getType()));
        actionTracker.setAction(event.getPlayer(), "PLACE_BLOCK", true, metadata);
    }

    @EventHandler(ignoreCancelled = true)
    public void onInteract(PlayerInteractEvent event) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("interaction", event.getAction().name());
        if (event.getClickedBlock() != null) {
            metadata.put("block", TelemetrySnapshotBuilder.normalizeBlockName(event.getClickedBlock().getType()));
        }
        actionTracker.setAction(event.getPlayer(), "INTERACT", true, metadata);
    }

    @EventHandler(ignoreCancelled = true)
    public void onConsume(PlayerItemConsumeEvent event) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("item", TelemetrySnapshotBuilder.normalizeBlockName(event.getItem().getType()));
        actionTracker.setAction(event.getPlayer(), "EAT", true, metadata);
    }

    @EventHandler(ignoreCancelled = true)
    public void onSprint(PlayerToggleSprintEvent event) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sprinting", event.isSprinting());
        actionTracker.setAction(event.getPlayer(), event.isSprinting() ? "START_SPRINT" : "STOP_SPRINT", true, metadata);
    }

    @EventHandler(ignoreCancelled = true)
    public void onSneak(PlayerToggleSneakEvent event) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("sneaking", event.isSneaking());
        actionTracker.setAction(event.getPlayer(), event.isSneaking() ? "START_SNEAK" : "STOP_SNEAK", true, metadata);
    }

    @EventHandler(ignoreCancelled = true)
    public void onDamage(EntityDamageByEntityEvent event) {
        if (!(event.getDamager() instanceof Player player)) {
            return;
        }

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("target", event.getEntity().getType().name().toLowerCase());
        metadata.put("damage", TelemetrySnapshotBuilder.round4(event.getDamage()));
        actionTracker.setAction(player, "ATTACK", true, metadata);
    }
}