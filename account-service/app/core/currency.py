"""Precision conversion for dried fish currency.

1 小鱼干 (dried fish) = 10,000 internal units.
The API accepts and returns natural floats (e.g. 3.0).
Internally all amounts are stored as BIGINT integers.
"""

from decimal import Decimal

INTERNAL_SCALE = 10_000


def to_internal(external: Decimal | float | int) -> int:
    """Convert external amount to internal integer units.

    Args:
        external: Amount in natural units (e.g. 3.0 = 3 fish).

    Returns:
        Internal BIGINT amount (e.g. 30000).
    """
    return round(Decimal(str(external)) * INTERNAL_SCALE)


def to_external(internal: int) -> Decimal:
    """Convert internal integer units to external Decimal amount.

    Args:
        internal: Internal BIGINT amount (e.g. 30000).

    Returns:
        External Decimal amount (e.g. Decimal('3.0')).
    """
    value = Decimal(internal) / INTERNAL_SCALE
    # Normalize to max 4 decimal places, then strip trailing zeros.
    # Integral values get at least 1 decimal place for display (0 → '0.0').
    value = value.quantize(Decimal("0.0001")).normalize()
    if value == value.to_integral_value():
        value = value.quantize(Decimal("0.1"))
    return value
