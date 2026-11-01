import { avatarOf } from '@platform/sdk';

/**
 * 头像。
 *
 * - 预设：一个 emoji 画在色块上
 * - 上传：`upload:<文件>` → `/avatars/<文件>`
 * - 都没设：按 id 稳定地挑一个预设（同一个人永远同一张，不会闪）
 */
export function Avatar({
  user,
  size = 32,
  className,
}: {
  user: { id: string; avatar?: string | null };
  size?: number;
  className?: string;
}) {
  const preset = avatarOf(user);
  const style = {
    width: size,
    height: size,
    background: preset.bg,
    fontSize: Math.round(size * 0.52),
    borderRadius: size >= 48 ? 14 : 10,
  };

  if (preset.upload) {
    return (
      <img
        className={className ? `avatar ${className}` : 'avatar'}
        style={style}
        src={`/avatars/${encodeURIComponent(preset.upload)}`}
        alt=""
      />
    );
  }

  return (
    <span className={className ? `avatar ${className}` : 'avatar'} style={style} aria-hidden>
      {preset.glyph}
    </span>
  );
}
