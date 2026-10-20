import type { ReactNode } from 'react';

// 管理端抬头 —— /admin/* 与 /audit 共用的版式。
//
// 结构契约（tests/e2e/page-gutter.spec.ts 按真视口量）：
//   · 根节点必须是 `.admin-hero`，标题是**根节点里的 h1**，说明是**根节点里的 p**
//     —— 那条用例取 `main h1` 与 `.admin-hero p`，换结构会当场判红。
//   · 横向檐沟由 AdminShell 的 .admin-layout 给（20px），这里**不能再加**
//     左右内距，否则窄屏下标题会离屏幕边 40px。
export default function AdminPageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  /** 标题上方的小胶囊（分类标签 / 图标 + 文字）。 */
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 右侧操作区；窄屏自动落到标题下方。 */
  actions?: ReactNode;
}) {
  return (
    <section className="admin-hero">
      <div className="admin-hero__inner">
        <div className="admin-hero__text">
          {eyebrow ? <span className="admin-hero__eyebrow">{eyebrow}</span> : null}
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="admin-hero__actions">{actions}</div> : null}
      </div>
    </section>
  );
}
