/** 时间戳 → 2026-10-31 16:20；管理端和用户中心共用 */
export function formatTime(at: number | null): string {
  if (!at) return '—';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
