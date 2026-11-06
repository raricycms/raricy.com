#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# tests/oauth-e2e.sh — OAuth 2.0 端到端验证脚本
#
# 12 段 / 14 项断言（部分段按分支计数：userinfo 与跨域段各有两种通过形态）。
# 依赖：
#   • dev server 运行在 $BASE（默认 http://localhost:3000），**与本脚本同一个库**
#   • 库内已有 oauth_test_<random> 用户（密码 TestPass123!）—— 本脚本不创建/删除它
#   • 库内已至少一个 OAuth 应用（Test App；client_id / client_secret 来自 CLI 输出）
#   • tsx 可用（项目自带）—— 用于 mint 授权码（不走 UI）
#
# ⚠️ **隔离要求**（R3-724）：脚本会直接写 OAuthAuthorizationCode，所以只允许对
#    隔离库运行 —— `DATABASE_URL` **必须**指向 `tests/.tmp/` 下的文件，否则直接
#    拒跑（exit 2）。本脚本不会碰 .env 指向的真实库；退出时清掉本次 mint 的 code。
#
# 运行（示例；先按 docs/oauth.md 建好隔离库与用户/应用）：
#   DATABASE_URL="file:$PWD/tests/.tmp/oauth-e2e.db" \
#   BASE=http://localhost:3100 \
#   OAUTH_TEST_USER=oauth_test_1vi7nn \
#   OAUTH_TEST_PASS=TestPass123! \
#   CLIENT_ID=… CLIENT_SECRET=… \
#   bash tests/oauth-e2e.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── 隔离闸门 ────────────────────────────────────────────────────────────────
# 与 tests/helpers/db.ts 的 assertTestDb 同一条前缀纪律：本脚本写的是**库**，
# 不是 HTTP 只读请求。不设这道闸时，在 .env 指向真实库的机器上跑一次就把
# OAuthAuthorizationCode 写进真实库（R3-724）。
DB_URL="${DATABASE_URL:-}"
case "${DB_URL//\\//}" in
  *"/tests/.tmp/"*) ;;
  *)
    echo "✗ 拒绝运行：DATABASE_URL 必须指向 tests/.tmp 下的隔离库（当前：'${DB_URL:-<未设置>}'）" >&2
    echo "  例：DATABASE_URL=\"file:$ROOT/tests/.tmp/oauth-e2e.db\" bash tests/oauth-e2e.sh" >&2
    exit 2
    ;;
esac

# 所有临时文件放本进程独有目录：固定 /tmp 文件名会在多开时互相覆盖。
WORKDIR="$(mktemp -d)"
COOKIES="$WORKDIR/cookies.txt"
MINT_TS="$WORKDIR/oauth-mint.mts"
CLEANUP_TS="$WORKDIR/oauth-cleanup.mts"
MINTED_CODES="$WORKDIR/minted-codes.txt"
: > "$MINTED_CODES"

# 清理脚本：按 code 的 sha256 哈希删掉本次 mint 的授权码（不删预置用户/应用）。
cat > "$CLEANUP_TS" <<'EOF'
import { readFileSync } from 'node:fs';
import { prisma } from '@/lib/db';
import { hashOpaqueToken } from '@/lib/oauth';
(async () => {
  const codes = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
  if (codes.length > 0) {
    await prisma.oAuthAuthorizationCode.deleteMany({
      where: { codeHash: { in: codes.map((c) => hashOpaqueToken(c)) } },
    });
  }
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
EOF

cleanup() {
  # 清理失败只提示，不掩盖本次断言的退出码。
  if [ -s "$MINTED_CODES" ]; then
    DATABASE_URL="$DATABASE_URL" npx tsx "$CLEANUP_TS" "$MINTED_CODES" >/dev/null 2>&1 \
      || echo "  ! 清理本次 mint 的授权码失败（库：$DATABASE_URL）" >&2
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

BASE="${BASE:-http://localhost:3000}"
TEST_USER="${OAUTH_TEST_USER:?必须设置 OAUTH_TEST_USER}"
TEST_PASS="${OAUTH_TEST_PASS:-TestPass123!}"
CID="${CLIENT_ID:?必须设置 CLIENT_ID}"
CSECRET="${CLIENT_SECRET:?必须设置 CLIENT_SECRET}"
REDIRECT_URI="${REDIRECT_URI:-https://example.com/cb}"

PASS=0
FAIL=0
ok() { PASS=$((PASS+1)); echo "  ✓ $1"; }
ko() { FAIL=$((FAIL+1)); echo "  ✗ $1"; echo "    $2"; }
section() { echo ""; echo "── $1 ──"; }

# ── mint 一个授权码（不走 UI，直接写库；只对隔离库执行，见顶部闸门）──────────
# 失败时返回非零，调用方用 `CODE=$(mint_code) || CODE=""` 收住 —— 否则 set -e
# 会在打印 ko/总结**之前**静默中止，退出码虽然非零但没有任何可读信息。
mint_code() {
  cat > "$MINT_TS" <<EOF
import { prisma } from '@/lib/db';
import { generateAuthorizationCode, hashOpaqueToken } from '@/lib/oauth';
import { nowForDb } from '@/lib/db-time';
(async () => {
  const app = await prisma.oAuthApplication.findFirst({ where: { clientId: '$CID' } });
  const u = await prisma.user.findUnique({ where: { username: '$TEST_USER' } });
  if (!app || !u) { console.error('NO_APP_OR_USER'); process.exit(1); }
  const code = generateAuthorizationCode();
  const now = nowForDb();
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: hashOpaqueToken(code),
      applicationId: app.id,
      userId: u.id,
      redirectUri: '$REDIRECT_URI',
      scopes: 'profile',
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      createdAt: now,
    },
  });
  console.log(code);
  await prisma.\$disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await prisma.\$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
EOF
  local out
  out=$(DATABASE_URL="$DATABASE_URL" npx tsx "$MINT_TS" 2>"$WORKDIR/mint.err" | tail -1) || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" >> "$MINTED_CODES"
  printf '%s' "$out"
}

# 表单值里的 URL 要做百分号编码：只保留 RFC 3986 的 unreserved（A-Za-z0-9-_.~），
# 其余一律 %XX（空格编成 %20，不是 +）。用 node 实现 —— 本机不一定有可用的 python3
# （store 占位符会静默输出空串），而 node 必然在：下面 mint 授权码已依赖 `npx tsx`。
urlencode() {
  printf %s "$1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(encodeURIComponent(s).replace(/[!\x27()*]/g,m=>"%"+m.charCodeAt(0).toString(16).toUpperCase())))'
}

# ── 0. 准备：登录拿 cookie ─────────────────────────────────────────────────
section "0. 登录拿 session cookie"
LOGIN_RES=$(curl -sS -c "$COOKIES" -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" \
  "$BASE/api/auth/login") || LOGIN_RES=""
echo "$LOGIN_RES" | grep -q '"code":200' && ok "owner/core 登录成功" || ko "登录失败" "$LOGIN_RES"

# ── 1. mint 一个 authorization code（不走 UI，直接调库） ─────────────────
section "1. mint authorization code"
CODE=$(mint_code) || CODE=""
if [ -n "$CODE" ]; then ok "code minted"; else ko "mint 失败" "$(cat "$WORKDIR/mint.err" 2>/dev/null || echo 'see stderr')"; fi

# ── 2. /api/oauth/token: code → access_token ─────────────────────────────
section "2. POST /api/oauth/token"
TOK_RES=$(curl -sS -u "$CID:$CSECRET" -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$(urlencode "$REDIRECT_URI")" \
  "$BASE/api/oauth/token")
AT=$(echo "$TOK_RES" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).access_token||'')}catch{console.log('')}})")
[ -n "$AT" ] && ok "拿到 access_token (长度 ${#AT})" || ko "exchange 失败" "$TOK_RES"

# ── 3. /api/oauth/userinfo ────────────────────────────────────────────────
section "3. GET /api/oauth/userinfo"
UI_RES=$(curl -sS -H "Authorization: Bearer $AT" "$BASE/api/oauth/userinfo")
echo "$UI_RES" | grep -q "\"sub\":\"$TEST_USER\\|\"username\":\"$TEST_USER" \
  && ok "userinfo 包含 username" \
  || ( echo "$UI_RES" | grep -q "\"sub\":" && ok "userinfo 至少包含 sub" ) \
  || ko "userinfo 缺字段" "$UI_RES"

# ── 4. 同一 code 再 exchange → 400 invalid_grant ─────────────────────────
section "4. 同一 code 第二次 exchange (单次使用)"
SECOND=$(curl -sS -o /dev/null -w "%{http_code}" -u "$CID:$CSECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$(urlencode "$REDIRECT_URI")" \
  "$BASE/api/oauth/token")
[ "$SECOND" = "400" ] && ok "返回 400" || ko "应 400 实 $SECOND" ""

# ── 5. 用错的 redirect_uri exchange → 400 ────────────────────────────────
section "5. redirect_uri 不匹配"
CODE2=$(mint_code) || CODE2=""
BAD_REDIRECT="https%3A%2F%2Fattacker.example%2Fcb"
MISMATCH=$(curl -sS -o /dev/null -w "%{http_code}" -u "$CID:$CSECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE2&redirect_uri=$BAD_REDIRECT" \
  "$BASE/api/oauth/token")
[ "$MISMATCH" = "400" ] && ok "返回 400 (redirect_mismatch)" || ko "应 400 实 $MISMATCH" ""

# ── 6. 错 client_secret → 401 ─────────────────────────────────────────────
section "6. 错 client_secret"
WRONG=$(curl -sS -o /dev/null -w "%{http_code}" -u "$CID:wrongsecret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE2&redirect_uri=$(urlencode "$REDIRECT_URI")" \
  "$BASE/api/oauth/token")
[ "$WRONG" = "401" ] && ok "返回 401" || ko "应 401 实 $WRONG" ""

# ── 7. /api/oauth/revoke（bearer 自吊销） ─────────────────────────────────
section "7. POST /api/oauth/revoke"
REVOKE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
  -d "{\"token\":\"$AT\"}" "$BASE/api/oauth/revoke")
[ "$REVOKE" = "200" ] && ok "返回 200" || ko "应 200 实 $REVOKE" ""

# ── 8. revoke 后 userinfo → 400 invalid_token ─────────────────────────────
section "8. revoke 后 userinfo"
POST_REVOKE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AT" "$BASE/api/oauth/userinfo")
[ "$POST_REVOKE" = "400" ] && ok "返回 400 invalid_token" || ko "应 400 实 $POST_REVOKE" ""

# ── 9. revoke 未知 token → 200（RFC 7009 §2.2 不泄露） ───────────────────
section "9. revoke 未知 token (RFC 7009)"
UNKNOWN=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" -d '{"token":"unknown_garbage"}' \
  "$BASE/api/oauth/revoke")
[ "$UNKNOWN" = "200" ] && ok "返回 200" || ko "应 200 实 $UNKNOWN" ""

# ── 10. /api/oauth/connections ────────────────────────────────────────────
section "10. GET /api/oauth/connections"
CONN_RES=$(curl -sS -b "$COOKIES" "$BASE/api/oauth/connections")
echo "$CONN_RES" | grep -q "\"code\":200" \
  && ok "返回 200" \
  || ko "获取失败" "$CONN_RES"

# ── 11. 跨域 /api/oauth/token 调用 (CSRF 豁免生效) ────────────────────────
section "11. 跨域 Origin 调 /api/oauth/token (CSRF 豁免)"
# 用**新 mint 的 code**：这一条要断言的是「跨域 Origin 下合法请求能正常兑换」。
# 旧版复用 step 5 的 CODE2 并接受 200/400 两种结果（只证明「不是 403」），
# 既分不清 code 是否被误消费，也把「400」当成了通过（R3-724）。
CODE3=$(mint_code) || CODE3=""
CROSS_RES=$(curl -sS -o /dev/null -w "%{http_code}" -u "$CID:$CSECRET" \
  -H "Origin: https://external.example.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE3&redirect_uri=$(urlencode "$REDIRECT_URI")" \
  "$BASE/api/oauth/token")
if [ "$CROSS_RES" = "200" ]; then
  ok "跨域 Origin 下正常兑换（200，CSRF 豁免生效）"
else
  ko "应 200 实 $CROSS_RES（403 = CSRF 误杀；400 = code/参数问题）" ""
fi

# ── 总结 ──────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo " 通过：$PASS    失败：$FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1