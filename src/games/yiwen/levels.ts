import { figure, run, type Figure, type Instruction } from './engine';

export interface Experiment {
  readonly id: string;
  readonly name: string;
  readonly input: Figure;
  readonly target: Figure;
  readonly hints: readonly [string, string];
}

// 目标独立手写，不用解法生成：改错规则时，不会连目标一起错得自洽。
// 七张卡分别观察方向、复制单位、顺序、参照方向、作用范围、分配与组合。
export const EXPERIMENTS: readonly Experiment[] = [
  { id: '01', name: '第一笔', input: figure('^'), target: figure('>'),
    hints: ['先放一枚符号，看看输出与底稿有什么不同。', '试试符号甲。可以反复运行，不会扣分。'] },
  { id: '02', name: '成双', input: figure('^o'), target: figure('^o^o'),
    hints: ['留意圆点和箭头的先后关系。', '先试一枚符号乙，观察它把什么看成一个整体。'] },
  { id: '03', name: '先后', input: figure('^'), target: figure('>', '>'),
    hints: ['同样两枚符号，换一下顺序会怎样？', '比较乙、甲与甲、乙。点执行轨迹可以查看中间结果。'] },
  { id: '04', name: '借一个方向', input: figure('^'), target: figure('^', '^'),
    hints: ['纸上图案的朝向和排列方向，可以分开考虑。', '让底稿先朝左，使用乙，再让整幅图转回来。'] },
  { id: '05', name: '框内', input: figure('^o', '.^'), target: figure('>o', '.>'),
    hints: ['这次圆点和空白的位置都没变。比较有框和无框的同一枚符号。', '框会让符号分别处理每一格。试试带框的甲。'] },
  { id: '06', name: '各自成双', input: figure('^o'), target: figure('^^oo'),
    hints: ['这里也是成双，但相同的图形挨在一起。', '把第五张卡对框的发现，用在乙上。'] },
  { id: '07', name: '合句', input: figure('^o'), target: figure('^', '^', 'o', 'o'),
    hints: ['先处理排列，再检查每个箭头的朝向。', '带框的乙让相同图形相邻；甲改变排列方向；带框的甲可以单独修正箭头。'] },
];

// 铭牌与实验台使用同一套语言。从开局即可求解，不检查通关数或「已学会」标记。
export const INSCRIPTION_INPUT = figure('^.', 'o>');
export const INSCRIPTION: readonly Instruction[] = [
  { rune: 'turn', framed: false },
  { rune: 'copy', framed: true },
  { rune: 'turn', framed: false },
];
export const INSCRIPTION_TARGET = run(INSCRIPTION_INPUT, INSCRIPTION).frames.at(-1)!;
