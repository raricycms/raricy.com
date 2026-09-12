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
