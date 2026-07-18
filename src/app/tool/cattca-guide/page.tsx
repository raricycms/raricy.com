import Link from 'next/link';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

// 读取 docs/cattca-guide.md，服务端渲染为 HTML（fenced code + tables）。
// 内容为仓库内可信文档（非用户输入）。
export const metadata = { title: 'Cattca 语法指南 · 聪明山' };

// docs/ 与项目根同级（进程 cwd 即项目根）。
function loadGuideHtml(): string {
  try {
    const guidePath = path.join(process.cwd(), 'docs', 'cattca-guide.md');
    const content = fs.readFileSync(guidePath, 'utf-8');
    return marked.parse(content, { async: false }) as string;
  } catch {
    return '<p>指南文档暂时无法加载。</p>';
  }
}

export default function CattcaGuidePage() {
  const html = loadGuideHtml();
  return (
    <>
      <style>{`
        .guide{padding:2rem 0;max-width:820px;margin:0 auto}
        .guide__back{color:var(--ink-2,#6c757d);text-decoration:none;font-size:.875rem;display:inline-block;margin-bottom:2rem;transition:color .2s ease}
        .guide__back:hover{color:var(--accent,#0d6efd)}
        .guide__content{background:var(--surface,#fff);border:1px solid var(--line,#e1e8ed);border-radius:.5rem;padding:2.5rem;color:var(--ink,#1d1d1f);line-height:1.8;font-size:.95rem}
        .guide__content h1{font-size:2rem;font-weight:700;margin-bottom:.5rem;padding-bottom:.75rem;border-bottom:2px solid var(--accent,#0d6efd)}
        .guide__content h2{font-size:1.4rem;font-weight:600;margin:2.5rem 0 1rem;padding-bottom:.5rem;border-bottom:1px solid var(--line,#e1e8ed)}
        .guide__content h3{font-size:1.15rem;font-weight:600;margin:1.75rem 0 .75rem}
        .guide__content p{margin:.75rem 0}
        .guide__content code{background:var(--surface-2,#f5f7fa);padding:.15rem .35rem;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.875em;color:var(--warning,#b5730a)}
        .guide__content pre{background:var(--surface-2,#f5f7fa);padding:1rem 1.25rem;border-radius:.375rem;overflow-x:auto;margin:1rem 0;border-left:3px solid var(--accent,#0d6efd);font-size:.875rem;line-height:1.6}
        .guide__content pre code{background:none;padding:0;color:var(--ink,#1d1d1f);font-size:inherit}
        .guide__content blockquote{border-left:3px solid var(--accent,#0d6efd);margin:1rem 0;padding:.5rem 1rem;background:var(--surface-2,#f5f7fa);color:var(--ink-2,#6c757d);border-radius:0 .25rem .25rem 0}
        .guide__content ul,.guide__content ol{margin:.75rem 0;padding-left:1.75rem}
        .guide__content li{margin:.35rem 0}
        .guide__content table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.9rem}
        .guide__content th,.guide__content td{border:1px solid var(--line,#e1e8ed);padding:.5rem .75rem;text-align:left}
        .guide__content th{background:var(--surface-2,#f5f7fa);font-weight:600}
        .guide__content strong{color:var(--ink,#1d1d1f)}
        .guide__content a{color:var(--accent,#0d6efd)}
        .guide__content hr{border:none;border-top:1px solid var(--line,#e1e8ed);margin:2rem 0}
        @media (max-width:768px){.guide__content{padding:1.5rem}.guide__content h1{font-size:1.6rem}}
      `}</style>
      <div className="guide wrap">
        <Link href="/tool/cattca" className="guide__back">← 返回 Cattca 编辑器</Link>
        <div className="guide__content" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </>
  );
}
