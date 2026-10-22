import { describe, expect, it } from 'vitest';
import { apply, equal, figure, MAX_PROGRAM, run, type Instruction } from '../../src/games/yiwen/engine';
import { EXPERIMENTS, INSCRIPTION, INSCRIPTION_INPUT, INSCRIPTION_TARGET } from '../../src/games/yiwen/levels';
import { freshProgress, readProgress } from '../../src/games/yiwen/progress';

const R: Instruction = { rune: 'turn', framed: false };
const D: Instruction = { rune: 'copy', framed: false };
const r: Instruction = { rune: 'turn', framed: true };
const d: Instruction = { rune: 'copy', framed: true };
const end = (input: ReturnType<typeof figure>, ops: Instruction[]) => run(input, ops).frames.at(-1)!;

describe('异文：同一操作在整体与格子两个范围内的含义', () => {
  it('旋转移动位置及朝向，保留非方形尺寸与空白', () => {
    const input = figure('^o.', '.><');
    expect(apply(input, R)).toEqual(figure('.>', 'vo', '^.'));
    expect(end(input, [R, R, R, R])).toEqual(input);
    expect(apply(input, r)).toEqual(figure('>o.', '.v^'));
    expect(input).toEqual(figure('^o.', '.><'));
  });
  it('旋转与复制不交换；能用同一套操作构造竖直且朝上的图案', () => {
    expect(end(figure('^'), [R, D])).toEqual(figure('>>'));
    expect(end(figure('^'), [D, R])).toEqual(figure('>', '>'));
    expect(end(figure('^'), [R, R, R, D, R])).toEqual(figure('^', '^'));
  });
  it('框分别作用到每格：复制的单位改变，空白格也占位置', () => {
    expect(apply(figure('^o', '>.') , D)).toEqual(figure('^o^o', '>.>.'));
    expect(apply(figure('^o', '>.'), d)).toEqual(figure('^^oo', '>>..'));
    expect(equal(figure('^.'), figure('^'))).toBe(false);
  });
  it('超出纸张或句子容量时停止，保留已经执行的轨迹', () => {
    const result = run(figure('^'), [D, D, D, D]);
    expect(result.frames).toHaveLength(4);
    expect(result.frames.at(-1)?.width).toBe(8);
    expect(result.error).toContain('8 × 8');
    expect(run(figure('^'), Array(MAX_PROGRAM + 1).fill(R)).error).not.toBeNull();
  });
  it('七个独立目标均可用实际语言到达，且不以默认底稿直接过关', () => {
    const programs = [[R], [D], [D, R], [R, R, R, D, R], [r], [d], [d, R, r, r, r]];
    EXPERIMENTS.forEach((level, index) => {
      expect(equal(level.input, level.target), level.id).toBe(false);
      const result = run(level.input, programs[index]);
      expect(result.error, level.id).toBeNull();
      expect(result.frames.at(-1), level.id).toEqual(level.target);
    });
  });
  it('铭牌直接解释刻痕，不依赖完成记录，正确图案包含空白', () => {
    expect(run(INSCRIPTION_INPUT, INSCRIPTION).error).toBeNull();
    expect(INSCRIPTION_TARGET).toEqual(figure('<o', '<o', '.v', '.v'));
    expect(freshProgress().completed).toEqual([]);
  });
});

describe('异文：本地存档边界', () => {
  it('保存不同实验的草稿和铭牌状态，不因换卡丢句子', () => {
    const progress = { ...freshProgress(), selected: 'plate', drafts: { '01': [R], plate: [R, d, R] }, completed: ['01'], opened: true };
    expect(readProgress(JSON.stringify(progress))).toEqual(progress);
  });
  it('损坏、旧版本、超长或未知指令均不会进入执行器', () => {
    expect(readProgress('{')).toEqual(freshProgress());
    expect(readProgress('{"version":2}')).toEqual(freshProgress());
    const result = readProgress(JSON.stringify({ version: 1, selected: 'unknown', opened: 'yes', completed: ['01', '01', 'unknown'],
      drafts: { '01': [{ rune: 'other', framed: false }], '02': Array(100).fill(R), '03': [D], plate: [{ rune: 'turn', framed: 'true' }] } }));
    expect(result.selected).toBe('01');
    expect(result.opened).toBe(false);
    expect(result.completed).toEqual(['01']);
    expect(result.drafts).toEqual({ '03': [D] });
  });
});
