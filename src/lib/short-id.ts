// ─────────────────────────────────────────────────────────────────────────────
// short-id.ts — 短 ID 生成（对齐 Flask app/utils/generate_stringid.py:generate_id）
//
// 字符集：小写字母 + 数字（base36 风格），默认 8 位。
// Flask 侧用 random.choice（非加密安全）；此处用 crypto.getRandomValues 取更好的
// 均匀分布，语义等价。用于剪贴板主键（ClipBoard.id / ClipText.clipId）。
// ─────────────────────────────────────────────────────────────────────────────

const CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789'; // 36 字符

/** 生成 len 位短 ID（小写字母 + 数字）。 */
export function generateShortId(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}
