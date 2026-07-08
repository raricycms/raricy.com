"""Application configuration via pydantic-settings.

Reads from .env file and environment variables.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Account service configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database — SQLite, no external DB needed
    database_url: str = "sqlite+aiosqlite:///account.db"

    # Service
    debug: bool = False
    service_name: str = "account-service"
    version: str = "0.1.0"

    # System account — the "issuer" of dried fish, can overdraft
    system_account_id: str = "00000000-0000-0000-0000-000000000000"
    system_user_id: str = "raricy-blog-system"

    # API Key
    api_key_prefix: str = "fish_sk_"

    # Idempotency
    idempotency_expiry_hours: int = 24

    # Internal service auth — shared secret between blog and account-service.
    # ALL endpoints require X-Internal-Token to match this value.
    # When empty (unconfigured), all requests are rejected (fail-closed).
    internal_token: str = ""


settings = Settings()
