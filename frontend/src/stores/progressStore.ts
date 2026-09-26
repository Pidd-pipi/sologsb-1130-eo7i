/**
 * 进度数据 store：实拍记录与全量帧条目的共享缓存。
 * 帧条目是「新计划」（逐帧拍摄张数求和）的唯一来源，
 * 帧序每次改动后由 useFrameSequence 触发 refreshFrames，
 * 保证镜头详情 / 总览 / 实拍记录读到同一份结果。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import type { FrameEntry } from '../types/frame';
import type { TakeLog } from '../types/take';

interface ProgressState {
  takes: TakeLog[];
  frames: FrameEntry[];
  ready: boolean;
}

export const useProgressStore = defineStore('progress', {
  state: (): ProgressState => ({
    takes: [],
    frames: [],
    ready: false,
  }),
  actions: {
    /** 读取实拍记录与帧条目（进度与超出提示都依赖逐帧拍摄张数） */
    async refresh() {
      this.takes = await api.listTakes();
      this.frames = await api.listAllFrames();
      this.ready = true;
    },
    /** 帧序改动后仅刷新帧条目缓存 */
    async refreshFrames() {
      this.frames = await api.listAllFrames();
    },
  },
});
