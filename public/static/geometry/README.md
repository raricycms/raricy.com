# 几何计算器（本地化副本）

- 原作：<https://github.com/NovaCyclone/xcxGeometry>
- 作者：NovaCyclone
- 上游提交：`570b349141d75429f717bb2e3e8541bdff84f322`（2026-10-18）
- 本站入口：`/tool/geometry`

本目录是原作的本地化副本，经作者同意部署到聪明山工具箱。页面全部是纯静态 HTML / JS，
所有计算都在浏览器本地完成，没有服务端请求、没有外部依赖、不读写 cookie 或 localStorage。

## 与上游的差异

- **补上缺失的 `document/math-page.css`**：上游把该文件误命名为 `mathpath.css`，而
  `derivative` / `lagrange` / `ellipseline` / `paraline` / `hyperline` 五页引用的是
  `math-page.css`，导致这些页面原先没有页面骨架、公式编辑器与结果区样式。这里按引用名落盘。
- 每页补 `charset` / `viewport` / `lang="zh-CN"`（上游部分页面缺失，窄屏会缩成桌面版）。
- 普通计算器的结果改走公共 `FormulaRender`：上游内联渲染器只认单个结构，会把
  `3*p(a,2)+2*a+1`、`5*a` 这类结果原样吐出来；公共版会拆乘除、渲染上标。
- 返回链接改为站内 `/tool/geometry`，标题按本站工具名统一。
- 移除原作者留下的 `console.log` 调试输出（保留 `console.error` / `console.warn`）。
- 未采用上游的 `index.html`：索引页改由 `/tool/geometry` 用本站组件渲染（与原索引的功能一致）。
- 未采用上游的 `.github/workflows/`：它调用的 `npm install` / `npm run build` 在本仓库
  没有对应的 `package.json` 与 `dist/`，推上去只会失败。
- 上游索引里登记了一个不存在的 `triangle.html`，本站索引不再列出该条目。

## 已知限制

- 符号引擎只处理整数与有理数，**不支持小数输入**（`0.5` 会报「无效表达式」）。
- 参数只支持 `a` / `b` / `h`（普通计算器）或页面各自声明的变量。
- 页面使用固定的浅色配色，不跟随本站 `data-theme` 深色主题。
