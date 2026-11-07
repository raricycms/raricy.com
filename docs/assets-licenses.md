# 素材来源与许可

> 本站「素材」的**唯一登记页**：谁生成、许可从哪来、哪些是随代码入库的、哪些是
> `postinstall` 派生物。根 `NOTICE.md` 只保留再分发声明并指向这里；两者不重复登记
> 同一份清单（R3-625 合并入口）。

## 1. 四类静态素材

| 素材 | 位置 | 谁生成 | 入库？ | 许可 / 来源 |
|---|---|---|---|---|
| 头像框 | `public/static/frames/*.png` | `scripts/make-frame-demos.mjs`（SVG 源码即脚本，PNG 为产物） | **入库**（`manifest.json` 记 sha256，`tests/unit/frame-assets.test.ts` 核对） | 本站自绘，适用根 MIT |
| 字体 | `public/static/fonts/**` | `scripts/make-numeric-fonts.py` 生成 `raricy-numeric/`（从 JetBrains Mono 子集化）；其余家族从 Google Fonts 取版本化文件 | **入库**（11 个 WOFF2；`npm run fonts:check` 校验哈希） | 全部 **SIL OFL-1.1**，逐家族来源见 `public/static/fonts/README.md` 与各自 `OFL.txt` |
| 内置黄脸表情 | `public/static/emoji/*.svg` | `scripts/copy-emoji-assets.mjs`（从 `@twemoji/svg` 只拷 `src/lib/emoji-faces.json` 用到的约 100 个） | **不入库**（postinstall 生成，`.gitignore`） | Twemoji：代码 MIT、**图形 CC BY 4.0**；脚本自写正确的 `LICENSE.txt`（上游包内 license 漏了图形许可） |
| 格式转换器引擎 | `public/static/converter/**`（约 65MB） | `scripts/copy-converter-assets.mjs`（从 `@ffmpeg/core`、`pdfjs-dist`、`tesseract.js`、`7z-wasm`、`unrar` 等拷贝） | **不入库**（postinstall 生成；`npm run converter:check` 自检） | 逐包 **Apache-2.0 / MIT** 等，脚本把各包 `LICENSE` 汇成 `NOTICE.txt` 放目标目录；RAR/7Z 只解不压是许可与构建事实（见 `docs/format-converter-implementation.md` §8.2） |

> `postinstall` 只跑 emoji + converter 两个拷贝脚本（`npm ci --ignore-scripts` 的环境
> 手工补 `npm run prepare:emoji && npm run prepare:converter`）；字体与头像框**不经过**
> postinstall。生成资产的对外口径（匿名可读、无 CSP、无缓存头、robots 可抓不列举）见
> `docs/architecture.md` §6.11 的「`/static/` 的对外口径」。

## 2. 第三方图标

`public/static/img/icons/` 下 14 个文件是 [Bootstrap Icons](https://icons.getbootstrap.com/)
（**MIT**，Copyright (c) The Bootstrap Authors）的 SVG 副本，随本站一起分发：

```text
bell-fill  book  box-arrow-right  controller  envelope  gear  gear-fill
github  heart-fill  journal-text  person  person-circle  star-fill  tools
```

其余图标（`add` / `arrow-left` / `calendar-check` / `chat-dots_new` / `clipboard` /
`eye-fill` / `fish` / `house` / `link` / `market` / `pencil-fill` / `person-fish-fill` /
`person-heart-fill` / `theme-toggle` / `trash-fill`）**来源与许可尚未登记，标「待补」**；
补齐前不要单独打包再分发（R3-623）。

## 3. 再分发规则（R3-604）

- 根 `LICENSE`（MIT）**只覆盖本站代码**，不替第三方素材授权；
- 第三方素材只有在其自身许可允许再分发时才入库；许可不明 / 禁止再分发的**不入库**
  （运行时数据与私密部署信息同样不入库）；
- 转发 / 打包本站时保留本页、根 `NOTICE.md` 与各目录自带的许可文件
  （`public/static/quandi/NOTICE.txt`、`public/static/fonts/README.md` 等）；
- 自行创作的素材（头像框、图标等）随代码入库，适用根 MIT。
