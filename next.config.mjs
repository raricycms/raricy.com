/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // 启用 forbidden()/unauthorized() —— 让受控页在原地渲染 403 页(对齐原站 abort(403))
    authInterrupts: true,
    // 请求体缓冲上限（默认 10MB）：有中间件时 Next 会把整个 body 缓冲进内存，
    // 超出部分被**直接截断**（只警告一句，不报错），路由拿到半截 body ——
    // multipart 解析失败 → 图床上传返回「无效的上传请求」。
    // 默认值正好等于图床单文件上限（10MB，见 image-upload.ts），于是自家上限永远
    // 用不满：接近 10MB 的图必失败。抬到 12MB 与 nginx 的 client_max_body_size 对齐，
    // 给 multipart 边界留出余量。
    middlewareClientMaxBodySize: '12mb',
  },
  // ── 旧 Flask 地址兼容（rewrite，不是跳转）────────────────────────────────
  //
  // Flask 的图床直链是 `/image/i/<id>`（app/web/image_hosting/__init__.py 的
  // `@image_bp.route('/i/<image_id>')`），头像直链是 `/auth/avatar/<user_id>`
  // （app/web/auth/profile.py）。迁移到 Next 后改成了 `/api/images/<id>/raw` 与
  // `/api/avatar/<id>`，而**存量内容里的旧地址是写死在正文里的**（截至 2026-09：
  // 55 篇博客 / 110 处 URL 指向 raricy.com 的旧图床地址），不接就会全变碎图。
  //
  // 用 rewrite 而不是 redirect：旧地址保持可用且**不改地址栏、不多一次往返**；
  // 而且目标路由的 404 / 私有图鉴权 / SVG 强制 attachment / Cache-Control /
  // X-Robots-Tag 全部自动继承，一行逻辑都不用复制。
  //
  // 注意：内容里还有一类老地址（`http://116.62.179.232:22822/image/i/...`）——
  // host 写死在正文里，站内路由管不着，只能改存量内容，本文件救不了。
  async rewrites() {
    return [
      { source: '/image/i/:id', destination: '/api/images/:id/raw' },
      { source: '/auth/avatar/:id', destination: '/api/avatar/:id' },
    ];
  },
  // 部署打包时可开启 output:'standalone'；本地沙箱下其 file-tracing 复制步骤会 ENOENT，
  // 故本地默认关闭（不影响 npm start 预览）。部署时再打开。
  serverExternalPackages: ['sharp', 'fernet', '@prisma/client'],
  // 显式声明本项目为 tracing 根，避免 Next 误选上层 lockfile
  outputFileTracingRoot: import.meta.dirname,
  // 头像与图床已由 Next 原生分发（/api/avatar/[id] 读 instance/avatars、
  // /api/images/[id]/raw 读 instance/images），前端也全部改用 /api/* 路径，
  // 因此不再需要把 /auth/avatar、/image 代理回 Flask —— web-next 已完全独立于 Flask。
  // SCSS 来自 Flask 项目的 app/static/scss 整树拷贝（src/styles-scss/）。
  // 运行 npm run build:css（一次性）或 dev:css（监听）把 SCSS 编译到
  // src/styles-scss/compiled/flask.css，由 src/app/layout.tsx 全局导入。
  sassOptions: { includePaths: ['./src/styles-scss'] },
};

export default nextConfig;
