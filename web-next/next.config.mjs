/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 启用 forbidden()/unauthorized() —— 让受控页在原地渲染 403 页(对齐原站 abort(403))
  experimental: { authInterrupts: true },
  // 部署打包时可开启 output:'standalone'；本地沙箱下其 file-tracing 复制步骤会 ENOENT，
  // 故本地默认关闭（不影响 npm start 预览）。部署时再打开。
  serverExternalPackages: ['sharp', 'fernet', '@prisma/client'],
  // 显式声明本项目为 tracing 根，避免 Next 误选上层 lockfile
  outputFileTracingRoot: import.meta.dirname,
  // 头像与图床已由 Next 原生分发（/api/avatar/[id] 读 instance/avatars、
  // /api/images/[id]/raw 读 instance/images），前端也全部改用 /api/* 路径，
  // 因此不再需要把 /auth/avatar、/image 代理回 Flask —— web-next 已完全独立于 Flask。
};

export default nextConfig;
