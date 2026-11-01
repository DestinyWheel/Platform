/**
 * 默认头像。
 *
 * 先只做「预设」：一个 emoji + 一个底色，不需要文件存储、不怕传大图，
 * 和深色界面也搭。上传头像的能力（`upload:<id>`）已经在服务端留好了口子，
 * 只是默认不开放——想开的时候把 AVATAR_UPLOAD 设成 1 即可。
 */
export interface AvatarPreset {
  id: string;
  /** 画在头像里的字：一个 emoji，或者一个汉字 */
  glyph: string;
  /** 底色（深色系，别抢卡片的戏） */
  bg: string;
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'wolf', glyph: '🐺', bg: '#26313f' },
  { id: 'fox', glyph: '🦊', bg: '#3a2a24' },
  { id: 'panda', glyph: '🐼', bg: '#2b332e' },
  { id: 'owl', glyph: '🦉', bg: '#34302a' },
  { id: 'whale', glyph: '🐳', bg: '#1f2f3d' },
  { id: 'dino', glyph: '🦕', bg: '#26382c' },
  { id: 'cat', glyph: '🐱', bg: '#332b3a' },
  { id: 'rabbit', glyph: '🐰', bg: '#3a2b33' },
  { id: 'octopus', glyph: '🐙', bg: '#3b2634' },
  { id: 'penguin', glyph: '🐧', bg: '#242c36' },
];

const PRESET_IDS = new Set(AVATAR_PRESETS.map((preset) => preset.id));

/** 头像值是不是一个合法的预设 */
export function isPresetAvatar(value: string | null | undefined): boolean {
  return Boolean(value && value.startsWith('preset:') && PRESET_IDS.has(value.slice(7)));
}

/**
 * 拿到这个人该显示的头像。
 *
 * - `preset:<id>` → 那个预设
 * - `upload:<id>` → 上传的图（前端自己去 `/avatars/<id>` 取）
 * - 没设置 → 按 id 稳定地挑一个（同一个人每次刷新都是同一张）
 */
export function avatarOf(user: { id: string; avatar?: string | null }): AvatarPreset & {
  upload?: string;
} {
  const value = user.avatar ?? '';
  if (value.startsWith('upload:')) {
    return { id: 'upload', glyph: '', bg: '#2b3441', upload: value.slice(7) };
  }
  const presetId = value.startsWith('preset:') ? value.slice(7) : '';
  const preset = AVATAR_PRESETS.find((item) => item.id === presetId);
  if (preset) return preset;

  // 没选过：用 id 的字符和稳定地选一个
  let hash = 0;
  for (const char of user.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_PRESETS[hash % AVATAR_PRESETS.length]!;
}
