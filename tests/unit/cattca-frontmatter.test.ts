// ─────────────────────────────────────────────────────────────────────────────
// cattca-frontmatter.test.ts —— 阅读器加载层：BOM / YAML frontmatter 剥离。
// 引擎不认 frontmatter（会当正文渲染），所以这一步必须在 load() 之前做。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { stripFrontmatter } from '@/app/components/cattca/frontmatter';

describe('stripFrontmatter', () => {
  it('剥离无 frontmatter 的文本原样返回', () => {
    expect(stripFrontmatter('你好。')).toBe('你好。');
  });

  it('剥离 BOM', () => {
    expect(stripFrontmatter('\uFEFF你好。')).toBe('你好。');
  });

  it('剥离标准 frontmatter', () => {
    const source = '---\ntitle: 测试\nauthor: 阿零\n---\n你好。';
    expect(stripFrontmatter(source)).toBe('你好。');
  });

  it('支持 CRLF 与结尾空格', () => {
    const source = '---\r\ntitle: 测试\r\n---  \r\n你好。';
    expect(stripFrontmatter(source)).toBe('你好。');
  });

  it('开口行带行尾空白也剥离（与 src/lib/story-service.ts 的 parseFrontmatter 同一条正则）', () => {
    // 手写的 .cattca 里 `--- ` 后面留一个空格很常见：故事页会剥、阅读器却把头部
    // 当正文渲染，同一份文件两套标准且不报错（R3-517）。
    for (const opening of ['--- ', '---\t', '---  \t ']) {
      const source = `${opening}\ntitle: 测试\n---\n你好。`;
      expect(stripFrontmatter(source), JSON.stringify(opening)).toBe('你好。');
    }
  });

  it('只有开头 --- 没有闭合时不剥离', () => {
    const source = '---\n不是 frontmatter 的正文';
    expect(stripFrontmatter(source)).toBe(source);
  });

  it('正文里的分隔线不受影响', () => {
    const source = '第一段\n\n---\n\n第二段';
    expect(stripFrontmatter(source)).toBe(source);
  });
});
