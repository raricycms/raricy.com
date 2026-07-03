"""Seed script — creates the system account on first run.

Usage:
    python scripts/seed.py

This script:
1. Creates the system account (raricy-blog-system) with is_system=True.
2. Outputs the system account's API key — store this in the blog's .env as
   ACCOUNT_SYSTEM_KEY.
3. Is idempotent — safe to run multiple times.
"""

import asyncio
import secrets
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import generate_api_key
from app.db.session import get_engine, get_session_factory
from app.models.account import Account


async def create_system_account():
    """Create the system account if it doesn't exist."""
    engine = get_engine()
    factory = get_session_factory()

    async with factory() as db:
        # Check if system account already exists
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
            print("If you lost it, re-create the database or rotate the key manually.")
            return

        # Generate API key
        plain_key, key_hash, key_prefix = generate_api_key()

        account = Account(
            id=system_id,
            user_id=settings.system_user_id,
            currency="DRIED_FISH",
            api_key_hash=key_hash,
            api_key_prefix=key_prefix,
            is_system=True,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)

        print("=" * 60)
        print("  SYSTEM ACCOUNT CREATED")
        print("=" * 60)
        print(f"  Account ID: {account.id}")
        print(f"  User ID:    {account.user_id}")
        print(f"  Currency:   {account.currency}")
        print(f"  Is System:  {account.is_system}")
        print()
        print(f"  API Key:    {plain_key}")
        print()
        print("  ⚠️  Store this API key in the blog's .env file:")
        print(f"     ACCOUNT_SYSTEM_KEY={plain_key}")
        print()
        print("  This key is only shown ONCE. Do not lose it.")
        print("=" * 60)
        print()
        print("Also, make sure to set a shared INTERNAL_TOKEN in .env for both")
        print("the blog and account-service. Generate one with:")
        print(f"  INTERNAL_TOKEN={secrets.token_urlsafe(32)}")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(create_system_account())
