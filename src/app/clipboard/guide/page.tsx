import { GuideShell, loadGuideHtml } from '@/app/components/MarkdownGuide';

// 读取 docs/guide/云剪贴板使用指南.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
export const metadata = { title: '云剪贴板使用指南 · 聪明山' };

export default function ClipboardGuidePage() {
  const html = loadGuideHtml('云剪贴板使用指南.md');
  return (
    <GuideShell backHref="/clipboard" backLabel="返回云剪贴板">
      {html}
    </GuideShell>
  );
}
