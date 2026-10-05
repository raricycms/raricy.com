# 编辑器换代方案（Vditor → 自研）

> **状态：方案，未实施。** 本文只写「打算怎么做、为什么、要动哪些文件」。
> 起因见 §1；结论一句话：**换掉 Vditor，但不自研文本引擎** —— 用 CodeMirror 6
> 当内核，自己写集成层与装饰层，预览复用本站已有的正文渲染管线。

## 1. 起因与问题定性

### 1.1 用户反馈

1. **不适应 Typora 的工作流** —— 具体是「单栏就地渲染、源码隐去」；
   另有一条补充症状：**粘贴代码时编辑器会自作主张补上 ` ``` ` 围栏**。
2. **在编辑器里用不上站内的云剪贴板 / 图床 / 音频床 / 收藏夹**；
   `[@…]` 语法只能手打，且**不能预览**。
3. **Vditor 的 markdown 渲染与正文渲染有格式差别。**

### 1.2 逐条定性

三条的性质完全不同，混在一起谈会得出「配一配就好了」的错误结论。

| # | 症状 | 性质 | 能不能靠配置解决 |
|---|------|------|-----------------|
| ① | 单栏就地渲染、源码隐去 | **内核能力** | 否 |
| ①′ | 粘贴自动补 ` ``` ` | **内核行为**（同上一条的同一个根） | 否 |
| ② | `[@…]` 只能手打 | **基建缺口**（我们自己的东西没接上） | 是（但得写代码） |
| ②′ | 编辑器内不能预览 `[@…]` | **结构性** | 否 |
| ③ | 预览与正文渲染不一致 | **结构性** | 否 |

**关于 ①：这条不是「缺一个模式」。**
`src/app/components/BlogForm.tsx` 早就在用 `mode: 'ir'` —— 那正是 Vditor 照 Typora 做的
即时渲染模式。所以用户说的不是「我要单栏，现在是双栏」，而是
**「Vditor 的 ir 做得不像 Typora」**。它的实现是 contenteditable 加一整套「输入即改结构」
的启发式，粘贴时替用户做决定（自动补围栏就是这一类的产物）。这是内核实现层面的问题，
Vditor 只给了开关，没给「换掉这套启发式」的口子。

**关于 ② 的前半：纯缺口，且缺口比想象的窄。**
插入基建**已经有了**，只是只接在讨论 / 评论上（`src/app/components/RichComposer.tsx`），
没接博客与剪贴板：

- `src/app/components/textarea-insert.ts` —— 往光标处插入一段文本，含三个踩过的坑
  （程序化赋值不触发 React onChange、必须等提交后再量高、先 focus 再 setSelectionRange）
- `src/app/components/StickerPicker.tsx`、`UserPicker.tsx`、`ImagePickerModal.tsx`
- `src/lib/image-client.ts` 的 `uploadImageFile()` —— 完整的浏览器侧图床上传
  （XHR 绕微信 X5、弱网重试一次、总体积闸门），**与编辑器无关**

真正缺的是**五个取数面板**：收藏夹、图床、音频、投票、剪贴板。
现在它们连个入口都没有 —— 收藏夹页面（`src/app/favorite/FavoriteMenu.tsx`）只是显示一句
「写成 `[@xxxxxx]`」让用户自己复制 ID。

**关于 ②′ 与 ③：结构性，根因是同一个 —— 两套渲染器。**

| | 渲染器 |
|---|---|
| 编辑器预览 | Vditor 自带的 lute |
| 正文终稿 | `src/app/components/MarkdownRenderer.tsx`（marked + DOMPurify + `ContentRefProcessor`） |

两套渲染器 → 必然漂移，且 `[@…]` 的展开（要发请求取剪贴板正文、投票数据、收藏夹卡片）
在 Vditor 的预览里**没有地方挂**。所以
`docs/guide/内容引用语法指南.md` 的「八、注意事项」里白纸黑字写着「编辑器中不可预览」。

**Vditor 有一个渲染口子，但它够不到要害 —— 这是「高摩擦的非零解」，不是干净替换。**
查过 vditor 4.0.0 的类型定义（见 §2.2 的来源说明）：

- **够得到的**：`IPreviewOptions.renderers?: ILuteRender` 有约 80 个按节点覆盖 HTML 输出的
  回调（`renderHeading` / `renderTable*` / `renderCodeBlock*` / `renderMath*` / `renderLink`…），
  挂在 `Vditor.md2html()` / `Vditor.preview()` 这两个**静态**方法上。另外实例上还有
  `preview.transform?(html)` 与 `preview.parse?(element)` 两个后钩子。
- **够不到的**：`renderers` **只在 `IPreviewOptions` 上，不在 `IOptions` 上** ——
  `new Vditor(...)` 的实时编辑器够不着它。而**编辑器内联那块 IR 编辑面本身由 Vditor
  内部产出，没有任何「换皮」的口子**，只有上面那两个后钩子。

也就是说：想让预览等价于站点渲染，得用约 80 个回调**在 Lute 的节点模型上重实现一遍**我们的
渲染器，**而且换掉的只是另开一个预览面板**——用户盯着的那个就地渲染的编辑区，还是它自己那套。
**投入产出比明确为负，结论不变：换掉 Vditor。**

### 1.3 现状盘点

全站只有**两处**实例化，但为「跟 Vditor 相处」写的代码量已经超过编辑器本身的业务逻辑：

| 位置 | 用途 |
|------|------|
| `src/app/components/BlogForm.tsx` | 博客发布 / 编辑 |
| `src/app/clipboard/upload/UploadForm.tsx` | 云剪贴板新建 / 编辑 |

围绕它们的自研代码：

- `src/lib/vditor-upload.ts`（195 行）—— 把「Vditor 的上传协议」翻译成
  「本站 `/api/images` 协议」（`fieldName: 'file'`、`format` 回调、去重后缀插在扩展名前…）
- `src/lib/vditor-theme.ts`（89 行）—— 三条主题轨道；其中
  `syncHljsTheme` 是为了绕开「Vditor 拼 `.css` 而 npm 包里只有 `.min.css`」，
  于是抢先占住 `#vditorHljsStyle` 这个 id
- `scripts/copy-vditor-assets.mjs`（190 行）+ `postinstall` 一环 —— 把资源拷进
  `public/static/vditor/`，否则图标 / 高亮 / 导出全 404
- `public/static/js/core/base.js` 的 `if (input.closest('.vditor')) return;` ——
  2026-10 线上事故的产物（否则工具栏里凭空多出「选择文件 / 未选择文件 / ×」三件套）
- `src/styles-scss/pages/_clipboard.scss` 里靠 `#clipboard-editor` 把特异性抬到 0-1-1
  的一段 —— 不这么做就会被后加载的 `vditor/dist/index.css` 的 1px 描边 + 3px 圆角盖掉

测试四个文件、文档六处都在钉这些细节（清单见 §6）。**这是一笔持续付的税。**

## 2. 结论与选型判据

### 2.1 一句话判据

> **新内核不能自带 markdown 渲染器。**

③ 的根因是「预览渲染器 ≠ 正文渲染器」。任何自带渲染器的方案都会把同一个问题原样搬过来 ——
换掉 Vditor 只是换了一个名字不同的 lute。

由此推出三条判据：

1. **要的是文本引擎，不是渲染器。**
2. **输入法必须可靠。** 中文站点，contenteditable 系内核的 composition 处理是长期雷区；
   用户反馈里那条「粘贴被改写」就是这一类的近亲。
3. **能挂行内装饰。** 只有能把「一段区间换成 widget」的内核，才谈得上「源码隐去 + 就地渲染」。

### 2.2 候选

版本 / 日期 / 许可来自 npm registry 与 GitHub API，**查证日期 2026-10-06**。

| 候选 | 最新版（日期） | 内核 | 自带渲染器 | 能复用自己的渲染 | 行内装饰 | 判断 |
|------|---------------|------|-----------|----------------|---------|------|
| Vditor | 4.0.0（2026-08-30） | 自研 contenteditable（ir/sv/wysiwyg 三态），引擎是 Lute（Go→WASM） | **是** | 只能逐节点覆盖，够不到内联编辑面（§1.2） | 否 | 正是要换掉的 |
| **CodeMirror 6** | state 6.7.6 / view 6.43.13（2026-09-22） | **纯文本 + 装饰 API** | 否 | **是** | **是**（`Decoration` / `WidgetType`） | **选定** |
| Milkdown | @milkdown/core 7.22.2（2026-09-23） | ProseMirror + remark | **是** | 否，且 markdown 是 PM 文档的派生（往返有损） | 是 | 否 |
| ByteMD | 1.22.0（**2025-02-12**，此后无新版） | **CodeMirror 5** + remark 渲染 | **是** | 只能部分 | 否 | 否（已基本停更） |
| ProseMirror 自建 | prosemirror-markdown 1.13.8（2026-09-21） | ProseMirror | 否 | 要自己写（正文管线是字符串进字符串出，接不进 PM 文档模型） | 是 | 代价高于 CM6 |
| Lexical | 0.52.0（2026-09-28） | Meta，富文本框架 | 否 | 同上；markdown 只是导入导出层，不是内核 | 是 | 否（仍 0.x，IME issue 多） |
| HyperMD | 0.3.11（**2018-10-07**） | CodeMirror 5 | 否 | — | 是 | 已死，勿选 |
| contenteditable 从零自研 | — | 无 | 否 | 是 | 自己造 | §2.3 |

**两条关于「看起来该排除、其实不能靠翻 GitHub 排除」的事实，写下来免得下次误判：**

1. ⚠️ **CodeMirror 与 ProseMirror 的 GitHub 主仓是 `archived` 状态，但项目没死。**
   作者 Marijn Haverbeke 把开发搬到了自有 forge `code.haverbeke.berlin`，
   npm 上的 `@codemirror/*` 一直在发版（`state` / `view` 在 2026-09-22 同日发版）。
   **只看 GitHub 的最后提交日期会得出「CM6 已停更」的错误结论。**
2. **Vditor 已经出到 4.0.0**，而本站装的是 `^3.10.7`。也就是说「升级 Vditor 大版本」
   在纸面上也是一条备选 —— 但它**一条痛点都打不掉**（§1.2 的三条分别来自
   内核行为、我们的基建缺口、两套渲染器），所以不单列。

**CodeMirror 6 的两个支撑事实：**

- **GFM 开箱即用。** `@codemirror/lang-markdown` 的 `markdownLanguage` =
  CommonMark + **GFM（表格 / 任务列表 / 删除线）** + 上下标 + emoji
  （由 `@lezer/markdown` 的扩展集提供）。中文用户常用的语法没有缺口。
- **有直接可抄的参考实现。** `@atomic-editor/editor`（MIT，React，0.6.2）做的就是
  这件事：非光标行收起标记、图片/表格/任务列表行内渲染、虚拟化只渲染视口、
  `- [ ]` 变可点复选框。**形态与本方案 §3.3 / §3.4 几乎一致**，装饰与原子区间的写法
  可以直接读它的源码。另可参考 `@retronav/ixora`（同思路，但 2023 后停更）
  与 Yandex 的 `@gravity-ui/markdown-editor`（PM + CM6 混用，证明路线可行）。

**体积**（bundlephobia，gzip）：`@codemirror/lang-markdown` 约 175KB（含 lezer 语言依赖）、
`view` 约 79KB、`state` 约 16KB；CM6 可 tree-shake，实际载荷更小。
对照：Vditor 主 JS 约 70KB，但 npm 包 unpackedSize 约 **23.6MB**（全量资源，
现在靠 `scripts/copy-vditor-assets.mjs` 往 `public/static/vditor/` 拷）。

### 2.2.1 「只给 Vditor 补面板、不换内核」能补到什么程度

这是本次**没有选**的一条路，但它不是「什么都做不了」，记下边界免得日后翻案时靠猜：

- ✅ **能补**：`IHintExtend` 可以注册一个触发前缀（`@` / `/`），返回候选列表
  （`html` 展示 + `value` 文本），且 `hint` **可以返回 Promise**（异步取数）。
  也就是说「手打 `[@…]`」这条**用 Vditor 也解得掉** —— 面板 + hint 下拉即可。
- ✅ **能补一半**：另开一个预览面板，用 `Vditor.md2html(md, { renderers })` 逐节点接管输出。
- ❌ **补不掉**：编辑器**就地渲染那块**换不了皮（③ 对用户最直观的那一半），
  粘贴时自作主张的行为改不掉（①′），装饰层也没有（① 的「源码隐去」做不细）。

**所以判据不是「Vditor 能不能补」，而是「补完还剩几条痛点」。答案是三条里还剩两条半。**

### 2.3 明确不做的：从零写文本引擎

**不要写 contenteditable WYSIWYG。** 选区与 Range、输入法 composition、撤销栈、
粘贴净化、跨浏览器差异 —— 每一项都是数月量级，而且**Vditor 让我们痛的正是这一层**。

要写的是**集成层**：工具条、取数面板、装饰规则、上传、主题、草稿。
这恰恰是现在被 Vditor 挡在外面的那一层 —— 我们不是「自己造一个 Vditor」，
是「把 Vditor 挡着的那一段拿回来自己写」。

CodeMirror 6 提供文本引擎（文档模型、选区、撤销、输入法、视口渲染），
我们只提供扩展。这个分界是本文档所有取舍的基础。

## 3. 架构

### 3.1 分层

```
MarkdownEditor（新，博客与剪贴板共用）
├── EditorShell        —— 工具条 / 取数面板挂载 / 状态条   ← 我们写
├── CodeMirror 6 实例  —— 文本引擎、快捷键、撤销栈        ← 现成
├── 装饰扩展           —— 隐藏标记 / widget               ← 我们写
└── 取数面板群         —— 复用 3 个 + 新写 5 个            ← 混合
```

### 3.2 复用清单

这是本方案最省的部分 —— **② 的前半几乎不用写新逻辑**：

| 需求 | 现成的东西 |
|------|-----------|
| 图床上传（选图 / 拖拽 / 粘贴 / 多选 / 重试 / 微信 X5 绕法 / 体积闸门） | `src/lib/image-client.ts` |
| 从图床选已有图 | `src/app/components/ImagePickerModal.tsx` |
| 表情 | `src/app/components/StickerPicker.tsx` |
| 用户名片 | `src/app/components/UserPicker.tsx` |
| 光标插入语义（含三个坑） | `src/app/components/textarea-insert.ts` |
| hljs 亮 / 暗双主题 | `MarkdownRenderer.tsx` 的 `useHljsThemeStyles`（见 §3.6） |
| 正文渲染 / 引用展开 / 数学 / 高亮 | `src/app/components/MarkdownRenderer.tsx` |

**新写**的只有五个取数面板（收藏夹 / 图床 / 音频 / 投票 / 剪贴板）。
它们形状相同：列一页 + 搜索 + 点一下回 token，可照 `ImagePickerModal.tsx` 的骨架做。

### 3.3 装饰层

分两类，**这个划分决定了实现的复杂度**：

**同步 widget** —— 文档一改就能画，不需要任何请求（`raw` 路由直接给字节）：

- `[@10位图床ID]` → `<img src="/api/images/<id>/raw">`
- `[@音频/<ID>]` → `<audio controls>`（注意上限 3 个）
- `[@合集/表情]` → 行内 `<img>`
- `$$…$$` / `$…$` → 公式

**异步 widget** —— 要先取数：

- `[@8位剪贴板ID]`（回正文）、`[@9位投票ID]`（投票数据）、
  `[@6位收藏夹ID]`（卡片）、`[@用户/用户名]`（名片）

CodeMirror 的装饰**必须在 `ViewPlugin` 里同步算出来**，所以异步那条走标准模式：

```
异步解析器（防抖后跑，复用 §3.5 的解析口）
      │ dispatch(StateEffect)
      ▼
StateField<Map<tokenKey, ResolvedRef>>     ← 已解析结果的驻留地
      │ 读 (doc, field)
      ▼
ViewPlugin → DecorationSet
```

**纪律：widget 用的解析结果与终稿渲染用的是同一个来源。** 否则我们就造出了第三套
渲染 —— 正是这次要消灭的东西。这一条要写成守卫（§7）。

### 3.4 「源码隐去」到底隐什么

照 Typora 的口径：**光标所在的行显示源码，其余行隐去标记。**
所以装饰规则必须知道光标位置 —— 这是 `ViewPlugin` 里读 `selection` 的事，
不是「整篇一律隐藏」。

`@atomic-editor/editor`（§2.2）做的正是这个行为，它的 README 原话是
「raw syntax appears only on the line your cursor is on」。**先读它的实现，
再写我们的** —— 这一段不必从零想。

落到本站的语法，要隐的是：`#` 标题符、`**` / `*` / `~~`、`[]()` 的括号与 URL、
`![]()`、`>`、列表符、` ``` ` 围栏（但**围栏里的内容是代码，不隐**）。

`[@…]` token 属于「整段换成 widget」那一类，不适用「光标行显示源码」——
光标进到 widget 里时退回显示 token 原文即可。

### 3.5 前置重构：把 `ContentRefProcessor` 抽出来

`ContentRefProcessor` 现在是 `src/app/components/MarkdownRenderer.tsx` 里的**私有类**
（第 60 行起）。编辑器要在**每个 token** 上用它，必须：

1. 抽到 `src/lib/content-ref-processor.ts`，`MarkdownRenderer` 改为 import；
2. 暴露「**按 token** 解析」的口子（现在只有「整篇 `preprocess`」这一个入口）；
3. **缓存要能跨渲染复用** —— 现在每次 `new ContentRefProcessor(...)` 都是新实例，
   缓存随实例一起丢。「每敲一个字重渲染一次」的编辑器撞上这个，会对每个引用
   反复发请求。

**这是 M0 的先决条件，不是可选项。**

### 3.6 主题

`MarkdownRenderer.tsx` 里的 `useHljsThemeStyles` 已经解决得**比 `vditor-theme.ts` 更好**：
插两份 `<style id="hljs-theme-light|dark">`，靠 `media='not all'` 切换哪份生效 ——
不换 `href`、不用抢 id、**天然没有「离开编辑页要摘掉全局 `<link>`」那个问题**
（那个问题现在由一条 e2e 用例如实描述着）。

所以：把 `useHljsThemeStyles` 抽成公用 hook，**删掉** `syncHljsTheme` /
`removeHljsTheme`，以及 BlogForm 里「必须在 `new Vditor` 之前调用」那个时序陷阱。

编辑器外壳跟随 `<html data-theme>`，颜色一律取 `docs/frontend-styles.md` 的令牌。

### 3.7 草稿与自动保存

- **博客**：Vditor 的 `cache: { enable: true, id: 'blog-upload-editor' }` 提供
  「新建时保留草稿」。自研要自己写一个（localStorage，键名保持同形）。
  编辑态本来就是 `cache: { enable: false }`。
- **剪贴板**：自动保存是 `UploadForm` 自己实现的（每分钟，偏好存在
  `localStorage.clipboard_autosave_enabled`），**与 Vditor 无关，不动**。

## 4. 分期

每期都能独立发布、独立回滚。

| 期 | 内容 | 打掉哪条反馈 |
|----|------|-------------|
| **M0** | 抽 `ContentRefProcessor`、抽 hljs 主题 hook、立「禁止第二个渲染器」的守卫 | — |
| **M1** | `MarkdownEditor` 内核替换：CM6 + markdown 语言包 + 工具条 + 快捷键 + 上传/拖拽/粘贴 + 草稿 + 主题；装饰层先只做**隐藏标记** | ①（含 ①′：粘贴不再被改写） |
| **M2** | 五个取数面板接上工具条 | ②「手打」 |
| **M3** | widget：先同步那批（图床图 / 音频 / 公式），再异步那批（剪贴板 / 投票 / 收藏夹 / 名片） | ②′「不能预览」、③ |
| **M4** | 表格（可选，见 §6） | — |

**M1 就该换掉博客与剪贴板两处** —— 留一个用 Vditor 会让我们同时维护两套，
而 `vditor-*` 那两个 lib 又必须为留下的那一处继续存在。宁可一次换完。

## 5. 迁移清单

### 5.1 新增

- `docs/editor-plan.md`（本文）
- `src/app/components/MarkdownEditor.tsx` —— 外壳与状态
- `src/app/components/markdown-editor/` —— 工具条、五个取数面板、草稿
- `src/lib/md-editor/` —— 装饰规则、widget、异步解析器接线、快捷键
- `src/lib/content-ref-processor.ts`（从 `MarkdownRenderer.tsx` 抽出）
- `src/lib/use-hljs-theme.ts`（同上）
- 依赖：`@codemirror/state` / `view` / `commands` / `language` / `search` /
  `lang-markdown` + `@lezer/highlight`（最终清单以实际 import 为准，宁少勿多）
- 测试：装饰规则与 token 插入的单测、§7 那几条新守卫、改写后的 e2e

### 5.2 修改

- `src/app/components/BlogForm.tsx`、`src/app/clipboard/upload/UploadForm.tsx`
- `src/app/components/MarkdownRenderer.tsx`（改用抽出的模块）
- `src/styles-scss/pages/_clipboard.scss`（删 `#clipboard-editor` 那段特异性 hack；
  补编辑器外壳样式）
- `public/static/js/core/base.js`（删 `input.closest('.vditor')` 早退及其注释）
- `package.json`（删依赖 `vditor` 与 `prepare:vditor` / `vditor:check`，
  以及 `postinstall` 里的对应一段）
- `.gitignore`（删 `/public/static/vditor/` 那条）
- `src/lib/image-client.ts`（第 83 行提到 Vditor 路径固定 `compress=1` 的注释）
- 文档：`docs/architecture.md` §5 的表两行、`docs/deploy.md`、
  `docs/frontend-styles.md`、`docs/legacy-constraints.md`、
  `docs/guide/图床使用指南.md`、
  **`docs/guide/内容引用语法指南.md` 的「编辑器中不可预览」一条要删掉**
- `docs/README.md`（索引表加一行）与 `src/lib/docs-catalog.ts`（登记本文）

### 5.3 删除

- `src/lib/vditor-upload.ts`、`src/lib/vditor-theme.ts`
- `scripts/copy-vditor-assets.mjs`
- `tests/e2e/vditor-theme.spec.ts`、`tests/e2e/vditor-upload.spec.ts`、
  `tests/unit/vditor-upload.test.ts`
- `tests/unit/base-js-filepick.test.ts` 里 Vditor 相关的两条用例
- `tests/e2e/global-setup.ts` 里「vditor 资源不存在就自愈重跑」那一段

## 6. 会丢的东西

| 能力 | 判断 |
|------|------|
| **表格编辑** | **唯一真会疼的。** 见下 |
| 导出（HTML / PDF） | 低频。真想要就单独立项 |
| 大纲面板 | 可以和「文章目录」共用逻辑，不难但也不急 |
| 全屏 | 不值一提 |
| 字数统计 | 自己写很便宜 |

**表格**建议在 M4 单独立项，且**不追求 Typora 那种可视化表格**（它是整个方案里
唯一的深水区）。退路有两种：源码 + 对齐高亮；或者做一个「表格编辑弹窗」，
覆盖插入 / 增删行列 / 对齐这些常见操作，改完写回源码。

## 7. 测试与守卫

### 7.1 要新立的守卫

静默错是这个仓库最在意的一类故障，编辑器换代至少引入三种新的静默错：

1. **只有一个渲染器。** 静态扫 `src/lib/md-editor/` 与 `MarkdownEditor`：
   不许 import `marked` 再自己拼 HTML；widget 一律走共用的解析口。
   形状照 `tests/unit/vditor-upload.test.ts` 里那条「全仓扫 `new Vditor(` 」的契约测试。
2. **token 正则同源。** 编辑器插入的 token 必须通过渲染侧的正则校验，
   且正则里的字符集是白名单。理由与本仓表情包那条纪律完全同源：
   宽一个 `\s*` 就是向同名用户凭空发通知。
3. **插入器与解析器不漂移。** 对每个面板产出的样例 token 跑一次真实解析 ——
   防的是「面板改了 token 形状、渲染侧不认」，症状是「插进去的东西渲染不出来」。

### 7.2 e2e

- **粘贴含 ` ``` ` 的文本不应被改写** —— 这是本次反馈的回归钉子，必须有一条
- 工具条五个面板各插一次，正文渲染出对应元素
- 主题跟随（亮 / 暗切换，编辑器与正文一致）
- 图床上传：拖拽 / 粘贴 / 多选，插入的结果能被正文渲染
- **不污染文章页**：离开编辑页后，文章页的代码高亮主题照旧
  （这条现在由 `vditor-theme.spec.ts` 的一条用例守着，改写时要保留**意图**而不是实现）

⚠️ 改写旧 e2e 时注意：那四个文件钉的多是**Vditor 的实现细节**
（`.vditor--dark` 类名、`#vditorContentTheme` 的 href、`#vditorHljsStyle`）。
新用例要钉**行为**（主题确实变了、上传确实插进来了），别换成新实现细节 ——
否则下一次换内核还要再废一遍。

## 8. 风险

1. **输入法 composition。** CM6 本身成熟，但**装饰层必须在 composition 期间暂停**
   —— 否则用户正在拼的字会被 redraw 打断。这是已知的、必须专门处理的一类 bug，
   不是「但愿不要碰到」。
2. **表格。** 唯一的真难点，见 §6。
3. **依赖体积。** CM6 是一串包（gzip 量级：`lang-markdown` 约 175KB 含 lezer 语言依赖、
   `view` 约 79KB、`state` 约 16KB；可 tree-shake）。
   而本仓的纪律是 `npm ci`（严格按 lockfile），加依赖必须显式装、
   把 `package-lock.json` 一起提交，并留意 `postinstall` 那三条 `copy-*-assets`
   的连带影响。**净账是正的**：Vditor 那条线要拷 23.6MB 资源进 `public/`。
4. **两处编辑器同时换。** 缓解：先换博客（反馈的源头），剪贴板紧随；
   两者共用 `MarkdownEditor` 与 `EditorShell`。
5. **旧测试全废。** 四个文件都要改写或删除，见 §7.2。
6. **异步 widget 的请求量。** 「每敲一个字重渲染」撞上「每个引用发一次请求」
   会把限频打爆（`docs/architecture.md` §6.5 的 `RULES`）。
   缓解：§3.5 的第 3 条（缓存跨渲染复用）+ 解析防抖 + 结果驻留在 `StateField` 里。

## 9. 未决问题（需要站长定）

1. **编辑器里插入图床图，插哪个形状？**
   `[@10位ID]`（本站语法：渲染器认、有条数上限、与其它引用一致）
   还是 `![](/api/images/<id>/raw)`（标准 markdown：离开本站也能看）。
   现在 Vditor 的上传按钮插的是后者。**两者都能被正文渲染器正确处理。**
2. **表格做到哪一步**（不做 / 源码 + 对齐 / 弹窗编辑）。
3. **「光标行显示源码」是否照搬 Typora。** 有人反而嫌它在光标移动时「闪」。
4. **导出功能是否保留。**
5. **装饰层的边界**：是否连 `>` 引用块、任务列表也做可视化（工作量大头在细节，
   不在机制）。

## 10. 为什么这件事值得做（一句话总结）

现在为「跟 Vditor 相处」而写的代码 —— 上传适配、主题三轨、资源拷贝、
`base.js` 的绕行、SCSS 的特异性 hack —— **比编辑器本身的业务逻辑还多**，
而且每一项都是为了让第三方内核接受我们的规则。
换成 CM6 之后，我们写的东西第一次**全是自己的规则**：预览就是终稿渲染器，
`[@…]` 的解析只有一份，主题跟着既有的那一套走。

这不是「自己造一个编辑器」，是**把被 Vditor 挡在外面的那一层拿回来**。
