import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { findDevTool } from '@/lib/dev-tools/registry';

// 开发者工具子页的公共外壳：返回合集的链接 + 标题 + 一句说明。
//
// 标题与说明**从 registry 取**（不在这里再抄一份）—— 合集首页、页面 metadata 与
// 页面上的 h1 都读同一份数据，改一处三处一起变。slug 拼错时这里抛错（构建期就炸），
// 不会静默渲染出一个没有标题的页面。
export default function DevToolShell({ slug, children }: { slug: string; children: ReactNode }) {
  const tool = findDevTool(slug);
  if (!tool) throw new Error(`开发者工具清单里没有登记：${slug}`);

  return (
    <section className="base-tool-page">
      <div className="container">
        <Link href="/tool/dev" className="devtool-shell__back">
          <ArrowLeft aria-hidden="true" /> 返回开发者工具合集
        </Link>
        <header className="devtool-head">
          <h1 className="tool-new-hero__title">{tool.title}</h1>
          <p className="tool-new-hero__description">{tool.desc}</p>
        </header>
        {children}
      </div>
    </section>
  );
}
