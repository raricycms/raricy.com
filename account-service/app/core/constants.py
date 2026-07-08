"""Cross-module constants — single source of truth for currency defaults/validation.

Avoid scattering magic strings across schemas, models, services, and routes.
Adding a new currency only requires updating DEFAULT_CURRENCY (and the regex
here) — every API entry point validates against CURRENCY_PATTERN automatically.
"""

# Default currency used when the caller doesn't specify one. New currencies
# must match the CURRENCY_PATTERN below (uppercase letters and underscores,
# 1-20 chars).
DEFAULT_CURRENCY: str = "DRIED_FISH"

# Pydantic / FastAPI Query pattern. Matches 1-20 chars of [A-Z_]. Anchored.
CURRENCY_PATTERN: str = r"^[A-Z_]{1,20}$"