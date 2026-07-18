// 本地空 PostCSS 配置：覆盖父级 Flask 项目的 postcss.config.js（其导出函数，
// Next.js 不接受）。Next 内置处理，无需额外插件。
const config = { plugins: {} };
export default config;
