"""Tests for the transfer endpoint — double-entry ledger core."""

import uuid

import pytest
from httpx import AsyncClient

from tests.conftest import (
    SYSTEM_API_KEY,
    SYSTEM_USER_ID,
    TEST_USER_API_KEY,
    TEST_USER_ID,
)


def _idempotency_key() -> str:
    return str(uuid.uuid4())


class TestTransferBasic:
    """Basic transfer scenarios."""

    @pytest.mark.asyncio
    async def test_system_to_user_transfer(
        self, async_client: AsyncClient, system_account, test_account
    ):
        """System account can transfer fish to a user."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 3.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
                "description": "每日签到（运势值 3）",
                "metadata": {"fortune_value": 3},
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 200
        body = response.json()
        data = body["data"]
        assert data["transaction_id"] is not None
        assert data["from_user_id"] == SYSTEM_USER_ID
        assert data["to_user_id"] == TEST_USER_ID
        assert data["amount"] == "3.0"
        assert data["entry_type"] == "checkin"
        # System account can go negative (overdraft)
        assert float(data["from_balance_after"]) <= 0
        # Test user should have exactly 3.0
        assert data["to_balance_after"] == "3.0"

    @pytest.mark.asyncio
    async def test_user_to_user_transfer(
        self, async_client: AsyncClient, system_account, test_account
    ):
        """After receiving fish from system, a user can transfer to another user."""
        # First, give test user some fish
        await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 10.0,
                "currency": "DRIED_FISH",
                "entry_type": "admin_grant",
                "description": "Initial grant",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )

        # Now test user transfers 3 fish to someone else
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": TEST_USER_ID,
                "to_user_id": "receiver-user-001",
                "amount": 3.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
                "description": "Test transfer",
            },
            headers={
                "Authorization": f"Bearer {TEST_USER_API_KEY}",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["from_balance_after"] == "7.0"
        assert data["to_balance_after"] == "3.0"

    @pytest.mark.asyncio
    async def test_transfer_creates_ledger_entries(
        self, async_client: AsyncClient, system_account, test_account
    ):
        """A transfer should create visible ledger entries for both parties."""
        key = _idempotency_key()
        await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 5.0,
                "currency": "DRIED_FISH",
                "entry_type": "admin_grant",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": key,
            },
        )

        # Check test user's ledger
        r = await async_client.get(f"/api/v1/accounts/{TEST_USER_ID}/ledger")
        assert r.status_code == 200
        entries = r.json()["data"]["entries"]
        assert len(entries) == 1
        assert entries[0]["direction"] == "DEBIT"
        assert entries[0]["amount"] == "5.0"
        assert entries[0]["entry_type"] == "admin_grant"


class TestTransferErrors:
    """Error handling scenarios."""

    @pytest.mark.asyncio
    async def test_insufficient_balance(
        self, async_client: AsyncClient, test_account
    ):
        """A new user with 0 balance cannot transfer fish."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": TEST_USER_ID,
                "to_user_id": "receiver-user-001",
                "amount": 5.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
            },
            headers={
                "Authorization": f"Bearer {TEST_USER_API_KEY}",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 400
        body = response.json()
        assert "Insufficient balance" in body["message"]

    @pytest.mark.asyncio
    async def test_missing_api_key(self, async_client: AsyncClient):
        """Transfer without an API key should return 401."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": "some-user",
                "to_user_id": "another-user",
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
            },
            headers={
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_invalid_api_key(self, async_client: AsyncClient):
        """Transfer with a non-existent API key should return 401."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": TEST_USER_ID,
                "to_user_id": "receiver-user-001",
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
            },
            headers={
                "Authorization": "Bearer fish_sk_invalid_key_000000000000",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_api_key_mismatch(self, async_client: AsyncClient, test_account):
        """Using test user's API key but claiming to be system should return 403."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,  # claims to be system
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
            },
            headers={
                "Authorization": f"Bearer {TEST_USER_API_KEY}",  # but uses test user's key
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 403
        body = response.json()
        assert "API key does not match" in body["message"]

    @pytest.mark.asyncio
    async def test_system_account_can_overdraft(
        self, async_client: AsyncClient, system_account, test_account
    ):
        """System account can transfer even when balance goes deeply negative."""
        # Transfer a huge amount — system can overdraft
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 999999.0,
                "currency": "DRIED_FISH",
                "entry_type": "admin_grant",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )
        assert response.status_code == 200
        # System balance should be very negative
        data = response.json()["data"]
        assert float(data["from_balance_after"]) < 0


class TestIdempotency:
    """Idempotency key behavior."""

    @pytest.mark.asyncio
    async def test_same_key_same_body_returns_cached(
        self, async_client: AsyncClient, system_account, test_account
    ):
        """Using the same idempotency key twice returns the same transaction."""
        key = _idempotency_key()
        payload = {
            "from_user_id": SYSTEM_USER_ID,
            "to_user_id": TEST_USER_ID,
            "amount": 3.0,
            "currency": "DRIED_FISH",
            "entry_type": "checkin",
        }
        headers = {
            "Authorization": f"Bearer {SYSTEM_API_KEY}",
            "X-Idempotency-Key": key,
        }

        r1 = await async_client.post("/api/v1/transfers", json=payload, headers=headers)
        assert r1.status_code == 200
        tx1 = r1.json()["data"]["transaction_id"]

        r2 = await async_client.post("/api/v1/transfers", json=payload, headers=headers)
        assert r2.status_code == 200
        tx2 = r2.json()["data"]["transaction_id"]

        # Same transaction ID returned
        assert tx1 == tx2

        # Balance should NOT have changed twice — still 3.0
        balance_r = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/balance?currency=DRIED_FISH"
        )
        assert balance_r.json()["data"]["balance"] == "3.0"

    @pytest.mark.asyncio
    async def test_same_key_different_body_returns_conflict(
        self, async_client: AsyncClient, system_account, test_account
    ):
        """Using the same idempotency key with different params returns 409."""
        key = _idempotency_key()
        headers = {
            "Authorization": f"Bearer {SYSTEM_API_KEY}",
            "X-Idempotency-Key": key,
        }

        # First request
        r1 = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers=headers,
        )
        assert r1.status_code == 200

        # Second request — same key, different amount
        r2 = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 5.0,  # different!
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers=headers,
        )
        assert r2.status_code == 409


class TestIdempotencyKeyValidation:
    """X-Idempotency-Key format validation."""

    @pytest.mark.asyncio
    async def test_missing_idempotency_key(self, async_client: AsyncClient):
        """Transfer without X-Idempotency-Key header returns 400."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
            },
        )
        assert response.status_code == 400
        assert "Idempotency-Key" in response.json()["message"]

    @pytest.mark.asyncio
    async def test_idempotency_key_with_special_chars(self, async_client: AsyncClient):
        """Idempotency key with special characters returns 400."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": "bad key with spaces!",
            },
        )
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_idempotency_key_too_long(self, async_client: AsyncClient):
        """Idempotency key > 64 chars returns 400."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": "a" * 65,
            },
        )
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_idempotency_key_empty(self, async_client: AsyncClient):
        """Empty idempotency key returns 400."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": "",
            },
        )
        assert response.status_code == 400
