"""Seed script — creates the system account on first run, or rotates its API key.

Usage:
    python scripts/seed.py              # Create system account (idempotent)
    python scripts/seed.py --rotate-key # Replace lost API key with a new one

This script:
1. Creates the system account (raricy-blog-system) with is_system=True.
2. Outputs the system account's API key — store this in the blog's .env as
   ACCOUNT_SYSTEM_KEY.
3. Is idempotent — safe to run multiple times.
4. --rotate-key generates a new key for an existing system account.
   The old key is invalidated immediately.
"""

import argparse
import asyncio
import secrets
import uuid

from sqlalchemy import select

from app.config import settings
from app.core.constants import DEFAULT_CURRENCY
from app.core.security import generate_api_key
from app.db.session import get_engine, get_session_factory
from app.models import Base  # noqa: F401 — ensure all models are imported
from app.models.account import Account


def _print_key(plain_key: str, action: str = "CREATED") -> None:
    """Print the API key banner."""
    print("=" * 60)
    print(f"  SYSTEM ACCOUNT - KEY {action}")
    print("=" * 60)
    print(f"  API Key:    {plain_key}")
    print()
    print("  [!!] Store this API key in the blog's .env file:")
    print(f"     ACCOUNT_SYSTEM_KEY={plain_key}")
    print()
    print("  This key is only shown ONCE. Do not lose it.")
    print("=" * 60)
    print()
    print("Also, make sure to set a shared INTERNAL_TOKEN in .env for both")
    print("the blog and account-service. Generate one with:")
    print(f"  INTERNAL_TOKEN={secrets.token_urlsafe(32)}")


async def create_system_account() -> None:
    """Create the system account if it doesn't exist."""
    engine = get_engine()

    # Ensure all tables exist before querying
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = get_session_factory()

    async with factory() as db:
        system_id = uuid.UUID(settings.system_account_id)
        result = await db.execute(
            select(Account).where(Account.id == system_id)
        )
        existing = result.scalar_one_or_none()

        if existing is not None:
            print(f"System account already exists:")
            print(f"  Account ID: {existing.id}")
            print(f"  User ID:    {existing.user_id}")
            print(f"  API Prefix: {existing.api_key_prefix}")
            print()
            print("The API key was shown on first creation only.")
            print("If you lost it, run: python scripts/seed.py --rotate-key")
            return

        # Generate API key
        plain_key, key_hash, key_prefix = generate_api_key()

        account = Account(
            id=system_id,
            user_id=settings.system_user_id,
            currency=DEFAULT_CURRENCY,
            api_key_hash=key_hash,
            api_key_prefix=key_prefix,
            is_system=True,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)

        _print_key(plain_key)

    await engine.dispose()


async def rotate_system_key() -> None:
    """Replace the system account's API key with a new one.

    The old key is invalidated immediately — any service using it will
    start getting 401 responses.
    """
    engine = get_engine()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = get_session_factory()

    async with factory() as db:
        system_id = uuid.UUID(settings.system_account_id)
        result = await db.execute(
            select(Account).where(Account.id == system_id)
        )
        account = result.scalar_one_or_none()

        if account is None:
            print("System account does not exist yet.")
            print("Run without --rotate-key to create it first:")
            print("  python scripts/seed.py")
            return

        old_prefix = account.api_key_prefix

        # Generate and apply new key
        plain_key, key_hash, key_prefix = generate_api_key()
        account.api_key_hash = key_hash
        account.api_key_prefix = key_prefix
        await db.commit()

        print(f"Old key (prefix: {old_prefix}) has been revoked.")
        print()
        _print_key(plain_key, action="ROTATED")
        print("[!!] Update ACCOUNT_SYSTEM_KEY in the blog's .env immediately --")
        print("     the old key will no longer work.")

    await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Seed the system account or rotate its API key."
    )
    parser.add_argument(
        "--rotate-key",
        action="store_true",
        help="Replace the system account's API key (invalidates the old one).",
    )
    args = parser.parse_args()

    if args.rotate_key:
        asyncio.run(rotate_system_key())
    else:
        asyncio.run(create_system_account())
