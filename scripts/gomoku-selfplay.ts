// ─────────────────────────────────────────────────────────────────────────────
// gomoku-selfplay.ts —— 五子棋 AI 对局对比工具。
//
// 【为什么不进 `npm test`】跑得慢（几十秒到几十分钟），而且它的价值是「改引擎时
// 手工对比一次」，不是每次提交都要验的回归网。日常的正确性由
// tests/unit/gomoku-ai.test.ts 的战术题库与不变量负责。
//
// 用法：
//   npx tsx scripts/gomoku-selfplay.ts                        # 普通 vs 困难，各 2 万节点
//   npx tsx scripts/gomoku-selfplay.ts normal:1000t hard:3000t # 自己指定预算
//   npx tsx scripts/gomoku-selfplay.ts normal:1000t hard:3000t 30
//
// 配置写法：`<难度>:<预算>`，难度只能是 easy / normal / hard，预算以 `n` 结尾是
// 节点数、以 `t` 结尾是毫秒。节点预算是确定性的（同样的参数跑两次结果完全一致），
// 墙钟不是。非法难度**直接抛错退出**，不会静默测成别的东西。
//
// 【为什么必须用一批「胜负各半」的开局 —— 这是本文件存在的理由】
// 直接拿胜负 A/B 同源引擎的两个版本是**测不出棋力的**。双方同源时棋局结果由
// **开局**决定：一个开局要么黑必胜要么白必胜，两色各下一遍必然 1:1。
// 实测：同引擎自对弈黑 100% 全胜；把黑第一手扔到 (2,2)、白占天元，黑照样全胜；
// 甚至白方拿 10 秒对 600ms 的黑也守不住 —— 那些局面开局就定了，加深度救不回来。
//
// 所以下面这张开局表刻意混了**黑白各半**的局面。只有在「本有悬念」的开局上，
// 强的一方才能把本该输的那一半也赢下来，比分才会离开 50%。
// ─────────────────────────────────────────────────────────────────────────────

import { BLACK, GomokuBoard, WHITE, type Player } from '../src/lib/gomoku-rules';
import { findBestMove, type AiOptions, type Difficulty } from '../src/lib/gomoku-ai';

interface Opening {
  name: string;
  stones: Array<[number, number, Player]>;
  toMove: Player;
}

const B = BLACK;
const W = WHITE;

/** 手工挑的开局：实测在同等棋力下黑白各有胜负。 */
const HANDMADE: Opening[] = [
  { name: '斜-白优', stones: [[7, 7, B], [7, 8, W], [8, 8, B]], toMove: W },
  { name: '直-白优', stones: [[7, 7, B], [8, 8, W], [7, 8, B]], toMove: W },
  { name: '跳-均', stones: [[7, 7, B], [6, 6, W], [8, 8, B]], toMove: W },
  { name: '远-均', stones: [[7, 7, B], [9, 9, W], [6, 6, B]], toMove: W },
  { name: '黑连-黑优', stones: [[7, 7, B], [7, 8, W], [7, 6, B]], toMove: W },
  { name: '黑斜连-黑优', stones: [[7, 7, B], [8, 8, W], [6, 6, B]], toMove: W },
  { name: '白多子1', stones: [[7, 7, B], [7, 8, W], [8, 7, W]], toMove: B },
  { name: '白多子2', stones: [[7, 7, B], [6, 6, W], [8, 8, W]], toMove: B },
  { name: '黑多子1', stones: [[7, 7, B], [7, 8, W], [8, 8, B], [8, 7, B]], toMove: W },
  { name: '黑多子2', stones: [[7, 7, B], [6, 6, W], [8, 8, B], [6, 7, B]], toMove: W },
];

/** 再补一批种子生成的开局，把样本量做够 —— 10 个开局最多分辨出约 15% 的差距。 */
function generated(count: number): Opening[] {
  let s = 0x2f6e2b1;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Opening[] = [];
  for (let i = 0; i < count; i++) {
    const used = new Set<string>();
    const pick = (radius: number): [number, number] => {
      for (;;) {
        const r = 7 + Math.round((rnd() * 2 - 1) * radius);
        const c = 7 + Math.round((rnd() * 2 - 1) * radius);
        const k = `${r},${c}`;
        if (!used.has(k)) {
          used.add(k);
          return [r, c];
        }
      }
    };
    const a = pick(1);
    const b = pick(2);
    const c = pick(2);
    out.push({
      name: `gen${i}`,
      stones: [
        [a[0], a[1], B],
        [b[0], b[1], W],
        [c[0], c[1], B],
      ],
      toMove: W,
    });
  }
  return out;
}

const OPENINGS: Opening[] = [...HANDMADE, ...generated(20)];

interface Contestant {
  name: string;
  opts: AiOptions;
}

const DIFFICULTIES: readonly string[] = ['easy', 'normal', 'hard'];

function parse(spec: string): Contestant {
  const [diff, budget = ''] = spec.split(':');
  // 【为什么这里要显式校验，不能用 `as Difficulty`】跨过这道转换的非法档位不会
  // 当场报错 —— 它会一路走到 `PARAMS[undefined]`，然后在 `Search` 里以
  // 「reading 'maxDepth' of undefined」炸掉，或者更糟：`findBestMove` 的
  // `?? 'easy'` 只兜 `undefined`，兜不住一个**拼错的字符串**，于是你以为在测
  // 「困难」，实际测的是别的东西。宁可在这里就退出。
  if (!DIFFICULTIES.includes(diff)) {
    throw new Error(`未知难度「${diff}」，可选：${DIFFICULTIES.join(' / ')}`);
  }
  const n = Number(budget.slice(0, -1));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`配置「${spec}」的预算不合法`);
  const opts: AiOptions =
    budget.endsWith('t')
      ? { difficulty: diff as Difficulty, timeBudgetMs: n }
      : { difficulty: diff as Difficulty, maxNodes: n };
  return { name: spec, opts };
}

/** 下完一整局，返回胜者（和棋返回 0）。 */
function playGame(
  black: Contestant,
  white: Contestant,
  opening: Opening
): { winner: Player | 0; plies: number } {
  const board = new GomokuBoard();
  for (const [r, c, p] of opening.stones) board.placeStone(r, c, p);
  let turn: Player = opening.toMove;

  for (let ply = 0; ply < 225; ply++) {
    const side = turn === BLACK ? black : white;
    const move = findBestMove(board, turn, side.opts);
    if (!board.isValidMove(move.row, move.col)) {
      // 引擎给出非法着法就是 bug，直接抛出，别把它混进战绩里
      throw new Error(`${side.name} 在 (${move.row},${move.col}) 走出非法着法`);
    }
    board.placeStone(move.row, move.col, turn);
    if (board.checkWinAt(move.row, move.col, turn).won) return { winner: turn, plies: ply + 1 };
    if (board.isFull()) return { winner: 0, plies: ply + 1 };
    turn = turn === BLACK ? WHITE : BLACK;
  }
  return { winner: 0, plies: 225 };
}

function main(): void {
  const a = parse(process.argv[2] ?? 'normal:20000n');
  const b = parse(process.argv[3] ?? 'hard:20000n');
  const games = Number(process.argv[4] ?? OPENINGS.length);

  console.log(`${a.name}  vs  ${b.name} —— 共 ${games} 个开局 × 两色 = ${games * 2} 局\n`);

  const tally: Record<string, number> = { [a.name]: 0, [b.name]: 0, 和棋: 0 };
  /** 每个开局 a 拿了几分（0 / 1 / 2）—— 配对统计的原始素材。 */
  const pairScores: number[] = [];
  let aBoth = 0;
  let aSplit = 0;
  let aNone = 0;

  for (let i = 0; i < games; i++) {
    const o = OPENINGS[i % OPENINGS.length];
    let aPoints = 0;
    // 同一开局下两遍：a 执黑一遍、b 执黑一遍，消掉先手优势
    for (const [black, white] of [
      [a, b],
      [b, a],
    ] as Array<[Contestant, Contestant]>) {
      const r = playGame(black, white, o);
      if (r.winner === 0) {
        tally['和棋']++;
        aPoints += 0.5;
      } else if (r.winner === BLACK) {
        tally[black.name]++;
        if (black === a) aPoints += 1;
      } else {
        tally[white.name]++;
        if (white === a) aPoints += 1;
      }
      console.log(
        `  ${o.name.padEnd(14)} ${black.name.padEnd(16)}执黑  ${String(r.plies).padStart(3)} 手  → ${
          r.winner === 0 ? '和棋' : (r.winner === BLACK ? black.name : white.name) + ' 胜'
        }`
      );
    }
    pairScores.push(aPoints);
    if (aPoints === 2) aBoth++;
    else if (aPoints === 1) aSplit++;
    else aNone++;
  }

  console.log(`\n${a.name}: ${tally[a.name]} 胜`);
  console.log(`${b.name}: ${tally[b.name]} 胜`);
  console.log(`和棋: ${tally['和棋']}`);

  // ── 胜负比之外，还要给出**不确定性** ────────────────────────────────────────
  // 60 局、胜率 75% 时标准误约 5.6 个百分点，95% 置信区间宽达 ±11 —— 不写区间
  // 的话，一个 68% 和一个 82% 看起来都像「七成」，实际上分不出高下。
  const n = games * 2;
  const p = (tally[a.name] + 0.5 * tally['和棋']) / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  console.log(
    `\n【${a.name} 的得分率】${pct(p)}  （${n} 局，95% 置信区间 ${pct(Math.max(0, p - 1.96 * se))} ~ ${pct(
      Math.min(1, p + 1.96 * se)
    )}）`
  );
  // 配对视角：同一开局两局全胜 / 一胜一负 / 全负。开局本身的倾向被消掉之后，
  // 「两局全胜」的个数才是棋力差最干净的读数。
  console.log(
    `【按开局配对】${a.name} 两局全胜 ${aBoth} 个开局 · 一胜一负 ${aSplit} 个 · 全负 ${aNone} 个`
  );
  // 配对均值：每个开局贡献 0~2 分，用它的标准差算标准误（比二项口径更贴近这个设计）
  const meanPair = pairScores.reduce((s, x) => s + x, 0) / pairScores.length;
  const varPair =
    pairScores.reduce((s, x) => s + (x - meanPair) * (x - meanPair), 0) /
    Math.max(1, pairScores.length - 1);
  const sePair = Math.sqrt(varPair / pairScores.length) / 2;
  console.log(
    `【配对均值】每开局 ${meanPair.toFixed(2)}/2 分，折合得分率 ${pct(meanPair / 2)}` +
      ` ± ${(1.96 * sePair * 100).toFixed(1)}pp`
  );
}

main();
