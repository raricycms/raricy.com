// ─────────────────────────────────────────────────────────────────────────────
// gomoku-selfplay.ts —— 五子棋 AI 自对弈对比工具。
//
// 【为什么不进 `npm test`】跑得慢（几秒到几十秒），而且它的价值是「改引擎时
// 手工对比一次」，不是每次提交都要验的回归网。日常的正确性由
// tests/unit/gomoku-ai.test.ts 的战术题库与不变量负责。
//
// 用法： npx tsx scripts/gomoku-selfplay.ts [每种先后手的局数]
//
// 【确定性】双方都用固定 `maxNodes` 而不是墙钟，且引擎不带任何随机 ——
// 同样的参数跑两次结果完全一致，这样「棋力变化」才是可比较的。
// ─────────────────────────────────────────────────────────────────────────────

import { BLACK, GomokuBoard, WHITE, type Player } from '../src/lib/gomoku-rules';
import { findBestMove, type AiOptions } from '../src/lib/gomoku-ai';

/** 每手的节点上限。固定值 = 确定性。调大更接近实战棋力，但更慢。 */
const NODES_PER_MOVE = 20_000;
/** 上限手数，防跑飞。正常对局几十手就结束了。 */
const MAX_PLY = 225;

interface Contestant {
  name: string;
  opts: AiOptions;
}

const CONTESTANTS: Contestant[] = [
  { name: '普通', opts: { difficulty: 'normal', maxNodes: NODES_PER_MOVE } },
  { name: '困难', opts: { difficulty: 'hard', maxNodes: NODES_PER_MOVE } },
];

/** 下完一整局，返回胜者（和棋返回 0）。 */
function playGame(black: Contestant, white: Contestant): Player | 0 {
  const board = new GomokuBoard();
  let turn: Player = BLACK;
  for (let ply = 0; ply < MAX_PLY; ply++) {
    const side = turn === BLACK ? black : white;
    const move = findBestMove(board, turn, side.opts);
    if (!board.isValidMove(move.row, move.col)) {
      // 引擎给出非法着法就是 bug，直接抛出，别把它混进战绩里
      throw new Error(`${side.name} 在 (${move.row},${move.col}) 走出非法着法`);
    }
    board.placeStone(move.row, move.col, turn);
    if (board.checkWinAt(move.row, move.col, turn).won) return turn;
    if (board.isFull()) return 0;
    turn = turn === BLACK ? WHITE : BLACK;
  }
  return 0;
}

/** 两名选手对打若干局，先后手各半，返回战绩。 */
function match(a: Contestant, b: Contestant, rounds: number): Record<string, number> {
  const tally: Record<string, number> = { [a.name]: 0, [b.name]: 0, 和棋: 0 };
  for (let g = 0; g < rounds; g++) {
    // 一局 a 执黑、一局 b 执黑，消掉先手优势
    for (const [black, white] of [
      [a, b],
      [b, a],
    ] as Array<[Contestant, Contestant]>) {
      const winner = playGame(black, white);
      if (winner === 0) tally['和棋']++;
      else if (winner === BLACK) tally[black.name]++;
      else tally[white.name]++;
    }
  }
  return tally;
}

function main(): void {
  const rounds = Number(process.argv[2] ?? 4);
  console.log(`每手 ${NODES_PER_MOVE} 节点，每种先后手各 ${rounds} 局\n`);

  for (let i = 0; i < CONTESTANTS.length; i++) {
    for (let j = i + 1; j < CONTESTANTS.length; j++) {
      const a = CONTESTANTS[i];
      const b = CONTESTANTS[j];
      const tally = match(a, b, rounds);
      const total = rounds * 2;
      console.log(`${a.name} vs ${b.name}（共 ${total} 局，先后手各半）`);
      console.log(`  ${a.name}: ${tally[a.name]} 胜`);
      console.log(`  ${b.name}: ${tally[b.name]} 胜`);
      console.log(`  和棋: ${tally['和棋']}\n`);
    }
  }
}

main();
