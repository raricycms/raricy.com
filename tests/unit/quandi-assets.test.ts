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
    expect([...used].filter((name) => !defined.has(name) && !semantic.has(name))).toEqual([]);
    for (const file of scripts) expect(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file })).not.toThrow();
  });
});
