"""V1 router — aggregates all v1 API route modules."""

from fastapi import APIRouter, FastAPI

from app.api.v1 import accounts, ledger, transfers


def register_v1_routes(app: FastAPI) -> None:
    """Register all v1 API routers on the FastAPI app."""
    app.include_router(accounts.router)
    app.include_router(transfers.router)
    app.include_router(ledger.router)
