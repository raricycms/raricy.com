import type { MetadataRoute } from 'next';

// ─────────────────────────────────────────────────────────────────────────────
// Web App 清单（PWA 元数据第一档）。
//
// Next 会自动往 <head> 注入 <link rel="manifest" href="/manifest.webmanifest">——
// 所以 layout 的 metadata 里**不要再手写 manifest 字段**，那会得到两条 link。
//
// 图标只有 PNG 一套，住 public/static/img/pwa/，由 scripts/make-pwa-icons.mjs 从
// 站点既有几何 favicon 派生（不是另画的品牌）。改了那个脚本就要重跑并提交素材，
// tests/unit/pwa-metadata.test.ts 会对着脚本写的 pwa/manifest.json 核对。
//
// start_url / scope / id 使用根路径（'/'），换域名后仍在当前 origin 下打开。
//    id 固定成 '/' 是为了让「同一个应用」
//    在将来改 start_url 时仍被识别为同一款，不至于重复安装一份。
//
// theme_color / background_color = 站点浅色页面底色（--color-background-page，#F8FAFC）。
// 深色主题下不会自动变色 —— manifest 是静态清单，浏览器窗口镶边的颜色交给运行时
// 的 <meta name="theme-color">（首帧前由 layout 的内联脚本按主题设、之后由 base.js
// 的 switchTheme 更新），两者刻意分工。
// ─────────────────────────────────────────────────────────────────────────────
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: '聪明山',
    short_name: '聪明山',
    description: '我们总将找到答案',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'zh-CN',
    dir: 'ltr',
    theme_color: '#F8FAFC',
    background_color: '#F8FAFC',
    icons: [
      // 普通图标（any）：保留透明背景，就是 favicon 的等比缩放。
      { src: '/static/img/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/static/img/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // 蒙版图标（maskable）：铺满站点底色 + 中央安全区留白，可被系统裁成任意形状。
      {
        src: '/static/img/pwa/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/static/img/pwa/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
