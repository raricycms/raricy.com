# 故事模块

## 概述

故事模块是一个基于文件系统的内容管理模块，支持 **Markdown 小说** 和 **Cattca 互动小说** 两种格式，合集可以**无限嵌套**。

## 文件结构

所有内容存放在 `instance/stories/` 下：

```
instance/stories/
  info.json                   ← 根合集元数据（可选）
  
  互动小说/                   ← 子合集
    info.json                 ← 合集元数据
    防御.cattca               ← Cattca 互动小说
    逃出房间.cattca
    
  小说集/                     ← 子合集
    info.json
    北斗赋.md                 ← Markdown 小说
    厘米世界记.md
    
  子合集/                     ← 可以继续嵌套
    info.json
    孙合集/                   ← 更深一层
      info.json
      某个故事.md
```

### 合集 (Collection)

合集就是 `instance/stories/` 下的**目录**。每个合集可以包含：
- `.md` 文件 — Markdown 故事
- `.cattca` 文件 — Cattca 互动小说
- 子目录 — 嵌套的合集

合集根目录下的 `info.json` 是可选的，格式：

```json
{
  "title": "合集名称",
  "description": "简介",
  "author": "默认作者",
  "priority": 100,
  "ignore": false
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `title` | string | 目录名 | 合集显示名称 |
| `description` | string | `""` | 合集简介 |
| `author` | string | `"未知作者"` | 默认作者（子故事未指定时使用） |
| `priority` | int | `0` | 排序优先级，越大越靠前 |
| `ignore` | bool | `false` | 设为 `true` 隐藏此合集 |

### 故事 (Story)

故事是单个文件，支持两种格式。元数据统一使用 **YAML frontmatter**（`---` 包裹的 YAML 头）：

```yaml
---
title: 故事标题
author: 作者名
genre: 小说
ai_assisted: false
description: 一句话简介
priority: 100
ignore: false
---
（正文内容）
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `title` | string | 文件名 | 故事标题 |
| `author` | string | 合集作者 | 作者 |
| `genre` | string | `""` | 类型标签，不设则不显示 |
| `ai_assisted` | bool | `false` | 设为 `true` 显示「AI辅助创作」标记 |
| `description` | string | `""` | 简介 |
| `priority` | int | `0` | 排序优先级 |
| `ignore` | bool | `false` | 设为 `true` 隐藏此故事 |

#### Markdown 故事（`.md`）

标准 Markdown 文件，前端使用 YAML frontmatter。正文由浏览器端渲染（marked.js + DOMPurify + highlight.js），支持 GFM 表格、任务列表、代码高亮等。

#### 排版规则

**段落缩进**：正文段落首行自动缩进两字符（`text-indent: 2em`）。以下情况不会缩进：

- **引用块内的段落** — 自动取消缩进
- **手动标记** — 在段落上添加 `class="u-no-indent"` 可取消缩进：

```markdown
> 这是引用块，里面的段落不会缩进。

<p class="u-no-indent">这一段也不会缩进。适合题记后的首段、独立引言等场景。</p>

这里恢复正常缩进。
```

**链接**：正文中的链接显示为品牌色，hover 时出现下划线。外部链接自动添加 `target="_blank" rel="noopener noreferrer nofollow"`。

**代码块**：带有复制按钮（右上角），高亮主题自动跟随亮色/暗色模式。

#### Cattca 互动小说（`.cattca`）

单文件格式。文件顶部是 YAML frontmatter，之后是 Cattca 脚本。Cattca 是一种自定义的互动小说脚本语言，在浏览器端由 `cattca.js` 解释执行。

### 排序规则

合集内的所有项目（故事 + 子合集）按以下规则排序：
1. `priority` 从大到小
2. 有 `description` 的排在无 `description` 的前面

## URL 结构

| URL | 行为 |
|-----|------|
| `/story/` | 根合集页 |
| `/story/<合集路径>/` | 合集页，列出内容和子合集 |
| `/story/<合集路径>/<故事id>` | 故事阅读/播放页 |

路由解析逻辑：路径若映射到存在的目录 → 合集页；否则 → 故事页。

## 合集嵌套示例

假设文件结构：
```
instance/stories/
  info.json            {"title": "故事中心"}
  短篇/
    info.json          {"title": "短篇小说"}
    雨夜.md
  长篇/
    info.json          {"title": "长篇小说"}
    科幻/
      info.json        {"title": "科幻长篇"}
      星际迷航.md
```

生成的 URL：
- `/story/` — "故事中心"合集页，展示"短篇"和"长篇"两个子合集
- `/story/短篇/` — "短篇小说"合集页，展示"雨夜"
- `/story/长篇/` — "长篇小说"合集页，展示"科幻"子合集
- `/story/长篇/科幻/` — "科幻长篇"合集页，展示"星际迷航"
- `/story/长篇/科幻/星际迷航` — 故事阅读页

## 添加新内容

**添加故事：** 在目标合集目录下放入 `.md` 或 `.cattca` 文件，带上 YAML frontmatter。

**添加子合集：** 创建新目录，放入 `info.json`（可选），再放入故事文件。

## Cattca 脚本简要说明

Cattca 使用 `</.../>` 作为控制分隔符。变量用 `</let>` / `</set>` 声明，流程用 `</goto>` / `</if>` / `</label>` 控制，交互用 `</input text>` / `</input case>` 获取用户输入。

详见 `app/static/js/cattca.js` 中的 `CattcaInterpreter` 类。
