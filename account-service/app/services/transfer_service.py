"""Transfer service — the core double-entry ledger logic.

Every transfer creates two LedgerEntry rows (one CREDIT, one DEBIT).
Idempotency keys prevent duplicate transfers on network retry.
API key authentication ensures only the from_user can initiate transfers.
"""

import json
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.currency import to_external, to_internal
from app.core.exceptions import (
    ApiKeyInvalidError,
    ApiKeyMismatchError,
    IdempotencyConflictError,
    InsufficientBalanceError,
)
from app.core.security import hash_api_key, verify_api_key
from app.models.account import Account
from app.models.ledger_entry import IdempotencyKey, LedgerEntry
from app.schemas.transfer import TransferResponse


class TransferService:
    """Service for executing double-entry transfers."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def transfer(
        self,
        from_user_id: str,
        to_user_id: str,
        amount: Decimal,
        currency: str,
        entry_type: str,
        description: str | None,
        metadata: dict | None,
        idempotency_key: str,
        api_key: str,
    ) -> TransferResponse:
        """Execute a double-entry transfer.

        Flow:
        1. Check idempotency — return cached response if seen before.
        2. Hash & verify API key — must belong to from_user_id.
        3. Convert amount to internal units.
        4. Lock both accounts (SELECT ... FOR UPDATE).
        5. Check balance of from_account (skip if is_system).
        6. Create CREDIT + DEBIT ledger entries.
        7. Compute post-transfer balances.
        8. Save idempotency key → response mapping.
        9. Return TransferResponse.

        Args:
            from_user_id: Sender's external user ID.
            to_user_id: Recipient's external user ID.
            amount: Transfer amount in natural units (e.g. 3.0).
            currency: Currency code.
            entry_type: Business type (checkin, feed_out, admin_grant, etc.).
            description: Optional human-readable note.
            metadata: Optional business context dict.
            idempotency_key: Unique key to prevent duplicate transfers.
            api_key: Raw API key from Authorization header.

        Returns:
            TransferResponse with transaction details and post-transfer balances.

        Raises:
            ApiKeyInvalidError: API key not found.
            ApiKeyMismatchError: API key doesn't belong to from_user_id.
            InsufficientBalanceError: Not enough balance (non-system accounts).
            IdempotencyConflictError: Same key, different request body.
        """
        # ------------------------------------------------------------------
        # 1. Check idempotency
        # ------------------------------------------------------------------
        cached = await self._check_idempotency(idempotency_key, from_user_id, to_user_id, amount, currency, entry_type)
        if cached is not None:
            return cached

        # ------------------------------------------------------------------
        # 2. Verify API key
        # ------------------------------------------------------------------
        key_hash = hash_api_key(api_key)
        from_account = await self._get_account_by_key_hash(key_hash)
        if from_account is None:
            raise ApiKeyInvalidError()

        if from_account.user_id != from_user_id:
            raise ApiKeyMismatchError(
                key_belongs_to=from_account.user_id,
                claimed_from_user=from_user_id,
            )

        # ------------------------------------------------------------------
        # 3. Convert amount
        # ------------------------------------------------------------------
        internal_amount = to_internal(amount)

        # ------------------------------------------------------------------
        # 4. Lock both accounts & verify existence
        # ------------------------------------------------------------------
        from_account_locked = await self._lock_account(from_account.id)
        if from_account_locked is None:
            raise ApiKeyInvalidError()  # shouldn't happen — key verified above

        to_account = await self._get_or_create_account_for_transfer(to_user_id, currency)
        to_account_locked = await self._lock_account(to_account.id)

        # ------------------------------------------------------------------
        # 5. Check balance (skip for system accounts)
        # ------------------------------------------------------------------
        if not from_account_locked.is_system:
            balance_internal, _ = await self._compute_balance(from_account_locked.id)
            if balance_internal < internal_amount:
                raise InsufficientBalanceError(
                    user_id=from_user_id,
                    required=internal_amount,
                    available=balance_internal,
                )

        # ------------------------------------------------------------------
        # 6. Create ledger entries (CREDIT from sender, DEBIT to receiver)
        # ------------------------------------------------------------------
        transaction_id = uuid.uuid4()
        now = datetime.utcnow()

        # CREDIT — money leaving the sender
        credit_entry = LedgerEntry(
            transaction_id=transaction_id,
            account_id=from_account_locked.id,
            direction="CREDIT",
            amount=internal_amount,
            currency=currency,
            entry_type=entry_type,
            description=description,
            metadata_=metadata or {},
            created_at=now,
        )
        self.db.add(credit_entry)

        # DEBIT — money entering the receiver
        debit_entry = LedgerEntry(
            transaction_id=transaction_id,
            account_id=to_account_locked.id,
            direction="DEBIT",
            amount=internal_amount,
            currency=currency,
            entry_type=entry_type,
            description=description,
            metadata_=metadata or {},
            created_at=now,
        )
        self.db.add(debit_entry)

        # ------------------------------------------------------------------
        # 7. Compute post-transfer balances
        # ------------------------------------------------------------------
        from_balance_internal, _ = await self._compute_balance(from_account_locked.id)
        to_balance_internal, _ = await self._compute_balance(to_account_locked.id)

        from_balance_after = to_external(from_balance_internal)
        to_balance_after = to_external(to_balance_internal)

        # ------------------------------------------------------------------
        # 8. Build response & save idempotency
        # ------------------------------------------------------------------
        response = TransferResponse(
            transaction_id=transaction_id,
            from_user_id=from_user_id,
            to_user_id=to_user_id,
            amount=amount,
            currency=currency,
            entry_type=entry_type,
            from_balance_after=from_balance_after,
            to_balance_after=to_balance_after,
            created_at=now,
        )

        await self._save_idempotency(idempotency_key, transaction_id, response)

        # Commit is handled by the FastAPI dependency (get_db)

        return response

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _check_idempotency(
        self,
        key: str,
        from_user_id: str,
        to_user_id: str,
        amount: Decimal,
        currency: str,
        entry_type: str,
    ) -> TransferResponse | None:
        """Check if this idempotency key has been used before.

        Returns:
            - TransferResponse if the same request was already processed.
            - None if the key is new.
        Raises:
            IdempotencyConflictError if the same key was used with different params.
        """
        result = await self.db.execute(
            select(IdempotencyKey).where(IdempotencyKey.key == key)
        )
        record = result.scalar_one_or_none()

        if record is None:
            return None

        # Check expiry
        if record.expires_at < datetime.utcnow():
            # Expired — delete and allow retry
            await self.db.delete(record)
            await self.db.flush()
            return None

        # Key exists and is valid — check for conflict
        if record.response_json is None:
            # In-progress (shouldn't normally happen in sync flow)
            raise IdempotencyConflictError(key)

        cached_response = record.response_json

        # Validate the request matches the cached one
        if (
            cached_response.get("from_user_id") != from_user_id
            or cached_response.get("to_user_id") != to_user_id
            or cached_response.get("amount") != str(amount)
            or cached_response.get("currency") != currency
            or cached_response.get("entry_type") != entry_type
        ):
            raise IdempotencyConflictError(key)

        # Same request — return cached response
        return TransferResponse(**cached_response)

    async def _save_idempotency(
        self,
        key: str,
        transaction_id: uuid.UUID,
        response: TransferResponse,
    ) -> None:
        """Persist an idempotency key → response mapping."""
        now = datetime.utcnow()
        expires_at = now + timedelta(hours=settings.idempotency_expiry_hours)

        record = IdempotencyKey(
            key=key,
            transaction_id=transaction_id,
            response_json=response.model_dump(mode="json"),
            created_at=now,
            expires_at=expires_at,
        )
        self.db.add(record)
        # Flush but don't commit — commit happens after ledger entries are written
        await self.db.flush()

    async def _get_account_by_key_hash(self, key_hash: str) -> Account | None:
        """Look up an account by its API key hash."""
        result = await self.db.execute(
            select(Account).where(Account.api_key_hash == key_hash)
        )
        return result.scalar_one_or_none()

    async def _lock_account(self, account_id: uuid.UUID) -> Account | None:
        """Lock an account row with SELECT ... FOR UPDATE.

        This prevents concurrent transfers from double-spending.
        """
        result = await self.db.execute(
            select(Account)
            .where(Account.id == account_id)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def _get_or_create_account_for_transfer(
        self, user_id: str, currency: str
    ) -> Account:
        """Get an existing account or create one for the recipient.

        If the recipient doesn't have an account yet, auto-create one.
        This handles the case where a user receives fish before explicitly
        creating an account (e.g., feed income for a new author).
        """
        result = await self.db.execute(
            select(Account).where(
                Account.user_id == user_id,
                Account.currency == currency,
            )
        )
        account = result.scalar_one_or_none()
        if account is not None:
            return account

        # Auto-create account for recipient — NO API key generated.
        # The account is "unclaimed" until the user explicitly registers
        # via POST /api/v1/accounts, at which point a key is issued.
        account = Account(
            user_id=user_id,
            currency=currency,
            api_key_hash=None,
            api_key_prefix=None,
            is_system=False,
        )
        self.db.add(account)
        await self.db.flush()
        return account

    async def _compute_balance(self, account_id: uuid.UUID) -> tuple[int, datetime | None]:
        """Compute current balance for an account from ledger entries.

        Must be called within a transaction that holds a lock on the account row.

        Returns:
            Tuple of (internal_balance, last_activity_timestamp).
        """
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
            ).where(LedgerEntry.account_id == account_id)
        )
        internal_balance, updated_at = result.one()
        return int(internal_balance), updated_at
