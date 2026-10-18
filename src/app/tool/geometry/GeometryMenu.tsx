'use client';

// 几何计算器索引 —— /tool/geometry 的工具清单。
//
// 计算器本体是 public/static/geometry 下的静态页面（原作 xcxGeometry 的本地化副本，
// 见该目录 README）。这里只做站内入口：搜索、分类与卡片都复用工具箱的 tool-new-* 类，
// 卡片用普通 <a>（目标是 public 下的 .html，不能走 next/link 的客户端路由）。
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Calculator,
  Circle,
  FunctionSquare,
  Ruler,
  Sigma,
  Triangle,
  type LucideIcon,
} from 'lucide-react';

type Cat = 'distance' | 'conic' | 'shape' | 'algebra';

type Geo = {
  slug: string;
  cat: Cat;
  kw: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  tags: string[];
};

const CATS: Array<[Cat | 'all', string]> = [
  ['all', '全部'],
  ['distance', '距离'],
  ['conic', '圆锥曲线'],
  ['shape', '图形'],
  ['algebra', '代数'],
];

const TOOLS: Geo[] = [
  {
    slug: 'monomial',
    cat: 'algebra',
    kw: '计算器 化简 分数 幂 根式 参数 符号运算',
    icon: Calculator,
    title: '普通计算器',
    desc: '分数、幂、根式与参数 a / b / h 的符号化简，结果以精确形式输出',
    tags: ['符号计算', '分数', '根式'],
  },
  {
    slug: 'derivative',
    cat: 'algebra',
    kw: '求导 导数 偏导 多项式 含参',
    icon: FunctionSquare,
    title: '多项式求导',
    desc: '对含参多项式求导，或对指定参数求偏导，支持幂、根式与分式',
    tags: ['求导', '偏导', '多项式'],
  },
  {
    slug: 'lagrange',
    cat: 'algebra',
    kw: '拉格朗日 乘数法 条件极值 方程组 偏导',
    icon: Sigma,
    title: '拉格朗日乘数法',
    desc: '输入目标函数 f(x,y) 与约束 g(x,y)=0，构造拉格朗日函数并输出方程组',
    tags: ['条件极值', '方程组'],
  },
  {
    slug: 'distance2',
    cat: 'distance',
    kw: '平面 两点 距离 坐标',
    icon: Ruler,
    title: '平面两点距离',
    desc: '计算平面上两点之间的距离',
    tags: ['平面', '两点'],
  },
  {
    slug: 'distance3',
    cat: 'distance',
    kw: '空间 两点 距离 坐标 三维',
    icon: Ruler,
    title: '空间两点距离',
    desc: '计算空间中两点之间的距离',
    tags: ['空间', '两点'],
  },
  {
    slug: 'linedistance2',
    cat: 'distance',
    kw: '平面 点线 距离 直线 坐标',
    icon: Ruler,
    title: '平面点线距离',
    desc: '计算平面内一点到直线的距离',
    tags: ['平面', '点线'],
  },
  {
    slug: 'ellipseline',
    cat: 'conic',
    kw: '椭圆 直线 交点 圆锥曲线 长短轴',
    icon: Circle,
    title: '椭圆与直线交点',
    desc: '计算椭圆与直线的两个交点，结果精确输出',
    tags: ['椭圆', '交点'],
  },
  {
    slug: 'paraline',
    cat: 'conic',
    kw: '抛物线 直线 交点 圆锥曲线',
    icon: Circle,
    title: '抛物线与直线交点',
    desc: '计算抛物线与直线的两个交点，结果精确输出',
    tags: ['抛物线', '交点'],
  },
  {
    slug: 'hyperline',
    cat: 'conic',
    kw: '双曲线 直线 交点 圆锥曲线',
    icon: Circle,
    title: '双曲线与直线交点',
    desc: '计算双曲线与直线的两个交点，结果精确输出',
    tags: ['双曲线', '交点'],
  },
  {
    slug: 'tetrahedron',
    cat: 'shape',
    kw: '四面体 体积 外接球 内切球 球心 半径',
    icon: Triangle,
    title: '四面体工具',
    desc: '计算四面体体积、外接球与内切球的球心、半径',
    tags: ['四面体', '外接球', '内切球'],
  },
];

function GeoCard({ t }: { t: Geo }) {
  return (
    <a
      className="tool-new-card"
      data-cat={t.cat}
      data-kw={t.kw}
      href={`/static/geometry/${t.slug}.html`}
    >
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
    </a>
  );
}

export default function GeometryMenu() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat | 'all'>('all');

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return TOOLS.filter((t) => {
      const okCat = cat === 'all' || t.cat === cat;
      const okQ = !term || (t.kw + ' ' + t.title).toLowerCase().includes(term);
      return okCat && okQ;
    });
  }, [q, cat]);

  return (
    <div className="container tool-geometry">
      <Link href="/tool" className="tool-geometry__back">
        <ArrowLeft aria-hidden="true" /> 返回工具箱
      </Link>

      <section className="tool-new-hero">
        <h1 className="tool-new-hero__title">几何计算器</h1>
        <p className="tool-new-hero__description">
          平面与空间几何、圆锥曲线、求导与拉格朗日乘数法。全部在浏览器本地计算，结果精确输出。
        </p>
        <div className="tool-new-hero__search">
          <input
            type="text"
            className="search-input"
            placeholder="搜索工具或功能，例如：距离、求导、椭圆…"
            aria-label="搜索几何计算器"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="tool-new-hero__filters">
          {CATS.map(([c, label]) => (
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
      </section>

      <section className="tool-new-grid">
        {shown.length > 0 ? (
          <div className="tool-new-grid__tools">
            {shown.map((t) => (
              <GeoCard t={t} key={t.slug} />
            ))}
          </div>
        ) : (
          <p className="tool-geometry__empty">没有找到相关工具</p>
        )}
      </section>
    </div>
  );
}
