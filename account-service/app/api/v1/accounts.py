"""Account API endpoints — create accounts and query balances."""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import case, func, select

from app.api.deps import (
    get_account_service,
    get_request_id,
    verify_internal_token,
)
from app.core.currency import to_external
from app.core.limiter import limiter
from app.models.ledger_entry import LedgerEntry
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

router = APIRouter(prefix="/api/v1/accounts", tags=["accounts"])


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
    _token: str = Depends(verify_internal_token),
):
    """Create a new account or return an existing one.

    The API key is ONLY returned on first creation (201).
    Duplicate requests return 200 with account info but NO api_key.
    """
    account, api_key = await service.create_account(
        user_id=body.user_id,
        currency=body.currency,
    )

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
        result = await service.db.execute(
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
            ).where(LedgerEntry.account_id == account.id)
        )
        internal_balance = result.scalar_one()
        balance = to_external(int(internal_balance))

        data = ExistingAccountResponse(
            account_id=account.id,
            user_id=account.user_id,
            currency=account.currency,
            balance=balance,
            created_at=account.created_at,
        )
        status_code = 200

    return ApiResponse(
        code=status_code,
        data=data,
        request_id=get_request_id(request),
        message="ok",
    )


@router.get(
    "/{user_id}/balance",
    response_model=ApiResponse[BalanceResponse],
)
@limiter.limit("100/second")
async def get_balance(
    request: Request,
    user_id: str,
    currency: str = Query(default="DRIED_FISH", pattern=r"^[A-Z_]{1,20}$"),
    service: AccountService = Depends(get_account_service),
    _token: str = Depends(verify_internal_token),
):
    """Get the balance for a user.

    Returns balance=0.0 for non-existent users (never 404).
    """
    balance, updated_at = await service.get_balance(user_id, currency)

    return ApiResponse(
        code=200,
        data=BalanceResponse(
            user_id=user_id,
            currency=currency,
            balance=balance,
            updated_at=updated_at,
        ),
        request_id=get_request_id(request),
        message="ok",
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
    _token: str = Depends(verify_internal_token),
):
    """Query balances for multiple users at once (max 100)."""
    balances = await service.get_balance_batch(body.user_ids, body.currency)

    return ApiResponse(
        code=200,
        data=BatchBalanceResponse(
            balances=balances,
            currency=body.currency,
        ),
        request_id=get_request_id(request),
        message="ok",
    )
