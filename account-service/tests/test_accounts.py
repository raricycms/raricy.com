"""Tests for account creation and balance query endpoints."""

import uuid
from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient

from tests.conftest import (
    SYSTEM_API_KEY,
    SYSTEM_USER_ID,
    TEST_USER_ID,
)


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

    @pytest.mark.asyncio
    async def test_balance_no_include_param(self, async_client: AsyncClient):
        """Without ?include=, today_checkin field is null (backward compat)."""
        await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "include-test-001", "currency": "DRIED_FISH"},
        )
        response = await async_client.get(
            "/api/v1/accounts/include-test-001/balance"
        )
        assert response.status_code == 200
        data = response.json()["data"]
        # today_checkin field exists in schema but is None when not requested
        assert data.get("today_checkin") is None

    @pytest.mark.asyncio
    async def test_balance_include_today_checkin_empty(
        self, async_client: AsyncClient
    ):
        """?include=today_checkin with no check-in today returns 0.0, not null."""
        await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "include-empty-001", "currency": "DRIED_FISH"},
        )
        response = await async_client.get(
            "/api/v1/accounts/include-empty-001/balance?include=today_checkin"
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["today_checkin"] == "0.0"

    @pytest.mark.asyncio
    async def test_balance_include_today_checkin_non_existent_user(
        self, async_client: AsyncClient
    ):
        """?include=today_checkin for non-existent user returns 0.0 (account missing path)."""
        response = await async_client.get(
            "/api/v1/accounts/never-existed/balance?include=today_checkin"
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["balance"] == "0.0"
        assert data["today_checkin"] == "0.0"
        assert data["updated_at"] is None

    @pytest.mark.asyncio
    async def test_balance_include_unknown_token_silently_ignored(
        self, async_client: AsyncClient
    ):
        """Unknown include tokens are ignored; today_checkin stays None."""
        await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "include-unknown-001", "currency": "DRIED_FISH"},
        )
        response = await async_client.get(
            "/api/v1/accounts/include-unknown-001/balance?include=tomorrow_checkin"
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data.get("today_checkin") is None

    @pytest.mark.asyncio
    async def test_balance_include_comma_separated(
        self, async_client: AsyncClient
    ):
        """Comma-separated include with today's checkin among unknowns still works."""
        await async_client.post(
            "/api/v1/accounts",
            json={"user_id": "include-multi-001", "currency": "DRIED_FISH"},
        )
        response = await async_client.get(
            "/api/v1/accounts/include-multi-001/balance"
            "?include=today_checkin,other_field"
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["today_checkin"] == "0.0"

    @pytest.mark.asyncio
    async def test_balance_include_today_checkin_with_data(
        self, async_client: AsyncClient, db_session
    ):
        """?include=today_checkin sums today's checkin entries correctly."""
        from app.core.timezone import UTC8_OFFSET
        from app.models.account import Account
        from app.models.ledger_entry import LedgerEntry

        # Create the user account (under TEST_USER_ID)
        await async_client.post(
            "/api/v1/accounts",
            json={"user_id": TEST_USER_ID, "currency": "DRIED_FISH"},
        )

        # Find the account_id via db_session
        from sqlalchemy import select
        account = (
            await db_session.execute(
                select(Account).where(Account.user_id == TEST_USER_ID)
            )
        ).scalar_one()

        # Insert a check-in entry that definitely falls in "today UTC+8"
        # We use 04:00 UTC = 12:00 UTC+8 (always within today's UTC+8 window
        # when the test runs any time before 16:00 UTC of the following day).
        today_utc8 = datetime.utcnow() + UTC8_OFFSET
        noon_utc8 = today_utc8.replace(hour=12, minute=0, second=0, microsecond=0)
        noon_utc = noon_utc8 - UTC8_OFFSET

        tx_id = uuid.uuid4()
        db_session.add(LedgerEntry(
            id=uuid.uuid4(),
            transaction_id=tx_id,
            account_id=account.id,
            direction="DEBIT",
            amount=20000,  # 2.0 fish internal units (1 fish = 10000)
            currency="DRIED_FISH",
            entry_type="checkin",
            description="Test checkin 1",
            created_at=noon_utc,
        ))
        db_session.add(LedgerEntry(
            id=uuid.uuid4(),
            transaction_id=uuid.uuid4(),
            account_id=account.id,
            direction="DEBIT",
            amount=30000,  # 3.0 fish
            currency="DRIED_FISH",
            entry_type="checkin",
            description="Test checkin 2",
            created_at=noon_utc + timedelta(minutes=5),
        ))
        # An OLD checkin that should NOT be counted (yesterday UTC+8)
        yesterday_utc8 = today_utc8 - timedelta(days=1)
        yesterday_noon_utc8 = yesterday_utc8.replace(hour=12, minute=0, second=0, microsecond=0)
        yesterday_noon_utc = yesterday_noon_utc8 - UTC8_OFFSET
        db_session.add(LedgerEntry(
            id=uuid.uuid4(),
            transaction_id=uuid.uuid4(),
            account_id=account.id,
            direction="DEBIT",
            amount=99900,  # 9.99 fish — should be excluded
            currency="DRIED_FISH",
            entry_type="checkin",
            description="Yesterday checkin (should not count)",
            created_at=yesterday_noon_utc,
        ))
        # A non-checkin entry today — also should NOT be counted
        db_session.add(LedgerEntry(
            id=uuid.uuid4(),
            transaction_id=uuid.uuid4(),
            account_id=account.id,
            direction="DEBIT",
            amount=50000,  # 5.0 fish — wrong entry_type
            currency="DRIED_FISH",
            entry_type="feed_income",
            description="Feed income (should not count)",
            created_at=noon_utc,
        ))
        await db_session.commit()

        response = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/balance?include=today_checkin"
        )
        assert response.status_code == 200
        data = response.json()["data"]
        # Today checkin: 2.0 + 3.0 = 5.0 (excluding yesterday and feed_income)
        assert data["today_checkin"] == "5.0"
        # Total balance includes everything: 2.0 + 3.0 + 9.99 + 5.0 = 19.99
        assert data["balance"] == "19.99"


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
        self, async_client: AsyncClient, db_session
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
