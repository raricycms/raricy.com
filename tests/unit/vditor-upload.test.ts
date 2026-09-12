// ─────────────────────────────────────────────────────────────────────────────
// vditor-upload.test.ts —— 钉住「vditor ↔ /api/images」之间的上传协议
//
// 【为什么要有】两端各有一套协议，不一致的**两种错法都不指向根因**，2026-09 两种都
// 线上踩过：
//   · 字段名不一致（vditor 默认 `file[]`，服务端读 `file`）→ 文件其实已经发出去了，
//     服务端 form.get('file') 取不到 → `400 请选择文件`。提示看着像没选文件，
//     于是没人去查请求体，往浏览器/权限方向白排查。
//   · 响应结构不一致（vditor 要 `data.succMap`，服务端给 `{ code, message, url }`）
//     → genUploadedLabel 在 response.data.errFiles 上抛 TypeError，图片**静默**插不进去。
//
// 这两条单测都够不着（前者要真实浏览器的 vditor，后者要登录态），所以分两段钉：
//   1–2. format 的行为：三种响应体各自翻译成什么（可直接调用，是纯函数）
//   3.   静态契约：fieldName 必须等于 route 里真正读的那个字段名；
//        且所有挂 vditor 的编辑器都必须走 vditorUploadOptions()，不许内联 upload 字面量
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { vditorUploadOptions } from '@/lib/vditor-upload';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** 只用到 name / type，不引 File 全局，免得绑 node 版本。 */
function fakeFile(name: string, type = 'image/png'): File {
  return { name, type } as File;
}

/** 上传配置是给 vditor 用的，测试里只关心协议字段，onError 收着备用。 */
function options(onError: (m: string) => void = () => {}) {
  return vditorUploadOptions(onError);
}

/** format 的返回值是 JSON 字符串（vditor 会自己 JSON.parse）。 */
function runFormat(files: File[], responseText: string): VditorUploadResponse {
  return JSON.parse(options().format!(files, responseText)) as VditorUploadResponse;
}

interface VditorUploadResponse {
  code: number;
  msg: string;
  data: { errFiles: string[]; succMap: Record<string, string> };
}

/** apiOk 的真实形状，取自 src/lib/format.ts。 */
const OK_BODY = JSON.stringify({
  code: 200,
  message: '上传成功',
  id: 'a1b2c3d4e5',
  url: '/api/images/a1b2c3d4e5/raw',
});

describe('format：把本站响应翻译成 vditor 的结构', () => {
  it('成功：succMap 的键是**带扩展名的原始文件名**，值是 raw 地址', () => {
    const r = runFormat([fakeFile('photo.png')], OK_BODY);
    expect(r.code).toBe(0);
    // 键必须是文件名而不是 id：vditor 靠键的扩展名决定插入 <img> 还是普通链接，
    // 给 id 会让图片变成一条链接。
    expect(r.data.succMap).toEqual({ 'photo.png': '/api/images/a1b2c3d4e5/raw' });
    expect(r.data.errFiles).toEqual([]);
  });

  it('成功：data 两个字段都在 —— 缺一个 vditor 就抛 TypeError', () => {
    const r = runFormat([fakeFile('photo.png')], OK_BODY);
    expect(Array.isArray(r.data.errFiles)).toBe(true);
    expect(typeof r.data.succMap).toBe('object');
  });

  it('失败：apiErr 的 message 原样带出去，不把 JSON 原文糊给用户', () => {
    const r = runFormat([], JSON.stringify({ code: 403, message: '需要核心用户权限' }));
    expect(r.code).toBe(1);
    expect(r.msg).toBe('需要核心用户权限');
  });

  it('失败：反代/网关的 HTML 错误页走兜底文案', () => {
    expect(runFormat([], '<html><body>413 Request Entity Too Large</body></html>').msg)
      .toBe('图片上传失败，请重试');
  });

  it('失败：网络中断时 responseText 是空串', () => {
    expect(runFormat([], '').msg).toBe('图片上传失败，请重试');
  });

  it('2xx 但结构不对（比如被网关改写过）也算失败，不静默插入', () => {
    const r = runFormat([fakeFile('photo.png')], JSON.stringify({ code: 200 }));
    expect(r.code).toBe(1);
    expect(r.data.succMap).toEqual({});
  });

  it('粘贴的截图没有文件名时按 MIME 补扩展名', () => {
    const r = runFormat([fakeFile('', 'image/jpeg')], OK_BODY);
    expect(Object.keys(r.data.succMap)).toEqual(['image.jpeg']);
  });
});

describe('多文件：服务端只收第一个，选择框层面就只放一个进来', () => {
  it('配置里关掉了多选', () => {
    expect(options().multiple).toBe(false);
  });

  it('★ 传进来的是 FileList（不是数组）也不能崩', () => {
    // vditor 给 format 的是 <input type=file> 的 event.target.files —— 一个 FileList，
    // 没有 slice / map。曾经的实现用 files.slice(1)，抛在 vditor 的 onreadystatechange 里：
    // 接口 200、图片插不进去、提示停在「上传中…」，页面上一点报错都没有。
    const fileList = { 0: fakeFile('a.png'), length: 1 } as unknown as File[];
    const r = runFormat(fileList, OK_BODY);
    expect(r.code).toBe(0);
    expect(Object.keys(r.data.succMap)).toEqual(['a.png']);
  });
});

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
    // 「被当成 File 校验的那个字段」—— 容忍改局部变量名，不容忍改字段名
    const m = route.match(/form\.get\(\s*'([^']+)'\s*\)[\s\S]{0,60}?instanceof\s+File/);
    expect(m, 'route.ts 里找不到 instanceof File 的表单字段读取').not.toBeNull();
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
