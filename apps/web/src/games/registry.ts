import type { ComponentType } from 'react';
import type { PublicView } from '@platform/sdk';
import { DiceGame } from './dice/DiceGame';

/** 游戏 UI 的统一入参：宿主只负责把视图和动作通道交给插件 */
export interface GameProps {
  view: PublicView;
  you: string;
  playerNames: Record<string, string>;
  legal: string[];
  onAction: (type: string, payload?: unknown) => void;
}

/**
 * M0：静态注册表（直接 import）。
 * M2 会换成 `await import(/plugins/<id>/<version>/client.js)` —— 组件签名不变。
 */
export const gameComponents: Record<string, ComponentType<GameProps>> = {
  dice: DiceGame,
};
