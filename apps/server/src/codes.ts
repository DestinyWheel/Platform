/**
 * 房间码、邀请码共用的短码生成。
 *
 * 字母表去掉了 0/O/1/I/L：这些字符念出来、手抄下来最容易错，
 * 而这两个码的典型用法就是"口头报给对方"或"抄在纸上"。
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length = 6): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 房间码 6 位（31^6 ≈ 8.9 亿） */
export const ROOM_CODE_LENGTH = 6;
/** 邀请码 8 位（31^8 ≈ 8.5 万亿）：它比房间码更"长期有效"，留足余量 */
export const INVITE_CODE_LENGTH = 8;
