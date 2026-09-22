import { GuideShell, loadGuideHtml } from '@/app/components/MarkdownGuide';

// 读取 docs/guide/音频床使用指南.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
export const metadata = { title: '音频床使用指南 · 聪明山' };

export default function AudioGuidePage() {
  const html = loadGuideHtml('音频床使用指南.md');
  return (
    <GuideShell backHref="/audio" backLabel="返回音频床">
      {html}
    </GuideShell>
  );
}
