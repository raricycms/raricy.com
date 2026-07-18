// 账户微服务的最小替身（仅供 E2E）。
//
// 【为什么非有不可】webServer 跑的是 next start，NODE_ENV=production。
// 注册与签到都走 Phase 1.5 的 fail-closed 写路径：未配置 ACCOUNT_SERVICE_INTERNAL_TOKEN
// 时 assertRemoteRequiredInProduction() 直接抛 503（见 src/lib/account-client.ts）。
// 即「不接账户服务就注册不了、签到不了」是**设计意图**，不是 bug。
// 因此 E2E 想覆盖注册/登录/签到，就必须有个远端在。起真的 account-service 需要
// Python + 它自己的库，对一条前端 E2E 链路来说太重；这里按客户端实际契约造个替身。
//
// 契约来源：src/lib/account-client.ts（路径、envelope、鉴权头），
// 与 account-service/app/api/deps.py（Bearer 传用户 Key）。
//
// 【它不是什么】不复刻复式记账、不校验余额充足性。它只需让 fail-closed 分支「能过」，
// 并把收到的转账记下来，好让用例断言「本地签到成功时远端确实记了账」——
// 那正是 Phase 1.5 想保证、而单测（mock 掉客户端）证明不了的东西。

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.E2E_ACCOUNT_PORT || 3101);
const INTERNAL_TOKEN = process.env.E2E_ACCOUNT_INTERNAL_TOKEN || 'e2e-internal-token';

interface RecordedTransfer {
  from_user_id: string;
  to_user_id: string;
  amount: number;
  entry_type: string;
  idempotency_key: string | null;
}

const balances = new Map<string, number>();
const accounts = new Map<string, { account_id: string; api_key: string }>();
const transfers: RecordedTransfer[] = [];
// 幂等键 → 已产出的响应。账户服务真身用 IdempotencyKey 表做同样的事；
// 这里留一份，让「同键重放不重复记账」在替身上也成立。
const idempotent = new Map<string, unknown>();

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/** 账户服务的统一 envelope；客户端 call() 会解出内层 data。 */
function ok(res: http.ServerResponse, status: number, data: unknown) {
  send(res, status, { code: status, message: 'ok', data, request_id: randomUUID() });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // 测试自省端点：不属于真实契约，故用 __e2e__ 前缀与真实路由隔开。
  if (path === '/__e2e__/transfers') {
    return send(res, 200, { transfers });
  }
  if (path === '/__e2e__/reset') {
    balances.clear();
    accounts.clear();
    transfers.length = 0;
    idempotent.clear();
    return send(res, 200, { ok: true });
  }

  // 服务间共享密钥。故意校验：若被测代码漏发这个头，应当在 E2E 里当场炸，
  // 而不是被替身悄悄放行、留到上线才发现。
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return send(res, 401, { code: 401, message: 'bad internal token' });
  }

  // POST /api/v1/accounts —— 幂等建号，首次返回 api_key
  if (path === '/api/v1/accounts' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = String(body.user_id ?? '');
    if (!userId) return send(res, 400, { code: 400, message: 'user_id required' });

    const existing = accounts.get(userId);
    if (existing) {
      return ok(res, 200, {
        account_id: existing.account_id,
        user_id: userId,
        currency: body.currency ?? 'DRIED_FISH',
        balance: balances.get(userId) ?? 0,
        // 复刻真身：已存在时**不**回 api_key（只有 201 首次创建才回）
      });
    }
    const created = { account_id: randomUUID(), api_key: `e2e-key-${randomUUID()}` };
    accounts.set(userId, created);
    balances.set(userId, 0);
    return ok(res, 201, {
      account_id: created.account_id,
      user_id: userId,
      currency: body.currency ?? 'DRIED_FISH',
      balance: 0,
      api_key: created.api_key,
      created_at: new Date().toISOString(),
    });
  }

  // POST /api/v1/transfers —— 唯一的记账写操作
  if (path === '/api/v1/transfers' && req.method === 'POST') {
    const body = await readBody(req);
    const idemKey = (req.headers['x-idempotency-key'] as string) || null;
    if (idemKey && idempotent.has(idemKey)) {
      return ok(res, 200, idempotent.get(idemKey));
    }

    const from = String(body.from_user_id ?? '');
    const to = String(body.to_user_id ?? '');
    const amount = Number(body.amount ?? 0);
    // 系统账户不设余额下限（真身用系统账户做发放源）
    const fromAfter = (balances.get(from) ?? 0) - amount;
    const toAfter = (balances.get(to) ?? 0) + amount;
    balances.set(from, fromAfter);
    balances.set(to, toAfter);

    const result = {
      transaction_id: randomUUID(),
      from_user_id: from,
      to_user_id: to,
      amount,
      currency: String(body.currency ?? 'DRIED_FISH'),
      entry_type: String(body.entry_type ?? ''),
      from_balance_after: fromAfter,
      to_balance_after: toAfter,
      created_at: new Date().toISOString(),
    };
    transfers.push({
      from_user_id: from,
      to_user_id: to,
      amount,
      entry_type: String(body.entry_type ?? ''),
      idempotency_key: idemKey,
    });
    if (idemKey) idempotent.set(idemKey, result);
    return ok(res, 201, result);
  }

  // GET /api/v1/accounts/{userId}/balance
  const balMatch = path.match(/^\/api\/v1\/accounts\/([^/]+)\/balance$/);
  if (balMatch && req.method === 'GET') {
    const userId = decodeURIComponent(balMatch[1]);
    return ok(res, 200, {
      user_id: userId,
      currency: 'DRIED_FISH',
      balance: balances.get(userId) ?? 0,
      updated_at: new Date().toISOString(),
    });
  }

  // POST /api/v1/accounts/balances/batch
  if (path === '/api/v1/accounts/balances/batch' && req.method === 'POST') {
    const body = await readBody(req);
    const ids: string[] = Array.isArray(body.user_ids) ? (body.user_ids as string[]) : [];
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = balances.get(id) ?? 0;
    return ok(res, 200, { balances: out });
  }

  // GET /api/v1/accounts/{userId}/ledger
  const ledgerMatch = path.match(/^\/api\/v1\/accounts\/([^/]+)\/ledger$/);
  if (ledgerMatch && req.method === 'GET') {
    return ok(res, 200, {
      entries: [],
      pagination: { page: 1, per_page: 20, total: 0, pages: 0, has_prev: false, has_next: false },
    });
  }

  send(res, 404, { code: 404, message: `mock account service: no route ${req.method} ${path}` });
});

server.listen(PORT, '127.0.0.1', () => {
  // Playwright 的 webServer 靠端口探活；这行只是给人看的
  console.log(`[mock-account-service] listening on http://127.0.0.1:${PORT}`);
});
