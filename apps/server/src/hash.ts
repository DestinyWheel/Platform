import { createHash } from 'node:crypto';

/**
 * 键序稳定的 JSON 序列化 —— 状态哈希的前提。
 * 同样的局面必须得到同样的字符串，否则回放校验会假报警。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

export function hashState(state: unknown): string {
  return createHash('sha256').update(stableStringify(state)).digest('hex').slice(0, 32);
}
