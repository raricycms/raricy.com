"""Custom exceptions for the account service.

Each exception maps to an HTTP status code and is caught by the global
exception handler in main.py to produce a unified ApiResponse.
"""

from app.core.currency import to_external


class AccountServiceError(Exception):
    """Base exception for all account service errors."""

    def __init__(self, message: str, code: int = 500, detail: dict | None = None):
        self.message = message
        self.code = code
        self.detail = detail or {}
        super().__init__(message)


class InsufficientBalanceError(AccountServiceError):
    """The account does not have enough balance for the transfer."""

    def __init__(self, user_id: str, required: int, available: int):
        super().__init__(
            message=f"Insufficient balance for user_id={user_id}: "
            f"required={to_external(required)}, available={to_external(available)}",
            code=400,
            detail={
                "user_id": user_id,
                "required": str(to_external(required)),
                "available": str(to_external(available)),
            },
        )


class ApiKeyInvalidError(AccountServiceError):
    """The provided API key is invalid (not found in database)."""

    def __init__(self):
        super().__init__(message="Invalid API key", code=401)


class ApiKeyMismatchError(AccountServiceError):
    """The API key does not belong to the claimed from_user_id."""

    def __init__(self, key_belongs_to: str, claimed_from_user: str):
        super().__init__(
            message="API key does not match the claimed from_user_id",
            code=403,
            detail={
                "key_belongs_to": key_belongs_to,
                "claimed_from_user": claimed_from_user,
            },
        )


class IdempotencyConflictError(AccountServiceError):
    """An idempotency key was reused with a different request body."""

    def __init__(self, key: str):
        super().__init__(
            message=f"Idempotency key conflict: {key} (different request body)",
            code=409,
            detail={"idempotency_key": key},
        )


class InternalTokenInvalidError(AccountServiceError):
    """X-Internal-Token is missing or invalid."""

    def __init__(self):
        super().__init__(message="Invalid or missing internal token", code=401)


class IdempotencyKeyMissingError(AccountServiceError):
    """X-Idempotency-Key header is missing."""

    def __init__(self):
        super().__init__(message="Missing X-Idempotency-Key header", code=400)


class IdempotencyKeyInvalidFormatError(AccountServiceError):
    """X-Idempotency-Key format is invalid."""

    def __init__(self):
        super().__init__(
            message="Invalid X-Idempotency-Key format (must be 1-64 alphanumeric, hyphens, or underscores)",
            code=400,
        )


class AccountAlreadyExistsRaceError(AccountServiceError):
    """Race condition: account was created by a concurrent request and re-query also failed.

    Returned when the IntegrityError re-query path also fails (e.g., another
    transaction also rolled back, or the post-rollback snapshot doesn't yet
    see the committed row). The caller should retry — the account creation
    is idempotent.

    Surfaced as 409 Conflict so the blog side knows the operation is
    recoverable by retry.
    """

    def __init__(self, user_id: str, currency: str):
        super().__init__(
            message=(
                f"Account for user_id={user_id} currency={currency} was created "
                "by a concurrent request but is not yet visible after re-query. "
                "Retry the call."
            ),
            code=409,
            detail={"user_id": user_id, "currency": currency},
        )
