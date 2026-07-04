"""Account ORM model.

Each account represents a (user_id, currency) pair.
Balances are NOT stored — they are derived from LedgerEntry aggregation.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import DEFAULT_CURRENCY
from app.models.base import Base


class Account(Base):
    """A virtual currency account tied to an external user."""

    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
        index=True,
        comment="External system user ID (UUID from blog)",
    )
    currency: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=DEFAULT_CURRENCY,
    )
    api_key_hash: Mapped[str | None] = mapped_column(
        String(128),
        nullable=True,
        comment="SHA-256 hash of the account's API key (NULL = unclaimed)",
    )
    api_key_prefix: Mapped[str | None] = mapped_column(
        String(12),
        nullable=True,
        comment="First 12 chars of API key for identification (NULL = unclaimed)",
    )
    is_system: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        comment="System accounts can overdraft (no balance check)",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    ledger_entries = relationship(
        "LedgerEntry",
        back_populates="account",
        lazy="raise",  # force explicit loading to avoid N+1
    )

    __table_args__ = (
        UniqueConstraint("user_id", "currency", name="uq_user_currency"),
    )

    def __repr__(self) -> str:
        return (
            f"<Account(id={self.id}, user_id={self.user_id}, "
            f"currency={self.currency}, is_system={self.is_system})>"
        )

    @property
    def is_claimed(self) -> bool:
        """Whether this account has been claimed by its owner (has an API key)."""
        return self.api_key_hash is not None
