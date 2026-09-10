import { GuideShell, loadGuideHtml } from '@/app/components/MarkdownGuide';

// 读取 docs/guide/cattca-guide.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
export const metadata = { title: 'Cattca 语法指南 · 聪明山' };

export default function CattcaGuidePage() {
  const html = loadGuideHtml('cattca-guide.md');
  return (
    <GuideShell backHref="/tool/cattca" backLabel="返回 Cattca 编辑器">
      {html}
    </GuideShell>
  );
}
