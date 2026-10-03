import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { randomUUID } from 'node:crypto';
import { buildClickPuzzle } from '@/lib/captcha-demo/click-image';
import { putChallenge, type ClickChallenge } from '@/lib/captcha-demo/store';

// POST /api/captcha-demo/click/challenge — 出点选题（图 + 要按顺序点的字）。
//
// 【为什么只有 POST】本站有一条静态守卫（tests/unit/anonymous-read-guard.test.ts）扫所有
//   导出 GET / HEAD 的 route —— 那些是「免认证读口」，必须逐个登记判据。出题要跑 sharp
//   生成图片，本来就不该是匿名读口。别顺手改成 GET。
//
// 【下发了什么、没下发什么】下发：成品图、要点的字（顺序即答案）、尺寸、容差半径。
//   **不下发**：字心坐标（targets / glyphs 都留在服务端）。
//   所以客户端只知道「要点哪些字」，不知道它们在图上哪 —— 这一步必须靠人眼（或 OCR）。
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const puzzle = await buildClickPuzzle();

  const id = randomUUID();
  putChallenge<ClickChallenge>({
    kind: 'click',
    id,
    userId: user.id,
    targets: puzzle.targets,
    glyphs: puzzle.glyphs,
    radius: puzzle.radius,
    width: puzzle.width,
    height: puzzle.height,
  });

  return apiOk({
    id,
    image: `data:image/png;base64,${puzzle.image.toString('base64')}`,
    promptChars: puzzle.promptChars,
    width: puzzle.width,
    height: puzzle.height,
    radius: puzzle.radius,
  });
}
