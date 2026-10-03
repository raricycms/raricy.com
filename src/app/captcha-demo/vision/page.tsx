import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import VisionDemo from './VisionDemo';

// /captcha-demo/vision —— 「视觉空间任务」演示页。
//
// 【与另两个题型并列】滑块、点选、视觉任务三页都在 /captcha-demo 下，共用同一套
//   `.cdm__*` 样式与同一份底图/沙盒纪律。要清理这一个，删掉
//   src/app/captcha-demo/vision/、src/app/api/captcha-demo/vision/、
//   src/lib/captcha-demo/vision-*.ts 与 _captcha-demo.scss 里的 .vdm__* 即可。
//
// 【为什么只要求登录】同另两页：出题要跑 sharp 渲染，是有 CPU 成本的路径，
//   不能对匿名开放；真接进签到时要与签到同档（core+）。
export const dynamic = 'force-dynamic';

export default async function VisionDemoPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/captcha-demo/vision'));

  return (
    <div className="captcha-demo-page">
      <VisionDemo />
    </div>
  );
}
