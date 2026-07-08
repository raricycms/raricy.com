"""Account API endpoints — create accounts and query balances."""

import logging

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import (
    get_account_service,
    ok_response,
    verify_internal_token,
)
from app.core.constants import CURRENCY_PATTERN, DEFAULT_CURRENCY
from app.core.currency import to_external
from app.core.limiter import limiter
from app.models.ledger_entry import compute_balance
from app.schemas.account import (
    BalanceResponse,
    BatchBalanceRequest,
    BatchBalanceResponse,
    CreateAccountRequest,
    CreateAccountResponse,
    ExistingAccountResponse,
)
from app.schemas.common import ApiResponse
from app.services.account_service import AccountService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/accounts",
    tags=["accounts"],
    dependencies=[Depends(verify_internal_token)],
)


@router.post(
    "",
    response_model=ApiResponse[CreateAccountResponse | ExistingAccountResponse],
    status_code=201,
)
@limiter.limit("20/second")
async def create_account(
    request: Request,
    body: CreateAccountRequest,
    service: AccountService = Depends(get_account_service),
):
    """Create a new account or return an existing one.

    The API key is ONLY returned on first creation (201).
    Duplicate requests return 200 with account info but NO api_key.
    """
    account, api_key = await service.create_account(
        user_id=body.user_id,
        currency=body.currency,
    )

    try:
        if api_key is not None:
            # New account — return api_key
            balance = 0.0  # new accounts always start at 0
            data = CreateAccountResponse(
                account_id=account.id,
                user_id=account.user_id,
                currency=account.currency,
                balance=balance,
                api_key=api_key,
                created_at=account.created_at,
            )
            status_code = 201
        else:
            # Existing account — no api_key
            internal_balance = await compute_balance(service.db, account.id)
            balance = to_external(internal_balance)

            data = ExistingAccountResponse(
                account_id=account.id,
                user_id=account.user_id,
                currency=account.currency,
                balance=balance,
                created_at=account.created_at,
            )
            status_code = 200
    except Exception as exc:
        # Log detailed context if response construction or compute_balance
        # ever fails so the 500 path produces useful diagnostics in uvicorn
        # logs — particularly the eager-default-refresh round trip that
        # occurs when the INSERT returns without `RETURNING created_at`.
        logger.exception(
            "Failed to build create-account response: user_id=%s currency=%s "
            "account_id=%s created_at=%r account_type=%s",
            body.user_id,
            body.currency,
            getattr(account, "id", None),
            getattr(account, "created_at", None),
            type(getattr(account, "created_at", None)).__name__,
            exc_info=exc,
        )
        raise

    return ok_response(request, data, code=status_code)


@router.get(
    "/{user_id}/balance",
    response_model=ApiResponse[BalanceResponse],
)
@limiter.limit("100/second")
async def get_balance(
    request: Request,
    user_id: str,
    currency: str = Query(default=DEFAULT_CURRENCY, pattern=CURRENCY_PATTERN),
    include: str | None = Query(
        default=None,
        description=(
            "Comma-separated optional fields to include. "
            "Supported: 'today_checkin' (UTC+8 day check-in earnings)."
        ),
    ),
    service: AccountService = Depends(get_account_service),
):
    """Get the balance for a user.

    Returns balance=0.0 for non-existent users (never 404).

    Pass `?include=today_checkin` to also receive today's (UTC+8) check-in
    earnings in `data.today_checkin`, saving the client an extra ledger query.
    """
    include_today_checkin = False
    if include:
        for token in include.split(","):
            if token.strip() == "today_checkin":
                include_today_checkin = True
                break

    balance, updated_at, today_checkin = await service.get_balance(
        user_id,
        currency,
        include_today_checkin=include_today_checkin,
    )

    return ok_response(
        request,
        BalanceResponse(
            user_id=user_id,
            currency=currency,
            balance=balance,
            updated_at=updated_at,
            today_checkin=today_checkin,
        ),
    )


@router.post(
    "/balances/batch",
    response_model=ApiResponse[BatchBalanceResponse],
)
@limiter.limit("20/second")
async def batch_balance(
    request: Request,
    body: BatchBalanceRequest,
    service: AccountService = Depends(get_account_service),
):
    """Query balances for multiple users at once (max 100)."""
    balances = await service.get_balance_batch(body.user_ids, body.currency)

    return ok_response(
        request,
        BatchBalanceResponse(
            balances=balances,
            currency=body.currency,
        ),
    )
