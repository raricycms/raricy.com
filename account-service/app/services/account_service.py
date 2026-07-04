"""Account service — creation, balance queries, lookups."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import DEFAULT_CURRENCY
from app.core.currency import to_external
from app.core.exceptions import AccountAlreadyExistsRaceError
from app.core.security import generate_api_key
from app.core.timezone import utc8_day_bounds
from app.models.account import Account
from app.models.ledger_entry import LedgerEntry, compute_balance, signed_amount_expr


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
        self, user_id: str, currency: str = DEFAULT_CURRENCY
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

        Raises:
            AccountAlreadyExistsRaceError: (409) Rare race condition where the
                pre-INSERT SELECT and the post-IntegrityError re-SELECT both
                fail to observe an existing account. The caller should retry.
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
            # between our pre-check SELECT and our INSERT. Roll back and
            # re-query — the winning transaction's row should now be visible.
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
            # Re-query also missed the row. This is rare but can happen
            # under unusual isolation or with concurrent test runs.
            # Convert to a domain error (409) so the caller can retry,
            # rather than leaking the raw IntegrityError as a 500.
            raise AccountAlreadyExistsRaceError(user_id, currency) from None

        return account, plain_key

    # ------------------------------------------------------------------
    # Balance queries
    # ------------------------------------------------------------------

    async def get_balance(
        self,
        user_id: str,
        currency: str = DEFAULT_CURRENCY,
        include_today_checkin: bool = False,
        today: datetime | None = None,
    ) -> tuple[Decimal, datetime | None, Decimal | None]:
        """Get the balance for a user.

        Balance is computed as SUM(DEBIT) - SUM(CREDIT) from ledger entries.
        For non-existent users, returns (0.0, None, None) — never raises 404.

        Args:
            user_id: External user ID.
            currency: Currency code.
            include_today_checkin: When True, also compute today's (UTC+8) check-in earnings.
            today: Override "today" timestamp — mainly for tests. Defaults to
                current UTC+8 midnight (start of today UTC+8).

        Returns:
            Tuple of (balance_in_natural_units, last_activity_timestamp, today_checkin).
            `today_checkin` is None when `include_today_checkin=False`,
            otherwise Decimal(0.0) if no check-in today.
        """
        account = await self.get_account_by_user_id(user_id, currency)
        if account is None:
            return Decimal("0.0"), None, (Decimal("0.0") if include_today_checkin else None)

        internal_balance = await compute_balance(self.db, account.id)

        # Get last activity timestamp
        result = await self.db.execute(
            select(func.max(LedgerEntry.created_at)).where(
                LedgerEntry.account_id == account.id
            )
        )
        updated_at = result.scalar_one()

        today_checkin: Decimal | None = None
        if include_today_checkin:
            today_checkin = await self._sum_today_checkin(account.id, today)

        return to_external(internal_balance), updated_at, today_checkin

    async def _sum_today_checkin(
        self, account_id: uuid.UUID, today: datetime | None = None
    ) -> Decimal:
        """SUM today's (UTC+8) check-in earnings for the account.

        Computes SUM(DEBIT) - SUM(CREDIT) over LedgerEntry rows with
        entry_type='checkin' and created_at within the UTC+8 calendar day.

        Uses idx_ledger_type_created (entry_type, created_at.desc) — an index
        range scan with the account_id filter applied afterwards.

        Returns Decimal(0.0) if no check-in today (never raises).
        """
        start_dt, end_dt = utc8_day_bounds(today)
        result = await self.db.execute(
            select(
                func.coalesce(func.sum(signed_amount_expr()), 0)
            ).where(
                LedgerEntry.account_id == account_id,
                LedgerEntry.entry_type == "checkin",
                LedgerEntry.created_at >= start_dt,
                LedgerEntry.created_at <= end_dt,
            )
        )
        return to_external(int(result.scalar_one()))

    async def get_balance_batch(
        self, user_ids: list[str], currency: str = DEFAULT_CURRENCY
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
                func.coalesce(func.sum(signed_amount_expr()), 0),
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
        self, user_id: str, currency: str = DEFAULT_CURRENCY
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
