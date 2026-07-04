"""FastAPI application entry point.

Creates the FastAPI app with:
- Lifespan handler (engine connect/dispose)
- Request ID middleware (X-Request-ID)
- Rate limiting (slowapi)
- Global exception handlers (unified ApiResponse format)
- Health check endpoint
- All v1 API routes
"""

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text

from app.api.v1.router import register_v1_routes
from app.config import settings
from app.core.exceptions import AccountServiceError
from app.core.limiter import limiter
from app.db.session import get_engine
from app.schemas.common import ApiResponse, ErrorResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — ensure engine is ready on startup, dispose on shutdown."""
    # Startup: trigger engine creation
    engine = get_engine()
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    yield
    # Shutdown: dispose engine
    await engine.dispose()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""

    app = FastAPI(
        title="Account Service",
        description="raricy.com dried-fish virtual currency microservice",
        version=settings.version,
        lifespan=lifespan,
    )

    # ------------------------------------------------------------------
    # Rate limiting
    # ------------------------------------------------------------------
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)

    # ------------------------------------------------------------------
    # Request ID middleware
    # ------------------------------------------------------------------
    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        """Attach a unique request_id to every request for tracing."""
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id

        response = await call_next(request)

        response.headers["X-Request-ID"] = request_id
        return response

    # ------------------------------------------------------------------
    # Exception handlers — unified ApiResponse format
    # ------------------------------------------------------------------
    @app.exception_handler(AccountServiceError)
    async def account_service_error_handler(request: Request, exc: AccountServiceError):
        request_id = getattr(request.state, "request_id", "unknown")
        return JSONResponse(
            status_code=exc.code,
            content=ErrorResponse(
                code=exc.code,
                message=exc.message,
                detail=exc.detail,
                request_id=request_id,
            ).model_dump(),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        request_id = getattr(request.state, "request_id", "unknown")
        details = []
        for error in exc.errors():
            details.append({
                "loc": list(error["loc"]),
                "msg": error["msg"],
                "type": error["type"],
            })
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(
                code=422,
                message="Validation error",
                detail={"errors": details},
                request_id=request_id,
            ).model_dump(),
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        request_id = getattr(request.state, "request_id", "unknown")
        # Capture full traceback for debugging
        import traceback
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        print(f"\n!!! UNHANDLED EXCEPTION !!! request_id={request_id}")
        print("".join(tb))
        detail: dict | None = None
        if settings.debug:
            detail = {
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": "".join(tb),
            }
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                code=500,
                message="Internal server error",
                detail=detail,
                request_id=request_id,
            ).model_dump(),
        )

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------
    @app.get("/health")
    async def health_check():
        """Health check — verifies the service and database are running."""
        db_status = "disconnected"
        try:
            engine = get_engine()
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            db_status = "connected"
        except Exception:
            db_status = "disconnected"

        return {
            "status": "ok" if db_status == "connected" else "degraded",
            "version": settings.version,
            "db": db_status,
        }

    # ------------------------------------------------------------------
    # Register routes
    # ------------------------------------------------------------------
    register_v1_routes(app)

    return app


# Module-level app instance for uvicorn
app = create_app()
