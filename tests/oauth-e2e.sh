#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# tests/oauth-e2e.sh — OAuth 2.0 端到端验证脚本
#
# 11 项断言，依赖：
#   • dev server 运行在 $BASE（默认 http://localhost:3000）
#   • 库内已有 oauth_test_<random> 用户（密码 TestPass123!）
#   • 库内已至少一个 OAuth 应用（Test App；client_id / client_secret 来自 CLI 输出）
#   • tsx 可用（项目自带）—— 用于 mint 授权码（不走 UI）
#
# 运行：
#   BASE=http://localhost:3000 \
#   OAUTH_TEST_USER=oauth_test_1vi7nn \
#   OAUTH_TEST_PASS=TestPass123! \
#   CLIENT_ID=F6N4isuuCHk3VbY8vLdy2YkzfEJbbsjx \
#   CLIENT_SECRET=v0EDt-aSuPX0lmRNj02zDsbIRlUFc3tFuh7avsqq58Y \
#   bash tests/oauth-e2e.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

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

# ── 0. 准备：登录拿 cookie ─────────────────────────────────────────────────
section "0. 登录拿 session cookie"
COOKIES=$(mktemp)
trap "rm -f $COOKIES /tmp/oauth_code.txt" EXIT
LOGIN_RES=$(curl -sS -c "$COOKIES" -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" \
  "$BASE/api/auth/login")
echo "$LOGIN_RES" | grep -q '"code":200' && ok "owner/core 登录成功" || ko "登录失败" "$LOGIN_RES"

# ── 1. mint 一个 authorization code（不走 UI，直接调库） ─────────────────
section "1. mint authorization code"
cat > /tmp/oauth-mint.mts <<EOF
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
})();
EOF
CODE=$(npx tsx /tmp/oauth-mint.mts 2>/dev/null | tail -1)
rm -f /tmp/oauth-mint.mts
[ -n "$CODE" ] && ok "code minted" || ko "mint 失败" "see stderr"

# ── 2. /api/oauth/token: code → access_token ─────────────────────────────
section "2. POST /api/oauth/token"
TOK_RES=$(curl -sS -u "$CID:$CSECRET" -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$(printf %s "$REDIRECT_URI" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')" \
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
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$(printf %s "$REDIRECT_URI" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')" \
  "$BASE/api/oauth/token")
[ "$SECOND" = "400" ] && ok "返回 400" || ko "应 400 实 $SECOND" ""

# ── 5. 用错的 redirect_uri exchange → 400 ────────────────────────────────
section "5. redirect_uri 不匹配"
cat > /tmp/oauth-mint.mts <<EOF
import { prisma } from '@/lib/db';
import { generateAuthorizationCode, hashOpaqueToken } from '@/lib/oauth';
import { nowForDb } from '@/lib/db-time';
(async () => {
  const app = await prisma.oAuthApplication.findFirst({ where: { clientId: '$CID' } });
  const u = await prisma.user.findUnique({ where: { username: '$TEST_USER' } });
  const code = generateAuthorizationCode();
  const now = nowForDb();
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: hashOpaqueToken(code),
      applicationId: app!.id, userId: u!.id,
      redirectUri: '$REDIRECT_URI', scopes: 'profile',
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000), createdAt: now,
    },
  });
  console.log(code);
  await prisma.\$disconnect();
})();
EOF
CODE2=$(npx tsx /tmp/oauth-mint.mts 2>/dev/null | tail -1)
rm -f /tmp/oauth-mint.mts
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
  -d "grant_type=authorization_code&code=$CODE2&redirect_uri=$(printf %s "$REDIRECT_URI" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')" \
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
CROSS_RES=$(curl -sS -o /dev/null -w "%{http_code}" -u "$CID:$CSECRET" \
  -H "Origin: https://external.example.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE2&redirect_uri=$(printf %s "$REDIRECT_URI" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')" \
  "$BASE/api/oauth/token")
# 该 code 已被 step 5 的「错 redirect_uri」耗尽，此处只验证不被 CSRF 拦截
# （会因 invalid_grant 返 400，但绝不会因 CSRF 返 403）
if [ "$CROSS_RES" = "400" ]; then ok "通过 CSRF 豁免（400 是预期：code 已被耗尽）"
elif [ "$CROSS_RES" = "200" ]; then ok "通过 CSRF 豁免"
else ko "应 400/200 实 $CROSS_RES（若 403 则是 CSRF 误杀）" ""; fi

# ── 总结 ──────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo " 通过：$PASS    失败：$FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1