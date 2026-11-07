// Sound lab isolation: which sound sources a listener has soloed or muted, and
// the SceneParams those choices produce. What this is for: letting the owner
// hear one agent, one layer or one world voice on its own while tuning. What it
// must not do: touch audio nodes (every change still rides scene.apply's
// declared ramps), read agent events, or change what plays when nothing is
// isolated — an empty isolation returns the params untouched.

import type { SceneParams } from "@hearable/core";

export const LANE_LAYERS = ["air", "grain", "pulse", "tension", "gestures"] as const;
export type LaneLayer = (typeof LANE_LAYERS)[number];

export const WORLD_LAYERS = ["drone", "field", "swell", "nature", "cues"] as const;
export type WorldLayer = (typeof WORLD_LAYERS)[number];

/**
 * A soloable/mutable source. Leaves are one lane layer or one world voice;
 * groups are a whole lane, one layer across every lane, or the whole world.
 */
export type SourceKey =
  | `lane:${number}`
  | `lane:${number}:${LaneLayer}`
  | `layer:${LaneLayer}`
  | "world"
  | `world:${WorldLayer}`;

export type Isolation = {
  readonly solo: readonly SourceKey[];
  readonly muted: readonly SourceKey[];
};

export const NO_ISOLATION: Isolation = { solo: [], muted: [] };

export function laneLayerKey(laneId: number, layer: LaneLayer): SourceKey {
  return `lane:${laneId}:${layer}`;
}

export function worldLayerKey(layer: WorldLayer): SourceKey {
  return `world:${layer}`;
}

/** The groups a leaf belongs to; soloing or muting any of them reaches the leaf. */
function groupsOf(leaf: SourceKey): readonly SourceKey[] {
  const parts = leaf.split(":");
  if (parts[0] === "lane" && parts.length === 3) {
    return [`lane:${Number(parts[1])}`, `layer:${parts[2] as LaneLayer}`];
  }
  if (parts[0] === "world" && parts.length === 2) return ["world"];
  return [];
}

export function isIsolating(isolation: Isolation): boolean {
  return isolation.solo.length > 0 || isolation.muted.length > 0;
}

/** Whether a leaf source is heard under the current solos and mutes. */
export function isAudible(isolation: Isolation, leaf: SourceKey): boolean {
  const reach = [leaf, ...groupsOf(leaf)];
  if (reach.some((key) => isolation.muted.includes(key))) return false;
  if (isolation.solo.length === 0) return true;
  return reach.some((key) => isolation.solo.includes(key));
}

/**
 * Whether a group key itself has anything audible under it. A group that is
 * neither soloed nor muted can still be partly heard through a soloed child.
 */
export function groupAudible(isolation: Isolation, group: SourceKey, laneIds: readonly number[]) {
  return leavesOf(group, laneIds).some((leaf) => isAudible(isolation, leaf));
}

export function leavesOf(group: SourceKey, laneIds: readonly number[]): readonly SourceKey[] {
  const parts = group.split(":");
  if (group === "world") return WORLD_LAYERS.map(worldLayerKey);
  if (parts[0] === "layer") return laneIds.map((id) => laneLayerKey(id, parts[1] as LaneLayer));
  if (parts[0] === "lane" && parts.length === 2) {
    return LANE_LAYERS.map((layer) => laneLayerKey(Number(parts[1]), layer));
  }
  return [group];
}

function toggle(list: readonly SourceKey[], key: SourceKey): readonly SourceKey[] {
  return list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
}

/** Solo is additive: several soloed sources play together. */
export function toggleSolo(isolation: Isolation, key: SourceKey): Isolation {
  return { ...isolation, solo: toggle(isolation.solo, key) };
}

export function toggleMute(isolation: Isolation, key: SourceKey): Isolation {
  return { ...isolation, muted: toggle(isolation.muted, key) };
}

/** Exclusive solo: hear only this source. A second press clears it. */
export function soloOnly(isolation: Isolation, key: SourceKey): Isolation {
  const alone = isolation.solo.length === 1 && isolation.solo[0] === key;
  return { solo: alone ? [] : [key], muted: isolation.muted };
}

/** Low enough to be inaudible under the master chain, still a finite dB target. */
const SILENT_DBFS = -96;

/**
 * Applies solos and mutes to one frame of scene targets. Silenced layers take
 * a zero gain target, so the graph reaches them on the same ramps any other
 * gain move uses; the waiting pad releases on its 5 s release ramp.
 */
export function isolateParams(params: SceneParams, isolation: Isolation): SceneParams {
  if (!isIsolating(isolation)) return params;
  const heard = (leaf: SourceKey) => isAudible(isolation, leaf);
  const lanes = params.lanes.map((lane) => {
    const air = heard(laneLayerKey(lane.laneId, "air"));
    const grain = heard(laneLayerKey(lane.laneId, "grain"));
    const pulse = heard(laneLayerKey(lane.laneId, "pulse"));
    const tension = heard(laneLayerKey(lane.laneId, "tension"));
    return {
      ...lane,
      layers: {
        air: air ? lane.layers.air : 0,
        grain: grain ? lane.layers.grain : 0,
        pulse: pulse ? lane.layers.pulse : 0,
        tension: tension ? lane.layers.tension : 0,
      },
      air: air ? lane.air : { ...lane.air, gain: 0 },
      grain: grain ? lane.grain : { ...lane.grain, gain: 0 },
      pulse: pulse ? lane.pulse : { ...lane.pulse, gain: 0 },
      tension: tension ? lane.tension : { on: false, gain: 0 },
    };
  });
  return {
    ...params,
    densityScale: heard(worldLayerKey("nature")) ? params.densityScale : 0,
    bed: heard(worldLayerKey("drone")) ? params.bed : { gainDbfs: SILENT_DBFS },
    macro: {
      ...params.macro,
      textureSwell: heard(worldLayerKey("swell")) ? params.macro.textureSwell : 0,
      fieldGain: heard(worldLayerKey("field")) ? params.macro.fieldGain : 0,
    },
    lanes,
  };
}
