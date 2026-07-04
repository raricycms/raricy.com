"""Initial schema — accounts, ledger_entries, idempotency_keys.

Revision ID: 001
Revises: None
Create Date: 2026-07-02
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Accounts table
    op.create_table(
        "accounts",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False, index=True),
        sa.Column("currency", sa.String(20), nullable=False, default="DRIED_FISH"),
        sa.Column("api_key_hash", sa.String(128), nullable=True),
        sa.Column("api_key_prefix", sa.String(12), nullable=True),
        sa.Column("is_system", sa.Boolean(), nullable=False, default=False),
        sa.Column("created_at", sa.DateTime, nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "currency", name="uq_user_currency"),
    )

    # Ledger entries table
    op.create_table(
        "ledger_entries",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("transaction_id", sa.Uuid, nullable=False, index=True),
        sa.Column("account_id", sa.Uuid,
                  sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
                  nullable=False, index=True),
        sa.Column("direction", sa.String(6), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(20), nullable=False, default="DRIED_FISH"),
        sa.Column("entry_type", sa.String(32), nullable=False, index=True),
        sa.Column("description", sa.String(255), nullable=True),
        sa.Column("metadata", sa.JSON(), nullable=False, default=dict),
        sa.Column("created_at", sa.DateTime, nullable=False,
                  server_default=sa.func.now()),
        sa.CheckConstraint("direction IN ('DEBIT', 'CREDIT')", name="chk_direction"),
        sa.CheckConstraint("amount > 0", name="chk_amount_positive"),
        sa.Index("idx_ledger_account_created", "account_id", sa.text("created_at DESC")),
        sa.Index("idx_ledger_type_created", "entry_type", sa.text("created_at DESC")),
    )

    # Idempotency keys table
    op.create_table(
        "idempotency_keys",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("transaction_id", sa.Uuid, nullable=False),
        sa.Column("response_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False,
                  server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime, nullable=False),
        sa.Index("idx_idempotency_expires", "expires_at"),
    )


def downgrade() -> None:
    op.drop_table("idempotency_keys")
    op.drop_table("ledger_entries")
    op.drop_table("accounts")
