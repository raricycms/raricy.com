import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import SliderDemo from './SliderDemo';

// /captcha-demo —— 滑块验证码演示页。
//
// 【刻意不接签到】这是一个**独立可删**的沙盒：要清理它，删掉
// src/app/captcha-demo/、src/app/api/captcha-demo/、src/lib/captcha-demo/ 与
// src/styles-scss/pages/_captcha-demo.scss（外加 main.scss 里那一行 @use）即可，
// 不触碰任何既有功能。等站长看过了再决定要不要往 POST /api/checkin 上接。
//
// 【为什么只要求登录、不要求 core+】真接进签到时必须与签到同档（core+，见
// docs/architecture.md §8 的「页面与接口必须同档」）。这里放宽是因为它是个给人看的
// demo —— 但**仍然要求登录**：出题要跑 sharp 生成图片，那是有 CPU 成本的路径，
// 不能对匿名开放。
export const dynamic = 'force-dynamic';

export default async function CaptchaDemoPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/captcha-demo'));

  return (
    <div className="captcha-demo-page">
      <SliderDemo />
    </div>
  );
}
