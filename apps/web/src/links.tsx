/**
 * 页面里的链接：私聊、聊天里粘进来的 `#/join/ABC234` 应该能点。
 *
 * 站内用 hash 路由（`#/table/xxx`），所以"绝对地址"就是 当前地址 + hash；
 * 站外链接原样返回，不要替别人改。
 */
import type { ReactNode } from 'react';

export function absoluteUrl(link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  const base = `${location.origin}${location.pathname}`;
  return link.startsWith('#') ? `${base}${link}` : `${base}#${link}`;
}

/** 点链接：站内改 hash（App 自己会切视图），站外新开标签页 */
export function goTo(link: string): void {
  if (/^https?:\/\//i.test(link)) {
    window.open(link, '_blank', 'noopener,noreferrer');
    return;
  }
  location.hash = link;
}

/** 站内 `#/...` 和站外 http(s) 都认；中文标点（。，；）不当链接的一部分 */
const LINK = /(https?:\/\/[^\s<>"'，。；、）】」]+|#\/[A-Za-z0-9/_%?=&.-]+)/g;

/** 房间里的一段路径写得短一点：`#/join/ABC234` → 「加入房间 ABC234」 */
function labelOf(link: string): string {
  const join = /^#\/join\/([A-Za-z0-9]+)$/.exec(link);
  return join ? `加入房间 ${join[1]}` : link;
}

/** 把正文里的链接渲染成可点的元素；其余文字原样返回 */
export function renderLinks(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  body.split(LINK).forEach((part, index) => {
    if (!part) return;
    if (/^https?:\/\//i.test(part)) {
      out.push(
        <a key={index} className="inline-link" href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>,
      );
      return;
    }
    if (part.startsWith('#/')) {
      // href 留着：右键能复制、新标签页也能打开，只是本页点击交给 goTo
      out.push(
        <a
          key={index}
          className="inline-link"
          href={part}
          onClick={(event) => {
            event.preventDefault();
            goTo(part);
          }}
        >
          {labelOf(part)}
        </a>,
      );
      return;
    }
    out.push(part);
  });
  return out;
}
