import type { GamePlugin } from '@platform/sdk';
import dice from '@platform/game-dice';

/**
 * M0：游戏注册表是静态的（直接 import）。
 * M2 会把它换成"扫描 storage/plugins + 版本表"，但 service 层看到的接口不变。
 */
export type AnyPlugin = GamePlugin<any>;

export class GameRegistry {
  private byId = new Map<string, AnyPlugin>();

  register(plugin: AnyPlugin): void {
    this.byId.set(plugin.manifest.id, plugin);
  }

  get(id: string): AnyPlugin | undefined {
    return this.byId.get(id);
  }

  list() {
    return [...this.byId.values()].map((p) => p.manifest);
  }
}

export function createRegistry(): GameRegistry {
  const registry = new GameRegistry();
  registry.register(dice);
  return registry;
}
