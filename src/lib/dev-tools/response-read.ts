// ─────────────────────────────────────────────────────────────────────────────
// response-read.ts — dev-tools 的「响应 / 报文读取」小工具（纯函数、零依赖）
//
// 【为什么单独一个模块】此前 7 个 dev-tools 组件各抄一份 `errorText`、3 个联网工具
// 各抄一份 `asRecord` / `readString` / `readNumber`（R3-473）。同一份第三方 JSON 的
// 防御若有多份副本，改一处口径（例如 `readNumber` 开始接受数字字符串）时其它副本
// 不会红，三个联网工具就会对同一份报文给出不同的解析结果。收成一份之后口径只有一处。
//
// 【只放「没读到」的防御，不做业务判断】这里不认识任何响应形状：字段语义仍由调用方
// 自己的 `parse*` 函数负责，本模块只回答「这个值能不能按 string/number 读出来」。
//
// ⚠️ `src/lib/file-converter/engines/ocr.ts` 里也有一个同名 `errorText`，**不是同一语义**
//    （它要保留引擎层抛出的 plain object 的 message / String(e)，结果进 ConvertError.detail），
//    不要并进来 —— 合并会让错误详情变样。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 catch 到的未知值变成一句可展示的文案。
 *
 * `fallback` 由调用方按场景给：dev-tools 的经历是「未知错误」，URL 工具是「非法输入」，
 * AES 工具是「操作失败，请检查密钥、IV 与密文格式」—— 三条都是用户可见文案，逐字保留。
 * `Error` 但 message 为空 → 同样走 fallback（空串在状态栏里等于没提示）。
 */
export function errorText(e: unknown, fallback = '未知错误'): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** 只认非数组对象；null / 原始值 / 数组 → null（第三方 JSON 的形状防御）。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只认字符串；缺失 / 类型不符 → 空串（展示层不写「undefined」）。 */
export function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** 只认有限数字；缺失 / NaN / Infinity / 字符串 → null（调用方按 null 出空值，不编 0）。 */
export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
