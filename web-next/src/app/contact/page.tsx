import type { Metadata } from 'next';
import FooterNote from '@/app/components/FooterNote';

// 对齐 app/templates/home/contact.html：文案 / 结构逐字保留；
// 原页自带 <style>（.contact-card / .contact-icon / .contact-link）一并搬入，
// 引用的 --color-* 令牌在 rebuild.css 中均已定义。Bootstrap 工具类
// (container / row / col-md-8 / text-* / mb-* / lead / list-unstyled) 也已由
// rebuild.css 提供。图标从 bi bi-* 换成本站 icon icon-* 系统（同名映射）；
// 微信无对应 icon，保留文案不加图标。

export const metadata: Metadata = { title: 'Raricy.com - 联系我们' };

const css = `
    body {
        background: var(--color-background-page);
        background-attachment: fixed;
        min-height: 100vh;
    }
    .contact-card {
        margin-top: 50px;
        box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
        padding: 30px;
        border-radius: 15px;
        background: var(--color-background-card);
        backdrop-filter: blur(5px);
        transition: transform 0.3s ease;
    }
    .contact-card:hover {
        transform: translateY(-5px);
    }
    .contact-icon {
        font-size: 1.5rem;
        margin-right: 10px;
        vertical-align: middle;
    }
    .contact-link {
        color: #2575fc;
        text-decoration: none;
        transition: color 0.3s ease;
    }
    .contact-link:hover {
        color: #f28391;
    }
`;

export default function ContactPage() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="container">
        <div className="contact-card">
          <h1 className="text-center mb-4">
            <span className="icon icon-chat-dots contact-icon" aria-hidden="true"></span>联系我们
          </h1>
          <p className="lead text-muted text-center mb-4">遇到问题或有建议？我们随时为您服务</p>

          <div className="row justify-content-center">
            <div className="col-md-8">
              <ul className="list-unstyled">
                <li className="mb-3">
                  <span className="icon icon-envelope contact-icon" aria-hidden="true"></span>
                  电子邮件：
                  <a href="mailto:raricycms@gmail.com" className="contact-link">
                    raricycms@gmail.com
                  </a>
                </li>
                <li className="mb-3">
                  微信号：<span className="contact-link">whitealiveautumn0</span>
                </li>
              </ul>

              <div className="text-center mt-4">
                <p className="text-muted">
                  或通过GitHub提交问题：
                  <a
                    href="https://github.com/raricycms/raricy.com"
                    className="contact-link"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="icon icon-github" aria-hidden="true"></span> 项目仓库
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <FooterNote>
        <p className="text-muted">就在附近！</p>
      </FooterNote>
    </>
  );
}
