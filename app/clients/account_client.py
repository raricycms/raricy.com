"""
账户服务 HTTP 客户端。

同步客户端（适配 Flask 同步模型），使用 httpx 同步 Client。
封装对 account-service FastAPI 微服务的全部 6 个 API 调用。

设计要点：
- 长生命周期 httpx.Client（init_app 时创建一次），复用底层 TCP/TLS 连接池。
- threading.Lock 保护并发请求 — httpx.Client 不是线程安全的，但锁竞争
  在网络 IO 面前可忽略（µs 级 vs ms 级）。
- per-call headers（Authorization / X-Idempotency-Key）在
  client.request(headers=...) 合并到 client-level 默认 headers 之上。
- Content-Type 由 httpx 在有 body 时自动加，无需手动指定。

用法：
    from app.clients import AccountClient
    client = AccountClient()
    balance = client.get_balance(user_id)
    result = client.transfer(from_user, to_user, amount, idempotency_key)
"""
import hashlib
import base64
import threading

import httpx
from flask import current_app


class AccountClientError(Exception):
    """账户服务通用错误。"""

    def __init__(self, message, code=None, detail=None):
        self.message = message
        self.code = code
        self.detail = detail
        super().__init__(message)


class InsufficientBalanceError(AccountClientError):
    """余额不足错误。"""

    def __init__(self, user_id, required, available):
        self.user_id = user_id
        self.required = required
        self.available = available
        super().__init__(
            f"小鱼干不足：需要 {required}，可用 {available}",
            code=400,
            detail={"user_id": user_id, "required": required, "available": available},
        )


class AccountClient:
    """同步 HTTP 客户端，封装对账户服务的调用。

    核心设计：
    - 博客系统本身是账户服务中的一个账户（user_id = 'raricy-blog-system'）
    - 博客持有自己的 API Key（存在 .env 中）
    - 博客替用户保管他们的 API Key（加密存储在 users 表）
    - 转账时，根据 from_user_id 选择正确的 Key：
      - from 是博客系统 → 用系统 Key
      - from 是普通用户 → 从 DB 取出用户加密的 Key，解密后使用
    """

    SYSTEM_USER_ID = "raricy-blog-system"

    def __init__(self, app=None):
        self.base_url = None
        self.system_key = None      # 博客系统自己的 API Key（从 .env 读）
        self.internal_token = None  # X-Internal-Token 共享密钥（从 .env 读）
        self.timeout = 5.0
        self._cipher = None         # Fernet 加密器（用于加/解密用户 Key）
        # 长生命周期 HTTP 客户端（init_app 中创建）
        self._client: httpx.Client | None = None
        # 保护 self._client 并发访问的锁
        self._lock = threading.Lock()
        if app:
            self.init_app(app)

    def init_app(self, app):
        """从 Flask app 配置初始化客户端。

        创建长生命周期 httpx.Client（复用底层连接池）。
        多次调用会关闭旧 client 后重建（保证配置生效）。
        """
        from cryptography.fernet import Fernet

        self.base_url = app.config.get("ACCOUNT_SERVICE_URL", "http://localhost:8000")
        self.system_key = app.config.get("ACCOUNT_SYSTEM_KEY", "")
        self.internal_token = app.config.get("ACCOUNT_SERVICE_INTERNAL_TOKEN", "")
        self.timeout = app.config.get("ACCOUNT_SERVICE_TIMEOUT", 5.0)

        # 从 SECRET_KEY 派生 Fernet 密钥（与 app/utils/AES.py 模式一致）
        derived = base64.urlsafe_b64encode(
            hashlib.sha256(app.config["SECRET_KEY"].encode()).digest()
        )
        self._cipher = Fernet(derived)

        # 关闭已有 client（如果存在），避免连接池泄漏
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass

        # 长生命周期 HTTP 客户端 — 复用 TCP/TLS 连接池
        # 默认 headers 只放共享密钥；per-call header 在 request() 时合并
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=self.timeout,
            headers={
                "X-Internal-Token": self.internal_token,
                "Accept": "application/json",
            },
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=10,
                keepalive_expiry=30.0,
            ),
        )

    # ── API Key 管理 ───────────────────────────────

    def _encrypt_key(self, plain_key: str) -> str:
        """加密用户 API Key（存 DB 用）。"""
        return self._cipher.encrypt(plain_key.encode()).decode()

    def _decrypt_key(self, encrypted: str) -> str:
        """解密用户 API Key（调 API 时用）。"""
        return self._cipher.decrypt(encrypted.encode()).decode()

    def _ensure_account_exists(self, user_id: str) -> bool:
        """确保用户在账户服务中有账户。无 Key 时自动补注册（幂等）。

        用于恢复注册时 create_account 失败的场景——
        当用户后续进行投喂等操作时自动补齐远程账户。

        Returns:
            True 如果账户存在或创建成功，False 如果失败。
        """
        from app.models.user import User
        user = User.query.get(user_id)
        if user and user.fish_api_key_encrypted:
            return True

        try:
            self.create_account(user_id)
            # create_account 内部已将 Key 加密写入用户表并 commit
            return True
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                f"账户服务补注册失败（user={user_id}），将在下次鱼干操作时重试"
            )
            return False

    def _get_api_key_for(self, user_id: str) -> str:
        """根据 user_id 获取对应的 API Key。

        - 博客系统 → 返回 .env 中的系统 Key
        - 普通用户 → 从 DB 解密用户的 Key
        - 用户无 Key → 尝试自动补注册（幂等），失败则抛异常
        """
        if user_id == self.SYSTEM_USER_ID:
            return self.system_key

        from app.models.user import User
        user = User.query.get(user_id)
        if not user or not user.fish_api_key_encrypted:
            # 尝试自动恢复：补注册账户（注册时可能因网络问题失败）
            if self._ensure_account_exists(user_id):
                # 重新读取（_ensure_account_exists → create_account 已 commit）
                user = User.query.get(user_id)
                if user and user.fish_api_key_encrypted:
                    return self._decrypt_key(user.fish_api_key_encrypted)
            raise AccountClientError(
                f"用户 {user_id} 没有关联的鱼干账户 API Key，自动恢复失败",
                code=400,
            )
        return self._decrypt_key(user.fish_api_key_encrypted)

    @staticmethod
    def _make_feed_idempotency_key(blog_id: str, user_id: str, count: int, suffix: str) -> str:
        """生成投喂操作的幂等键（确保不超过 64 字符限制）。

        使用 SHA-256 前 16 位 hex 作为短标识，格式：feed-{hex16}-{suffix}
        SHA-256 提供足够的碰撞抗性（64 bits），远优于 MD5。
        """
        short_hash = hashlib.sha256(
            f"{blog_id}-{user_id}-{count}".encode()
        ).hexdigest()[:16]
        return f"feed-{short_hash}-{suffix}"

    # ── 内部 HTTP 请求 ─────────────────────────────

    def _request(
        self, method: str, path: str,
        json_data: dict = None,
        params: dict | None = None,
        idempotency_key: str = None,
        api_key: str = None,
    ):
        """发送请求到账户服务。所有请求需 X-Internal-Token（client-level 默认）。

        使用长生命周期 self._client（连接池复用），加锁保护并发。
        per-call headers 在 client.request(headers=...) 时与 client 默认 headers 合并。
        """
        assert self._client is not None, "AccountClient 未 init_app"

        # per-call headers：与 self._client.headers 合并；per-call 优先覆盖
        headers: dict = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if idempotency_key:
            headers["X-Idempotency-Key"] = idempotency_key

        # 关键：用 json= 而不是 content=json.dumps(...)
        # httpx 在 content=<str> 时会自动设 Content-Type: text/plain; charset=utf-8，
        # FastAPI 走不到 Pydantic JSON 校验分支，返回 422 Validation error。
        # 用 json= 时 httpx 会自动 JSON 序列化并设 Content-Type: application/json。
        try:
            with self._lock:
                resp = self._client.request(
                    method, path,
                    params=params,
                    json=json_data,
                    headers=headers,
                )
                data = resp.json()

            # 锁外做错误处理（纯 Python 开销）
            if resp.status_code >= 400:
                self._handle_error(resp.status_code, data)

            return data.get("data", data)
        except httpx.RequestError as e:
            raise AccountClientError(f"账户服务不可达: {e}", code=503)
        except httpx.TimeoutException:
            raise AccountClientError("账户服务超时", code=503)

    def _handle_error(self, status_code: int, data: dict):
        """解析错误响应，抛出对应异常。"""
        message = data.get("message", "未知错误")
        detail = data.get("detail")
        code = data.get("code", status_code)

        if "不足" in message:
            raise InsufficientBalanceError(
                user_id=detail.get("user_id", "") if detail else "",
                required=detail.get("required", 0) if detail else 0,
                available=detail.get("available", 0) if detail else 0,
            )
        raise AccountClientError(message, code=code, detail=detail)

    # ── 公开 API ───────────────────────────────────

    def create_account(self, user_id: str, currency: str = "DRIED_FISH") -> dict:
        """用户注册时创建账户。返回的 api_key 加密存储到用户表。

        幂等：重复调用不报错，但也不返回 Key（已有账户返回 200 无 api_key）。
        """
        result = self._request(
            "POST", "/api/v1/accounts",
            json_data={"user_id": user_id, "currency": currency},
        )

        # 如果是新建账户，api_key 字段存在；加密存储
        api_key = result.get("api_key")
        if api_key:
            from app.models.user import User
            from app.extensions import db
            user = User.query.get(user_id)
            if user:
                user.fish_api_key_encrypted = self._encrypt_key(api_key)
                db.session.commit()

        return result

    def get_balance(self, user_id: str, include_today_checkin: bool = False):
        """查询单个用户余额。不存在的用户返回 0.0。

        Args:
            user_id: 外部用户 ID。
            include_today_checkin: 是否在响应中包含今日签到获得数。
                默认为 False（向后兼容，单 HTTP 调用）。
                设为 True 时账户服务 1 次 HTTP 返回余额 + 今日签到。

        Returns:
            - include_today_checkin=False: float，仅余额
            - include_today_checkin=True: dict，含 'balance' (float) 和可选
              'today_checkin' (float)，便于调用方一次拿两个字段。
        """
        params = None
        if include_today_checkin:
            params = {"include": "today_checkin"}
        data = self._request(
            "GET",
            f"/api/v1/accounts/{user_id}/balance",
            params=params,
        )
        if include_today_checkin:
            return {
                "balance": float(data.get("balance", 0)),
                "today_checkin": float(data.get("today_checkin", 0)),
            }
        return float(data["balance"])

    def get_balances(self, user_ids: list) -> dict:
        """批量查询余额（最多 100 个）。返回 {user_id: balance}。"""
        data = self._request(
            "POST", "/api/v1/accounts/balances/batch",
            json_data={"user_ids": list(user_ids)[:100]},
        )
        return {uid: float(bal) for uid, bal in data.get("balances", {}).items()}

    def transfer(
        self,
        from_user_id: str,
        to_user_id: str,
        amount: float,
        entry_type: str,
        description: str = "",
        metadata: dict = None,
        idempotency_key: str = None,
    ) -> dict:
        """转账。自动根据 from_user_id 选择正确的 API Key。

        - from_user_id = "raricy-blog-system" → 用系统 Key（签到发鱼干等）
        - from_user_id = 普通用户 → 从 DB 解密该用户的 Key（投喂等）

        Raises:
            InsufficientBalanceError: 余额不足
            AccountClientError: API Key 无效 (401) 或 Key 不匹配 (403)
        """
        api_key = self._get_api_key_for(from_user_id)

        return self._request(
            "POST", "/api/v1/transfers",
            json_data={
                "from_user_id": from_user_id,
                "to_user_id": to_user_id,
                "amount": float(amount),
                "entry_type": entry_type,
                "description": description,
                "metadata": metadata or {},
            },
            idempotency_key=idempotency_key,
            api_key=api_key,
        )

    def feed_transfer(
        self,
        feeder_id: str,
        author_id: str,
        amount: float,
        author_income: float,
        blog_id: str,
        blog_title: str,
        feeder_name: str,
    ) -> dict:
        """执行投喂的远程同步（两步转账，失败时尽量保持一致性）。

        投喂模型：feeder → system（全额），system → author（80% 分成）。
        两步共享确定性幂等键，Step 1 失败时跳过 Step 2。

        Returns:
            dict: {'step1': 'ok'|'failed', 'step2': 'ok'|'failed'|'skipped'}
        """
        import logging
        logger = logging.getLogger(__name__)

        result = {'step1': 'failed', 'step2': 'skipped'}

        # Step 1: 投喂者 → 系统（全额，使用投喂者 Key）
        try:
            self.transfer(
                from_user_id=feeder_id,
                to_user_id=self.SYSTEM_USER_ID,
                amount=float(amount),
                entry_type='feed_consume',
                description=f"投喂文章「{blog_title}」",
                metadata={'blog_id': blog_id},
                idempotency_key=self._make_feed_idempotency_key(
                    blog_id, feeder_id, int(amount), 'consume'
                ),
            )
            result['step1'] = 'ok'
        except Exception as e:
            logger.warning(f"账户服务投喂同步失败（投喂者→系统）: {e}")
            return result  # Step 1 失败则跳过 Step 2

        # Step 2: 系统 → 作者（80% 分成，使用系统 Key）
        try:
            self.transfer(
                from_user_id=self.SYSTEM_USER_ID,
                to_user_id=author_id,
                amount=author_income,
                entry_type='feed_income',
                description=f"投喂文章「{blog_title}」分成",
                metadata={
                    'blog_id': blog_id,
                    'feeder_id': feeder_id,
                    'feeder_name': feeder_name,
                },
                idempotency_key=self._make_feed_idempotency_key(
                    blog_id, feeder_id, int(amount), 'income'
                ),
            )
            result['step2'] = 'ok'
        except Exception as e:
            logger.warning(f"账户服务投喂同步失败（系统→作者）: {e}")
            result['step2'] = 'failed'

        return result

    def get_ledger(
        self, user_id: str, page: int = 1, per_page: int = 20,
        entry_type: str = None, start: str = None, end: str = None,
    ) -> dict:
        """查询交易流水（分页）。支持按 entry_type 和日期范围过滤。

        Returns:
            dict: {entries: [...], pagination: {page, per_page, total, pages, has_prev, has_next}}
        """
        params = {"page": page, "per_page": per_page}
        if entry_type:
            params["entry_type"] = entry_type
        if start:
            params["start"] = start
        if end:
            params["end"] = end

        query_string = "&".join(f"{k}={v}" for k, v in params.items())
        return self._request(
            "GET", f"/api/v1/accounts/{user_id}/ledger?{query_string}",
        )
