import type { LogEntry } from '@platform/sdk';

/** 日志模板渲染。M2 之后换成插件自带的 locales/*.json，M0 先硬编码在宿主里。 */
export function renderLog(entry: LogEntry, names: Record<string, string>): string {
  const name = (id: unknown): string => names[String(id)] ?? String(id).slice(0, 6);
  const args = entry.args ?? {};

  switch (entry.key) {
    case 'dice.roll':
      return `${name(args.player)} 掷出了 ${String(args.value)} 点`;

    case 'dice.roundEnd': {
      const rolls = (args.rolls ?? {}) as Record<string, number | null>;
      const parts = Object.entries(rolls)
        .map(([player, value]) => `${name(player)}:${value ?? '-'}`)
        .join('  ');
      return `第 ${String(args.round)} 轮结束 — ${parts}`;
    }

    case 'dice.gameEnd': {
      const ranking = (args.ranking ?? []) as string[][];
      const champions = (ranking[0] ?? []).map(name).join('、');
      return `对局结束，冠军：${champions}`;
    }

    default:
      return entry.key;
  }
}
