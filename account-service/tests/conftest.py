"""Pytest fixtures for account-service tests."""

import asyncio
import os
import uuid
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.core.constants import DEFAULT_CURRENCY
from app.core.security import hash_api_key
from app.db.session import get_db
from app.main import create_app
from app.models import Base
from app.models.account import Account

# ---------------------------------------------------------------------------
# Test configuration
# ---------------------------------------------------------------------------
TEST_DB_PATH = "test.db"
settings.database_url = f"sqlite+aiosqlite:///{TEST_DB_PATH}"
settings.internal_token = "test-internal-token"

from app.core.limiter import limiter
limiter.enabled = False

SYSTEM_API_KEY = "fish_sk_test_system_key_0000000000000000"
TEST_USER_API_KEY = "fish_sk_test_user_key_000000000000000000"
TEST_INTERNAL_TOKEN = "test-internal-token"
SYSTEM_USER_ID = settings.system_user_id
TEST_USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SYSTEM_ACCOUNT_ID = uuid.UUID(settings.system_account_id)
TEST_ACCOUNT_ID = uuid.UUID("11111111-2222-3333-4444-555555555555")


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def _engine():
    """Session-scoped StaticPool engine."""
    import app.db.session as db_sess
    db_sess._engine = None

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{TEST_DB_PATH}",
        echo=False, poolclass=StaticPool,
    )
    db_sess._engine = engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)


def _get_engine():
    import app.db.session as db_sess
    return db_sess._engine


# ---------------------------------------------------------------------------
# Per-test session — shared by all requests within a test
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def db_session(_engine) -> AsyncGenerator[AsyncSession, None]:
    """Per-test session. Wipes old data, pre-seeds system + test accounts."""
    # Truncate all tables first — clean slate for each test
    async with _engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())

    session = AsyncSession(_engine, expire_on_commit=False)
    # Seed known accounts
    for acct_id, uid, key, sys_flag in [
        (SYSTEM_ACCOUNT_ID, SYSTEM_USER_ID, SYSTEM_API_KEY, True),
        (TEST_ACCOUNT_ID, TEST_USER_ID, TEST_USER_API_KEY, False),
    ]:
        session.add(Account(
            id=acct_id, user_id=uid, currency=DEFAULT_CURRENCY,
            api_key_hash=hash_api_key(key),
            api_key_prefix=key[:12], is_system=sys_flag,
        ))
    await session.commit()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


# ---------------------------------------------------------------------------
# HTTP client — all requests share db_session
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def async_client(db_session) -> AsyncGenerator[AsyncClient, None]:
    """httpx AsyncClient. Each request commits, so subsequent requests
    within the same test can see data from prior requests."""
    app = create_app()

    async def override_get_db():
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Internal-Token": TEST_INTERNAL_TOKEN},
    ) as client:
        yield client

    app.dependency_overrides.clear()
