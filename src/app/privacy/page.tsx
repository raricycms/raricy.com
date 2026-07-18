import type { Metadata } from 'next';

// 对齐 app/templates/home/privacy.html：正文逐字保留，原页自带 <style>（.policy-card）
// 一并搬入；引用的 --color-* 令牌在 rebuild.css 中均已定义。

export const metadata: Metadata = { title: 'Raricy.com - 隐私政策' };

const css = `
    body {
        background: var(--color-background-page);
        background-attachment: fixed;
        min-height: 100vh;
    }
    .policy-card {
        margin-top: 30px;
        margin-bottom: 40px;
        box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
        padding: 35px 40px;
        border-radius: 15px;
        background: var(--color-background-card);
        backdrop-filter: blur(5px);
    }
    .policy-card h1 {
        color: var(--color-text-primary);
        font-size: 1.8rem;
        margin-bottom: 0.5rem;
    }
    .policy-card h2 {
        color: var(--color-brand-primary);
        font-size: 1.3rem;
        margin-top: 2rem;
        margin-bottom: 0.8rem;
        padding-bottom: 0.3rem;
        border-bottom: 1px solid var(--color-border);
    }
    .policy-card h3 {
        color: var(--color-text-primary);
        font-size: 1.05rem;
        margin-top: 1.2rem;
        margin-bottom: 0.5rem;
    }
    .policy-card p, .policy-card li {
        color: var(--color-text-secondary);
        line-height: 1.8;
        font-size: 0.95rem;
    }
    .policy-card ul, .policy-card ol {
        padding-left: 1.5rem;
        margin-bottom: 1rem;
    }
    .policy-card li {
        margin-bottom: 0.3rem;
    }
    .policy-card .last-updated {
        color: var(--color-text-tertiary);
        font-size: 0.85rem;
        text-align: right;
        margin-top: 2.5rem;
        border-top: 1px solid var(--color-border);
        padding-top: 1rem;
    }
    @media (max-width: 768px) {
        .policy-card {
            padding: 20px 18px;
            margin-top: 15px;
        }
        .policy-card h1 { font-size: 1.5rem; }
        .policy-card h2 { font-size: 1.15rem; }
    }
`;

export default function PrivacyPage() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="container">
        <div className="policy-card">
          <h1>隐私政策</h1>
          <p>
            Raricy.com（聪明山）高度重视您的隐私。本隐私政策详细说明了我们在您使用本网站时如何收集、使用和保护您的个人信息。请仔细阅读。
          </p>

          <h2>1. 我们收集的信息</h2>
          <h3>1.1 账号信息</h3>
          <p>在您注册账号时，我们会收集以下信息：</p>
          <ul>
            <li>
              <strong>用户名</strong>：您在网站上的显示名称和登录标识。
            </li>
            <li>
              <strong>电子邮箱地址</strong>：用于账号标识和联系。本网站不会向您发送营销邮件或垃圾邮件。
            </li>
            <li>
              <strong>密码</strong>：您的密码使用 bcrypt 算法进行哈希处理后存储，我们不会以明文形式存储您的密码。
            </li>
            <li>
              <strong>邀请码</strong>（可选）：注册时可选择提供，用于提升用户角色。
            </li>
            <li>
              <strong>个人简介</strong>（可选）：您可以在个人主页填写一段简短的自我介绍（最长 500
              字），该内容将公开展示。
            </li>
            <li>
              <strong>最后登录时间</strong>：系统会在您每次登录时记录当前时间，并公开展示在您的个人主页上。
            </li>
          </ul>
          <p>
            注册成功后，网站会自动为您生成一个头像图片（基于用户 ID 的确定性图案）。您也可以上传自定义头像。
          </p>

          <h3>1.2 我们不收集的信息</h3>
          <p>
            为最大限度地保护您的隐私，本网站明确<strong>不收集</strong>以下信息：
          </p>
          <ul>
            <li>
              <strong>IP 地址</strong>：本网站任何地方均不记录或存储用户的 IP 地址。
            </li>
            <li>
              <strong>浏览行为</strong>：不使用任何分析或追踪服务（如 Google Analytics、百度统计等）。
            </li>
            <li>
              <strong>设备指纹</strong>：不收集浏览器指纹、User-Agent 或其他设备标识信息。
            </li>
            <li>
              <strong>位置信息</strong>：不收集任何地理位置数据。
            </li>
          </ul>

          <h2>2. Cookie 使用</h2>
          <p>
            2.1 本网站仅使用维持网站基本功能所必需的会话 Cookie（Session Cookie）。该 Cookie
            用于在您登录后维持认证状态，属于技术必要型 Cookie。
          </p>
          <p>
            2.2 本网站<strong>不使用</strong>任何第三方 Cookie、追踪 Cookie、广告 Cookie
            或社交媒体追踪像素。
          </p>
          <p>
            2.3 会话 Cookie 在您关闭浏览器后即失效（不设"记住我"功能）。您可以在浏览器设置中禁用
            Cookie，但这可能导致无法正常登录和使用网站。
          </p>
          <p>
            2.4 您的主题偏好（浅色/深色模式）存储在浏览器的 localStorage
            中，该数据仅存在于您的设备上，不会发送至服务器。
          </p>

          <h2>3. 第三方服务</h2>
          <h3>3.1 Cloudflare Turnstile（人机验证）</h3>
          <p>
            为防止自动化程序恶意注册，本网站在注册页面可能启用 Cloudflare Turnstile
            人机验证服务。Turnstile 是 Cloudflare
            提供的隐私友好型验证方案，不依赖 Cookie，不使用用户数据用于广告目的。该服务仅在站长启用时生效，并非始终运行。Turnstile
            的隐私政策请参阅 Cloudflare 官方网站。
          </p>

          <h3>3.2 Google 站点验证</h3>
          <p>
            网站首页包含 Google Search Console 的域名验证 meta 标签，仅用于向 Google
            证明域名所有权，不向 Google 传输任何用户数据。
          </p>

          <h3>3.3 无其他第三方服务</h3>
          <p>
            本网站不使用任何 CDN 托管的第三方脚本、字体或样式库。所有静态资源（CSS、JavaScript、图标）均由本站服务器直接提供。网站不包含社交媒体分享按钮或嵌入第三方内容。
          </p>

          <h2>4. 用户生成的内容</h2>
          <p>
            4.1
            您在使用网站功能时，可能会主动发布以下类型的内容：博客文章、评论、投票、剪贴板条目、图片上传、照片墙放置、个人简介。这些内容会被存储在网站服务器上，并根据您设定的可见性（公开/私有）展示给其他用户。
          </p>
          <p>
            4.2
            您可以随时编辑或删除自己发布的内容。删除操作通常为软删除（内容在前端隐藏，但保留在数据库中），这是为了在出现争议或申诉时可供核查。
          </p>

          <h2>5. 通知系统</h2>
          <p>
            5.1
            本网站使用站内通知系统，在发生以下事件时通知您：您的文章被点赞或评论、您的评论收到回复、管理员对您的内容进行了编辑或删除、管理员对您进行了禁言或解禁、站长发送的系统公告或通知、申诉相关通知。
          </p>
          <p>
            5.2 通知完全在网站内部实现，<strong>不会</strong>通过电子邮件、短信或其他外部渠道发送。
          </p>
          <p>5.3 已读通知将在 30 天后自动清理删除。未读通知将一直保留。</p>

          <h2>6. 数据存储与保留</h2>
          <p>6.1 您的数据存储在网站服务器的数据库中（SQLite 或 PostgreSQL，取决于部署配置）。</p>
          <p>6.2 数据保留期限：</p>
          <ul>
            <li>
              <strong>账号信息</strong>：保留至您请求删除账号为止。
            </li>
            <li>
              <strong>用户生成内容</strong>：您删除的内容采用软删除机制（数据库记录保留但前端不可见），以便在申诉或合规需要时核查。
            </li>
            <li>
              <strong>通知记录</strong>：已读通知保留 30 天后自动清理；未读通知保留至您标记为已读之后 30
              天。
            </li>
            <li>
              <strong>禁言历史</strong>：作为管理记录长期保留。
            </li>
            <li>
              <strong>管理员操作日志</strong>：作为审计记录长期保留。
            </li>
          </ul>
          <p>
            6.3
            您可以请求删除您的账号。账号删除后，您的用户名、邮箱等个人信息将从系统中移除。您发布的内容可能被匿名化处理或根据实际情况保留。
          </p>

          <h2>7. 数据安全</h2>
          <p>7.1 我们采用以下措施保护您的数据安全：</p>
          <ul>
            <li>密码使用 bcrypt 算法进行单向哈希，即使数据库泄露也无法还原明文密码；</li>
            <li>
              生产环境使用 HTTPS 加密传输（通过 Nginx 反向代理，配置了 ProxyFix 中间件以确保正确的
              HTTPS 行为）；
            </li>
            <li>上传的图片文件经过 Pillow 图像库重新编码处理，防止图片中嵌入恶意代码；</li>
            <li>SVG 文件以附件方式提供下载而非内联显示，防止 XSS 攻击；</li>
            <li>用户输入内容（评论、留言等）均进行 HTML 转义处理，防止跨站脚本攻击。</li>
          </ul>
          <p>
            7.2
            尽管我们采取了合理的安全措施，但请注意没有任何网络传输或电子存储方法是 100%
            安全的。我们会尽力保护您的个人信息，但无法保证绝对安全。
          </p>

          <h2>8. 您的权利</h2>
          <p>根据适用法律，您对自己的数据拥有以下权利：</p>
          <ul>
            <li>
              <strong>访问权</strong>：查看您的个人资料、发布的内容和通知记录；
            </li>
            <li>
              <strong>更正权</strong>：修改您的用户名、邮箱、密码、头像、个人简介和通知偏好设置；
            </li>
            <li>
              <strong>删除权</strong>：删除您发布的内容（博客、评论、留言、图片等）；请求删除您的账号；
            </li>
            <li>
              <strong>控制权</strong>：自主选择接收或关闭各类通知；
            </li>
            <li>
              <strong>申诉权</strong>：对管理员的操作提出申诉，要求复核。
            </li>
          </ul>
          <p>如需行使以上权利，您可以通过网站设置页面自行操作，或通过本政策末尾的联系方式取得联系。</p>

          <h2>9. 封禁与申诉</h2>
          <p>
            9.1
            当用户违反网站规定时，管理员有权对用户实施禁言。禁言记录包含：禁言原因、禁言期限、执行管理员等信息。
          </p>
          <p>9.2 禁言历史将存储在系统中，用于管理透明度和后续审核参考。</p>
          <p>
            9.3
            被禁言的用户可以通过审计日志公示页面提交申诉，或通过电子邮件联系站长。申诉的处理过程和结果将通知申诉用户。
          </p>

          <h2>10. 数据共享与披露</h2>
          <p>
            10.1 我们<strong>不会</strong>将您的个人信息出售、出租或交易给任何第三方。
          </p>
          <p>10.2 我们不会将您的数据用于广告投放、用户画像或自动化决策。</p>
          <p>10.3 我们不会向您发送任何营销邮件或推广信息（本网站根本不具备邮件发送功能）。</p>
          <p>10.4 仅在以下情况下，我们可能会披露您的信息：</p>
          <ul>
            <li>获得您的明确同意；</li>
            <li>法律法规或行政、司法机关的强制性要求。</li>
          </ul>

          <h2>11. 未成年人的隐私</h2>
          <p>
            本网站不对未成年人设有特殊的数据收集机制。如果您是未成年人，请在监护人的指导和同意下使用本网站。如果您是监护人并认为您的被监护人未经您同意向我们提供了个人信息，请联系我们，我们将及时删除相关数据。
          </p>

          <h2>12. 政策更新</h2>
          <p>12.1 我们可能会不时更新本隐私政策。更新后的政策将在网站上公布。</p>
          <p>12.2 重大变更，我们会通过站内通知方式告知您。</p>
          <p>12.3 在政策更新后继续使用本网站，即表示您接受更新后的隐私政策。</p>

          <h2>13. 联系方式</h2>
          <p>
            如您对本隐私政策有任何疑问、意见或请求（包括数据删除、申诉等），请通过以下方式联系我们：
          </p>
          <ul>
            <li>电子邮件：raricycms@gmail.com</li>
            <li>
              GitHub：
              <a href="https://github.com/raricycms/raricy.com" target="_blank" rel="noreferrer">
                https://github.com/raricycms/raricy.com
              </a>
            </li>
          </ul>

          <div className="last-updated">最后更新：2026年6月16日</div>
        </div>
      </div>
    </>
  );
}
