import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // 启用 forbidden()/unauthorized() —— 让受控页在原地渲染 403 页
    authInterrupts: true,
    // 请求体缓冲上限（默认 10MB）：有中间件时 Next 会把整个 body 缓冲进内存，
    // 超出部分被**直接截断**（只警告一句，不报错），路由拿到半截 body ——
    // multipart 解析失败 → 图床上传返回「无效的上传请求」。
    // 默认值正好等于图床单文件上限（10MB，见 image-upload.ts），于是自家上限永远
    // 用不满：接近 10MB 的图必失败。抬到 12MB 与 nginx 的 client_max_body_size 对齐，
    // 给 multipart 边界留出余量。
    middlewareClientMaxBodySize: '12mb',
  },
  // ── 旧地址兼容（rewrite，不是跳转）──────────────────────────────────────
  //
  // 历史直链：图床是 `/image/i/<id>`，头像是 `/auth/avatar/<user_id>`；现在这两条
  // 分别由 `/api/images/<id>/raw` 与 `/api/avatar/<id>` 承接，而**存量内容里的
  // 旧地址是写死在正文里的**（截至 2026-09：55 篇博客 / 110 处 URL 指向
  // raricy.com 的旧图床地址），不接就会全变碎图。
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
  // 因此 /auth/avatar、/image 这两个前缀也由本应用自己承接（上面的 rewrite 转发到
  // 本应用的 /api/* 路由），没有需要代理到外部实现的路径了。
  // SCSS 整树来自上一版实现（src/styles-scss/）。
  // src/app/layout.tsx 直接 import 入口 main.scss，由 Next 自己编译
  // （dev 走 HMR，build 走下面的 sassOptions），没有任何手工编译步骤，也不入库产物。
  //
  // includePaths 用绝对路径：相对的会被 sass-loader 按 process.cwd() 解析，是 cwd 敏感的。
  // 注意它**目前用不到** —— 71 个 SCSS 文件全是显式相对 `@use`（Sass 解析时先相对当前
  // 文件找），实测带不带它输出完全一致。留着当保险，别在构建报找不到样式表时先怀疑它。
  sassOptions: { includePaths: [path.join(import.meta.dirname, 'src/styles-scss')] },
};

export default nextConfig;
