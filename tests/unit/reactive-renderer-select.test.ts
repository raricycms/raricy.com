import { describe, expect, it } from 'vitest';
import { parseReactiveFlags } from '@/lib/reactive/flags';
import { selectContentRenderer } from '@/lib/renderer-select';
import { parseContentFormat, resolveContentWriteFormat } from '@/lib/content-format';

const base = { format: 'markdown' };
const enabled = parseReactiveFlags({});
const emergency = parseReactiveFlags({ REACTIVE_MD_MODE: 'off' });

describe('format write gate', () => {
  it('preserves defaults, rejects unknown languages and keeps reactive writes open', () => {
    expect(parseContentFormat('Markdown')).toBeNull();
    expect(resolveContentWriteFormat(undefined)).toEqual({ ok: true, format: 'markdown' });
    expect(resolveContentWriteFormat(null)).toEqual({ ok: false, reason: 'invalid_format' });
    expect(resolveContentWriteFormat(undefined, 'reactive')).toEqual({ ok: true, format: 'reactive' });
  });
});

describe('reactive renderer selection（统一后）', () => {
  it('默认启用：未设置环境变量也是统一管线', () => {
    expect(parseReactiveFlags({})).toEqual({ mode: 'on', percent: 100 });
    expect(parseReactiveFlags({ REACTIVE_MD_MODE: 'on' })).toEqual({ mode: 'on', percent: 100 });
    // shadow 不再做影子编译，等同启用；只有显式 off 是回退。
    expect(parseReactiveFlags({ REACTIVE_MD_MODE: 'shadow' }).mode).toBe('shadow');
    expect(parseReactiveFlags({ REACTIVE_MD_MODE: 'off' }).mode).toBe('off');
    // percent 仅保留环境变量兼容，不再参与选择。
    expect(parseReactiveFlags({ REACTIVE_MD_PERCENT: '0' }).percent).toBe(0);
  });

  it('默认：Markdown 与 Reactive 都走 reactive，不再看 percent', () => {
    expect(selectContentRenderer({ ...base, flags: enabled })).toEqual({ renderer: 'reactive', reason: 'format' });
    expect(selectContentRenderer({ ...base, flags: { mode: 'on', percent: 0 } }))
      .toEqual({ renderer: 'reactive', reason: 'format' });
  });

  it('事故回退：Markdown → legacy；Reactive → static；未知格式仍 unavailable', () => {
    expect(selectContentRenderer({ ...base, flags: emergency })).toEqual({ renderer: 'legacy', reason: 'flag' });
    expect(selectContentRenderer({ ...base, format: 'reactive', flags: emergency }))
      .toEqual({ renderer: 'reactive-static', reason: 'flag' });
    expect(selectContentRenderer({ ...base, format: 'other', flags: enabled }))
      .toEqual({ renderer: 'unavailable', reason: 'invalid-format' });
  });

  it('编译失败 → unavailable（不按格式猜，也不交给旧解析器，off 下也一样）', () => {
    expect(selectContentRenderer({ ...base, flags: enabled, compilationFailed: true }))
      .toEqual({ renderer: 'unavailable', reason: 'fallback' });
    expect(selectContentRenderer({ ...base, flags: emergency, compilationFailed: true }))
      .toEqual({ renderer: 'unavailable', reason: 'fallback' });
  });
});
