import { describe, expect, it } from 'vitest';
import { parseReactiveFlags } from '@/lib/reactive/flags';
import { selectContentRenderer } from '@/lib/renderer-select';
import { parseContentFormat, resolveContentWriteFormat } from '@/lib/content-format';

const base = { id: 'article-a', kind: 'blog' as const, format: 'markdown', markdownCompatible: true };
const enabled = parseReactiveFlags({ REACTIVE_MD_MODE: 'on', REACTIVE_MD_PERCENT: '100' });

describe('format write gate', () => {
  it('preserves defaults, rejects unknown languages and keeps reactive writes closed', () => {
    expect(parseContentFormat('Markdown')).toBeNull();
    expect(resolveContentWriteFormat(undefined)).toEqual({ ok: true, format: 'markdown' });
    expect(resolveContentWriteFormat(null)).toEqual({ ok: false, reason: 'invalid_format' });
    expect(resolveContentWriteFormat(undefined, 'reactive')).toEqual({ ok: true, format: 'reactive' });
  });
});

describe('reactive renderer selection', () => {
  it('fails closed for malformed flags', () => {
    expect(parseReactiveFlags({ REACTIVE_MD_MODE: 'ON', REACTIVE_MD_PERCENT: '100' })).toEqual({ mode: 'off', percent: 100 });
    for (const value of ['-1', '101', '2.5', 'Infinity', '5x', '']) {
      expect(parseReactiveFlags({ REACTIVE_MD_PERCENT: value }).percent).toBe(0);
    }
  });
  it('lets the emergency switch and shadow override per-document configuration', () => {
    for (const mode of ['off', 'shadow'] as const) {
      expect(selectContentRenderer({ ...base, override: 'reactive', flags: { mode, percent: 100 } }))
        .toMatchObject({ renderer: 'legacy', reason: 'flag' });
    }
  });
  it('requires verified compatibility and falls back locally after compile failure', () => {
    expect(selectContentRenderer({ ...base, flags: enabled })).toMatchObject({ renderer: 'reactive' });
    expect(selectContentRenderer({ ...base, flags: enabled, markdownCompatible: false, override: 'reactive' }))
      .toMatchObject({ renderer: 'legacy', reason: 'fallback' });
    expect(selectContentRenderer({ ...base, flags: enabled, compilationFailed: true }))
      .toMatchObject({ renderer: 'legacy', reason: 'fallback' });
  });
  it('never sends reactive or unknown content to legacy and refuses stale snapshots', () => {
    const reactive = { ...base, format: 'reactive', flags: { mode: 'off' as const, percent: 100 }, contentVersion: 'v2' };
    expect(selectContentRenderer(reactive)).toMatchObject({ renderer: 'unavailable', reason: 'snapshot-missing' });
    expect(selectContentRenderer({ ...reactive, snapshotVersion: 'v1' })).toMatchObject({ renderer: 'unavailable' });
    expect(selectContentRenderer({ ...reactive, snapshotVersion: 'v2' })).toMatchObject({ renderer: 'reactive-static' });
    expect(selectContentRenderer({ ...reactive, flags: enabled, override: 'legacy', snapshotVersion: 'v2' }))
      .toMatchObject({ renderer: 'reactive-static', reason: 'invalid-override' });
    expect(selectContentRenderer({ ...base, format: 'other', flags: enabled })).toMatchObject({ renderer: 'unavailable' });
  });
  it('makes 0/100 percent boundaries explicit and honors a legacy override', () => {
    expect(selectContentRenderer({ ...base, flags: { mode: 'on', percent: 0 } })).toMatchObject({ renderer: 'legacy' });
    expect(selectContentRenderer({ ...base, flags: enabled })).toMatchObject({ renderer: 'reactive' });
    expect(selectContentRenderer({ ...base, flags: enabled, override: 'legacy' })).toMatchObject({ renderer: 'legacy' });
  });
});
