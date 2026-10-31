import type { GameManifest } from '@platform/sdk';

/**
 * 节奏档位 → 每步给多少毫秒。null = 不限时（友谊局，不计分）。
 *
 * 回合制按"每天能动几次"换算：24 次/天 = 每小时一步；2d = 两天一步。
 */
export const TURN_PACE_MS: Record<string, number | null> = {
  '24': 3_600_000,
  '12': 7_200_000,
  '8': 10_800_000,
  '4': 21_600_000,
  '2': 43_200_000,
  '1': 86_400_000,
  '2d': 172_800_000,
  none: null,
};

export const TURN_PACE_LABEL: Record<string, string> = {
  '24': '每天 24 回合（每小时一动）',
  '12': '每天 12 回合',
  '8': '每天 8 回合',
  '4': '每天 4 回合',
  '2': '每天 2 回合',
  '1': '每天 1 回合',
  '2d': '2 天一动',
  none: '无限（友谊赛，不计分）',
};

export const REALTIME_PACE = ['fast', 'normal', 'slow', 'none'] as const;
export const TURN_PACES = ['24', '12', '8', '4', '2', '1', '2d', 'none'] as const;

/** 插件没写自己节奏时的默认值 */
export const DEFAULT_REALTIME = { fast: 20, normal: 45, slow: 90 };

/** 即时制档位 → 毫秒；插件在 manifest.realtime 里自己定 */
export function realtimeTurnMs(manifest: GameManifest, pace: string): number | null {
  if (pace === 'none') return null;
  const speeds = manifest.realtime ?? DEFAULT_REALTIME;
  const seconds =
    pace === 'fast' ? speeds.fast : pace === 'slow' ? speeds.slow : speeds.normal;
  // 兜一下：太快容易误伤，太慢等于没有
  return Math.min(Math.max(seconds, 5), 3600) * 1000;
}

/** 回合制档位 → 毫秒 */
export function turnPaceMs(pace: string): number | null {
  return TURN_PACE_MS[pace] ?? null;
}

const DAY = 86_400_000;

/**
 * 把到期时间推进到「每日可行动时段」里。
 *
 * 时段按 UTC 的分钟数存（0–1439），这样数据库里不存时区；用户看到的是本地时间。
 * 到点时刻落在窗口外，就顺延到下一个窗口开始——否则玩家在睡觉时段被扣超时。
 */
export function alignToWindow(
  at: number,
  startMin: number | null,
  endMin: number | null,
): number {
  if (startMin === null || endMin === null) return at;
  if (startMin >= endMin) return at; // 跨午夜暂不支持，按全天处理

  let cursor = at;
  for (let guard = 0; guard < 3; guard += 1) {
    const base = Math.floor(cursor / DAY) * DAY;
    const from = base + startMin * 60_000;
    const to = base + endMin * 60_000;
    if (cursor < from) return from;
    if (cursor < to) return cursor;
    cursor = base + DAY + startMin * 60_000;
  }
  return cursor;
}
