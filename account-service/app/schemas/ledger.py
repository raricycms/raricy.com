"""Ledger (transaction history) Pydantic schemas."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas.common import PaginationInfo


class LedgerQueryParams(BaseModel):
    """Query parameters for listing ledger entries."""

    page: int = Field(default=1, ge=1, description="Page number (1-based)")
    per_page: int = Field(default=20, ge=1, le=100, description="Entries per page")
    entry_type: str | None = Field(
        default=None,
        description="Comma-separated type filter (e.g. 'checkin,feed_out')",
    )
    start: date | None = Field(
        default=None,
        description="Filter entries created on or after this date",
    )
    end: date | None = Field(
        default=None,
        description="Filter entries created on or before this date",
    )
    currency: str = Field(
        default="DRIED_FISH",
        pattern=r"^[A-Z_]{1,20}$",
    )


class LedgerEntryResponse(BaseModel):
    """A single ledger entry in the response."""

    id: uuid.UUID
    transaction_id: uuid.UUID
    direction: str
    amount: Decimal = Field(description="Amount in natural units")
    entry_type: str
    description: str | None = None
    counterparty: str | None = Field(
        default=None,
        description="User ID of the other party in this transaction",
    )
    balance_after: Decimal | None = Field(
        default=None,
        description="Account balance after this entry (natural units)",
    )
    metadata: dict = Field(default_factory=dict)
    created_at: datetime


class LedgerPageResponse(BaseModel):
    """Paginated ledger entry list."""

    entries: list[LedgerEntryResponse]
    pagination: PaginationInfo
