import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { randomUUID } from 'node:crypto';
import { buildPuzzle, CANVAS_W, CANVAS_H, PIECE_SIZE } from '@/lib/captcha-demo/puzzle-image';
import { putChallenge } from '@/lib/captcha-demo/store';

// POST /api/captcha-demo/challenge — 出一题（背景 + 拼图块 + 一个挑战 id）。
//
// 【演示用：只要求登录，不要求 core+】真接进签到时要与签到同档（core+）。
//   这里放宽是因为它是个给人看的 demo，看一眼不该先要提权。
//
// 【为什么只有 POST】本站有一条静态守卫（tests/unit/anonymous-read-guard.test.ts）
//   扫所有导出 GET / HEAD 的 route —— 那些是「免认证读口」，必须逐个登记判据。
//   出题是要花 CPU 生成图片的路径，**本来就不该是匿名读口**；用 POST 既躲开了那本台账，
//   也省得为一个 demo 往白名单里塞一条。别顺手改成 GET。
//
// 【没有落库】挑战存在进程内存里（见 store.ts）。所以这是**纯演示**：重启即失效，
//   多实例部署也不共享。要上线得先决定它进不进库。
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const puzzle = await buildPuzzle();

  const id = randomUUID();
  putChallenge({
    id,
    // 绑用户：否则 A 解出来的答案可以喂给 B 的挑战
    userId: user.id,
    answerX: puzzle.answerX,
    maxOffset: CANVAS_W - PIECE_SIZE,
    pieceSize: PIECE_SIZE,
    width: CANVAS_W,
    height: CANVAS_H,
    pieceY: puzzle.pieceY,
  });

  // 只下发「要显示什么」，**不下发答案**（answerX 留在服务端）。
  return apiOk({
    id,
    background: `data:image/png;base64,${puzzle.background.toString('base64')}`,
    piece: `data:image/png;base64,${puzzle.piece.toString('base64')}`,
    pieceY: puzzle.pieceY,
    pieceSize: PIECE_SIZE,
    width: CANVAS_W,
    height: CANVAS_H,
    maxOffset: CANVAS_W - PIECE_SIZE,
  });
}
