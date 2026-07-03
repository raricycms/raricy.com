"""Tests for account creation and balance query endpoints."""

import pytest
from httpx import AsyncClient

from tests.conftest import TEST_USER_ID


class TestCreateAccount:
    """POST /api/v1/accounts"""

    @pytest.mark.asyncio
    async def test_create_account_returns_api_key(self, async_client: AsyncClient):
        """Creating a new account returns 201 with an API key."""
        response = await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "new-user-001", "currency": "DRIED_FISH"},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["code"] == 201
        assert body["data"]["api_key"].startswith("fish_sk_")
        assert body["data"]["user_id"] == "new-user-001"
        assert body["data"]["balance"] == "0.0"

    @pytest.mark.asyncio
    async def test_create_duplicate_account_no_api_key(self, async_client: AsyncClient, db_session):
        """Creating the same account twice returns 200 with no API key."""
        payload = {"user_id": "dup-user-001", "currency": "DRIED_FISH"}

        # First creation via API
        r1 = await async_client.post("/api/v1/accounts", json=payload)
        assert r1.status_code == 201
        assert "api_key" in r1.json()["data"]

        # Second creation via service (same session, already committed)
        from app.services.account_service import AccountService
        svc = AccountService(db_session)
        account, api_key = await svc.create_account("dup-user-001", "DRIED_FISH")
        assert api_key is None
        assert account.user_id == "dup-user-001"

    @pytest.mark.asyncio
    async def test_create_account_different_currencies(self, async_client: AsyncClient):
        """Same user_id, different currency = different accounts."""
        # Create DRIED_FISH account
        r1 = await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "multi-currency-001", "currency": "DRIED_FISH"},
        )
        assert r1.status_code == 201

        # Create STAR_COIN account (future currency)
        r2 = await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "multi-currency-001", "currency": "STAR_COIN"},
        )
        assert r2.status_code == 201
        assert r1.json()["data"]["account_id"] != r2.json()["data"]["account_id"]


class TestGetBalance:
    """GET /api/v1/accounts/{user_id}/balance"""

    @pytest.mark.asyncio
    async def test_balance_non_existent_user(self, async_client: AsyncClient):
        """Querying a non-existent user returns 0.0, not 404."""
        response = await async_client.get(
            "/api/v1/accounts/nonexistent-user/balance?currency=DRIED_FISH"
        )
        assert response.status_code == 200
        body = response.json()
        assert body["data"]["balance"] == "0.0"
        assert body["data"]["user_id"] == "nonexistent-user"
        assert body["data"]["updated_at"] is None

    @pytest.mark.asyncio
    async def test_balance_after_account_creation(self, async_client: AsyncClient):
        """Newly created account should have balance 0.0."""
        # Create account
        await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "balance-test-001", "currency": "DRIED_FISH"},
        )

        # Check balance
        response = await async_client.get(
            "/api/v1/accounts/balance-test-001/balance?currency=DRIED_FISH"
        )
        assert response.status_code == 200
        assert response.json()["data"]["balance"] == "0.0"


class TestBatchBalance:
    """POST /api/v1/accounts/balances/batch"""

    @pytest.mark.asyncio
    async def test_batch_balance_basic(self, async_client: AsyncClient):
        """Batch query returns correct balances for multiple users."""
        # Create two accounts
        await async_client.post(
            "/api/v1/accounts", json={"user_id": "batch-001", "currency": "DRIED_FISH"}
        )
        await async_client.post(
            "/api/v1/accounts", json={"user_id": "batch-002", "currency": "DRIED_FISH"}
        )

        response = await async_client.post(
            "/api/v1/accounts/balances/batch",
            json={"user_ids": ["batch-001", "batch-002", "batch-nonexistent"], "currency": "DRIED_FISH"},
        )
        assert response.status_code == 200
        body = response.json()
        balances = body["data"]["balances"]
        assert balances["batch-001"] == "0.0"
        assert balances["batch-002"] == "0.0"
        assert balances["batch-nonexistent"] == "0.0"

    @pytest.mark.asyncio
    async def test_batch_balance_exceeds_limit(self, async_client: AsyncClient):
        """More than 100 user_ids should return 422 validation error."""
        user_ids = [f"user-{i:04d}" for i in range(101)]
        response = await async_client.post(
            "/api/v1/accounts/balances/batch",
            json={"user_ids": user_ids, "currency": "DRIED_FISH"},
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_batch_balance_empty(self, async_client: AsyncClient):
        """Empty user_ids list should return 422."""
        response = await async_client.post(
            "/api/v1/accounts/balances/batch",
            json={"user_ids": [], "currency": "DRIED_FISH"},
        )
        assert response.status_code == 422


class TestAccountClaiming:
    """Claiming behaviour — unclaimed accounts (auto-created by transfers)."""

    @pytest.mark.asyncio
    async def test_claim_unclaimed_account(self, async_client: AsyncClient, db_session):
        """An unclaimed account (from auto-create) should be claimable."""
        from app.models.account import Account
        unclaimed = Account(
            user_id="unclaimed-user-001",
            currency="DRIED_FISH",
            api_key_hash=None,
            api_key_prefix=None,
            is_system=False,
        )
        db_session.add(unclaimed)
        await db_session.commit()

        response = await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "unclaimed-user-001", "currency": "DRIED_FISH"},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["code"] == 201
        assert body["data"]["api_key"].startswith("fish_sk_")
        assert body["data"]["user_id"] == "unclaimed-user-001"

    @pytest.mark.asyncio
    async def test_already_claimed_returns_no_key(self, async_client: AsyncClient, db_session):
        """After claiming, a second create_account call returns no key."""
        r1 = await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "already-claimed-001", "currency": "DRIED_FISH"},
        )
        assert r1.status_code == 201
        assert "api_key" in r1.json()["data"]

        # Second call via service (same session) — should return no key
        from app.services.account_service import AccountService
        svc = AccountService(db_session)
        account, api_key = await svc.create_account("already-claimed-001", "DRIED_FISH")
        assert api_key is None

    @pytest.mark.asyncio
    async def test_unclaimed_account_cannot_transfer_out(
        self, async_client: AsyncClient, system_account, db_session
    ):
        """An unclaimed account has no API key, so it cannot be used as sender."""
        from app.models.account import Account
        unclaimed = Account(
            user_id="unclaimed-sender-001",
            currency="DRIED_FISH",
            api_key_hash=None,
            api_key_prefix=None,
            is_system=False,
        )
        db_session.add(unclaimed)
        await db_session.commit()

        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": "unclaimed-sender-001",
                "to_user_id": TEST_USER_ID,
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
            },
            headers={
                "Authorization": "Bearer fish_sk_fake_key_0000000000000000",
                "X-Idempotency-Key": "unclaimed-test-001",
            },
        )
        assert response.status_code == 401


class TestInternalTokenRequired:
    """All endpoints must require X-Internal-Token."""

    WRONG_TOKEN = "wrong-internal-token"

    @pytest.mark.asyncio
    async def test_create_account_with_wrong_token(self, async_client: AsyncClient):
        """POST /accounts with wrong X-Internal-Token returns 401."""
        response = await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "no-token-user", "currency": "DRIED_FISH"},
            headers={"X-Internal-Token": self.WRONG_TOKEN},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_get_balance_with_wrong_token(self, async_client: AsyncClient):
        """GET /balance with wrong X-Internal-Token returns 401."""
        response = await async_client.get(
            "/api/v1/accounts/some-user/balance",
            headers={"X-Internal-Token": self.WRONG_TOKEN},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_batch_balance_with_wrong_token(self, async_client: AsyncClient):
        """POST /balances/batch with wrong X-Internal-Token returns 401."""
        response = await async_client.post(
            "/api/v1/accounts/balances/batch",
            json={"user_ids": ["user-1"], "currency": "DRIED_FISH"},
            headers={"X-Internal-Token": self.WRONG_TOKEN},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_transfer_with_wrong_token(self, async_client: AsyncClient):
        """POST /transfers with wrong X-Internal-Token returns 401."""
        response = await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": "u1",
                "to_user_id": "u2",
                "amount": 1.0,
                "currency": "DRIED_FISH",
                "entry_type": "transfer",
            },
            headers={
                "Authorization": "Bearer fish_sk_test",
                "X-Idempotency-Key": "test-key-01",
                "X-Internal-Token": self.WRONG_TOKEN,
            },
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_ledger_with_wrong_token(self, async_client: AsyncClient):
        """GET /ledger with wrong X-Internal-Token returns 401."""
        response = await async_client.get(
            "/api/v1/accounts/some-user/ledger",
            headers={"X-Internal-Token": self.WRONG_TOKEN},
        )
        assert response.status_code == 401
