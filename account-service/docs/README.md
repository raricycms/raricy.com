# account-service 文档

raricy.com 小鱼干（Dried Fish）虚拟货币账户微服务。基于 FastAPI + SQLite（默认，可选 PostgreSQL）+ 复式记账（Double-Entry Ledger）。

## 文档目录

```
account-service/docs/
├── README.md           # 本文件 — 总览与导航
├── 项目架构.md          # 架构全景、目录树、分层设计、核心原理
├── 部署与运行.md        # 环境要求、初始化、配置、Docker、生产部署
└── API接口文档.md       # 完整 REST API 规格（6 个接口）
```

## 读者指南

| 你的角色 | 建议阅读路径 |
|----------|-------------|
| 想快速了解项目是什么 | 本文件 → [项目架构](项目架构.md) |
| 需要部署/运行服务 | [部署与运行](部署与运行.md) |
| 博客后端对接开发 | [API接口文档](API接口文档.md) → [项目架构](项目架构.md)（安全设计章节） |
| 代码贡献者 / 维护者 | 全部阅读 |

## 外部参考

| 文档 | 说明 |
|------|------|
| [项目 README](../README.md) | 快速开始、API 概览、核心设计摘要 |
| [fish-account-refactor 设计文档](../../docs/fish-account-refactor/) | 原始架构设计（7 篇），了解"为什么这样设计" |
| [CLAUDE.md](../../CLAUDE.md) | 主项目（博客）的开发指南 |

## 核心术语

| 术语 | 说明 |
|------|------|
| **小鱼干 (Dried Fish)** | raricy.com 的虚拟货币，通过签到、被投喂等途径获得 |
| **复式记账 (Double-Entry)** | 每笔交易产生两条流水（DEBIT + CREDIT），余额从流水聚合计算，不存储余额字段 |
| **内部单位** | 1 小鱼干 = 10,000 内部单位（BIGINT 存储）。API 使用自然单位（Decimal），转换对调用方透明 |
| **系统账户** | `raricy-blog-system`（UUID `00000000-0000-0000-0000-000000000000`），`is_system=True`，可透支。博客系统即此账户——所有鱼干发行都从它转出 |
| **API Key** | 每个账户有独立的 `fish_sk_` 前缀密钥，SHA-256 哈希存储。开户或认领时返回明文一次 |
| **内部 Token** | `X-Internal-Token` header，博客与 account-service 之间的共享密钥。所有端点强制校验 |
| **幂等 (Idempotency)** | 通过 `X-Idempotency-Key` 防止网络重试导致重复转账。Key 24 小时后过期 |
| **认领 (Claim)** | 转账自动为接收方创建账户时不生成 API Key（`api_key_hash = NULL`）。用户主动调用开户接口时生成 Key 认领之 |
