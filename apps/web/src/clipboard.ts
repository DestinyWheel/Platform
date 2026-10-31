/**
 * 复制到剪贴板。
 *
 * navigator.clipboard 只在**安全上下文**（https，或 localhost）里存在。
 * 这个平台是 http://IP:8080 直接访问的，属于不安全上下文，
 * navigator.clipboard 干脆是 undefined —— 直接调它会抛 TypeError，
 * 于是「复制」按钮点了跟没点一样。这里退回「临时 textarea + execCommand」的老办法，
 * 那条路在 http 下照样能用。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 用户拒绝授权、文档没有焦点……往下走老办法
    }
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    // 移动端上 select() 偶尔不生效，先 focus 再 setSelectionRange 更稳
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}

/** 复制失败时的兜底：把这段文字选中，用户按 Ctrl+C 就行 */
export function selectText(node: Element | null | undefined): void {
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
