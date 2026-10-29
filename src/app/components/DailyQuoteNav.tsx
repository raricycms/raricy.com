import Link from 'next/link';

/**
 * 每日一言的三个页面入口（往期一言 / 一言集 / 我的投稿）共用这一组导航。
 *
 * 【当前项是 span 不是链接】指向当前页面的链接没有可去的地方，但视觉上仍要标出
 * 「你在哪」——所以当前项渲染成 `<span aria-current="page">`：读屏软件播报当前页，
 * 指针不会变成手形，键盘也不会停在一个点了没反应的东西上。
 *
 * 【这里是服务端组件】三页都是 SSR 首屏，当前项由页面自己传 `current` 决定；
 * 不要改成客户端 `usePathname()` —— 那会把导航连同三页的判定一起拖进 bundle，
 * 而它恰恰只有这三个固定落点。
 */
const ITEMS = [
  { key: 'history', href: '/checkin/quotes', label: '往期一言' },
  { key: 'saved', href: '/favorite/quotes', label: '一言集' },
  { key: 'submissions', href: '/checkin/submissions', label: '我的投稿' },
] as const;

export type DailyQuoteNavKey = (typeof ITEMS)[number]['key'];

export default function DailyQuoteNav({ current }: { current?: DailyQuoteNavKey }) {
  return (
    <nav className="daily-quote-nav" aria-label="每日一言相关">
      {ITEMS.map((item) =>
        item.key === current ? (
          <span key={item.key} className="daily-quote-nav__item is-active" aria-current="page">
            {item.label}
          </span>
        ) : (
          <Link key={item.key} href={item.href} className="daily-quote-nav__item">
            {item.label}
          </Link>
        )
      )}
    </nav>
  );
}
