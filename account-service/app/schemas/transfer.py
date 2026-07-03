"""Transfer-related Pydantic schemas."""

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class TransferRequest(BaseModel):
    """Request body for creating a transfer (double-entry transaction).

    The Authorization header must contain the API key belonging to from_user_id.
    The X-Idempotency-Key header is required to prevent duplicate transfers.
    """

    from_user_id: str = Field(
        max_length=36,
        description="Sender's external user ID",
    )
    to_user_id: str = Field(
        max_length=36,
        description="Recipient's external user ID",
    )
    amount: Decimal = Field(
        gt=0,
        description="Amount in natural units (e.g. 3.0 = 3 fish)",
    )
    currency: str = Field(
        default="DRIED_FISH",
        pattern=r"^[A-Z_]{1,20}$",
    )
    entry_type: str = Field(
        max_length=32,
        description="Business type: checkin, feed_out, admin_grant, etc.",
    )
    description: str | None = Field(
        default=None,
        max_length=255,
    )
    metadata: dict = Field(
        default_factory=dict,
        description="Arbitrary business context (fortune_value, blog_id, etc.)",
    )


class TransferResponse(BaseModel):
    """Response for a completed transfer."""

    transaction_id: uuid.UUID
    from_user_id: str
    to_user_id: str
    amount: Decimal
    currency: str
    entry_type: str
    from_balance_after: Decimal
    to_balance_after: Decimal
    created_at: datetime
