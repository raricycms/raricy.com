"""LedgerEntry and IdempotencyKey ORM models.

Core of the double-entry ledger system:
- Every transaction creates 2+ LedgerEntry rows (DEBIT + CREDIT pairs).
- IdempotencyKey prevents duplicate transfers on network retry.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    JSON,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class LedgerEntry(Base):
    """A single entry in the double-entry ledger.

    Each transfer produces at least two entries (one DEBIT, one CREDIT).
    Balances are computed by summing entries per account.
    """

    __tablename__ = "ledger_entries"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        nullable=False,
        index=True,
        comment="Groups entries belonging to the same transfer",
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    direction: Mapped[str] = mapped_column(
        String(6),
        nullable=False,
        comment="DEBIT (received) or CREDIT (sent/spent)",
    )
    amount: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        comment="Amount in internal units (1 fish = 10000 units)",
    )
    currency: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="DRIED_FISH",
    )
    entry_type: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        index=True,
        comment="Business type: checkin, feed_out, feed_income, admin_grant, etc.",
    )
    description: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    metadata_: Mapped[dict] = mapped_column(
        "metadata",
        JSON,
        default=dict,
        nullable=False,
        comment="Arbitrary business context (fortune_value, blog_id, etc.)",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    account = relationship("Account", back_populates="ledger_entries")

    __table_args__ = (
        CheckConstraint("direction IN ('DEBIT', 'CREDIT')", name="chk_direction"),
        CheckConstraint("amount > 0", name="chk_amount_positive"),
        Index("idx_ledger_account_created", "account_id", created_at.desc()),
        Index("idx_ledger_type_created", "entry_type", created_at.desc()),
    )

    def __repr__(self) -> str:
        return (
            f"<LedgerEntry(id={self.id}, tx={self.transaction_id}, "
            f"account={self.account_id}, {self.direction} {self.amount}, "
            f"type={self.entry_type})>"
        )


class IdempotencyKey(Base):
    """Stores idempotency keys to prevent duplicate transfers.

    Keys expire after idempotency_expiry_hours (default 24h).
    """

    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
    )
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        nullable=True,
    )
    response_json: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
        comment="Cached transfer response for replay",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        comment="TTL for automatic cleanup",
    )

    __table_args__ = (
        Index("idx_idempotency_expires", "expires_at"),
    )

    def __repr__(self) -> str:
        return f"<IdempotencyKey(key={self.key}, tx={self.transaction_id})>"
