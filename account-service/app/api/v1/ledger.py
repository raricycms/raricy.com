"""Ledger API endpoint — paginated transaction history with filters."""

from datetime import date

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import (
    get_ledger_service,
    get_request_id,
    verify_internal_token,
)
from app.core.limiter import limiter
from app.schemas.common import ApiResponse
from app.schemas.ledger import LedgerPageResponse
from app.services.ledger_service import LedgerService

router = APIRouter(prefix="/api/v1/accounts", tags=["ledger"])


@router.get(
    "/{user_id}/ledger",
    response_model=ApiResponse[LedgerPageResponse],
)
@limiter.limit("30/second")
async def get_ledger(
    request: Request,
    user_id: str,
    page: int = Query(default=1, ge=1, description="Page number (1-based)"),
    per_page: int = Query(default=20, ge=1, le=100, description="Entries per page"),
    currency: str = Query(default="DRIED_FISH", pattern=r"^[A-Z_]{1,20}$"),
    entry_type: str | None = Query(
        default=None,
        description="Comma-separated type filter (e.g. 'checkin,feed_out')",
    ),
    start: date | None = Query(default=None, description="Start date (inclusive)"),
    end: date | None = Query(default=None, description="End date (inclusive)"),
    service: LedgerService = Depends(get_ledger_service),
    _token: str = Depends(verify_internal_token),
):
    """Get paginated transaction history for a user.

    Supports filtering by entry_type (comma-separated) and date range.
    Returns an empty list for non-existent users.
    """
    result = await service.get_ledger(
        user_id=user_id,
        page=page,
        per_page=per_page,
        currency=currency,
        entry_type=entry_type,
        start=start,
        end=end,
    )

    return ApiResponse(
        code=200,
        data=result,
        request_id=get_request_id(request),
        message="ok",
    )
