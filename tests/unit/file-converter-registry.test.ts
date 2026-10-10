// file-converter/registry.ts —— 能力登记表的校验与运行时过滤。
//
// 【这组用例钉的是什么】roadmap §12.1 的两条铁律：
//   · 「不存在的边不靠改后缀补上」—— registryProblems 是登记册的静态体检；
//   · 「未验收的方向不出现在可执行菜单」—— edgeAvailable 的逐条判据，
//     尤其是 **FFmpeg 能力未探测前按可满足处理**（否则菜单要等 31MB wasm
//     下载完才出现，那是「先下载再决定能干什么」的本末倒置）。

import { describe, it, expect } from 'vitest';
import { registryProblems, edgeAvailable, availableEdges, edgeById } from '@/lib/file-converter/registry';
import { CATEGORIES } from '@/lib/file-converter/categories';
import type { CapabilityReport, CategoryDef, EdgeDef, InspectInfo } from '@/lib/file-converter/types';

const CAPS_NONE: CapabilityReport = {
  webpEncode: false,
  avifEncode: false,
  avifDecode: false,
  workerOk: true,
  ffmpeg: null, // 未探测
};

const CAPS_FFMPEG_OK: CapabilityReport = {
  ...CAPS_NONE,
  webpEncode: true,
  ffmpeg: { loaded: true, encoders: ['libmp3lame'], decoders: ['aac'] },
};

function edge(partial: Partial<EdgeDef> & Pick<EdgeDef, 'id'>): EdgeDef {
  return {
    label: 'L',
    from: ['png'],
    to: 'jpeg',
    method: 'reencode',
    notices: [],
    params: [],
    run: async () => {
      throw new Error('测试夹具，不应被调用');
    },
    status: 'live',
    ...partial,
  };
}

function category(key: CategoryDef['key'], edges: EdgeDef[]): CategoryDef {
  return { key, label: key, hint: '', accept: '', maxFilesPerTask: 1, edges };
}

const INFO_PNG: InspectInfo = {
  sniff: { kind: 'png', mime: 'image/png', ext: 'png' },
  name: 'a.png',
  size: 1,
};

describe('registryProblems（静态体检）', () => {
  it('合法登记册无问题', () => {
    expect(registryProblems([category('image', [edge({ id: 'image:to-jpg' })])])).toEqual([]);
  });

  it('重复 id / 前缀错 / 缺 label / from 为空 逐条报出', () => {
    const problems = registryProblems([
      category('image', [
        edge({ id: 'image:a' }),
        edge({ id: 'image:a' }),
        edge({ id: 'audio:wrong-prefix' }),
        edge({ id: 'image:b', label: '' }),
        edge({ id: 'image:c', from: [] }),
      ]),
    ]);
    expect(problems.join('\n')).toContain('重复的边 id：image:a');
    expect(problems.join('\n')).toContain('前缀');
    expect(problems.join('\n')).toContain('缺 label');
    expect(problems.join('\n')).toContain('from 为空');
  });

  it('document 类别免前缀（pdf: / office: 混合），其它类别不免', () => {
    expect(
      registryProblems([category('document', [edge({ id: 'pdf:a' }), edge({ id: 'office:b' })])])
    ).toEqual([]);
  });

  it('planned 不应有 run；live 缺 run 报错', () => {
    const problems = registryProblems([
      category('image', [
        edge({ id: 'image:planned-with-run', status: 'planned' }),
        {
          ...edge({ id: 'image:live-no-run' }),
          run: undefined as unknown as EdgeDef['run'],
        },
      ]),
    ]);
    expect(problems.join('\n')).toContain('planned 状态不应实现 run');
    expect(problems.join('\n')).toContain('缺 run 实现');
  });

  it('参数校验：重复 key / select 缺 options / range 缺 min-max', () => {
    const problems = registryProblems([
      category('image', [
        edge({
          id: 'image:p',
          params: [
            { key: 'a', label: 'a', type: 'select', defaultValue: 'x' },
            { key: 'a', label: 'a2', type: 'select', defaultValue: 'x', options: [] },
            { key: 'r', label: 'r', type: 'range', defaultValue: 1 },
          ],
        }),
      ]),
    ]);
    expect(problems.join('\n')).toContain('重复参数 a');
    expect(problems.join('\n')).toContain('缺 options');
    expect(problems.join('\n')).toContain('缺 min/max');
  });

  it('当前登记册（骨架期）自身无问题 —— 各能力区交付后这条继续钉住', () => {
    expect(registryProblems(CATEGORIES)).toEqual([]);
  });
});

describe('edgeAvailable（运行时过滤）', () => {
  it('planned 一律不可用', () => {
    expect(edgeAvailable(edge({ id: 'x', status: 'planned' }), CAPS_FFMPEG_OK)).toBe(false);
  });

  it('FFmpeg 未探测（caps.ffmpeg === null）时按可满足处理', () => {
    const e = edge({ id: 'x', requires: ['ffmpeg', 'ffmpeg-enc:libmp3lame'] });
    expect(edgeAvailable(e, CAPS_NONE)).toBe(true);
  });

  it('FFmpeg 加载失败 → 依赖它的边全部不可用', () => {
    const caps: CapabilityReport = {
      ...CAPS_NONE,
      ffmpeg: { loaded: false, encoders: [], decoders: [], error: 'wasm 加载失败' },
    };
    expect(edgeAvailable(edge({ id: 'x', requires: ['ffmpeg'] }), caps)).toBe(false);
  });

  it('编码器白名单逐条核对', () => {
    const e = edge({ id: 'x', requires: ['ffmpeg-enc:libmp3lame'] });
    expect(edgeAvailable(e, CAPS_FFMPEG_OK)).toBe(true);
    expect(edgeAvailable(edge({ id: 'x', requires: ['ffmpeg-enc:libx264'] }), CAPS_FFMPEG_OK)).toBe(false);
    expect(edgeAvailable(edge({ id: 'x', requires: ['ffmpeg-dec:aac'] }), CAPS_FFMPEG_OK)).toBe(true);
  });

  it('浏览器能力闸（webp-encode / avif-* / worker）不满足即不可用', () => {
    expect(edgeAvailable(edge({ id: 'x', requires: ['webp-encode'] }), CAPS_NONE)).toBe(false);
    expect(edgeAvailable(edge({ id: 'x', requires: ['webp-encode'] }), CAPS_FFMPEG_OK)).toBe(true);
    expect(edgeAvailable(edge({ id: 'x', requires: ['worker'] }), { ...CAPS_NONE, workerOk: false })).toBe(false);
  });
});

describe('availableEdges / edgeById', () => {
  it('按 sniff kind 过滤 + match 追加判据', () => {
    const cat = category('image', [
      edge({ id: 'image:a', from: ['png', 'jpeg'] }),
      edge({ id: 'image:b', from: ['gif'] }),
      edge({ id: 'image:c', from: ['png'], match: (i) => i.animated === true }),
    ]);
    const ids = availableEdges(cat, INFO_PNG, CAPS_FFMPEG_OK).map((e) => e.id);
    expect(ids).toEqual(['image:a']);
  });

  it('edgeById 跨类别查找，找不到返回 null', () => {
    const cats = [category('image', [edge({ id: 'image:a' })]), category('audio', [edge({ id: 'audio:b' })])];
    expect(edgeById(cats, 'audio:b')?.id).toBe('audio:b');
    expect(edgeById(cats, 'video:nope')).toBeNull();
  });
});
