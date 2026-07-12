"""Async database engine and session factory."""

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import settings

_engine = None


def _configure_sqlite_concurrency(engine):
    """修复 SQLite 上的并发转账正确性问题。

    SQLite 不支持行级锁，transfer_service 里的 SELECT ... FOR UPDATE 被静默
    忽略，"读余额 → 判断够不够 → 写扣款"之间没有互斥，两笔并发转账可能
    都读到旧余额而双花 / 把余额扣成负数。

    采用 SQLAlchemy 官方针对 pysqlite 的事务 recipe：
    - busy_timeout：并发写时等待而非立即 SQLITE_BUSY 报错；
    - BEGIN IMMEDIATE：每个事务开始即获取写锁，强制串行化"读-判断-写"，
      恢复 FOR UPDATE 本应提供的互斥。

    代价：事务串行执行（个人站低频鱼干操作可接受）。高并发场景建议迁移
    PostgreSQL（届时 FOR UPDATE 生效，可移除本函数）。
    """
    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_on_connect(dbapi_conn, _record):
        # 关闭 pysqlite 的自动 BEGIN，改由下面的 begin 事件手动控制
        dbapi_conn.isolation_level = None
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    @event.listens_for(engine.sync_engine, "begin")
    def _sqlite_on_begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE")


def get_engine():
    """Create or return the cached async SQLAlchemy engine.

    Uses NullPool for SQLite — each session gets its own connection,
    avoiding transaction-state leaks between sessions.
    """
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            settings.database_url,
            echo=settings.debug,
            poolclass=NullPool,
        )
        if settings.database_url.startswith("sqlite"):
            _configure_sqlite_concurrency(_engine)
    return _engine


def get_session_factory():
    """Return a callable that creates new AsyncSession instances.

    Used by scripts (seed.py) that manage their own lifecycle.
    """
    from functools import partial
    engine = get_engine()
    return partial(AsyncSession, engine, expire_on_commit=False)


async def get_db():
    """FastAPI dependency: yields an async database session.

    Creates AsyncSession directly (no sessionmaker) to avoid
    transaction context-manager issues with SQLite.
    Rolls back on exception, commits on success, always closes.
    """
    engine = get_engine()
    session = AsyncSession(engine, expire_on_commit=False)
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()
