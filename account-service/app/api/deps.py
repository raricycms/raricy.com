"""FastAPI dependency injection.

Provides DB sessions, service instances, API key extraction,
internal token verification, and idempotency key validation.
"""

import re
import secrets

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.exceptions import (
    IdempotencyKeyInvalidFormatError,
    IdempotencyKeyMissingError,
    InternalTokenInvalidError,
)
from app.db.session import get_db
from app.services.account_service import AccountService
from app.services.ledger_service import LedgerService
from app.services.transfer_service import TransferService


# Re-export get_db for convenience
__all__ = [
    "get_db",
    "get_account_service",
    "get_transfer_service",
    "get_ledger_service",
    "extract_api_key",
    "verify_internal_token",
    "extract_idempotency_key",
    "get_request_id",
]

# Only allow safe characters, 1-64 chars (matching DB column width)
_IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


async def get_account_service(db: AsyncSession = Depends(get_db)) -> AccountService:
    """Dependency: AccountService with an active DB session."""
    return AccountService(db)


async def get_transfer_service(db: AsyncSession = Depends(get_db)) -> TransferService:
    """Dependency: TransferService with an active DB session."""
    return TransferService(db)


async def get_ledger_service(db: AsyncSession = Depends(get_db)) -> LedgerService:
    """Dependency: LedgerService with an active DB session."""
    return LedgerService(db)


async def extract_api_key(authorization: str | None = Header(None)) -> str | None:
    """Extract Bearer token from the Authorization header.

    Returns the raw API key string, or None if no header is present.
    Validation (hash lookup + ownership check) happens in TransferService.
    """
    if not authorization:
        return None

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None

    return token


async def verify_internal_token(
    x_internal_token: str | None = Header(None, alias="X-Internal-Token"),
) -> str:
    """Verify the X-Internal-Token shared secret.

    Every endpoint must include this dependency. When internal_token is
    not configured the service is fail-closed — all requests are rejected.
    Uses constant-time comparison to prevent timing attacks.
    """
    if not settings.internal_token:
        raise InternalTokenInvalidError()
    if not x_internal_token:
        raise InternalTokenInvalidError()
    if not secrets.compare_digest(x_internal_token, settings.internal_token):
        raise InternalTokenInvalidError()
    return x_internal_token


async def extract_idempotency_key(
    x_idempotency_key: str | None = Header(None, alias="X-Idempotency-Key"),
) -> str:
    """Extract and validate the X-Idempotency-Key header.

    Rejects missing keys and keys with invalid characters or lengths.
    The DB column is VARCHAR(64) — we enforce the same limit here.
    """
    if not x_idempotency_key:
        raise IdempotencyKeyMissingError()
    if not _IDEMPOTENCY_KEY_PATTERN.match(x_idempotency_key):
        raise IdempotencyKeyInvalidFormatError()
    return x_idempotency_key


def get_request_id(request: Request) -> str:
    """Get the request ID from request state (set by middleware)."""
    return getattr(request.state, "request_id", "unknown")
