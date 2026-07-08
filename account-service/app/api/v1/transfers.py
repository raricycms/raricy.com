"""Transfer API endpoint — the core double-entry transfer operation.

Requires:
  - Authorization: Bearer <api_key>  (must belong to from_user_id)
  - X-Idempotency-Key: <uuid>        (required, prevents duplicates)
"""

from fastapi import APIRouter, Depends, Request

from app.api.deps import (
    extract_api_key,
    extract_idempotency_key,
    get_transfer_service,
    ok_response,
    verify_internal_token,
)
from app.core.exceptions import ApiKeyInvalidError
from app.core.limiter import limiter
from app.schemas.common import ApiResponse
from app.schemas.transfer import TransferRequest, TransferResponse
from app.services.transfer_service import TransferService

router = APIRouter(
    prefix="/api/v1",
    tags=["transfers"],
    dependencies=[Depends(verify_internal_token)],
)


@router.post(
    "/transfers",
    response_model=ApiResponse[TransferResponse],
)
@limiter.limit("10/second")
async def create_transfer(
    request: Request,
    body: TransferRequest,
    service: TransferService = Depends(get_transfer_service),
    api_key: str | None = Depends(extract_api_key),
    idempotency_key: str = Depends(extract_idempotency_key),
):
    """Execute a double-entry transfer.

    The API key in the Authorization header must belong to from_user_id.
    The X-Idempotency-Key header prevents duplicate transfers on retry.

    Raises:
        400: Insufficient balance.
        401: Invalid or missing API key.
        403: API key doesn't belong to from_user_id.
        409: Idempotency key conflict (same key, different request).
    """
    if not api_key:
        raise ApiKeyInvalidError()

    result = await service.transfer(
        from_user_id=body.from_user_id,
        to_user_id=body.to_user_id,
        amount=body.amount,
        currency=body.currency,
        entry_type=body.entry_type,
        description=body.description,
        metadata=body.metadata,
        idempotency_key=idempotency_key,
        api_key=api_key,
    )

    return ok_response(request, result)
