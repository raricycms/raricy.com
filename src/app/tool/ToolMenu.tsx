'use client';

// 工具箱菜单。
// 搜索、过滤、分组与卡片均走 tool-new-* BEM 类。
//
// 【开发者工具入口在 2026-10 收敛成一个合集（/tool/dev）】
// 原先「编码 / 解码」与「加密 / 安全」两组收在「更多开发者工具」手风琴里，现在连同
// 新增的 JSON / 正则 / Diff / Cron / JWT / 时间戳 / 二维码 / 网络查询一起登记在
// `src/lib/dev-tools/registry.ts`，由合集页统一陈列。这里只放一张合集卡 + 四张常用
// 工具卡，**不再维护第二份清单** —— 旧的 CODEC / CRYPTO 数组已删，两份清单必然 drift。
import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowRight,
  AudioLines,
  Braces,
  Calculator,
  Clipboard,
  Clock,
  FileCog,
  FileJson,
  Image,
  QrCode,
  Regex,
  Search,
  Star,
  Vote,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  DEV_TOOLS,
  devToolHref,
  findDevTool,
  type DevToolSlug,
} from '@/lib/dev-tools/registry';

type Cat = 'site' | 'file' | 'math' | 'dev';
type Tool = {
  cat: Cat;
  kw: string;
  href: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  tags: string[];
  coreOnly?: boolean;
  featured?: boolean;
};

const SITE: Tool[] = [
  {
    cat: 'site',
    kw: '云剪贴板 clipboard 云端 文本 分享 片段 markdown 引用',
    href: '/clipboard',
    icon: Clipboard,
    title: '云剪贴板',
    // 原为「云端文本存储与分享」—— 那句任何网盘都成立，说不出它跟博客的区别。
    // 这句讲的是它唯一无法被博客替代的能力（一个 ID 引用多处，改一次全更新）。
    desc: '保存内容片段，在站内文章中引用',
    tags: ['片段', 'Markdown', '引用'],
  },
  {
    cat: 'site',
    kw: '图床 图片 image 上传 托管',
    href: '/image',
    icon: Image,
    title: '图床',
    desc: '图片上传与托管分享',
    tags: ['图片', '上传', '分享'],
  },
  {
    cat: 'site',
    kw: '音频床 audio 音频 声音 音乐 mp3 m4a ogg 上传 托管 分享',
    href: '/audio',
    icon: AudioLines,
    title: '音频床',
    desc: '音频上传与托管分享',
    tags: ['音频', '上传', '分享'],
    // 与图床并列，同样**不设 `coreOnly`**：页面自身就是 `requireCoreUser`，
    // 档位不够的人点进来是就地 403 —— 「入口不跟着藏」，与「我的收藏夹」那条同口径。
  },
  {
    cat: 'site',
    kw: '投票 vote 问卷 调查',
    href: '/vote',
    icon: Vote,
    title: '投票箱',
    desc: '创建和参与投票，支持嵌入博客文章',
    tags: ['投票', '问卷'],
    coreOnly: true,
  },
  {
    cat: 'site',
    kw: '收藏夹 favorite 收藏 星标 整理 分享',
    href: '/favorite',
    icon: Star,
    title: '我的收藏夹',
    desc: '收藏文章，整理后与成员分享',
    tags: ['收藏', '整理'],
    // 刻意**不设 coreOnly**：这一条原先挂在顶栏下拉菜单里，那里写明
    // 「不对档位设条件（core 以下点了是就地 403）—— 入口不跟着藏」。
    // 换了个入口位置，这条口径不变。
  },
  {
    cat: 'site',
    kw: 'cattca 工具',
    href: '/tool/cattca',
    icon: Wrench,
    title: 'Cattca',
    desc: '互动故事脚本编辑与运行',
    tags: ['工具'],
  },
];

const FILE_TOOLS: Tool[] = [
  {
    cat: 'file',
    kw: '格式 转换 文件 图片 音频 视频 文档 PDF 表格 字幕 电子书 压缩包 JPG JPEG PNG WebP AVIF HEIC OGG MP3 WAV FLAC M4A MP4 MKV XLSX CSV JSON EPUB ZIP RAR 7Z converter',
    href: '/tool/convert',
    icon: FileCog,
    title: '格式转换器',
    desc: '图片 / 音频 / 视频 / 文档 PDF / 表格 / 字幕 / 电子书 / 压缩包互转，文件在本机处理',
    tags: ['图片', '音频', '本地处理'],
  },
];

const MATH: Tool[] = [
  {
    cat: 'math',
    kw: '几何 计算器 数学 距离 圆锥曲线 椭圆 抛物线 双曲线 四面体 求导 偏导 拉格朗日 符号计算 geometry calculator',
    href: '/tool/geometry',
    icon: Calculator,
    title: '几何计算器',
    desc: '平面与空间距离、圆锥曲线交点、多项式求导与拉格朗日乘数法，结果精确输出',
    tags: ['几何', '符号计算', '本地处理'],
  },
];

/** 常用开发者工具：标题 / 说明 / 标签都从 registry 取，只有图标是本地给的。 */
function devPick(slug: DevToolSlug, icon: LucideIcon): Tool {
  const def = findDevTool(slug);
  if (!def) throw new Error(`开发者工具清单里没有登记：${slug}`);
  return {
    cat: 'dev',
    kw: def.keywords,
    href: devToolHref(def),
    icon,
    title: def.title,
    desc: def.desc,
    tags: [...def.tags],
  };
}

const DEV: Tool[] = [
  {
    cat: 'dev',
    kw: '开发者 工具 dev json 正则 表达式 sql diff 文本对比 cron jwt 时间戳 uuid 二维码 条码 dns ip 子网 url 编码 加密 哈希 base hex aes 合集 collection 工具集',
    href: '/tool/dev',
    icon: Braces,
    title: '开发者工具合集',
    desc: `JSON、正则、Diff、Cron、JWT、时间戳、二维码、条码与网络查询等 ${DEV_TOOLS.length} 项工具`,
    tags: ['合集', 'JSON', '网络'],
    featured: true,
  },
  devPick('json', FileJson),
  devPick('regex', Regex),
  devPick('timestamp', Clock),
  devPick('qrcode', QrCode),
];

function ToolCard({ t }: { t: Tool }) {
  const inner = (
    <>
      <div className="tool-new-card__header">
        <div className="tool-new-card__header-info">
          <h3 className="title">
            <span aria-hidden="true">
              <t.icon />
            </span>{' '}
            {t.title}
          </h3>
          <p className="description">{t.desc}</p>
        </div>
      </div>
      <div className="tool-new-card__tags">
        {t.tags.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="tool-new-card__footer">
        <span className="btn">
          开始使用 <ArrowRight aria-hidden="true" />
        </span>
      </div>
    </>
  );
  return t.href.startsWith('/') ? (
    <Link
      className={`tool-new-card${t.featured ? ' tool-new-card--featured' : ''}`}
      data-cat={t.cat}
      data-kw={t.kw}
      href={t.href}
    >
      {inner}
    </Link>
  ) : (
    <a className="tool-new-card" data-cat={t.cat} data-kw={t.kw} href={t.href}>
      {inner}
    </a>
  );
}

export default function ToolMenu({ isCore }: { isCore: boolean }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'all' | Cat>('all');

  const query = q.trim().toLowerCase();
  const site = SITE.filter((t) => !t.coreOnly || isCore);

  const match = (t: Tool) => {
    const okCat = cat === 'all' || t.cat === cat;
    const haystack = [t.kw, t.title, t.desc, ...t.tags].join(' ').toLowerCase();
    return okCat && (!query || haystack.includes(query));
  };

  const blocks = [
    { key: 'site', title: '站务工具', items: site.filter(match) },
    { key: 'file', title: '文件处理', items: FILE_TOOLS.filter(match) },
    { key: 'math', title: '数学 / 几何', items: MATH.filter(match) },
    { key: 'dev', title: '开发者工具', items: DEV.filter(match) },
  ];

  const total = blocks.reduce((n, b) => n + b.items.length, 0);

  return (
    <>
      <section className="tool-new-hero">
        <div className="container">
          <h1 className="tool-new-hero__title">工具箱</h1>
          <p className="tool-new-hero__description">
            编码、转换、计算、开发者工具与站内服务。
          </p>
          <div className="tool-new-hero__search">
            <input
              type="text"
              className="search-input"
              placeholder="搜索工具或类别，例如：Base64、JSON、二维码…"
              aria-label="搜索工具"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="tool-new-hero__filters">
            {(
              [
                ['all', '全部'],
                ['site', '站务工具'],
                ['file', '文件处理'],
                ['math', '数学 / 几何'],
                ['dev', '开发者工具'],
              ] as Array<['all' | Cat, string]>
            ).map(([c, label]) => (
              <button
                key={c}
                type="button"
                className={`filter-pill${cat === c ? ' active' : ''}`}
                onClick={() => setCat(c)}
                aria-pressed={cat === c}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="container">
        <section className="tool-new-grid">
          {total === 0 ? (
            <div className="tool-new-empty">
              <Search className="tool-new-empty__icon" aria-hidden="true" />
              <p className="tool-new-empty__text">没有匹配的工具</p>
              <p className="tool-new-empty__subtext">
                换个关键词，或把分类切回「全部」。
              </p>
            </div>
          ) : (
            blocks.map((b) =>
              b.items.length > 0 ? (
                <div className="tool-new-grid__section" data-section={b.key} key={b.key}>
                  <h2 className="tool-new-grid__section-title">{b.title}</h2>
                  <div className="tool-new-grid__tools">
                    {b.items.map((t) => (
                      <ToolCard t={t} key={t.title} />
                    ))}
                  </div>
                </div>
              ) : null
            )
          )}
        </section>
      </div>
    </>
  );
}
