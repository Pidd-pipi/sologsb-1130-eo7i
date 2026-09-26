/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，联动镜头帧区间。
 * 被 /frames 与 /shots/:id 消费。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import { useProgressStore } from '../stores/progressStore';
import * as api from '../db/api';
import { framesToDuration, plannedCaptures } from '../utils/frameMath';
import type { FrameEntry, ShotCount } from '../types/frame';

/** 镜头计划重算结果 */
export interface SyncPlanResult {
  /** 新计划是否生效；false 表示已拍张数超过新计划，已保留原计划 */
  applied: boolean;
  /** 生效后的计划张数 */
  planned: number;
  /** 已拍张数 */
  taken: number;
  /** 已拍超出新计划的张数 */
  overshoot: number;
}

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();
  const progressStore = useProgressStore();
  const { frames, selectedFrameNo } = storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  /** 当前帧序等效时长（秒）：逐帧拍摄张数求和 ÷ 帧率 */
  const totalDuration = computed(() => framesToDuration(plannedCaptures(frames.value), fps.value));
  /** 镜头计划张数：与存储的帧区间同源（结束帧号 - 起始帧号 + 1），各页面一致 */
  const plannedFrames = computed(() => {
    const s = shot.value;
    return s ? Math.max(1, s.endFrame - s.startFrame + 1) : 0;
  });

  async function insertAfter(frameNo: number | null) {
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    await frameStore.insertAt(Math.max(0, index));
    return syncShotRange();
  }

  async function removeAt(frameNo: number) {
    const index = frames.value.findIndex((f) => f.frameNo === frameNo);
    if (index < 0) return null;
    await frameStore.removeAt(index);
    return syncShotRange();
  }

  async function move(fromIndex: number, toIndex: number) {
    await frameStore.move(fromIndex, toIndex);
    return syncShotRange();
  }

  /**
   * 帧序变化后重算镜头的帧区间、时长与计划张数。
   * 计划张数 = 逐帧拍摄张数之和；时长 = 计划张数 ÷ 帧率；帧区间跨度 = 计划张数。
   * 已拍张数超过新计划时保留原计划（按存储的原区间跨度），并返回超出张数。
   */
  async function syncShotRange(): Promise<SyncPlanResult | null> {
    if (shotId.value === null) return null;
    const current = shotStore.byId(shotId.value);
    if (!current) return null;
    const fps = current.fps || 24;
    const start = current.startFrame;
    const captures = Math.max(1, plannedCaptures(frames.value));
    const takes = await api.listTakesByShot(shotId.value);
    const taken = takes.reduce((sum, t) => sum + (t.takenFrames || 0), 0);
    const storedPlan = Math.max(1, current.endFrame - current.startFrame + 1);
    const applied = taken <= captures;
    const planned = applied ? captures : storedPlan;
    await shotStore.applyPlan(shotId.value, {
      durationSec: framesToDuration(planned, fps),
      startFrame: start,
      endFrame: start + planned - 1,
    });
    // 帧条目已变化：刷新进度缓存，让详情 / 总览 / 实拍记录读到同一份新计划
    await progressStore.refreshFrames();
    return { applied, planned, taken, overshoot: Math.max(0, taken - captures) };
  }

  /** 整段（或指定帧）套用拍摄张数，并重算镜头计划 */
  async function applyShotCount(shotCount: ShotCount, indexes?: number[]): Promise<SyncPlanResult | null> {
    await frameStore.applyShotCount(shotCount, indexes);
    return syncShotRange();
  }

  /** 条带上的单帧曝光/位移改动；拍摄张数变化时联动重算镜头计划 */
  async function patch(frameNo: number, patchValue: Partial<FrameEntry>): Promise<SyncPlanResult | null> {
    await frameStore.patchFrame(frameNo, patchValue);
    if (typeof patchValue.shotCount === 'number') return syncShotRange();
    return null;
  }

  function select(frameNo: number | null) {
    frameStore.select(frameNo);
  }

  return {
    frames,
    selectedFrameNo,
    shot,
    fps,
    frameCount,
    totalDuration,
    plannedFrames,
    insertAfter,
    removeAt,
    move,
    applyShotCount,
    patch,
    select,
    syncShotRange,
    reload: (id: number) => frameStore.loadForShot(id),
  };
}
