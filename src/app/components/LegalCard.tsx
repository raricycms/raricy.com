// 法律 / 协议正文卡片容器（用户协议、隐私政策等纯文本页用）。
// 样式见 styles-scss/pages/_notifications.scss 的 .legal-card，对齐博客详情的卡片观感。
export default function LegalCard({ children }: { children: React.ReactNode }) {
  return <div className="legal-card">{children}</div>;
}
