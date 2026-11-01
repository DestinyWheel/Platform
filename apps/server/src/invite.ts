/**
 * 邀请别人打一局：私聊正文 + 能直接点开的链接。
 *
 * 以前正文里塞的是 `#/join/ABC234` 这样一段裸文字——对方得自己选中复制再粘到地址栏。
 * 现在链接单独放一个字段，前端画成「进入牌桌」按钮，正文只留一句人话。
 */
import type { DirectInviteRecord } from './store.js';

export interface InvitePayload {
  body: string;
  kind: 'invite';
  /** 页面内跳转地址：有房间号就按房间号进（开打了会当观战），没有就按桌 id 进 */
  link: string;
  invite: DirectInviteRecord;
}

export function buildInvite(input: {
  inviterName: string;
  gameId: string;
  gameName: string;
  tableId: string;
  code: string | null;
}): InvitePayload {
  const code = input.code && input.code.trim() !== '' ? input.code.trim() : null;
  const body = `${input.inviterName} 邀请你打「${input.gameName}」${code ? `，房间号 ${code}` : ''}`;

  return {
    body,
    kind: 'invite',
    link: code ? `#/join/${encodeURIComponent(code)}` : `#/table/${encodeURIComponent(input.tableId)}`,
    invite: {
      tableId: input.tableId,
      code,
      gameId: input.gameId,
      gameName: input.gameName,
    },
  };
}
