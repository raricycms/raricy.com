'use client';

// 工具箱菜单 — 对齐 Flask `app/templates/tool/new_menu.html`。
// 搜索、过滤、分组与卡片均走 tool-new-* BEM 类。
import Link from 'next/link';
import { useMemo, useState } from 'react';

type Cat = 'site' | 'codec' | 'crypto';
type Tool = {
  cat: Cat;
  kw: string;
  href: string;
  emoji: string;
  title: string;
  desc: string;
  tags: string[];
  coreOnly?: boolean;
};

const SITE: Tool[] = [
  {
    cat: 'site',
    kw: '云剪贴板 clipboard 云端 文本 分享',
    href: '/clipboard',
    emoji: '📋',
    title: '云剪贴板',
    desc: '云端文本存储与分享',
    tags: ['云端', '分享', '文本'],
  },
  {
    cat: 'site',
    kw: '图床 图片 image 上传 托管',
    href: '/image',
    emoji: '🖼️',
    title: '图床',
    desc: '图片上传与托管分享',
    tags: ['图片', '上传', '分享'],
  },
  {
    cat: 'site',
    kw: '投票 vote 问卷 调查',
    href: '/vote',
    emoji: '🗳️',
    title: '投票箱',
    desc: '创建和参与投票，支持嵌入博客文章',
    tags: ['投票', '问卷'],
    coreOnly: true,
  },
  {
    cat: 'site',
    kw: '照片墙 photo 照片 软木板',
    href: '/photowall',
    emoji: '📸',
    title: '照片墙',
    desc: '社区共享软木板，贴照片、旋转、缩放',
    tags: ['社区', '照片', '共创'],
    coreOnly: true,
  },
  {
    cat: 'site',
    kw: 'cattca 工具',
    href: '/tool/cattca',
    emoji: '🛠️',
    title: 'Cattca',
    desc: '其他工具功能',
    tags: ['工具'],
  },
];
const CODEC: Tool[] = [
  {
    cat: 'codec',
    kw: 'base base64 base58 编码 解码',
    href: '/tool/base',
    emoji: '🔣',
    title: 'Base 编码',
    desc: 'Base16 / 32 / 36 / 58 / 62 / 64 / 85 / 91 / 92',
    tags: ['Base64', 'Base58', '+7'],
  },
  {
    cat: 'codec',
    kw: 'hex 十六进制 字节 bytes 转换',
    href: '/tool/hex',
    emoji: '🔡',
    title: 'Hex 编码',
    desc: '十六进制与字节流互转',
    tags: ['Hex', 'Bytes'],
  },
  {
    cat: 'codec',
    kw: 'url 编码 解码 percent query',
    href: '/tool/url',
    emoji: '🔗',
    title: 'URL 编码',
    desc: 'URL 百分号编码 / 解码',
    tags: ['URL', 'Web', '编码'],
  },
  {
    cat: 'codec',
    kw: 'html 实体 entity 转义 escape',
    href: '/tool/html',
    emoji: '📰',
    title: 'HTML 编码',
    desc: 'HTML 实体编码 / 解码，支持常用符号和特殊字符',
    tags: ['Entity', 'Escape'],
  },
  {
    cat: 'codec',
    kw: 'quoted-printable mime rfc2045 邮件',
    href: '/tool/qp',
    emoji: '✉️',
    title: 'Quoted-printable',
    desc: '邮件 MIME Quoted-Printable 编 / 解码',
    tags: ['MIME', 'RFC2045'],
  },
];
const CRYPTO: Tool[] = [
  {
    cat: 'crypto',
    kw: 'hash 哈希 sha md5 校验',
    href: '/tool/hash',
    emoji: '#️⃣',
    title: '哈希计算',
    desc: 'SHA-256 / SHA-1 / SHA-512 / MD5 等',
    tags: ['SHA-256', 'MD5'],
  },
  {
    cat: 'crypto',
    kw: 'aes 加密 解密 对称 cbc gcm',
    href: '/tool/aes',
    emoji: '🔒',
    title: 'AES',
    desc: '常见模式（CBC / CTR / GCM）与填充',
    tags: ['AES', '密钥'],
  },
];

function ToolCard({ t }: { t: Tool }) {
  const inner = (
    <>
      <div className="tool-new-card__header">
        <div className="tool-new-card__header-info">
          <h3 className="title">
            <span aria-hidden="true">{t.emoji}</span> {t.title}
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
        <span className="btn">开始使用 →</span>
      </div>
    </>
  );
  return t.href.startsWith('/') ? (
    <Link className="tool-new-card" data-cat={t.cat} data-kw={t.kw} href={t.href}>
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
  const [moreOpen, setMoreOpen] = useState(false);

  const site = SITE.filter((t) => !t.coreOnly || isCore);
  const match = (t: Tool) => {
    const okCat = cat === 'all' || t.cat === cat;
    const okQ =
      !q.trim() ||
      (t.kw + ' ' + t.title).toLowerCase().includes(q.toLowerCase().trim());
    return okCat && okQ;
  };

  const showMore = moreOpen;

  const blocks = useMemo(
    () => [
      { key: 'site', title: '站务工具', items: site.filter(match) },
      {
        key: 'codec',
        title: '编码 / 解码',
        items: CODEC.filter(match),
        more: true,
      },
      {
        key: 'crypto',
        title: '加密 / 安全',
        items: CRYPTO.filter(match),
        more: true,
      },
    ],
    [q, cat, isCore]
  );

  return (
    <div className="container">
      <section className="tool-new-hero">
        <h1 className="tool-new-hero__title">工具箱</h1>
        <p className="tool-new-hero__description">
          常用编码、加密和数据处理工具的整合平台，助你更高效地完成开发与日常工作。
        </p>
        <div className="tool-new-hero__search">
          <input
            type="text"
            className="search-input"
            placeholder="搜索工具或类别，例如：Base64、AES、哈希…"
            aria-label="搜索工具"
            value={q}
            onChange={(e) => {
              const v = e.target.value;
              setQ(v);
              if (v.trim()) setMoreOpen(true);
            }}
          />
        </div>
        <div className="tool-new-hero__filters">
          {(
            [
              ['all', '全部'],
              ['site', '站务工具'],
              ['codec', '编码 / 解码'],
              ['crypto', '加密 / 安全'],
            ] as Array<['all' | Cat, string]>
          ).map(([c, label]) => (
            <button
              key={c}
              type="button"
              className={`filter-pill${cat === c ? ' active' : ''}`}
              onClick={() => {
                setCat(c);
                if (c === 'codec' || c === 'crypto') setMoreOpen(true);
              }}
              aria-pressed={cat === c}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="tool-new-grid">
        {blocks[0].items.length > 0 && (
          <div className="tool-new-grid__section">
            <h2 className="tool-new-grid__section-title">站务工具</h2>
            <div className="tool-new-grid__tools">
              {blocks[0].items.map((t) => (
                <ToolCard t={t} key={t.title} />
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          className="filter-pill"
          aria-expanded={showMore}
          onClick={() => setMoreOpen((v) => !v)}
          style={{ display: 'inline-block', margin: '16px auto' }}
        >
          {showMore ? '收起开发者工具' : '更多开发者工具'}
        </button>

        {showMore &&
          blocks
            .filter((b) => b.more)
            .map((b) =>
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
            )}
      </section>
    </div>
  );
}