/**
 * 拍摄进度：由实拍张数与废帧数计算镜头完成百分比与剩余张数。
 * 计划张数与镜头存储的帧区间同源；已拍超过逐帧张数求和的新计划时给出超出提示。
 * 数据缓存在 progressStore，帧序改动后各页面读到同一份结果。
 * 被 / 与 /progress 消费。
 */
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { useProgressStore } from '../stores/progressStore';
import { plannedCaptures } from '../utils/frameMath';
import type { Shot } from '../types/shot';
import type { TakeLog, WasteBucket } from '../types/take';
import { createEmptyTake } from '../types/take';

export interface ShotProgressSummary {
  shotId: number;
  code: string;
  planned: number;
  taken: number;
  wasted: number;
  remaining: number;
  percent: number;
  /** 已拍超出新计划（逐帧拍摄张数求和）的张数 */
  overshoot: number;
}

/** 纯函数：按实拍张数/废帧数算进度 */
export function computeProgress(planned: number, taken: number, wasted: number) {
  const total = Math.max(1, Math.floor(planned));
  const done = Math.max(0, Math.floor(taken));
  const bad = Math.max(0, Math.floor(wasted));
  const remaining = Math.max(0, total - done);
  const percent = Math.min(100, Math.round((done / total) * 100));
  return { planned: total, taken: done, wasted: bad, remaining, percent };
}

/** 镜头计划张数：与存储的帧区间同源（结束帧号 - 起始帧号 + 1） */
export function shotPlannedFrames(shot: Shot): number {
  return Math.max(1, Math.floor(shot.endFrame) - Math.floor(shot.startFrame) + 1);
}

export function useProgress() {
  const shotStore = useShotStore();
  const progressStore = useProgressStore();
  const { takes, frames } = storeToRefs(progressStore);
  const loading = ref(false);

  const summaries = computed<ShotProgressSummary[]>(() =>
    shotStore.shots.map((shot) => {
      const planned = shotPlannedFrames(shot);
      const rows = takes.value.filter((t) => t.shotId === shot.id);
      const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
      const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
      const p = computeProgress(planned, taken, wasted);
      const framePlan = plannedCaptures(frames.value.filter((f) => f.shotId === shot.id));
      const overshoot = Math.max(0, p.taken - (framePlan || planned));
      return { shotId: shot.id ?? 0, code: shot.code, ...p, overshoot };
    }),
  );

  const overall = computed(() => {
    const planned = summaries.value.reduce((s, x) => s + x.planned, 0);
    const taken = summaries.value.reduce((s, x) => s + x.taken, 0);
    const wasted = summaries.value.reduce((s, x) => s + x.wasted, 0);
    const remaining = summaries.value.reduce((s, x) => s + x.remaining, 0);
    const overshoot = summaries.value.reduce((s, x) => s + x.overshoot, 0);
    const percent = planned ? Math.min(100, Math.round((taken / planned) * 100)) : 0;
    return { planned, taken, wasted, remaining, overshoot, percent };
  });

  /** 废帧分布：按张数区间分桶 */
  const wasteBuckets = computed<WasteBucket[]>(() => {
    const buckets: WasteBucket[] = [
      { label: '0 张', count: 0 },
      { label: '1-2 张', count: 0 },
      { label: '3-5 张', count: 0 },
      { label: '6 张以上', count: 0 },
    ];
    for (const row of takes.value) {
      const n = row.wastedFrames || 0;
      if (n === 0) buckets[0].count += 1;
      else if (n <= 2) buckets[1].count += 1;
      else if (n <= 5) buckets[2].count += 1;
      else buckets[3].count += 1;
    }
    return buckets;
  });

  /** 读取实拍记录与帧条目（计划张数与超出提示都依赖逐帧拍摄张数） */
  async function loadTakes() {
    loading.value = true;
    try {
      await progressStore.refresh();
    } finally {
      loading.value = false;
    }
  }

  function emptyTake(shot: Shot): TakeLog {
    const planned = shotPlannedFrames(shot);
    const rows = takes.value.filter((t) => t.shotId === shot.id);
    const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, taken, wasted);
    return { ...createEmptyTake(shot.id ?? 0, shot.code), remainingFrames: p.remaining, percent: p.percent };
  }

  /** 登记一条实拍记录，并回写镜头完成百分比 */
  async function registerTake(shot: Shot, date: string, takenFrames: number, wastedFrames: number) {
    const planned = shotPlannedFrames(shot);
    const rows = takes.value.filter((t) => t.shotId === shot.id);
    const prevTaken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const prevWasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, prevTaken + takenFrames, prevWasted + wastedFrames);
    const row: TakeLog = {
      date,
      shotCode: shot.code,
      shotId: shot.id ?? 0,
      takenFrames,
      wastedFrames,
      remainingFrames: p.remaining,
      percent: p.percent,
      updatedAt: Date.now(),
    };
    const id = await api.addTake(row);
    progressStore.takes = [{ ...row, id }, ...takes.value];
    if (typeof shot.id === 'number') await shotStore.syncProgress(shot.id, p.percent);
    return { ...row, id };
  }

  async function removeTake(id: number) {
    await api.deleteTake(id);
    progressStore.takes = takes.value.filter((t) => t.id !== id);
  }

  return {
    takes,
    loading,
    summaries,
    overall,
    wasteBuckets,
    loadTakes,
    emptyTake,
    registerTake,
    removeTake,
    computeProgress,
  };
}
