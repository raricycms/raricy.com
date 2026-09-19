# 一个最小的鱼干银行（可运行的参考实现）

> 面向要基于 raricy 的鱼干开「银行 / 托管 / 兑换」的站外开发者。
> **读完并跑起来这一篇，你就有了一套能收、能付、能对账的最小实现** ——
> 不需要读本站源码。
>
> 本文假设你已经读过 `docs/bot/fish-bot.md`（接口契约、限频、幂等纪律）。本文只讲
> **怎么把它们拼成一个能跑的东西**，以及拼的时候最容易在哪几处亏钱。

## 0. 它长什么样

```
   用户浏览器                 你的服务器                 raricy
       │                          │                        │
       │ ①在你这开个户             │                        │
       ├─────────────────────────▶│                        │
       │                          │                        │
       │ ②点「充值 100」          │                        │
       │◀─────────────────────────┤                        │
       │  跳到 raricy 收银台（金额由你的链接给定，用户改不了）│
       ├──────────────────────────────────────────────────▶│
       │                          │                        │
       │                          │ ③回调：谁给你转了 100  │
       │                          │◀───────────────────────┤
       │                          │  ④验签 → 去重 → 入账    │
       │                          │                        │
       │ ⑤提现：你在自己页面点     │                        │
       │                          │ ⑥用转账接口付出去       │
       │                          ├───────────────────────▶│
       │                          │                        │
       │                          │ ⑦兜底：游标拉流水对账   │
       │                          ├───────────────────────▶│
```

**关键点：钱始终在 raricy 的账上，你只是拿一个账号跟用户做买卖。** 用户在你这里的
「余额」是你自己数据库里的一个数字 —— raricy 不知道它、也不为它背书。

## 1. 准备（三件事，都在浏览器里做）

### 1.1 建一个机器人账号

**在站内正常注册一个账号**，别拿你个人的号跑脚本。

> ⚠️ **注册不能走 API。** `/api/auth/register` 带人机验证，脚本过不了 —— 这是刻意的：
> 注册入口如果对自动化开放，spam 成本就是零。所以这一步**必须由人在浏览器里做一次**，
> 之后所有事都可以交给脚本。

### 1.2 签发一张只读凭据

登录这个机器人账号 → 打开 `/fish/api` → 「签发只读凭据」→ 填备注（例如 `我的银行-对账`）
→ 输入登录密码 → 页面给出一串令牌。

**立刻存进环境变量。它只显示这一次**，关掉页面就取不回来了（库里只存哈希）。

这张凭据**只能查余额与流水**。这一点很重要，见 §4 那条限制。

### 1.3 登记回调地址

同一页下面「收款回调」：填 `https://你的域名/fish/callback`，再输一次密码。
页面给出**签名密钥**，同样只显示这一次。

要求（页面也会拦）：必须 `https`、**直接返回 2xx**（我们不跟随重定向）、不能指向内网地址。

现在你手上有四个值：

| 变量 | 从哪来 | 干什么用 |
|------|--------|----------|
| `RARICY_BANK_USERNAME` | §1.1 的账号 | 转账时说明「谁在付」 |
| `RARICY_PASSWORD` | §1.1 的密码 | **只有提现用**（见 §4） |
| `RARICY_TOKEN` | §1.2 的令牌 | 查余额、拉流水、对账 |
| `RARICY_WEBHOOK_SECRET` | §1.3 的密钥 | 校验回调真的是 raricy 发来的 |

## 2. 完整实现

单文件、零依赖（只要 Node 18+，`fetch` 是内置的）。存成 `bank.mjs` 直接跑。

```js
// bank.mjs —— 最小可运行的鱼干银行：收款（回调）→ 记账 → 提现 → 对账
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const RARICY = process.env.RARICY_BASE ?? 'https://raricy.com';
const BANK_USERNAME = process.env.RARICY_BANK_USERNAME;
const PASSWORD = process.env.RARICY_PASSWORD;              // 只在提现时用
const TOKEN = process.env.RARICY_TOKEN;                    // 只读凭据
const SECRET = process.env.RARICY_WEBHOOK_SECRET;          // 回调签名密钥
const PORT = Number(process.env.PORT ?? 8080);

// ── 内部账本 ────────────────────────────────────────────────────────────────
// ⚠️ 生产必须换成真正的数据库（要事务、要备份）。这里用 JSON 文件是为了让
//    这份参考实现能整段复制粘贴就跑起来。
const DB_PATH = process.env.DB_PATH ?? './bank-db.json';
const EMPTY = { balances: {}, claimed: {}, seenDeliveries: [], cursor: 0 };

const load = () =>
  fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : structuredClone(EMPTY);
const save = (db) => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
let db = load();

const round2 = (n) => Math.round(n * 100) / 100;

// ── ① 验签 ──────────────────────────────────────────────────────────────────
// 校验用的是**原始请求体**。先 JSON.parse 再 stringify 会改掉空白与键序，
// 算出来的签名对不上 —— 这是接入时最常见的一个坑。
function verifySignature(rawBody /* Buffer */, headers) {
  const ts = headers['x-raricy-timestamp'];
  const got = headers['x-raricy-signature'] ?? '';
  if (!ts) return false;

  const expect =
    'v1=' + crypto.createHmac('sha256', SECRET).update(`${ts}.`).update(rawBody).digest('hex');

  const a = Buffer.from(got);
  const b = Buffer.from(expect);
  // 定时安全比较：`===` 会泄露「前缀匹配了多少个字节」
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  // 时间戳新鲜度挡重放。注意**重试时时间戳是新的**，所以这一步不能替代去重。
  return Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
}

// ── ② 回调入口：到账 ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/fish/callback') {
    res.writeHead(404).end('not found');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, req.headers)) {
      res.writeHead(401).end('bad signature');
      return; // 验签不过**绝不入账**，也不返回 2xx（让 raricy 重试）
    }

    let evt;
    try {
      evt = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    db = load(); // 多进程/多次请求下重新读，避免覆盖（生产用数据库事务）

    // ★ 去重必须先做 ★ 投递是「至少一次」，同一个 delivery_id 可能来好几遍。
    if (db.seenDeliveries.includes(evt.delivery_id)) {
      res.writeHead(200).end('duplicate');
      return;
    }
    db.seenDeliveries.push(evt.delivery_id);
    if (db.seenDeliveries.length > 5000) db.seenDeliveries.splice(0, 2500); // 别无限涨

    // ★ 认人：只能用 from.user_id ★
    // 绝不能用 note / username —— 那是任何人都能写的东西。
    const customerId = db.claimed[evt.from.user_id];
    if (!customerId) {
      // 这个人还没在我们这里认领过账号 —— 钱记到「待认领」池子里，
      // 等他走 §3 的认领流程。**绝不能凭 note 猜他是谁。**
      db.balances.__unclaimed = round2((db.balances.__unclaimed ?? 0) + evt.amount);
    } else {
      db.balances[customerId] = round2((db.balances[customerId] ?? 0) + evt.amount);
      console.log(`[入账] ${customerId} +${evt.amount}（单号 ${evt.transfer_id}）`);
    }
    save(db);
    res.writeHead(200).end('ok'); // ← 一定要 2xx，否则我们会重试
  });
});

// ── ③ 兜底对账：游标拉流水 ──────────────────────────────────────────────────
// 回调可能丢（判死、或我们这边根本没登记成功），所以**必须**有这个兜底。
// 回调的价值是「把定时轮询变成事件驱动」，不是「取代对账」。
async function raricyPost(path, body) {
  const res = await fetch(`${RARICY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function reconcile() {
  const data = await raricyPost('/api/fish/market/transactions', {
    since_id: db.cursor,
    limit: 100,
  });

  // ★★ 先对齐时钟，再谈滞后 —— 这一步错了，对账会**静默地什么都不做** ★★
  // raricy 的 `createdAt` 是「UTC+8 墙上时间贴 Z 标签」，**不是**标准 UTC 瞬间。
  // 拿它直接跟本机的 Date.now() 比，每一行都会显得「来自未来 8 小时」，
  // 下面那句 break 会在第一行就命中 —— 于是这个函数每次都原地返回，
  // 看起来一切正常、日志一行不报，而钱一笔都没入账。
  // 正确做法：把「现在」换算到**同一把钟**上再比。
  const RARICY_CLOCK_OFFSET_MS = 8 * 60 * 60 * 1000; // +8 小时
  const nowInRaricyClock = Date.now() + RARICY_CLOCK_OFFSET_MS;

  let lastId = db.cursor;
  for (const tx of data.transactions) {
    // ★ 留 10 秒滞后 ★
    // 转账若因账户服务故障被回滚，那两条流水会在几秒内**被删除**。
    // 「一看见就入账」会让你入了一笔随后消失的钱。
    if (new Date(tx.createdAt).getTime() > nowInRaricyClock - 10_000) break;

    if (tx.type === 'transfer_receive') {
      const customerId = db.claimed[tx.relatedUserId]; // 转账方 = 我们的客户
      if (customerId && !db.seenDeliveries.includes(`cursor:${tx.id}`)) {
        // 用 `cursor:<流水id>` 当去重键，与回调那边的 delivery_id 并存 ——
        // 同一条到账可能先被回调记过、又被对账扫到。
        db.seenDeliveries.push(`cursor:${tx.id}`);
        db.balances[customerId] = round2((db.balances[customerId] ?? 0) + tx.amount);
        console.log(`[对账补录] ${customerId} +${tx.amount}（单号 ${tx.transferId}）`);
      }
    }
    lastId = tx.id;
  }
  db.cursor = lastId;
  save(db);
}

// ── ④ 提现：把钱付给用户 ────────────────────────────────────────────────────
// ⚠️ 这一段用的是**账号密码**，不是那张只读凭据 —— 只读凭据转不了账（§4）。
async function withdraw(customerId, amount, orderId) {
  const raricyUserId = Object.keys(db.claimed).find((k) => db.claimed[k] === customerId);
  if (!raricyUserId) throw new Error(`客户 ${customerId} 还没认领 raricy 账号`);

  const res = await fetch(`${RARICY}/api/fish/market/transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: BANK_USERNAME,
      password: PASSWORD,
      to_user_id: raricyUserId,
      amount,
      note: `提现 ${orderId}`,
      // ★ 幂等键跟着「这笔业务」走，不跟着「这次请求」走 ★
      // 用你自己的提现单号。超时/断连后**原样重发这一条**是安全的；
      // 不带键的话，重试 = 真的再付一笔。
      idempotency_key: orderId,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`提现失败 ${res.status}: ${data.message}`);
  if (data.duplicated) console.log(`[提现] ${orderId} 是重放，未重复付款`);
  return data;
}

// ── 启动 ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`回调接收端已启动：http://127.0.0.1:${PORT}/fish/callback`);
  console.log('（上线时需要用 https 暴露它 —— 登记的地址必须是 https）');
});

// 每 30 秒兜底对一次账
setInterval(() => {
  reconcile().catch((e) => console.error('[对账失败]', e.message));
}, 30_000);
```

## 3. 跑一遍

**a. 用只读凭据确认它能用：**

```bash
curl -X POST https://raricy.com/api/fish/market/balance \
  -H "Authorization: Bearer $RARICY_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
# → {"code":200, ..., "balance": 0}
```

**b. 让一个用户充值。** 把用户送到收银台（`docs/bot/fish-bot.md` §9）：

```
https://raricy.com/fish/pay
  ?to=你的机器人账号名
  &amount=100
  &order=TOPUP-20260919-0001
  &from=我的鱼干银行
  &return=https://你的域名/paid
```

> `order` **一定要给**：不给的话，页面每次加载都会生成一个新的支付标识，
> 用户付完刷新页面再点一次就是**真的第二笔**。

**c. 你的服务器应当收到回调**，控制台打印 `[入账] ...`。

**d. 认领（把 raricy 账号和你站内的客户对上）。** 上面那个用户第一次充值时，
`from.user_id` 在你的 `claimed` 表里查不到，钱会进 `__unclaimed`。让他走一遍：

1. 你在自己站内给他一串一次性验证码；
2. 让他在 raricy 里**转 0.1 给你**，备注里带上那串码；
3. 你从流水里按**备注**找到那笔 0.1，把 `relatedUserId` 记成他的 raricy id：

```js
db.claimed[tx.relatedUserId] = '你自己站内的客户 id';
db.cursor = tx.id; // 别让这 0.1 又被当成一笔充值
```

> 为什么绕这一圈：**备注是谁都能写的自由文本**。「我是 alice」证明不了他是 alice。
> 唯一能信的只有流水里由系统填的 `relatedUserId`。
> （若嫌麻烦，也可以走 OAuth —— 用户授权后你直接拿到他的 raricy user id，
> 但那需要站长登记应用，见 `docs/oauth.md`。）

**e. 提现。** 用户在你站内点提现，调 `withdraw(客户id, 金额, 提现单号)`。

## 4. 这个实现刻意没做的事

| 没做 | 为什么 / 生产上怎么办 |
|------|----------------------|
| **只读凭据不能转账** | 这是设计如此，不是缺陷：转账那条路的全部价值就在「必须是本人在场、当场输一次密码」。所以**提现那一段仍然要拿账号密码**。把密码放进环境变量、只给提现这一个进程用；日常对账/轮询只带只读凭据 —— 泄露了也搬不走钱，且能单独吊销 |
| 注册走 API | 注册有人机验证，脚本过不去。建号由人在浏览器里做一次 |
| 内部账本用 JSON 文件 | 生产要换成数据库 + 事务。并发入账下 JSON 会丢写 |
| 认领要多转 0.1 | 这是最省事且不需要任何人批准的方案。OAuth 更省事，但要站长建应用 |
| 回调地址是 http 且在本机 | 登记时 raricy 只收 https、且拒绝内网地址（含 127.0.0.1、云元数据地址）。本地开发要用隧道把它暴露成 https |
| 没做提现的余额校验 | 上面 `withdraw` 直接付。生产上你要在自己的库里先扣客户余额、再调转账，并处理「转账失败要退回余额」 |

## 5. 四条最容易亏钱的纪律

1. **回调必须去重**（按 `X-Raricy-Delivery`）。投递是「至少一次」，重复是正常的，
   不是异常。不去重 = 同一笔钱入两次。
2. **认人只能用 `from.user_id` / `relatedUserId`**，永远不要用备注或用户名。
3. **对账必须留 10 秒滞后**，且必须**真的跑**（回调会丢）。只靠回调对账早晚会漏钱。
4. **提现的幂等键必须跟着提现单号走**。超时重试时原样重发同一条是安全的；
   换一个新键重试 = 再付一笔。

## 6. 遇到问题先看哪

| 症状 | 多半是 |
|------|--------|
| **对账跑了但一笔都没入** | **时钟没对齐**：`createdAt` 是「UTC+8 墙上时间贴 Z」，直接跟 `Date.now()` 比会让每行都像来自未来（见 §2 代码里的注释） |
| 回调收不到 | 地址不是 https / 不是 2xx / 指向内网；或页面显示「连续失败 n 次」 |
| 回调收到了但验签不过 | 用了 `JSON.parse` 之后再 `stringify` 的正文；或密钥用了旧的（换过密钥的话） |
| 同一笔入账两次 | 没按 `delivery_id` 去重；或回调与对账两路都入账且没共用去重表 |
| 提现重复付款 | 重试时换了幂等键；或压根没带键 |
| `401` 且文案说凭据无效 | 只读凭据被吊销 / 过期（一年）；或把令牌写错了 |
| `403` 且文案提到「只能读取」 | 拿只读凭据去调转账了，转账要用密码 |
| `429` | 见 `docs/bot/fish-bot.md` §4 的配额表 |
