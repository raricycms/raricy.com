"""Ledger service — paginated transaction history with filters."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import DEFAULT_CURRENCY
from app.core.currency import to_external
from app.models.account import Account
from app.models.ledger_entry import LedgerEntry, compute_balance, signed_amount_expr
from app.schemas.common import PaginationInfo
from app.schemas.ledger import LedgerEntryResponse, LedgerPageResponse
from app.services.account_service import AccountService


class LedgerService:
    """Service for querying transaction history."""

    def __init__(self, db: AsyncSession, account_service: AccountService):
        self.db = db
        self.account_service = account_service

    async def get_ledger(
        self,
        user_id: str,
        page: int = 1,
        per_page: int = 20,
        currency: str = DEFAULT_CURRENCY,
        entry_type: str | None = None,
        start: date | None = None,
        end: date | None = None,
    ) -> LedgerPageResponse:
        """Get paginated ledger entries for a user.

        Args:
            user_id: External user ID.
            page: Page number (1-based).
            per_page: Entries per page (max 100).
            currency: Currency code.
            entry_type: Optional comma-separated type filter.
            start: Optional start date filter (inclusive).
            end: Optional end date filter (inclusive).

        Returns:
            LedgerPageResponse with entries and pagination metadata.
        """
        # First, find the account
        account = await self.account_service.get_account_by_user_id(user_id, currency)
        if account is None:
            return LedgerPageResponse(
                entries=[],
                pagination=PaginationInfo(
                    page=page,
                    per_page=per_page,
                    total=0,
                    pages=0,
                    has_prev=False,
                    has_next=False,
                ),
            )

        account_id = account.id

        # Build query
        base_query = select(LedgerEntry).where(
            LedgerEntry.account_id == account_id,
            LedgerEntry.currency == currency,
        )

        # Optional type filter (supports comma-separated values)
        if entry_type:
            types = [t.strip() for t in entry_type.split(",") if t.strip()]
            if types:
                base_query = base_query.where(LedgerEntry.entry_type.in_(types))

        # Optional date range
        if start:
            start_dt = datetime(start.year, start.month, start.day)
            base_query = base_query.where(LedgerEntry.created_at >= start_dt)
        if end:
            end_dt = datetime(end.year, end.month, end.day, 23, 59, 59)
            base_query = base_query.where(LedgerEntry.created_at <= end_dt)

        # Count total
        count_query = select(func.count()).select_from(base_query.subquery())
        total_result = await self.db.execute(count_query)
        total = total_result.scalar_one()

        # Paginate
        pages = max(1, (total + per_page - 1) // per_page) if total > 0 else 0
        offset = (page - 1) * per_page

        query = (
            base_query
            .order_by(LedgerEntry.created_at.desc())
            .offset(offset)
            .limit(per_page)
        )
        result = await self.db.execute(query)
        entries = result.scalars().all()

        # Build response entries with counterparty info and balance_after
        entry_responses = []
        for entry in entries:
            counterparty = await self._get_counterparty(entry.transaction_id, account_id)
            balance_after = await self._compute_balance_at(account_id, entry.created_at, entry.id)

            entry_responses.append(
                LedgerEntryResponse(
                    id=entry.id,
                    transaction_id=entry.transaction_id,
                    direction=entry.direction,
                    amount=to_external(entry.amount),
                    entry_type=entry.entry_type,
                    description=entry.description,
                    counterparty=counterparty,
                    balance_after=balance_after,
                    metadata=entry.metadata_,
                    created_at=entry.created_at,
                )
            )

        return LedgerPageResponse(
            entries=entry_responses,
            pagination=PaginationInfo(
                page=page,
                per_page=per_page,
                total=total,
                pages=pages,
                has_prev=page > 1,
                has_next=page < pages,
            ),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _get_counterparty(
        self, transaction_id: uuid.UUID, account_id: uuid.UUID
    ) -> str | None:
        """Find the counterparty (other party) in a transaction.

        Looks for the other LedgerEntry in the same transaction.
        """
        result = await self.db.execute(
            select(LedgerEntry)
            .where(
                LedgerEntry.transaction_id == transaction_id,
                LedgerEntry.account_id != account_id,
            )
            .limit(1)
        )
        other = result.scalar_one_or_none()
        if other is None:
            return None

        # Get the user_id for the counterparty account
        acc_result = await self.db.execute(
            select(Account.user_id).where(Account.id == other.account_id)
        )
        user_id = acc_result.scalar_one_or_none()
        return user_id

    async def _compute_balance_at(
        self, account_id: uuid.UUID, at_time: datetime, entry_id: uuid.UUID
    ) -> Decimal | None:
        """Compute the running balance after a specific ledger entry.

        Sums all entries up to and including the given entry.
        """
        result = await self.db.execute(
            select(
                func.coalesce(func.sum(signed_amount_expr()), 0),
            ).where(
                LedgerEntry.account_id == account_id,
                LedgerEntry.created_at <= at_time,
            )
        )
        internal_balance = result.scalar_one()
        return to_external(int(internal_balance))
