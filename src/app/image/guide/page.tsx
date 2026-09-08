import { GuideShell, loadGuideHtml } from '@/app/components/MarkdownGuide';

// 读取 docs/图床使用指南.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
export const metadata = { title: '图床使用指南 · 聪明山' };

export default function ImageGuidePage() {
  const html = loadGuideHtml('图床使用指南.md');
  return (
    <GuideShell backHref="/image" backLabel="返回图床">
      {html}
    </GuideShell>
  );
}
