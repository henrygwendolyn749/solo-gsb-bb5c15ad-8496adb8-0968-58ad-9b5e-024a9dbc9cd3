import type { Cue } from '../types';

/** A-B 循环的前后余量（秒） */
export interface LoopMargins {
  /** A 点 = 字幕起点 − pre */
  pre: number;
  /** B 点 = 字幕终点 + post */
  post: number;
}

/** 循环区间（秒，左闭右开 [a, b)） */
export interface LoopRange {
  a: number;
  b: number;
}

/** 默认余量：A 前 250ms，B 后 350ms，便于听清字幕进出点 */
export const DEFAULT_LOOP_MARGINS: LoopMargins = { pre: 0.25, post: 0.35 };
/** 单侧余量上限（秒） */
export const MAX_LOOP_MARGIN = 5;
/** 循环区间最短长度（秒）；经音频时长裁剪后短于此视为空区间 */
export const MIN_LOOP_LENGTH = 0.05;

/** 循环不可用的原因 */
export type LoopDisabledReason = 'no-audio' | 'no-selection' | 'empty-range';

export const LOOP_DISABLED_REASONS: Record<LoopDisabledReason, string> = {
  'no-audio': '请先导入音频',
  'no-selection': '请先选择一条字幕',
  'empty-range': '循环区间经音频时长裁剪后为空'
};

export type LoopRangeResult =
  | { ok: true; range: LoopRange }
  | { ok: false; reason: LoopDisabledReason };

/** 余量清洗：非有限值 / 负数归零，超过上限截断 */
export function sanitizeMargins(margins: LoopMargins): LoopMargins {
  const clamp = (v: number) =>
    Math.min(MAX_LOOP_MARGIN, Math.max(0, Number.isFinite(v) ? v : 0));
  return { pre: clamp(margins.pre), post: clamp(margins.post) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 计算循环区间：
 * A = max(0, 字幕起点 − 前余量)，B = 字幕终点 + 后余量；
 * 音频时长已知（>0）时两端都裁剪到时长内。
 * 无音频 / 未选字幕 / 裁剪后区间不足 MIN_LOOP_LENGTH 时返回对应原因。
 */
export function computeLoopRange(args: {
  hasAudio: boolean;
  cue: Pick<Cue, 'start' | 'end'> | null;
  margins: LoopMargins;
  /** 音频时长（秒），未知为 0 */
  duration: number;
}): LoopRangeResult {
  const { hasAudio, cue, duration } = args;
  if (!hasAudio) return { ok: false, reason: 'no-audio' };
  if (!cue) return { ok: false, reason: 'no-selection' };

  const { pre, post } = sanitizeMargins(args.margins);
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;

  let a = Math.max(0, cue.start - pre);
  let b = cue.end + post;
  if (dur > 0) {
    a = Math.min(a, dur);
    b = Math.min(b, dur);
  }
  a = round3(a);
  b = round3(b);

  if (b - a < MIN_LOOP_LENGTH - 1e-6) return { ok: false, reason: 'empty-range' };
  return { ok: true, range: { a, b } };
}

/** 播放状态转换结果 */
export type LoopPlaybackAction =
  | { type: 'none' }
  | { type: 'seek'; to: number; reason: 'loop-back' | 'jump-to-a' };

/** 播放中逐帧检查：越过 B 点（≥ b）则回到 A 点继续 */
export function loopTickAction(currentTime: number, range: LoopRange): LoopPlaybackAction {
  if (currentTime >= range.b) return { type: 'seek', to: range.a, reason: 'loop-back' };
  return { type: 'none' };
}

/** 区间出现 / 更新后：播放头落在新区间 [a, b) 外则立即跳到 A 点 */
export function loopEnterAction(currentTime: number, range: LoopRange): LoopPlaybackAction {
  if (currentTime < range.a || currentTime >= range.b) {
    return { type: 'seek', to: range.a, reason: 'jump-to-a' };
  }
  return { type: 'none' };
}
