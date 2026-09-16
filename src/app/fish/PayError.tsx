import type { ReactNode } from 'react';

// 付款相关页面的统一错误卡片（收银台 /fish/pay 与扫码收款页 /fish/collect 共用）。
//
// 文案全是我们自己的字面量，**不含任何用户输入** —— 参数不合法时页面能展示的信息
// 越少越好（不回显对方拼的 URL，免得变成反射型内容的载体）。
export default function PayError({
  heading,
  title,
  message,
  hint,
}: {
  /** 页面标题（h1） */
  heading: string;
  /** 卡片标题 */
  title: string;
  message: string;
  hint: ReactNode;
}) {
  return (
    <div className="content-wrapper">
      <h1 className="page-title">{heading}</h1>
      <div className="market-card pay-error">
        <p className="pay-error__title">{title}</p>
        <p className="pay-error__message">{message}</p>
        <p className="pay-error__hint">{hint}</p>
      </div>
    </div>
  );
}
