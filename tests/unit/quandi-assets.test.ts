import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const document = fs.readFileSync(path.join(root, 'src/games/quandi/document.html'), 'utf8');
const assetRoot = path.join(root, 'public/static/quandi');
function walk(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
}

describe('圈地运动固定资源', () => {
  it('文档只加载已入库的本站资源，不含第三方 CDN 或公开 HTML 副本', () => {
    const urls = [...document.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(15);
    for (const url of urls) {
      expect(url.startsWith('/static/quandi/')).toBe(true);
      expect(fs.existsSync(path.join(root, 'public', url))).toBe(true);
    }
    expect(walk(assetRoot).some((file) => file.endsWith('.html'))).toBe(false);
    expect(fs.readFileSync(path.join(assetRoot, 'NOTICE.txt'), 'utf8')).toContain('b1050bd177fa9764afd039f2ec6e68af55137436');
  });

  it('隔离文档的 HTML/脚本类名都由自己的样式定义，不借用父页 CSS', () => {
    const cssRoot = path.join(assetRoot, 'css');
    const styles = new Map<string, string>();
    function load(file: string) {
      if (styles.has(file)) return;
      const text = fs.readFileSync(file, 'utf8'); styles.set(file, text);
      for (const match of text.matchAll(/@import url\('([^']+)'\)/g)) load(path.resolve(path.dirname(file), match[1]));
    }
    load(path.join(cssRoot, 'main.css'));
    const css = [...styles.values()].join('\n');
    const defined = new Set([...css.matchAll(/\.([\w-]+)/g)].map((match) => match[1]));
    const scripts = walk(path.join(assetRoot, 'js')).filter((file) => file.endsWith('.js'));
    const texts = [document, ...scripts.map((file) => fs.readFileSync(file, 'utf8'))];
    const used = new Set<string>();
    for (const text of texts) {
      for (const pattern of [/class="([^"]+)"/g, /className\s*=\s*['"]([^'"]+)['"]/g]) {
        for (const match of text.matchAll(pattern)) for (const name of match[1].split(/\s+/)) if (/^[\w-]+$/.test(name)) used.add(name);
      }
    }
    // 两个类只做已声明的外观组合/布局包装，子项各自定义样式。
    const semantic = new Set(['difficulty-selection', 'gamemode-selection']);
    // 自检：扫描真的产出了内容（CSS 解析或类名提取写废时，下面那条会空过）。
    expect(defined.size, '样式表里应当解析出大量类名').toBeGreaterThan(50);
    expect(used.size, '文档/脚本里应当提取出大量类名').toBeGreaterThan(10);
    // 允许表不是摆设：这 2 个类必须真的被使用，否则应从允许表删掉（R3-549）。
    for (const name of semantic) {
      expect(used.has(name), `允许表里的 ${name} 没有被任何文档/脚本使用，应删掉这条豁免`).toBe(true);
    }
    expect([...used].filter((name) => !defined.has(name) && !semantic.has(name))).toEqual([]);
    for (const file of scripts) expect(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file })).not.toThrow();
  });

  it('精灵图清单里的 12 条路径都真实存在且是 PNG（素材漏拷/改名不再静默降级）', () => {
    // R3-606：ImageLoader 的所有消费点都有「加载失败 → 程序化绘制」回退，所以素材
    // 缺失时游戏照常可玩、页面不报错。这里把 12 条路径钉成存在性断言。
    const loader = fs.readFileSync(path.join(assetRoot, 'js/core/ImageLoader.js'), 'utf8');
    const paths = [...loader.matchAll(/'(\/static\/quandi\/image\/[^']+\.png)'/g)].map((m) => m[1]);
    expect(paths.length, 'ImageLoader 的精灵图清单应为 12 条').toBe(12);
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const rel of paths) {
      const file = path.join(root, 'public', rel);
      expect(fs.existsSync(file), `缺少精灵图 ${rel}（ImageLoader 会静默回退，页面看不出来）`).toBe(true);
      expect(fs.readFileSync(file).subarray(0, 8).equals(pngSig), `${rel} 的内容不是 PNG`).toBe(true);
    }
  });
});
