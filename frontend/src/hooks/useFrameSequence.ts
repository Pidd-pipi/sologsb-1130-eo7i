/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，联动镜头帧区间。
 * 每帧的拍摄张数参与镜头计划：帧区间、时长与计划张数都按总张数重算，
 * 详情 / 总览 / 实拍记录读取同一份镜头计划。被 /frames 与 /shots/:id 消费。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import * as api from '../db/api';
import { framesToDuration, planFromFrames, plannedFramesOf, totalShotCount } from '../utils/frameMath';
import type { FrameEntry, ShotCount } from '../types/frame';

/** 帧序联动镜头计划的重算结果 */
export interface RangeSyncResult {
  /** 已实拍张数超出新计划，保留原计划（未写回） */
  kept: boolean;
  /** 已实拍张数 */
  taken: number;
  /** 本次按每帧张数算出的新计划张数 */
  planned: number;
  /** 已实拍超出新计划的张数（kept 时 > 0） */
  overBy: number;
}

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();
  const { frames, selectedFrameNo } = storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  /** 整段帧序的总拍摄张数（每帧 shotCount 累加） */
  const totalShots = computed(() => totalShotCount(frames.value));
  /** 当前帧序等效时长：总张数 ÷ 帧率 */
  const totalDuration = computed(() => framesToDuration(totalShots.value, fps.value));
  /** 镜头记录上的计划张数（与总览、实拍记录同一口径） */
  const plannedFrames = computed(() => (shot.value ? plannedFramesOf(shot.value) : 0));

  async function insertAfter(frameNo: number | null): Promise<RangeSyncResult> {
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    await frameStore.insertAt(Math.max(0, index));
    return syncShotRange();
  }

  async function removeAt(frameNo: number): Promise<RangeSyncResult> {
    const index = frames.value.findIndex((f) => f.frameNo === frameNo);
    if (index < 0) return { kept: false, taken: 0, planned: plannedFrames.value, overBy: 0 };
    await frameStore.removeAt(index);
    return syncShotRange();
  }

  async function move(fromIndex: number, toIndex: number): Promise<RangeSyncResult> {
    await frameStore.move(fromIndex, toIndex);
    return syncShotRange();
  }

  /** 该镜头已登记的实拍张数合计 */
  async function takenFramesOf(id: number): Promise<number> {
    const rows = await api.listTakesByShot(id);
    return rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
  }

  /**
   * 帧序或每帧张数变化后重算镜头的帧区间、时长与计划张数。
   * 计划张数 = 逐帧 shotCount 之和；时长 = 计划张数 ÷ 帧率；
   * 结束帧号 = 起始帧号 + 计划张数 - 1（每张占一个成片帧位）。
   * 已实拍张数超出新计划时保留原计划，不写回镜头，并返回超出张数。
   */
  async function syncShotRange(): Promise<RangeSyncResult> {
    if (shotId.value === null) return { kept: false, taken: 0, planned: 0, overBy: 0 };
    const current = shotStore.byId(shotId.value);
    if (!current) return { kept: false, taken: 0, planned: 0, overBy: 0 };
    const fps = current.fps || 24;
    const plan = planFromFrames(frames.value, current.startFrame, fps);
    const taken = await takenFramesOf(shotId.value);
    if (taken > plan.totalShots) {
      return { kept: true, taken, planned: plan.totalShots, overBy: taken - plan.totalShots };
    }
    await shotStore.update(shotId.value, {
      durationSec: plan.durationSec,
      startFrame: plan.startFrame,
      endFrame: plan.endFrame,
    });
    return { kept: false, taken, planned: plan.totalShots, overBy: 0 };
  }

  /** 条带/表格上的单帧改动；改拍摄张数时联动重算镜头计划 */
  async function patch(frameNo: number, patchValue: Partial<FrameEntry>): Promise<RangeSyncResult | null> {
    await frameStore.patchFrame(frameNo, patchValue);
    if (typeof patchValue.shotCount === 'number') return syncShotRange();
    return null;
  }

  /** 整段（或指定帧）套用拍摄张数，并重算帧区间、时长与计划张数 */
  async function applyShotCount(count: ShotCount, indexes?: number[]): Promise<RangeSyncResult> {
    await frameStore.applyShotCount(count, indexes);
    return syncShotRange();
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
    totalShots,
    totalDuration,
    plannedFrames,
    insertAfter,
    removeAt,
    move,
    patch,
    applyShotCount,
    select,
    syncShotRange,
    reload: (id: number) => frameStore.loadForShot(id),
  };
}
