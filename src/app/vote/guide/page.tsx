import { GuideShell, loadGuideHtml } from '@/app/components/MarkdownGuide';

// 读取 docs/投票箱使用指南.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
export const metadata = { title: '投票箱使用指南 · 聪明山' };

export default function VoteGuidePage() {
  const html = loadGuideHtml('投票箱使用指南.md');
  return (
    <GuideShell backHref="/vote" backLabel="返回投票箱">
      {html}
    </GuideShell>
  );
}
