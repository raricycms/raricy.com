"""Account-related Pydantic schemas."""

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.core.constants import CURRENCY_PATTERN, DEFAULT_CURRENCY


class CreateAccountRequest(BaseModel):
    """Request body for creating a new account."""

    user_id: str = Field(
        max_length=36,
        description="External user ID (UUID from the blog system)",
    )
    currency: str = Field(
        default=DEFAULT_CURRENCY,
        pattern=CURRENCY_PATTERN,
        description="Currency code",
    )


class CreateAccountResponse(BaseModel):
    """Response for a newly created account. Includes the API key ONCE."""

    account_id: uuid.UUID
    user_id: str
    currency: str
    balance: Decimal = Field(default=Decimal("0.0"))
    api_key: str = Field(description="API key — only returned on creation, store it safely")
    created_at: datetime


class ExistingAccountResponse(BaseModel):
    """Response when an account already exists. No API key included."""

    account_id: uuid.UUID
    user_id: str
    currency: str
    balance: Decimal
    created_at: datetime


class BalanceResponse(BaseModel):
    """Single-account balance response."""

    user_id: str
    currency: str
    balance: Decimal = Field(default=Decimal("0.0"))
    updated_at: datetime | None = Field(
        default=None,
        description="Timestamp of the most recent ledger entry, or None if no activity",
    )
    today_checkin: Decimal | None = Field(
        default=None,
        description=(
            "Today's check-in earnings (UTC+8 date). "
            "Only populated when client passes ?include=today_checkin."
        ),
    )


class BatchBalanceRequest(BaseModel):
    """Batch balance query — up to 100 user IDs."""

    user_ids: list[str] = Field(
        max_length=100,
        description="List of user IDs to query (max 100)",
    )
    currency: str = Field(
        default=DEFAULT_CURRENCY,
        pattern=CURRENCY_PATTERN,
    )

    @field_validator("user_ids")
    @classmethod
    def check_max_user_ids(cls, v: list[str]) -> list[str]:
        if len(v) > 100:
            raise ValueError("Maximum 100 user_ids per batch request")
        if len(v) == 0:
            raise ValueError("At least one user_id is required")
        return v


class BatchBalanceResponse(BaseModel):
    """Batch balance query response."""

    balances: dict[str, Decimal] = Field(
        description="Map of user_id → balance (0.0 for non-existent users)"
    )
    currency: str
