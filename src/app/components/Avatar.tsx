import type { CSSProperties, MouseEventHandler } from 'react';
import { avatarUrl } from '@/lib/avatar-refs';

// ─────────────────────────────────────────────────────────────────────────────
// Avatar —— 全站**唯一**渲染头像的地方
//
// 【为什么要有它】此前 15 处各写各的 `<img src={/api/avatar/${id}}>`，每个都自己
// 拼模板串、自己记得写 `border-radius: 8%`。头像框要显示得到处都是，就必须先把
// 它们收敛 —— 否则「加一个框」意味着改 15 个文件，而**漏掉的那一处只会永远没有框**，
// 不报错。落点台账与静态守卫见 tests/unit/avatar-sites-guard.test.ts。
//
// 【为什么没有 'use client'】本组件不碰任何浏览器 API，所以：
//   · 被服务端组件 import → 就在服务端渲染（博客列表 20 个头像 = 0 个 island）
//   · 被客户端组件 import → 进客户端包
// 加一个 `onError` 隐藏破图就会强制它变成客户端组件，让 15 处头像**全部**变成
// hydration 边界。代价换来的是一道已经用「盘上双闸」堵死的失败路径，**不加**。
//
// 【为什么可以 import avatar-refs】那是**零依赖**模块（不碰 fs / prisma），
// 专门为客户端拆出来的（见它的文件头）。绝不能 import 的是 `@/lib/avatar`（读盘）
// 与 `@/lib/frame-service`（读盘 + prisma）—— 那会让客户端组件炸构建。
//
// 【★ 组件永不推导「谁该戴框」★】`frameUrl` 只从外面传进来，且必须来自
// `frame-service.frameUrlFor()`（唯一的判定出口，含到期判定）。组件这里一旦自己
// 拿 key 去算，就绕过了到期 —— 而那正是 db-time-guard 在静态层面拦着的写法。
// ─────────────────────────────────────────────────────────────────────────────

export interface AvatarProps {
  /** 头像归属者 id。与 `src` 二者至少有一个，都没有则**不渲染**（匿名评论者那条路）。 */
  userId?: string | null;
  /**
   * 头像地址。DTO 已经给了就传（例：评论链路的 `avatar_url`）。
   * 缺省走 `avatarUrl(userId)` —— 别在调用点自己拼模板串，全仓只允许一处拼
   *（tests/unit/avatar-sites-guard.test.ts 盯着）。
   */
  src?: string | null;
  /**
   * 头像框贴图地址，来自 DTO 的 `frame_url` / `frameUrl`。
   * ⚠️ **必须**是 `frameUrlFor()` 的产物，组件不推导、也不判到期。
   */
  frameUrl?: string | null;
  alt: string;

  /** 挂在**外层盒子**上的类（原来是 `.site-user-avatar` / `.chat-msg__avatar` 那一层）。 */
  className?: string;
  /** 挂在**头像 `<img>`** 上的类（原来是 `.comment-author-avatar` 那种直接给 img 的）。 */
  imgClassName?: string;
  /**
   * 仅给原先用**内联尺寸**的那几处（FeedButton 的弹窗名单）。
   * 走内联是因为 `docs/frontend-styles.md` §4.1 明确要求「内联样式同样写
   * `border-radius: '8%'`，不要写死 px」。
   */
  size?: number;
  style?: CSSProperties;

  /**
   * 外层元素。默认 `span`；讨论消息作者那处原先是个 `<button>`（点开头像选项框），
   * 传 `'button'` 保持可点击语义。
   */
  as?: 'span' | 'button';
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  /** 只在 `as="button"` 时有意义（span 上没有 role，加 aria-label 是噪音）。 */
  ariaLabel?: string;
  loading?: 'lazy' | 'eager';
}

export default function Avatar({
  userId,
  src,
  frameUrl,
  alt,
  className,
  imgClassName,
  size,
  style,
  as = 'span',
  onClick,
  title,
  ariaLabel,
  loading,
}: AvatarProps) {
  // ⚠️ 用 `||` 而不是 `??`：DTO 给了**空串**时要当成「没给」，回落到 identicon 兜底
  //（那条路永不 404）。用 `??` 的话空串会被当成一个有效地址穿过 `if (!url)` 的检查，
  // 结果是整个头像不渲染 —— 而「看不到」与「没头像」在页面上长得一样。
  const url = src || (userId ? avatarUrl(userId) : null);
  // 既没有可用的 src 也没有 userId —— 不渲染，而不是渲染一个空 src（那会让浏览器去
  // 请求当前页面地址并画一张裂图）。匿名评论者那条路在这里。
  if (!url) return null;

  const boxClass = className ? `avatar ${className}` : 'avatar';
  const boxStyle: CSSProperties | undefined = size
    ? { width: size, height: size, borderRadius: '8%', ...style }
    : style;
  const imgClass = imgClassName ? `avatar__img ${imgClassName}` : 'avatar__img';

  const layers = (
    <>
      <img className={imgClass} src={url} alt={alt} loading={loading} />
      {frameUrl ? (
        // alt 留空 + aria-hidden：这是纯装饰，屏读器再念一遍用户名是噪音。
        // draggable={false} 与 pointer-events:none 是同一件事的两道保险
        //（后者在 _avatar.scss 里）。
        <img
          className="avatar__frame"
          src={frameUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ) : null}
    </>
  );

  if (as === 'button') {
    return (
      <button
        type="button"
        className={boxClass}
        style={boxStyle}
        onClick={onClick}
        title={title}
        aria-label={ariaLabel}
      >
        {layers}
      </button>
    );
  }

  return (
    <span className={boxClass} style={boxStyle} title={title}>
      {layers}
    </span>
  );
}
