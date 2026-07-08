# Account Service

raricy.com 小鱼干（Dried Fish）虚拟货币账户微服务。

基于 FastAPI + SQLite（可切换 PostgreSQL）+ 复式记账（Double-Entry Ledger）。

## 快速开始

### 前置条件

- Python 3.12+
- SQLite 3（默认）。PostgreSQL 可选，但需手动安装 `asyncpg` 驱动
- `pip` / `uv`

### 安装

```bash
cd account-service
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e .
```

### 配置

复制环境变量模板并编辑：

```bash
cp .env.example .env
```

`.env` 内容（默认 SQLite）：

```env
DATABASE_URL=sqlite+aiosqlite:///account.db
DEBUG=true
SERVICE_NAME=account-service
INTERNAL_TOKEN=<替换为强随机字符串>
```

> 如需切换 PostgreSQL，请先 `pip install asyncpg`，然后将 `DATABASE_URL` 改为 `postgresql+asyncpg://user:pass@host:5432/account`。

### 数据库初始化

```bash
# SQLite 无需手动创建数据库，直接运行迁移即可
alembic upgrade head

# 创建系统账户（获取 API Key）
python scripts/seed.py
```

### 运行

```bash
uvicorn app.main:app --reload --port 8000
```

API 文档：http://localhost:8000/docs

## 运行测试

```bash
# 测试使用 SQLite 内存数据库，无需额外配置
pytest -v
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/v1/accounts` | 创建账户 |
| `GET` | `/api/v1/accounts/{user_id}/balance` | 查询余额 |
| `POST` | `/api/v1/accounts/balances/batch` | 批量查询余额 |
| `POST` | `/api/v1/transfers` | 转账（需要 API Key 认证） |
| `GET` | `/api/v1/accounts/{user_id}/ledger` | 交易流水查询 |

## 核心设计

- **复式记账**：每笔交易产生两条流水（DEBIT + CREDIT），余额从流水聚合计算
- **精度**：1 小鱼干 = 10,000 内部单位，API 使用自然单位（如 3.0）
- **幂等**：写入操作支持 `X-Idempotency-Key` 防重复
- **认证**：API Key（`fish_sk_` 前缀，SHA-256 哈希存储）
- **系统账户**：`raricy-blog-system` 可透支，作为鱼干的"发行方"

详见 [docs/fish-account-refactor/](../docs/fish-account-refactor/) 设计文档。
