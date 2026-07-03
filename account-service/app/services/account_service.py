"""Account service — creation, balance queries, lookups."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.currency import to_external
from app.core.security import generate_api_key
from app.models.account import Account
from app.models.ledger_entry import LedgerEntry


class AccountService:
    """Service for account management and balance queries.

    All methods receive an explicit AsyncSession — the caller
    (usually a FastAPI dependency) provides the session.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    # ------------------------------------------------------------------
    # Creation
    # ------------------------------------------------------------------

    async def create_account(
        self, user_id: str, currency: str = "DRIED_FISH"
    ) -> tuple[Account, str | None]:
        """Create a new account, claim an unclaimed one, or return existing.

        Three cases:
        1. No account exists → create a new one and return its API key.
        2. Unclaimed account exists (auto-created by a transfer) →
           generate an API key and claim it. Returns the key.
        3. Claimed account already exists → return account info without the key.

        Args:
            user_id: External user ID (UUID from the blog system).
            currency: Currency code.

        Returns:
            Tuple of (Account, plain_api_key | None).
            The API key is returned on creation AND on claiming; None for
            already-claimed accounts.
        """
        # Check if account already exists
        existing = await self.get_account_by_user_id(user_id, currency)
        if existing is not None:
            if existing.is_claimed:
                # Case 3: Already claimed — return info, no key
                return existing, None
            else:
                # Case 2: Unclaimed (auto-created by a transfer) — claim it
                plain_key, key_hash, key_prefix = generate_api_key()
                existing.api_key_hash = key_hash
                existing.api_key_prefix = key_prefix
                await self.db.flush()
                return existing, plain_key

        # Case 1: Brand new account
        plain_key, key_hash, key_prefix = generate_api_key()

        account = Account(
            user_id=user_id,
            currency=currency,
            api_key_hash=key_hash,
            api_key_prefix=key_prefix,
            is_system=False,
        )
        self.db.add(account)
        try:
            await self.db.flush()
        except IntegrityError:
            # Race condition: another request created the same account
            # between our check and insert. Roll back and re-query.
            await self.db.rollback()
            existing = await self.get_account_by_user_id(user_id, currency)
            if existing is not None:
                if existing.is_claimed:
                    return existing, None
                else:
                    # Unclaimed — this request claims it
                    plain_key, key_hash, key_prefix = generate_api_key()
                    existing.api_key_hash = key_hash
                    existing.api_key_prefix = key_prefix
                    await self.db.flush()
                    return existing, plain_key
            raise  # should never happen — the unique constraint guarantees a row

        return account, plain_key

    # ------------------------------------------------------------------
    # Balance queries
    # ------------------------------------------------------------------

    async def get_balance(
        self, user_id: str, currency: str = "DRIED_FISH"
    ) -> tuple[Decimal, datetime | None]:
        """Get the balance for a user.

        Balance is computed as SUM(DEBIT) - SUM(CREDIT) from ledger entries.
        For non-existent users, returns (0.0, None) — never raises 404.

        Args:
            user_id: External user ID.
            currency: Currency code.

        Returns:
            Tuple of (balance_in_natural_units, last_activity_timestamp).
        """
        account = await self.get_account_by_user_id(user_id, currency)
        if account is None:
            return Decimal("0.0"), None

        result = await self.db.execute(
            select(
                func.coalesce(
                    func.sum(
                        case(
                            (LedgerEntry.direction == "DEBIT", LedgerEntry.amount),
                            else_=-LedgerEntry.amount,
                        )
                    ),
                    0,
                ),
                func.max(LedgerEntry.created_at),
            ).where(LedgerEntry.account_id == account.id)
        )
        internal_balance, updated_at = result.one()
        return to_external(int(internal_balance)), updated_at

    async def get_balance_batch(
        self, user_ids: list[str], currency: str = "DRIED_FISH"
    ) -> dict[str, Decimal]:
        """Get balances for multiple users in a single query.

        Args:
            user_ids: List of external user IDs (max 100).
            currency: Currency code.

        Returns:
            Dict mapping user_id → balance (0.0 for non-existent or no-activity users).
        """
        # Subquery: account_id → user_id
        # LEFT JOIN ledger_entries to include accounts with zero entries
        result = await self.db.execute(
            select(
                Account.user_id,
                func.coalesce(
                    func.sum(
                        case(
                            (LedgerEntry.direction == "DEBIT", LedgerEntry.amount),
                            else_=-LedgerEntry.amount,
                        )
                    ),
                    0,
                ),
            )
            .outerjoin(LedgerEntry, LedgerEntry.account_id == Account.id)
            .where(
                Account.user_id.in_(user_ids),
                Account.currency == currency,
            )
            .group_by(Account.user_id)
        )

        balances: dict[str, Decimal] = {uid: Decimal("0.0") for uid in user_ids}
        for user_id, internal_balance in result:
            balances[user_id] = to_external(int(internal_balance))

        return balances

    # ------------------------------------------------------------------
    # Lookups
    # ------------------------------------------------------------------

    async def get_account_by_user_id(
        self, user_id: str, currency: str = "DRIED_FISH"
    ) -> Account | None:
        """Find an account by user_id and currency."""
        result = await self.db.execute(
            select(Account).where(
                Account.user_id == user_id,
                Account.currency == currency,
            )
        )
        return result.scalar_one_or_none()

    async def get_account_by_api_key_hash(self, key_hash: str) -> Account | None:
        """Find an account by API key hash."""
        result = await self.db.execute(
            select(Account).where(Account.api_key_hash == key_hash)
        )
        return result.scalar_one_or_none()

    async def get_account_by_id(self, account_id: uuid.UUID) -> Account | None:
        """Find an account by its internal UUID."""
        result = await self.db.execute(
            select(Account).where(Account.id == account_id)
        )
        return result.scalar_one_or_none()

    async def get_or_create_system_account(self) -> Account:
        """Ensure the system account exists, creating it if necessary.

        The system account has a fixed UUID, is_system=True, and can overdraft.
        """
        system_id = uuid.UUID(settings.system_account_id)
        account = await self.get_account_by_id(system_id)
        if account is not None:
            return account

        # Create system account — no API key needed for internal use initially,
        # but generate one so it can be used for transfers.
        plain_key, key_hash, key_prefix = generate_api_key()

        account = Account(
            id=system_id,
            user_id=settings.system_user_id,
            currency="DRIED_FISH",
            api_key_hash=key_hash,
            api_key_prefix=key_prefix,
            is_system=True,
        )
        self.db.add(account)
        await self.db.flush()
        return account
