import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import ClickDemo from './ClickDemo';

// /captcha-demo/click —— 点选验证码演示页。
//
// 【与滑块页并列，两个都留着】滑块（puzzle-image.ts）与点选（click-image.ts）共用底图
//   管线（canvas.ts），风格一致 ⇒ 站长可以直接对比「哪个题型更划算」。
//
// 【刻意不接签到】同滑块页：这是一个**独立可删**的沙盒。要清理它，删掉
//   src/app/captcha-demo/click/、src/app/api/captcha-demo/click/、
//   src/lib/captcha-demo/click-*.ts 与 _captcha-demo.scss 里对应的类即可。
//
// 【为什么只要求登录】与滑块页同款：出题要跑 sharp 生成图片，是有 CPU 成本的路径，
//   不能对匿名开放；真接进签到时要与签到同档（core+）。
export const dynamic = 'force-dynamic';

export default async function ClickDemoPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/captcha-demo/click'));

  return (
    <div className="captcha-demo-page">
      <ClickDemo />
    </div>
  );
}
