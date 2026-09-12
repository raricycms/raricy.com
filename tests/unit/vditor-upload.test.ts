// ─────────────────────────────────────────────────────────────────────────────
// vditor-upload.test.ts —— 钉住「vditor ↔ /api/images」之间的上传协议
//
// 【为什么要有】两端各有一套协议，不一致的**错法都不指向根因**，几种都线上踩过：
//   · 字段名不一致（vditor 默认 `file[]`，服务端读 `file`）→ 文件其实已经发出去了，
//     服务端取不到 → `400 请选择文件`。提示看着像没选文件，于是没人去查请求体。
//   · 响应结构不一致（vditor 要 `data.succMap`）→ genUploadedLabel 抛 TypeError，
//     图片**静默**插不进去，而它抛在 XHR 回调里 → 提示停在「上传中…」。
//   · format 动了第一个参数（那是 FileList / DataTransferItemList，不是数组）→
//     抛在同一条回调里，症状与上一条一模一样。
//
// 这些单测都够不着「真浏览器」，所以这里钉的是**协议契约**（纯函数 + 静态扫描），
// 端到端那半在 tests/e2e/vditor-upload.spec.ts。
//
// 几条容易改错的 vditor 行为（都核过 dist/index.js，别照 types 里的注释改）：
//   · validate **只在返回字符串时**中止上传（返回 false 等于没闸门）
//   · format 的入参可能是 FileList / DataTransferItemList / 数组（拖拽时连 name 都没有）
//   · code:1 不影响 succMap 的插入；但 code:1 + 空 msg + 空 errFiles = 静默失败
//   · succMap 的键靠**扩展名**判类型，去重后缀必须插在扩展名之前
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_UPLOAD_REQUEST_BYTES } from '@/lib/image-client';
import { vditorUploadOptions } from '@/lib/vditor-upload';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * 假 File：只用到 name / type / size，用 Object.create 挂在 File.prototype 上
 * 好让 `instanceof File` 成立（生产代码就是靠它把 File 从 DataTransferItem 里认出来的），
 * 同时避免为「超过 11MB」这种用例真去分配十几兆。
 */
function fakeFile(name: string, type = 'image/png', size = 1024): File {
  const file = Object.create(File.prototype) as File;
  Object.defineProperties(file, {
    name: { value: name },
    type: { value: type },
    size: { value: size },
  });
  return file;
}

/** 上传配置是给 vditor 用的，测试里只关心协议字段，onError 收着备用。 */
function options(onError: (m: string) => void = () => {}) {
  return vditorUploadOptions(onError);
}

interface VditorUploadResponse {
  code: number;
  msg: string;
  data: { errFiles: string[]; succMap: Record<string, string> };
}

/** format 的返回值是 JSON 字符串（vditor 会自己 JSON.parse）。 */
function runFormat(files: unknown, responseText: string): VditorUploadResponse {
  return JSON.parse(options().format!(files as File[], responseText)) as VditorUploadResponse;
}

/** 服务端成功响应（新形状：items/failed + 单文件时才有 id/url）。 */
function serverOk(items: { filename: string; url: string }[], failed: unknown[] = []): string {
  return JSON.stringify({
    code: 200,
    message: items.length === 1 ? '上传成功' : `成功上传 ${items.length} 张`,
    items: items.map((it, i) => ({ filename: it.filename, id: `id${i}`, url: it.url })),
    failed,
    ...(items.length === 1 && failed.length === 0 ? { id: 'id0', url: items[0].url } : {}),
  });
}

const ONE = serverOk([{ filename: 'photo.png', url: '/api/images/a1b2c3d4e5/raw' }]);

describe('format：把本站响应翻译成 vditor 的结构', () => {
  it('成功：succMap 的键是**带扩展名的原始文件名**，值是 raw 地址', () => {
    const r = runFormat(undefined, ONE);
    expect(r.code).toBe(0);
    // 键必须是文件名而不是 id：vditor 靠键的扩展名决定插入 <img> 还是普通链接，
    // 给 id 会让图片变成一条链接。
    expect(r.data.succMap).toEqual({ 'photo.png': '/api/images/a1b2c3d4e5/raw' });
    expect(r.data.errFiles).toEqual([]);
  });

  it('成功：data 两个字段都在 —— 缺一个 vditor 就抛 TypeError', () => {
    const r = runFormat(undefined, ONE);
    expect(Array.isArray(r.data.errFiles)).toBe(true);
    expect(typeof r.data.succMap).toBe('object');
  });

  it('★ 完全不碰第一个参数（它可能是 FileList / DataTransferItemList / undefined）', () => {
    // vditor 拖拽时传的是 DataTransferItemList，元素的 .name 是 undefined，
    // 而且它自己会先按 accept/max 丢掉一部分文件 —— 下标根本对不上。
    // 所以键只能来自服务端回显，第一个参数碰都不能碰：
    const itemList = { 0: { kind: 'string', getAsFile: () => null }, length: 1 };
    expect(runFormat(itemList, ONE).code).toBe(0);
    expect(runFormat(new DataTransferItemListShim(), ONE).data.succMap).toEqual({
      'photo.png': '/api/images/a1b2c3d4e5/raw',
    });
    expect(runFormat(undefined, ONE).code).toBe(0);
  });

  it('★ 一张都没成时 msg 不能为空（否则 vditor 走 tip.hide() = 静默失败）', () => {
    // code 200 但 items 缺失/为空：网关改写、或服务端版本比客户端旧
    const r = runFormat(undefined, JSON.stringify({ code: 200, message: '上传成功' }));
    expect(r.code).toBe(1);
    expect(r.msg).not.toBe('');
    expect(r.data.succMap).toEqual({});
  });

  it('失败：apiErr 的 message 原样带出去，不把 JSON 原文糊给用户', () => {
    const r = runFormat(undefined, JSON.stringify({ code: 403, message: '需要核心用户权限' }));
    expect(r.code).toBe(1);
    expect(r.msg).toBe('需要核心用户权限');
  });

  it('失败：反代/网关的 HTML 错误页走兜底文案', () => {
    expect(runFormat(undefined, '<html><body>413 Request Entity Too Large</body></html>').msg)
      .toBe('图片上传失败，请重试');
  });

  it('失败：网络中断时 responseText 是空串', () => {
    expect(runFormat(undefined, '').msg).toBe('图片上传失败，请重试');
  });
});

describe('多文件', () => {
  it('两张图 → succMap 两个键（都插进编辑器）', () => {
    const r = runFormat(
      undefined,
      serverOk([
        { filename: 'a.png', url: '/api/images/aaaaaaaaaa/raw' },
        { filename: 'b.jpg', url: '/api/images/bbbbbbbbbb/raw' },
      ])
    );
    expect(r.code).toBe(0);
    expect(r.data.succMap).toEqual({
      'a.png': '/api/images/aaaaaaaaaa/raw',
      'b.jpg': '/api/images/bbbbbbbbbb/raw',
    });
  });

  it('★ 同名文件去重，后缀插在扩展名之前（否则会被判成普通链接）', () => {
    const r = runFormat(
      undefined,
      serverOk([
        { filename: 'shot.png', url: '/api/images/aaaaaaaaaa/raw' },
        { filename: 'shot.png', url: '/api/images/bbbbbbbbbb/raw' },
      ])
    );
    // 键撞了 vditor 只认一个 → 少插一张；而后缀放末尾（shot.png(2)）会让
    // genUploadedLabel 取不到 .png，退化成插入一条链接。
    expect(Object.keys(r.data.succMap)).toEqual(['shot.png', 'shot(2).png']);
  });

  it('★ 部分失败：失败原因进 msg、失败文件进 errFiles、成功的照样插', () => {
    const r = runFormat(
      undefined,
      serverOk(
        [{ filename: 'ok.png', url: '/api/images/aaaaaaaaaa/raw' }],
        [{ filename: 'big.png', message: '文件过大，单文件上限 10 MB' }]
      )
    );
    expect(r.code).toBe(1); // 有失败 → 让 vditor 弹 tip
    expect(r.msg).toBe('文件过大，单文件上限 10 MB');
    expect(r.data.errFiles).toEqual(['big.png']);
    // code 1 不影响插入 —— 成功的这张必须还在
    expect(r.data.succMap).toEqual({ 'ok.png': '/api/images/aaaaaaaaaa/raw' });
  });
});

describe('validate：上传前的闸门', () => {
  const validate = (files: unknown[]) => options().validate!(files as File[]);

  it('正常放行（vditor 只认字符串为拒绝，返回 true 与 undefined 等价）', () => {
    expect(typeof validate([fakeFile('a.png'), fakeFile('b.png')])).not.toBe('string');
  });

  it('★ 拖拽里混入非文件项（getAsFile() 返回 null）必须拦下，不能让 vditor 崩', () => {
    // 拖进来一段文字或一个链接时 dataTransfer.items 里就有 kind: 'string' 的项，
    // 它的 getAsFile() 返回 null。multiple 打开后 vditor 会遍历每一项，
    // null 会在它读 file.name 时抛 TypeError —— 表现是「拖进去什么都没发生」。
    const withText = [fakeFile('a.png'), { kind: 'string', getAsFile: () => null }];
    expect(typeof validate(withText)).toBe('string');
  });

  it('DataTransferItem 形状的项能取出 File', () => {
    const real = fakeFile('a.png');
    expect(typeof validate([{ kind: 'file', getAsFile: () => real }])).not.toBe('string');
  });

  it('★ 总体积超限 → 拦下并给出动作指引', () => {
    const half = Math.ceil(MAX_UPLOAD_REQUEST_BYTES / 2) + 1;
    const msg = validate([fakeFile('a.png', 'image/png', half), fakeFile('b.png', 'image/png', half)]);
    expect(typeof msg).toBe('string');
    // 文案要给动作指引：被 validate 拒时 vditor 不会重置 input.value，
    // 重选同一批文件不会再触发 change，只说「太大了」用户会以为点了没反应。
    expect(msg).toContain('分批');
  });

  it('注定被 vditor 丢掉的文件不计入总体积（单文件超 10MB 由它自己拦）', () => {
    const big = fakeFile('big.png', 'image/png', 20 * 1024 * 1024);
    const small = fakeFile('small.png', 'image/png', 1024);
    // 20MB 那张会被 vditor 的 max 检查丢掉，不该因为它在就拒掉整批
    expect(typeof validate([big, small])).not.toBe('string');
  });
});

/** 只为断言「format 不碰第一个参数」——不是真的 DataTransferItemList。 */
class DataTransferItemListShim {
  0 = { kind: 'file' };
  length = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 静态契约：跨文件对齐，改一边不改另一边就报错
// ─────────────────────────────────────────────────────────────────────────────

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 注释里提到 `upload: {...}` 不算配置，先抹掉再扫。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('静态契约：两端字段名必须一致', () => {
  it('★ vditor 的 fieldName === route 里真正读的那个表单字段', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src/app/api/images/route.ts'), 'utf8');
    // 「被当成 File 校验的那个字段」—— 容忍改局部变量名，不容忍改字段名。
    // 注意是 getAll（一次可以多个文件），不是 get。
    const m = route.match(/form\.getAll\(\s*'([^']+)'\s*\)[\s\S]{0,120}?instanceof\s+File/);
    expect(m, 'route.ts 里找不到 getAll(...) + instanceof File 的表单字段读取').not.toBeNull();
    // 曾经是 vditor 默认的 'file[]' —— 服务端取不到 → 400 请选择文件
    expect(options().fieldName).toBe(m![1]);
  });

  it('★ 每个挂了 vditor 的编辑器都走 vditorUploadOptions()，不许内联 upload 字面量', () => {
    const offenders: string[] = [];
    for (const file of collectFiles(path.join(ROOT, 'src'))) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (!code.includes('new Vditor(')) continue;
      if (!/(^|[^.\w])upload\s*:/.test(code)) continue;
      if (!code.includes('vditorUploadOptions(')) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders, '这些文件自己写了 upload 配置，两端的协议对齐会 drift').toEqual([]);
  });
});
