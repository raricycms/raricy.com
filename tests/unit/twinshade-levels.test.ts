// 关卡表（src/games/twinshade/levels.ts）的体检。
//
// 这不是「跑一遍编译」，而是替作者做那件人工试玩很容易漏的事：
//   · 形状错误（行宽 / 缺 A、B / 灯少于两盏）在 compileLevel 当场炸；
//   · **无解**是最隐蔽的一种 —— ASCII 完全合法，点进去却怎么走都通不了；
//   · **par 与 solver 的最优步数不一致**更隐蔽 —— 关卡能通，但三星线永远拿不到
//     （par 写小了）或形同虚设（par 写大了），而页面上一切正常。
//
// 失败信息必须可行动：带关卡 id + 关名 + 期望 / 实际，无解时给出最常见的原因
// （两盏灯的相对位置必须与出生点一致 —— 不用冰面的关卡里两个身体相对位移恒定）。
// 同一份判据在 scripts/twinshade-levels.ts 里跑（作者对账用），两处口径必须一致。

import { describe, expect, it } from 'vitest';
import { compileLevel, initialState, resolveMove } from '../../src/games/twinshade/engine';
import { LEVELS } from '../../src/games/twinshade/levels';
import { analyzeLevel } from '../../src/games/twinshade/solver';

/** 棋盘尺寸预算：再大手机上每一格就小到看不清了。 */
const MAX_WIDTH = 11;
const MAX_HEIGHT = 9;

/**
 * 无解时最可能的原因。solver 报「无解」只说明 BFS 没找到路，不说明为什么；
 * 作者需要的是这句几何约束，否则只能一格一格试。
 */
const GEOMETRY_HINT =
  '九成是几何问题：不用冰面的关卡里，两个身体每一步同向、同位移，相对位置恒定，' +
  '所以**两盏灯的相对位置必须与两侧出生点完全一致**（顺序可交换）。' +
  '若这一关用了冰面，则要确认滑行真能把两侧的距离差拉开、且路线没被石头堵死。';

const where = (def: { id: string; name: string }) => `关卡 ${def.id}（${def.name}）`;

/** 关卡 ASCII 里的石头字符：a–z 里除了 o（灯）的字母，加上 1–9（同纹组的编号）。 */
const STONE = /[a-np-z1-9]/;

// 逐关一条用例（而不是「一个 it 循环全部」）：失败时测试报告直接指到哪一关，
// 不用从一行汇总里翻。
for (const def of LEVELS) {
  describe(where(def), () => {
    it('ASCII 形状合法：每行等长、尺寸在预算内、hint 非空、act 在 1..3', () => {
      const name = where(def);

      // 先手查一遍行宽：compileLevel 也会拒，但这里的报错能直接指出「第几行」。
      const width = def.rows[0]?.length ?? 0;
      def.rows.forEach((row, index) => {
        expect(
          row.length,
          `${name}：第 ${index + 1} 行长度是 ${row.length}，与首行的 ${width} 不一致（多 / 少了一个字符？）`,
        ).toBe(width);
      });

      // 编译本身：所有形状错误都在这里抛，错误信息自带关卡 id。
      const level = compileLevel(def);

      expect(
        level.width,
        `${name}：宽度是 ${level.width}，超过上限 ${MAX_WIDTH}（手机上一格会小到点不准）`,
      ).toBeLessThanOrEqual(MAX_WIDTH);
      expect(
        level.height,
        `${name}：高度是 ${level.height}，超过上限 ${MAX_HEIGHT}（手机上一格会小到点不准）`,
      ).toBeLessThanOrEqual(MAX_HEIGHT);

      expect(def.act, `${name}：act 是 ${def.act}，必须在 1..3 之间（关卡选择按它分章）`)
        .toBeGreaterThanOrEqual(1);
      expect(def.act, `${name}：act 是 ${def.act}，必须在 1..3 之间（关卡选择按它分章）`)
        .toBeLessThanOrEqual(3);

      expect(
        def.hint.trim().length,
        `${name}：hint 是空的 —— 「提示」按钮会弹出一片空白，而且不报错`,
      ).toBeGreaterThan(0);
      expect(def.name.trim().length, `${name}：name 是空的 —— HUD 与关卡选择里会显示成空白`).toBeGreaterThan(0);

      // compileLevel 已经拦过「灯少于两盏」，这里留一条显式断言：它是通关判定的地基。
      expect(
        level.goals.size,
        `${name}：只有 ${level.goals.size} 盏灯。少于两盏时「两个身体各站一盏」永远不成立`,
      ).toBeGreaterThanOrEqual(2);
    });

    it('analyzeLevel 能通、未 truncated，par 等于 solver 算出的最优步数', () => {
      const name = where(def);
      const level = compileLevel(def);
      const result = analyzeLevel(level);

      // truncated 与「无解」是两件事：撞上限时 solved:false 不代表关卡有问题，
      // 但那说明这一关的搜索空间已经大到不能在关卡表里活着了。
      expect(
        result.truncated,
        `${name}：BFS 撞上节点上限（visited=${result.visited}）。这不是无解，是棋面 / 状态空间太大，` +
          '请缩小关卡或降低石头数量。',
      ).toBe(false);

      expect(
        result.solved,
        `${name}：solver 判定无解（visited=${result.visited}，最优步数=${result.optimal ?? '—'}）。${GEOMETRY_HINT}`,
      ).toBe(true);

      expect(
        def.par,
        `${name}：par 写的是 ${def.par}，但 solver 算出的最优步数是 ${result.optimal}。` +
          (result.optimal !== null && result.optimal > def.par
            ? 'par 写小了 —— 把关卡能做到的最短步数当成了「作者最好成绩」，三星线永远拿不到。'
            : 'par 写大了 —— 多走几步也能三星，星级失去区分度。') +
          ' par 必须等于 solver 的最优步数。',
      ).toBe(result.optimal);

      // 再走一遍 solver 给的路径：确认「最优步数」不是另一套判定算出来的。
      // 若 engine 与 solver 判定漂移，par 会是一个两边都同意、但没人真能走到的数。
      let state = initialState(level);
      let solved = false;
      for (const dir of result.moves ?? []) {
        const outcome = resolveMove(level, state, dir);
        expect(
          outcome.ok,
          `${name}：solver 给的最优路径里「${dir}」这一步在 engine 里走不动 —— 两套判定已经不一致（先查 engine.ts 的判定顺序）。`,
        ).toBe(true);
        if (!outcome.ok) break;
        state = outcome.state;
        solved = outcome.solved;
      }
      expect(
        solved,
        `${name}：按 solver 给的 ${result.moves?.length ?? 0} 步走完并没有通关 —— par 与真实最优解不一致。`,
      ).toBe(true);
      expect(state.moves, `${name}：路径步数 ${state.moves} 与 par ${def.par} 不一致。`).toBe(def.par);
    });

    // 「石头必须是工具」这条纪律被玩家打回过两次，所以落成断言：
    //   · 删掉石头能过 ⇒ 石头只是减速带；
    //   · 把石头冻成墙能过 ⇒ 这块石头从头到尾没被推过（贴墙当装饰）。
    // 两种改法各求一次最短解，都必须「无解」或「比原 par 更长」。
    const stoneCount = def.rows.join('').split('').filter((ch) => STONE.test(ch)).length;
    if (stoneCount > 0) {
      it('石头是工具：删掉石头、或把石头冻成墙之后，都必须无解或更长', () => {
        const name = where(def);
        const variants: [string, string][] = [
          ['.', '删掉石头（换成地板）'],
          ['#', '把石头冻成墙（推不动）'],
        ];
        for (const [filler, what] of variants) {
          const rows = def.rows.map((row) => row.replace(new RegExp(STONE, 'g'), filler));
          // 换成墙以后可能把出生点 / 灯围死，compileLevel 直接抛 —— 那就是「无解」。
          let probe;
          try {
            probe = compileLevel({ ...def, rows });
          } catch {
            continue;
          }
          const result = analyzeLevel(probe);
          const stillSolvable = result.solved && (result.optimal as number) <= def.par;
          expect(
            stillSolvable,
            `${name}：${what}之后仍然 ${result.optimal} 步可通（par 是 ${def.par}）—— ` +
              '这一关的石头没有参与解法。' +
              (filler === '#'
                ? '石头贴着墙、推都推不了是最常见的成因：重新摆石头，让至少一块必须被推动。'
                : '石头只是挡路，玩家绕开就行：让它成为刹车、门栓或必须挪开的障碍。'),
          ).toBe(false);
        }
      });
    }
  });
}

describe('关卡表整体', () => {
  it('关卡 id 唯一（id 是进度存档的键，重复 = 两关共用一份成绩）', () => {
    const ids = LEVELS.map((def) => def.id);
    const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    expect(
      duplicated,
      `关卡 id 有重复：${duplicated.join('、')}。` +
        'id 是 localStorage 里 best 表的键，两关同 id 会让它们的成绩互相覆盖，而且不报错。',
    ).toEqual([]);
  });

  it('关卡顺序按章节递增（关卡选择按出现顺序分组）', () => {
    const acts = LEVELS.map((def) => def.act);
    expect(
      acts,
      `关卡表里 act 的顺序不是递增的：${acts.join(',')}。` +
        'LevelSelect 按「出现顺序」分组（不是按 act 排序），乱序会让同一章被拆成两个小节。',
    ).toEqual([...acts].sort((left, right) => left - right));
  });
});
