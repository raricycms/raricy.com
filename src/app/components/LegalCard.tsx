// 法律 / 协议正文卡片容器（用户协议、隐私政策等纯文本页用）。
// 样式见 styles-scss/pages/_notifications.scss 的 .legal-card，对齐博客详情的卡片观感。
//
// 【与 components/_card.scss 的 .card 不是同一语义，别合并】这里是法务长文容器，
// .card 是审计详情 / 鱼干统计的数据卡；圆角与底色接近是视觉巧合（R3-643）。
export default function LegalCard({ children }: { children: React.ReactNode }) {
  return <div className="legal-card">{children}</div>;
}
