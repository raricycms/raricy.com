/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 启用 forbidden()/unauthorized() —— 让受控页在原地渲染 403 页(对齐原站 abort(403))
  experimental: { authInterrupts: true },
  // 部署打包时可开启 output:'standalone'；本地沙箱下其 file-tracing 复制步骤会 ENOENT，
  // 故本地默认关闭（不影响 npm start 预览）。部署时再打开。
  serverExternalPackages: ['sharp', 'fernet', '@prisma/client'],
  // 与父级 Flask 仓库共存：显式声明本项目为 tracing 根，避免 Next 误选上层 lockfile
  outputFileTracingRoot: import.meta.dirname,
  // 图床与头像在迁移期间仍由 Flask 提供（instance/images、/auth/avatar）。
  // 通过 rewrites 把这些路径代理回 Flask，前端无需感知过渡状态。
  async rewrites() {
    const flask = process.env.FLASK_ORIGIN || 'http://127.0.0.1:5050';
    return [
      { source: '/auth/avatar/:id', destination: `${flask}/auth/avatar/:id` },
      { source: '/image/:path*', destination: `${flask}/image/:path*` },
    ];
  },
};

export default nextConfig;
