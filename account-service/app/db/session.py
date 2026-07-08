"""Async database engine and session factory."""

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import settings

_engine = None


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
