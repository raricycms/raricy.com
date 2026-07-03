"""API Key generation and verification.

API Key format: fish_sk_<32 bytes random base64url>
Only SHA-256 hashes are stored; plain keys are returned once at creation.
"""

import hashlib
import secrets

from app.config import settings


def generate_api_key() -> tuple[str, str, str]:
    """Generate a new API key.

    Returns:
        Tuple of (plain_key, key_hash, key_prefix).
        - plain_key: the full API key to give to the user once
        - key_hash: SHA-256 hex digest for storage
        - key_prefix: first 12 chars for identification (includes prefix)
    """
    random_bytes = secrets.token_urlsafe(32)
    plain_key = f"{settings.api_key_prefix}{random_bytes}"
    key_hash = hash_api_key(plain_key)
    key_prefix = plain_key[:12]
    return plain_key, key_hash, key_prefix


def hash_api_key(key: str) -> str:
    """Hash an API key with SHA-256.

    Args:
        key: The plain-text API key.

    Returns:
        Hex-encoded SHA-256 digest.
    """
    return hashlib.sha256(key.encode()).hexdigest()


def verify_api_key(plain_key: str, stored_hash: str) -> bool:
    """Constant-time comparison of a plain key against a stored hash.

    Args:
        plain_key: The API key provided in the request.
        stored_hash: The SHA-256 hex digest from the database.

    Returns:
        True if the key matches the hash.
    """
    computed = hash_api_key(plain_key)
    return secrets.compare_digest(computed, stored_hash)
