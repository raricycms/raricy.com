"""Tests for the ledger (transaction history) endpoint."""

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


class TestLedgerBasic:
    """Basic ledger query scenarios."""

    @pytest.mark.asyncio
    async def test_ledger_non_existent_user(self, async_client: AsyncClient):
        """Querying ledger for a user that doesn't exist returns empty list."""
        response = await async_client.get(
            "/api/v1/accounts/nonexistent-user/ledger"
        )
        assert response.status_code == 200
        body = response.json()
        assert body["data"]["entries"] == []
        assert body["data"]["pagination"]["total"] == 0

    @pytest.mark.asyncio
    async def test_ledger_after_transfer(
        self, async_client: AsyncClient    ):
        """After a transfer, ledger entries appear for both parties."""
        # Make a transfer
        key = _idempotency_key()
        await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 5.0,
                "currency": "DRIED_FISH",
                "entry_type": "checkin",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": key,
            },
        )

        # Check receiver's ledger
        r = await async_client.get(f"/api/v1/accounts/{TEST_USER_ID}/ledger")
        assert r.status_code == 200
        data = r.json()["data"]
        assert len(data["entries"]) == 1
        entry = data["entries"][0]
        assert entry["direction"] == "DEBIT"
        assert entry["amount"] == "5.0"
        assert entry["entry_type"] == "checkin"
        assert entry["counterparty"] == SYSTEM_USER_ID

        # Check sender's ledger
        r2 = await async_client.get(f"/api/v1/accounts/{SYSTEM_USER_ID}/ledger")
        assert r2.status_code == 200
        sender_entries = r2.json()["data"]["entries"]
        assert len(sender_entries) >= 1
        sender_entry = [
            e for e in sender_entries if e["transaction_id"] == entry["transaction_id"]
        ][0]
        assert sender_entry["direction"] == "CREDIT"
        assert sender_entry["counterparty"] == TEST_USER_ID


class TestLedgerPagination:
    """Pagination behavior."""

    @pytest.mark.asyncio
    async def test_ledger_pagination(
        self, async_client: AsyncClient    ):
        """Multiple transfers should be paginated correctly."""
        # Make 5 transfers
        for i in range(5):
            await async_client.post(
                "/api/v1/transfers",
                json={
                    "from_user_id": SYSTEM_USER_ID,
                    "to_user_id": TEST_USER_ID,
                    "amount": 1.0,
                    "currency": "DRIED_FISH",
                    "entry_type": "checkin",
                    "description": f"Transfer {i}",
                },
                headers={
                    "Authorization": f"Bearer {SYSTEM_API_KEY}",
                    "X-Idempotency-Key": _idempotency_key(),
                },
            )

        # Query page 1 with per_page=2
        r1 = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/ledger?page=1&per_page=2"
        )
        assert r1.status_code == 200
        p1 = r1.json()["data"]
        assert len(p1["entries"]) == 2
        assert p1["pagination"]["page"] == 1
        assert p1["pagination"]["per_page"] == 2
        assert p1["pagination"]["total"] == 5
        assert p1["pagination"]["pages"] == 3
        assert p1["pagination"]["has_prev"] is False
        assert p1["pagination"]["has_next"] is True

        # Page 2
        r2 = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/ledger?page=2&per_page=2"
        )
        assert len(r2.json()["data"]["entries"]) == 2
        assert r2.json()["data"]["pagination"]["has_prev"] is True
        assert r2.json()["data"]["pagination"]["has_next"] is True

        # Page 3 (last — only 1 entry)
        r3 = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/ledger?page=3&per_page=2"
        )
        assert len(r3.json()["data"]["entries"]) == 1
        assert r3.json()["data"]["pagination"]["has_next"] is False


class TestLedgerFilters:
    """Filtering by type and date."""

    @pytest.mark.asyncio
    async def test_ledger_filter_by_type(
        self, async_client: AsyncClient    ):
        """Filtering by entry_type should only return matching entries."""
        # Make a checkin transfer
        await async_client.post(
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
                "X-Idempotency-Key": _idempotency_key(),
            },
        )

        # Make an admin_grant transfer
        await async_client.post(
            "/api/v1/transfers",
            json={
                "from_user_id": SYSTEM_USER_ID,
                "to_user_id": TEST_USER_ID,
                "amount": 2.0,
                "currency": "DRIED_FISH",
                "entry_type": "admin_grant",
            },
            headers={
                "Authorization": f"Bearer {SYSTEM_API_KEY}",
                "X-Idempotency-Key": _idempotency_key(),
            },
        )

        # Filter by checkin only
        r = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/ledger?entry_type=checkin"
        )
        assert r.status_code == 200
        entries = r.json()["data"]["entries"]
        assert all(e["entry_type"] == "checkin" for e in entries)
        assert len(entries) == 1

    @pytest.mark.asyncio
    async def test_ledger_filter_by_multiple_types(
        self, async_client: AsyncClient    ):
        """Comma-separated type filter supports multiple entry_types."""
        # Make transfers of different types
        for etype in ["checkin", "admin_grant", "feed_income"]:
            await async_client.post(
                "/api/v1/transfers",
                json={
                    "from_user_id": SYSTEM_USER_ID,
                    "to_user_id": TEST_USER_ID,
                    "amount": 1.0,
                    "currency": "DRIED_FISH",
                    "entry_type": etype,
                },
                headers={
                    "Authorization": f"Bearer {SYSTEM_API_KEY}",
                    "X-Idempotency-Key": _idempotency_key(),
                },
            )

        # Filter by two types
        r = await async_client.get(
            f"/api/v1/accounts/{TEST_USER_ID}/ledger?entry_type=checkin,admin_grant"
        )
        assert r.status_code == 200
        entries = r.json()["data"]["entries"]
        types = {e["entry_type"] for e in entries}
        assert types <= {"checkin", "admin_grant"}
        assert len(entries) == 2

    @pytest.mark.asyncio
    async def test_ledger_order_desc(
        self, async_client: AsyncClient    ):
        """Ledger entries should be ordered by created_at descending."""
        for i in range(3):
            await async_client.post(
                "/api/v1/transfers",
                json={
                    "from_user_id": SYSTEM_USER_ID,
                    "to_user_id": TEST_USER_ID,
                    "amount": 1.0,
                    "currency": "DRIED_FISH",
                    "entry_type": "checkin",
                    "description": f"Transfer {i}",
                },
                headers={
                    "Authorization": f"Bearer {SYSTEM_API_KEY}",
                    "X-Idempotency-Key": _idempotency_key(),
                },
            )

        r = await async_client.get(f"/api/v1/accounts/{TEST_USER_ID}/ledger")
        entries = r.json()["data"]["entries"]
        # Check ordering
        timestamps = [e["created_at"] for e in entries]
        assert timestamps == sorted(timestamps, reverse=True)
