'use client';

// 开发者工具合集首页：搜索、按分类筛选、卡片陈列。
//
// 清单来自 `src/lib/dev-tools/registry.ts`（唯一真相源，零依赖）；这里只负责
// 渲染与过滤。图标名到组件的映射写成 `Record<DevToolIconName, LucideIcon>`，
// 所以清单里加一个新图标名而这里没跟上时 tsc 会报错。
//
// 卡片的形状复用工具箱主页的 `tool-new-card` / `tool-new-grid` —— 合集和工具箱
// 是同一套视觉语言，不另造一套。
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Barcode,
  Binary,
  Braces,
  CalendarClock,
  Clock,
  Code,
  Code2,
  Database,
  FileJson,
  FileType,
  Fingerprint,
  GitCompare,
  Globe,
  Hash,
  Info,
  KeyRound,
  Link2,
  ListFilter,
  ListTree,
  Lock,
  Mail,
  Megaphone,
  MonitorSmartphone,
  Network,
  Palette,
  QrCode,
  RadioTower,
  Regex,
  Route,
  ScanQrCode,
  Search,
  Server,
  SlidersHorizontal,
  Type,
  type LucideIcon,
} from 'lucide-react';
import {
  DEV_TOOLS,
  DEV_TOOL_CATEGORIES,
  devToolHref,
  type DevToolCategoryKey,
  type DevToolDef,
  type DevToolIconName,
} from '@/lib/dev-tools/registry';

const ICONS: Record<DevToolIconName, LucideIcon> = {
  FileJson,
  ListTree,
  Route,
  ArrowRightLeft,
  GitCompare,
  Regex,
  Database,
  Code2,
  Type,
  Palette,
  Clock,
  CalendarClock,
  KeyRound,
  Fingerprint,
  SlidersHorizontal,
  Megaphone,
  ListFilter,
  Globe,
  Network,
  RadioTower,
  Server,
  QrCode,
  ScanQrCode,
  Barcode,
  Braces,
  Binary,
  Link2,
  Code,
  Mail,
  Hash,
  Lock,
  Info,
  FileType,
  MonitorSmartphone,
};

function ToolCard({ tool }: { tool: DevToolDef }) {
  const Icon = ICONS[tool.icon];
  return (
    <Link className="tool-new-card" data-cat={tool.category} href={devToolHref(tool)}>
      <div className="tool-new-card__header">
        <div className="tool-new-card__header-info">
          <h3 className="title">
            <span aria-hidden="true">
              <Icon />
            </span>{' '}
            {tool.title}
          </h3>
          <p className="description">{tool.desc}</p>
        </div>
      </div>
      <div className="tool-new-card__tags">
        {tool.tags.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="tool-new-card__footer">
        <span className="btn">
          打开工具 <ArrowRight aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

export default function DevToolsHub({ total }: { total: number }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<DevToolCategoryKey | 'all'>('all');

  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = DEV_TOOLS.filter((t) => {
      const okCat = cat === 'all' || t.category === cat;
      const haystack = `${t.title} ${t.desc} ${t.keywords} ${t.tags.join(' ')}`.toLowerCase();
      return okCat && (!query || haystack.includes(query));
    });
    return DEV_TOOL_CATEGORIES.map((c) => ({
      ...c,
      items: shown.filter((t) => t.category === c.key),
    })).filter((g) => g.items.length > 0);
  }, [cat, query]);

  const shownCount = groups.reduce((n, g) => n + g.items.length, 0);
  const filters: Array<[DevToolCategoryKey | 'all', string]> = [
    ['all', '全部'],
    ...DEV_TOOL_CATEGORIES.map((c): [DevToolCategoryKey, string] => [c.key, c.label]),
  ];

  return (
    <>
      <section className="tool-new-hero">
        <div className="container">
          <Link href="/tool" className="devtool-hub__back">
            <ArrowLeft aria-hidden="true" /> 返回工具箱
          </Link>
          <h1 className="tool-new-hero__title">开发者工具合集</h1>
          <p className="tool-new-hero__description">
            JSON、正则、Diff、Cron、JWT、时间戳、二维码、条码与网络查询等 {total}{' '}
            项工具。数据在浏览器本地处理；需要联网的工具会在页面上说明。
          </p>
          <div className="tool-new-hero__search">
            <input
              type="text"
              className="search-input"
              placeholder="搜索工具，例如：JSON、正则、二维码、DNS…"
              aria-label="搜索开发者工具"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="tool-new-hero__filters">
            {filters.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`filter-pill${cat === key ? ' active' : ''}`}
                onClick={() => setCat(key)}
                aria-pressed={cat === key}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="devtool-hub__meta">
            {query ? `匹配 ${shownCount} 项` : `共 ${total} 项`}
          </p>
        </div>
      </section>

      <div className="container">
        <section className="tool-new-grid">
          {groups.length === 0 ? (
            <div className="tool-new-empty">
              <Search className="tool-new-empty__icon" aria-hidden="true" />
              <p className="tool-new-empty__text">没有匹配的工具</p>
              <p className="tool-new-empty__subtext">换个关键词，或把分类切回「全部」。</p>
            </div>
          ) : (
            groups.map((g) => (
              <div className="tool-new-grid__section" key={g.key}>
                <h2 className="tool-new-grid__section-title">
                  {g.label}
                  <span className="devtool-section__count">{g.items.length}</span>
                </h2>
                <div className="tool-new-grid__tools">
                  {g.items.map((t) => (
                    <ToolCard key={t.slug} tool={t} />
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
