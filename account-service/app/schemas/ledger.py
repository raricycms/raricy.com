"""Ledger (transaction history) Pydantic schemas."""

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas.common import PaginationInfo


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
