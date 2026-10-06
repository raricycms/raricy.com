import { describe, expect, it } from 'vitest';
import { activeMention, extractMentions } from '@/lib/mention-shared';

describe('@ 输入提示的光标与语法边界', () => {
  it('裸 @、中文名字、换行后 @ 都能开始搜索', () => {
    expect(activeMention('@', 1)).toEqual({ query: '', start: 0, end: 1 });
    expect(activeMention('你好\n@张三', 6)).toEqual({ query: '张三', start: 3, end: 6 });
  });
  it('在用户名中间只替换这一整个 token，保留后面的正文', () => {
    expect(activeMention('前文 @bobby 后文', 6)).toEqual({ query: 'bo', start: 3, end: 9 });
  });
  it('不抢邮件、引用 token、标点、过长名字或选区的输入', () => {
    for (const text of ['a@bob', '[@用户/bob]', '[@bob/表情]', '@bob，', `@${'a'.repeat(21)}`]) {
      expect(activeMention(text, text.length), text).toBeNull();
    }
    expect(activeMention('@bob', 3, 4)).toBeNull();
  });
  it('通知解析维持空白 / 行尾边界，引用不发通知', () => {
    expect(extractMentions('@bob @bobby @bob [@用户/bob] [@bob/表情] @bob，')).toEqual(['bob', 'bobby']);
  });
});
