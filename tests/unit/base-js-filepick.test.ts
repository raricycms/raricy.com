// @vitest-environment jsdom
//
// public/static/js/core/base.js —— 文件选择器的运行时增强。
//
// 【回归测试】收藏夹的「选择文件」按钮一直顶着浏览器默认样式，两个原因各占一半：
//   1. `.filepick` 一族的 CSS 在 SCSS 拆分时丢了（那条另有 tests/unit/css-js-classes.test.ts 守）
//   2. enhanceFileInputs 只在 initSiteChrome 里跑一次，而 Next 的 <Link> 跳转
//      **不重新加载文档** —— 工具页与「我的收藏夹」的入口都在工具箱，所以从常规入口
//      进去时那颗 input 是 init 之后才挂上的，包装根本没生成。实测：整页刷新时
//      hasFilepick = true，客户端跳转 = false。
// 本文件钉住的是第 2 条（第 1 条由上面那个测试守）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BASE_JS = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../public/static/js/core/base.js'),
  'utf-8'
);

function runBaseJs() {
  new Function(BASE_JS)();
}

/** 等 MutationObserver 的微任务投递 + 一次调度（rAF 或 setTimeout 兜底）跑完。 */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as any).fetch = () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, count: 0 }) });
  vi.restoreAllMocks();
});

describe('文件选择器：init 时就存在的 input', () => {
  it('被包装成 .filepick，且 label/文件名/清除钮齐备', () => {
    document.body.innerHTML = '<div class="tool-panel"><input id="fileInput" type="file"></div>';
    runBaseJs();

    const wrap = document.querySelector('.filepick')!;
    const input = wrap.querySelector('input[type="file"]') as HTMLInputElement;
    const label = wrap.querySelector('.filepick__btn') as HTMLLabelElement;
    const clear = wrap.querySelector('.filepick__clear') as HTMLElement;

    expect(wrap, '没有生成 .filepick 包装').toBeTruthy();
    expect(input.id, '原有 id 必须保留 —— 页面自己的 getElementById 还要用').toBe('fileInput');
    expect(label.textContent).toBe('选择文件');
    expect(label.getAttribute('for'), 'label 靠 for 转发点击，指错就点不开文件框').toBe('fileInput');
    expect(wrap.querySelector('.filepick__name')!.textContent).toBe('未选择文件');
    // 清除钮的显隐由 CSS 按 .filepick--has 决定（jsdom 不加载样式表，这里只断言那个开关）：
    // 没选文件时不该有 --has
    expect(wrap.classList.contains('filepick--has')).toBe(false);
    expect(clear.tagName).toBe('BUTTON');
  });

  it('选中文件后：文件名换成真实名字，并挂上 .filepick--has（清除钮据此显形）', () => {
    document.body.innerHTML = '<input id="f" type="file">';
    runBaseJs();
    const input = document.getElementById('f') as HTMLInputElement;
    const wrap = document.querySelector('.filepick')!;

    // jsdom 里给 input.files 赋值要用 DataTransfer 那套；直接派发 change 不够，
    // 故绕开真实文件，改用 Object.defineProperty 顶一个 files 上去。
    const fake = { length: 1, 0: { name: '收藏夹.json' } };
    Object.defineProperty(input, 'files', { value: fake, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(wrap.querySelector('.filepick__name')!.textContent).toBe('收藏夹.json');
    expect(wrap.classList.contains('filepick--has')).toBe(true);
    expect(wrap.querySelector('.filepick__name')!.classList.contains('filepick__name--has')).toBe(true);
  });

  it('已有 hidden 属性的 input 不接管（图床拖拽区 / 讨论输入区自带 UI）', () => {
    document.body.innerHTML = '<input type="file" hidden>';
    runBaseJs();
    expect(document.querySelector('.filepick')).toBeNull();
  });

  it('display:none 的 input 不接管', () => {
    document.body.innerHTML = '<input type="file" style="display: none">';
    runBaseJs();
    expect(document.querySelector('.filepick')).toBeNull();
  });
});

describe('文件选择器：客户端路由跳转后才挂上的 input', () => {
  it('✅ init 之后再插入的 input 也会被增强 —— 这是「从工具箱点进来」的那条路', async () => {
    document.body.innerHTML = '<main></main>';
    runBaseJs();
    expect(document.querySelector('.filepick'), 'init 时没有 input，不该凭空包装').toBeNull();

    // 模拟 Next <Link> 跳转：文档不重载，只是 React 把新页面挂上来
    const host = document.querySelector('main')!;
    host.innerHTML = '<div class="favorite-picker__new"><input type="file" class="favorite-picker__input"></div>';
    await settle();

    expect(
      document.querySelector('.filepick'),
      '客户端跳转后插入的 input 没有被增强 —— 用户会看到浏览器原生的「选择文件」'
    ).toBeTruthy();
  });

  it('批量插入（一次 addNodes 里带多个）只包一次，不重复包装', async () => {
    document.body.innerHTML = '<main></main>';
    runBaseJs();
    document.querySelector('main')!.innerHTML = '<input type="file"><input type="file">';
    await settle();

    const wraps = document.querySelectorAll('.filepick');
    expect(wraps.length).toBe(2);
    for (const w of Array.from(wraps)) expect(w.querySelectorAll('input[type="file"]').length).toBe(1);
  });
});

describe('重复执行 base.js（HMR / 测试反复执行）', () => {
  it('上一轮的观察器被断开，不累积', () => {
    const Real = window.MutationObserver;
    const created: Array<{ disconnected: boolean }> = [];
    class Tracked extends Real {
      disconnected = false;
      constructor(cb: MutationCallback) {
        super(cb);
        created.push(this as unknown as { disconnected: boolean });
      }
      disconnect() {
        this.disconnected = true;
        super.disconnect();
      }
    }
    (window as any).MutationObserver = Tracked;
    try {
      document.body.innerHTML = '<main></main>';
      runBaseJs();
      expect(created.length).toBe(1);

      runBaseJs();
      expect(created.length).toBe(2);
      expect(created[0].disconnected, '重入时上一轮观察器没断开 —— 会随每次重跑累积').toBe(true);
      expect(created[1].disconnected).toBe(false);
    } finally {
      (window as any).MutationObserver = Real;
    }
  });
});
