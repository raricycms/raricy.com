"""Common Pydantic schemas — unified response wrapper, pagination, errors."""

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """Unified API response wrapper.

    All endpoints return this structure:
    { code: 200, data: {...}, request_id: "<uuid>", message: "ok" }
    """

    code: int = Field(default=200, description="HTTP-like status code")
    data: T | None = Field(default=None, description="Response payload")
    request_id: str = Field(description="Unique request identifier for tracing")
    message: str = Field(default="ok", description="Human-readable status message")


class ErrorResponse(BaseModel):
    """Error response schema."""

    code: int
    message: str
    detail: dict | None = None
    request_id: str


class PaginationInfo(BaseModel):
    """Pagination metadata."""

    page: int
    per_page: int
    total: int
    pages: int
    has_prev: bool
    has_next: bool
