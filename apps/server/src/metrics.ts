/**
 * 极简指标：计数器 + 即时值。
 * 暴露成 Prometheus 风格文本，够 Grafana / 手工 curl 用；不引第三方依赖。
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  add(name: string, delta: number): void {
    this.gauges.set(name, (this.gauges.get(name) ?? 0) + delta);
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  /** Prometheus 文本格式：名字里的点统一换成下划线 */
  toPrometheus(extra: Record<string, number> = {}): string {
    const lines: string[] = [];
    const clean = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, '_');

    for (const [name, value] of [...this.counters, ...this.gauges]) {
      lines.push(`platform_${clean(name)} ${value}`);
    }
    for (const [name, value] of Object.entries(extra)) {
      lines.push(`platform_${clean(name)} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
