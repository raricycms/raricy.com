import Link from 'next/link';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { ArrowLeft } from 'lucide-react';

// Markdown 指南页面的共享外壳：从 docs/guide/ 读取仓库内可信文档，服务端渲染为
// HTML（fenced code + tables），并统一排版样式。四份指南（cattca / 云剪贴板 /
// 图床 / 投票箱）共用，避免每页复制一份 <style>。
//
// 用法：每个 guide 页面自行 export metadata 标题，然后
//   const html = loadGuideHtml('xxx.md');
//   <GuideShell backHref="/xxx" backLabel="← 返回 xxx">{html}</GuideShell>
//
// ⚠️ docs/guide/ 下的**文件名是接口** —— 页面传的就是它。改名/移走会让下面
// 的 catch 兜底成一句「指南文档暂时无法加载。」且照样 200，线上静默失效。
// 守卫：tests/unit/guide-docs.test.ts（静态）与 smoke.mjs §2b（线上查正文）。

// 全部走 --color-* 主题令牌，随 <html data-theme> 深浅自适应。
// （早前用的是 --ink/--surface/--line/--accent 等一套主题体系里不存在的变量，
//  fallback 全是浅色值 —— 暗色下整页还是白底黑字。）
const GUIDE_STYLES = `
  .guide{padding:2rem 0;max-width:820px;margin:0 auto}
  .guide__back{color:var(--color-text-secondary);text-decoration:none;font-size:.875rem;display:inline-block;margin-bottom:2rem;transition:color .2s ease}
  .guide__back:hover{color:var(--color-brand-primary)}
  .guide__content{background:var(--color-background-card);border:1px solid var(--color-border);border-radius:.5rem;padding:2.5rem;color:var(--color-text-primary);line-height:1.8;font-size:.95rem}
  .guide__content h1{font-size:2rem;font-weight:700;margin-bottom:.5rem;padding-bottom:.75rem;border-bottom:2px solid var(--color-brand-primary)}
  .guide__content h2{font-size:1.4rem;font-weight:600;margin:2.5rem 0 1rem;padding-bottom:.5rem;border-bottom:1px solid var(--color-border)}
  .guide__content h3{font-size:1.15rem;font-weight:600;margin:1.75rem 0 .75rem}
  .guide__content p{margin:.75rem 0}
  .guide__content code{background:var(--color-background-content);padding:.15rem .35rem;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.875em;color:#b5730a}
  .guide__content pre{background:var(--color-background-content);padding:1rem 1.25rem;border-radius:.375rem;overflow-x:auto;margin:1rem 0;border-left:3px solid var(--color-brand-primary);font-size:.875rem;line-height:1.6}
  .guide__content pre code{background:none;padding:0;color:var(--color-text-primary);font-size:inherit}
  .guide__content blockquote{border-left:3px solid var(--color-brand-primary);margin:1rem 0;padding:.5rem 1rem;background:var(--color-background-content);color:var(--color-text-secondary);border-radius:0 .25rem .25rem 0}
  .guide__content ul,.guide__content ol{margin:.75rem 0;padding-left:1.75rem}
  .guide__content li{margin:.35rem 0}
  .guide__content table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.9rem}
  .guide__content th,.guide__content td{border:1px solid var(--color-border);padding:.5rem .75rem;text-align:left}
  .guide__content th{background:var(--color-background-content);font-weight:600}
  .guide__content strong{color:var(--color-text-primary)}
  .guide__content a{color:var(--color-brand-primary)}
  .guide__content hr{border:none;border-top:1px solid var(--color-border);margin:2rem 0}
  /* 行内代码的暖色没有对应的主题令牌，暗色单独提亮一档（pre 里的代码仍是正文色） */
  [data-theme="dark"] .guide__content code{color:#e0a458}
  [data-theme="dark"] .guide__content pre code{color:var(--color-text-primary)}
  @media (max-width:768px){.guide__content{padding:1.5rem}.guide__content h1{font-size:1.6rem}}
`;

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
    <>
      <style>{GUIDE_STYLES}</style>
      <div className="guide wrap">
        <Link href={backHref} className="guide__back">
          <ArrowLeft aria-hidden="true" /> {backLabel}
        </Link>
        <div className="guide__content" dangerouslySetInnerHTML={{ __html: children }} />
      </div>
    </>
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
