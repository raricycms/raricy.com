import Link from 'next/link';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { ArrowLeft } from 'lucide-react';

// Markdown 指南页面的共享外壳：从 docs/guide/ 读取仓库内可信文档，服务端渲染为
// HTML（fenced code + tables），并统一排版样式。六个页面（cattca / 云剪贴板 /
// 图床 / 音频床 / 投票箱 / 收藏夹）共用，避免每页复制一份外壳。
//
// 用法：每个 guide 页面自行 export metadata 标题，然后
//   const html = loadGuideHtml('xxx.md');
//   <GuideShell backHref="/xxx" backLabel="← 返回 xxx">{html}</GuideShell>
//
// ⚠️ docs/guide/ 下的**文件名是接口** —— 页面传的就是它。改名/移走会让下面
// 的 catch 兜底成一句「指南文档暂时无法加载。」且照样 200，线上静默失效。
// 守卫：tests/unit/guide-docs.test.ts（静态）与 smoke.mjs §2b（线上查正文）。
//
// 【排版样式在哪】不在这里了。`.guide` 外壳与正文的排版都搬进了 SCSS
// （`src/styles-scss/pages/_guide.scss` + `components/_doc-prose.scss` 的 mixin），
// 与站内文档页 `/docs` 共用同一份 —— 两边渲染的是同一批 Markdown，抄两份必然漂。
// 曾经那段内联 `<style>` 的代价是：`<body>` 里的样式总在全站样式表之后，
// 谁覆盖谁只能靠读两处代码猜出来。

// docs/guide/ 与项目根同级（进程 cwd 即项目根，systemd 的 WorkingDirectory）。
export function loadGuideHtml(docFileName: string): string {
  try {
    const guidePath = path.join(process.cwd(), 'docs', 'guide', docFileName);
    const content = fs.readFileSync(guidePath, 'utf-8');
    return marked.parse(content, { async: false }) as string;
  } catch {
    return '<p>指南文档暂时无法加载。</p>';
  }
}

export function GuideShell({
  backHref,
  backLabel,
  children,
}: {
  backHref: string;
  backLabel: string;
  children: string;
}) {
  return (
    <div className="guide wrap">
      <Link href={backHref} className="guide__back">
        <ArrowLeft aria-hidden="true" /> {backLabel}
      </Link>
      <div className="guide__content" dangerouslySetInnerHTML={{ __html: children }} />
    </div>
  );
}

// 工具页导航区里的「使用指南」入口小胶囊（样式对齐 cattca 编辑器的语法指南入口）。
export function GuidePill({ href, label = '使用指南' }: { href: string; label?: string }) {
  return (
    <Link
      href={href}
      style={{
        fontSize: '0.8125rem',
        color: 'var(--color-brand-primary)',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        padding: '0.25rem 0.5rem',
        border: '1px solid var(--color-border)',
        borderRadius: '0.25rem',
        transition: 'all 0.2s ease',
        alignSelf: 'center',
      }}
    >
      {label}
    </Link>
  );
}
