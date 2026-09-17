import { GuideShell, loadGuideHtml } from '@/app/components/MarkdownGuide';

// 读取 docs/guide/收藏夹使用指南.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
//
// ⚠️ docs/guide/ 下的**文件名是接口** —— 改名会让下面这行静默兜底成一句
//    「指南文档暂时无法加载。」且照样 200。守卫：tests/unit/guide-docs.test.ts。
export const metadata = { title: '收藏夹使用指南 · 聪明山' };

export default function FavoriteGuidePage() {
  const html = loadGuideHtml('收藏夹使用指南.md');
  return (
    <GuideShell backHref="/favorite" backLabel="返回我的收藏夹">
      {html}
    </GuideShell>
  );
}
