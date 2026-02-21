package com.minecraftfriend.telemetry.runtime;

import org.bukkit.Chunk;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.block.Biome;
import org.bukkit.block.Block;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.util.RayTraceResult;
import org.bukkit.util.Vector;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

public final class TelemetrySnapshotBuilder {

    private final int lineOfSightMaxDistance;
    private final int nearbyBlockRadius;
    private final int nearbyEntityDistance;

    public TelemetrySnapshotBuilder(int lineOfSightMaxDistance, int nearbyBlockRadius, int nearbyEntityDistance) {
        this.lineOfSightMaxDistance = lineOfSightMaxDistance;
        this.nearbyBlockRadius = nearbyBlockRadius;
        this.nearbyEntityDistance = nearbyEntityDistance;
    }

    public Map<String, Object> buildTelemetryPayload(Player player, Map<String, Object> action) {
        Location location = player.getLocation();
        Vector velocity = player.getVelocity();
        World world = player.getWorld();

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("timestamp", Instant.now().toString());
        root.put("timestampMs", System.currentTimeMillis());

        Map<String, Object> playerInfo = new LinkedHashMap<>();
        playerInfo.put("name", player.getName());
        playerInfo.put("uuid", player.getUniqueId().toString());
        playerInfo.put("world", world.getName());
        root.put("player", playerInfo);

        Map<String, Object> state = new LinkedHashMap<>();
        state.put("position", mapPosition(location));
        state.put("velocity", mapVelocity(velocity));
        state.put("yaw", round4(location.getYaw()));
        state.put("pitch", round4(location.getPitch()));
        state.put("onGround", player.isOnGround());
        state.put("health", round4(player.getHealth()));
        state.put("hunger", player.getFoodLevel());

        double armorValue = 0.0;
        if (player.getAttribute(Attribute.GENERIC_ARMOR) != null) {
            armorValue = player.getAttribute(Attribute.GENERIC_ARMOR).getValue();
        }
        state.put("armor", round4(armorValue));

        ItemStack held = player.getInventory().getItemInMainHand();
        state.put("heldItem", mapItem(held, player.getInventory().getHeldItemSlot()));
        state.put("selectedHotbarSlot", player.getInventory().getHeldItemSlot());
        state.put("inventory", mapInventory(player.getInventory()));

        Block below = location.clone().subtract(0, 1, 0).getBlock();
        Block front = location.clone().add(location.getDirection().normalize()).getBlock();
        state.put("blockBelow", normalizeBlockName(below.getType()));
        state.put("blockFront", normalizeBlockName(front.getType()));

        state.put("nearbyBlocksRaw", mapNearbyBlocks(location, nearbyBlockRadius));
        state.put("nearbyEntities", mapNearbyEntities(player, nearbyEntityDistance));

        Map<String, Object> view = mapView(player, lineOfSightMaxDistance);
        state.put("view", view);
        state.put("lineOfSight", view.get("lineOfSight"));
        state.put("cameraTarget", view.get("cameraTarget"));
        state.put("playerLookTarget", view.get("lookVector"));

        state.put("weather", mapWeather(world, location));
        state.put("timeOfDay", mapTime(world));
        state.put("biome", mapBiome(location));
        state.put("dimension", world.getEnvironment().name().toLowerCase());

        Map<String, Object> heightLimits = new LinkedHashMap<>();
        heightLimits.put("floor", world.getMinHeight());
        heightLimits.put("ceiling", world.getMaxHeight());
        state.put("heightLimits", heightLimits);

        Chunk chunk = location.getChunk();
        Map<String, Object> chunkRegion = new LinkedHashMap<>();
        chunkRegion.put("chunkX", chunk.getX());
        chunkRegion.put("chunkZ", chunk.getZ());
        chunkRegion.put("regionX", chunk.getX() >> 5);
        chunkRegion.put("regionZ", chunk.getZ() >> 5);
        chunkRegion.put("loaded", chunk.isLoaded());
        state.put("chunkRegion", chunkRegion);

        Map<String, Object> lightLevel = new LinkedHashMap<>();
        lightLevel.put("skyLight", location.getBlock().getLightFromSky());
        lightLevel.put("blockLight", location.getBlock().getLightFromBlocks());
        state.put("lightLevel", lightLevel);

        root.put("state", state);
        root.put("action", action == null ? defaultAction() : action);

        return root;
    }

    private Map<String, Object> defaultAction() {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("label", "OBSERVER_IDLE");
        action.put("source", "user-telemetry");
        action.put("success", null);
        action.put("metadata", new LinkedHashMap<>());
        return action;
    }

    private Map<String, Object> mapWeather(World world, Location location) {
        Map<String, Object> weather = new LinkedHashMap<>();
        boolean rain = world.hasStorm();
        boolean thunder = world.isThundering();
        Biome biome = location.getBlock().getBiome();
        boolean snow = rain && biome.name().contains("SNOW");
        weather.put("rain", rain);
        weather.put("thunder", thunder);
        weather.put("snow", snow);
        return weather;
    }

    private Map<String, Object> mapTime(World world) {
        Map<String, Object> time = new LinkedHashMap<>();
        long age = world.getFullTime();
        long day = age / 24000L;
        long t = world.getTime();
        time.put("age", age);
        time.put("day", day);
        time.put("time", t);
        time.put("isDay", t >= 0 && t <= 12300);
        return time;
    }

    private Map<String, Object> mapBiome(Location location) {
        Biome biome = location.getBlock().getBiome();
        String biomeName = String.valueOf(biome).toLowerCase();
        Map<String, Object> mapped = new LinkedHashMap<>();
        mapped.put("id", biomeName);
        mapped.put("name", biomeName);
        mapped.put("category", "minecraft");
        mapped.put("temperature", round4(location.getBlock().getTemperature()));
        mapped.put("rainfall", null);
        return mapped;
    }

    private Map<String, Object> mapPosition(Location location) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("x", round4(location.getX()));
        map.put("y", round4(location.getY()));
        map.put("z", round4(location.getZ()));
        return map;
    }

    private Map<String, Object> mapVelocity(Vector velocity) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("vx", round4(velocity.getX()));
        map.put("vy", round4(velocity.getY()));
        map.put("vz", round4(velocity.getZ()));
        return map;
    }

    private List<Map<String, Object>> mapNearbyBlocks(Location center, int radius) {
        Location base = center.clone();
        base.setX(Math.floor(base.getX()));
        base.setY(Math.floor(base.getY()));
        base.setZ(Math.floor(base.getZ()));

        List<Map<String, Object>> blocks = new ArrayList<>();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dy = -radius; dy <= radius; dy++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    Block block = center.getWorld().getBlockAt(
                            (int) base.getX() + dx,
                            (int) base.getY() + dy,
                            (int) base.getZ() + dz
                    );
                    Material type = block.getType();

                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("dx", dx);
                    row.put("dy", dy);
                    row.put("dz", dz);
                    row.put("ndx", round4((double) dx / Math.max(1, radius)));
                    row.put("ndy", round4((double) dy / Math.max(1, radius)));
                    row.put("ndz", round4((double) dz / Math.max(1, radius)));
                    row.put("block", normalizeBlockName(type));
                    row.put("hardness", null);
                    row.put("metadata", block.getBlockData().getAsString());
                    row.put("fluidType", type == Material.WATER ? "water" : (type == Material.LAVA ? "lava" : null));
                    row.put("fluidLevel", null);

                    Map<String, Object> lightLevel = new LinkedHashMap<>();
                    lightLevel.put("skyLight", block.getLightFromSky());
                    lightLevel.put("blockLight", block.getLightFromBlocks());
                    row.put("lightLevel", lightLevel);

                    Map<String, Object> tags = new LinkedHashMap<>();
                    tags.put("flammable", type.isFlammable());
                    tags.put("breakableByHand", !type.isSolid());
                    row.put("tags", tags);

                    blocks.add(row);
                }
            }
        }
        return blocks;
    }

    private List<Map<String, Object>> mapNearbyEntities(Player player, int distance) {
        return player.getNearbyEntities(distance, distance, distance).stream()
                .filter(entity -> !entity.getUniqueId().equals(player.getUniqueId()))
                .map(this::mapEntity)
                .collect(Collectors.toList());
    }

    private Map<String, Object> mapEntity(Entity entity) {
        Location location = entity.getLocation();
        Vector velocity = entity.getVelocity();

        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", entity.getEntityId());
        row.put("name", entity.getName());
        row.put("type", entity.getType().name().toLowerCase());
        row.put("distance", null);
        row.put("isPlayer", entity instanceof Player);
        row.put("hostile", false);
        row.put("position", mapPosition(location));
        row.put("velocity", mapVelocity(velocity));
        row.put("yaw", round4(location.getYaw()));
        row.put("pitch", round4(location.getPitch()));
        row.put("onGround", entity.isOnGround());
        row.put("heldItem", null);
        row.put("projectile", null);
        return row;
    }

    private Map<String, Object> mapView(Player player, int maxDistance) {
        Map<String, Object> view = new LinkedHashMap<>();

        Vector direction = player.getEyeLocation().getDirection();
        Map<String, Object> lookVector = new LinkedHashMap<>();
        lookVector.put("x", round4(direction.getX()));
        lookVector.put("y", round4(direction.getY()));
        lookVector.put("z", round4(direction.getZ()));
        view.put("lookVector", lookVector);

        List<Map<String, Object>> lineOfSight = new ArrayList<>();
        RayTraceResult hit = player.getWorld().rayTraceBlocks(player.getEyeLocation(), direction, maxDistance);
        if (hit != null && hit.getHitBlock() != null) {
            Block block = hit.getHitBlock();
            Map<String, Object> hitBlock = new LinkedHashMap<>();
            hitBlock.put("type", "block");
            hitBlock.put("name", normalizeBlockName(block.getType()));
            hitBlock.put("distance", round4(hit.getHitPosition() != null
                    ? hit.getHitPosition().distance(player.getEyeLocation().toVector())
                    : player.getEyeLocation().distance(block.getLocation())));

            Map<String, Object> hitPos = new LinkedHashMap<>();
            hitPos.put("x", block.getX());
            hitPos.put("y", block.getY());
            hitPos.put("z", block.getZ());
            hitBlock.put("position", hitPos);
            lineOfSight.add(hitBlock);
        }
        view.put("lineOfSight", lineOfSight);

        Entity targetEntity = null;
        try {
            targetEntity = player.getTargetEntity(maxDistance);
        } catch (Throwable ignored) {
        }

        if (targetEntity != null) {
            Map<String, Object> target = new LinkedHashMap<>();
            target.put("type", "entity");
            target.put("name", targetEntity.getType().name().toLowerCase());
            target.put("distance", round4(targetEntity.getLocation().distance(player.getEyeLocation())));
            target.put("position", mapPosition(targetEntity.getLocation()));
            view.put("cameraTarget", target);
        } else if (!lineOfSight.isEmpty()) {
            view.put("cameraTarget", lineOfSight.get(0));
        } else {
            view.put("cameraTarget", null);
        }

        return view;
    }

    private List<Map<String, Object>> mapInventory(PlayerInventory inventory) {
        List<Map<String, Object>> rows = new ArrayList<>();
        ItemStack[] contents = inventory.getContents();
        for (int slot = 0; slot < contents.length; slot++) {
            ItemStack item = contents[slot];
            if (item == null || item.getType() == Material.AIR) {
                continue;
            }
            rows.add(mapItem(item, slot));
        }
        return rows;
    }

    private Map<String, Object> mapItem(ItemStack item, int slot) {
        Map<String, Object> row = new LinkedHashMap<>();
        Material type = item.getType();
        row.put("name", normalizeBlockName(type));
        row.put("count", item.getAmount());
        row.put("slot", slot);
        row.put("type", type.ordinal());
        row.put("metadata", 0);
        row.put("durability", null);
        row.put("enchantments", new ArrayList<>());
        return row;
    }

    public static String normalizeBlockName(Material material) {
        return material.name().toLowerCase();
    }

    public static double round4(double value) {
        return Math.round(value * 10_000.0) / 10_000.0;
    }
}