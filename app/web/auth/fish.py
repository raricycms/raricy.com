"""小鱼干模块 — 余额页面 + 流水页面 + JSON API

Phase 1 过渡策略：优先读取远程账户服务，失败时 fallback 到本地 DB。
"""
import logging
from datetime import datetime, timedelta
from functools import wraps

from flask import current_app, jsonify, render_template, request
from flask_login import current_user, login_required

from . import auth_bp

# 保留本地服务导入作为 fallback
from app.service.fish import (
    get_balance,
    get_balance_batch,
    get_transactions,
    get_balance_leaderboard,
    get_today_checkin_fish,
)

logger = logging.getLogger(__name__)


def _json_auth_required(f):
    """Like @login_required but returns JSON 401 instead of redirecting."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({'code': 401, 'message': '请先登录'}), 401
        return f(*args, **kwargs)
    return decorated


# ═══════════════════════════════════════════════════════
#  兼容适配器 — 将账户服务 ledger entry 转为旧格式
# ═══════════════════════════════════════════════════════

def _adapt_tx(entry: dict) -> dict:
    """将账户服务 ledger entry 转为旧 FishTransaction.to_dict() 格式。

    账户服务返回：
        {id, transaction_id, direction (DEBIT/CREDIT), amount (Decimal),
         entry_type, description, counterparty, balance_after, metadata, created_at}

    旧格式模板期望：
        {id, user_id, amount (负数=支出), type, description, reference_type,
         reference_id, related_user_id, created_at}
    """
    amount = float(entry.get('amount', 0))
    # CREDIT = 资金流出（映射为旧格式负数）
    if entry.get('direction') == 'CREDIT':
        amount = -amount

    # 从 metadata 提取投喂者信息（A→system→B 模型中，
    # system→B 的 counterparty 是系统账户，投喂者信息在 metadata 中）
    metadata = entry.get('metadata', {}) or {}
    description = entry.get('description', '')
    if entry.get('entry_type') == 'feed_income' and metadata.get('feeder_name'):
        description = f"{metadata['feeder_name']} {description}"

    return {
        'id': str(entry.get('id', '')),
        'user_id': '',
        'amount': amount,
        'type': entry.get('entry_type', ''),
        'description': description,
        'reference_type': None,
        'reference_id': None,
        'related_user_id': entry.get('counterparty'),
        'created_at': entry.get('created_at'),
    }


def _adapt_pagination(pagination: dict, page: int = 1) -> dict:
    """将账户服务 pagination 转为旧模板格式。"""
    return {
        'page': pagination.get('page', page),
        'pages': pagination.get('pages', 1),
        'total': pagination.get('total', 0),
        'has_prev': pagination.get('has_prev', False),
        'has_next': pagination.get('has_next', False),
        'prev_num': pagination.get('page', page) - 1 if pagination.get('has_prev') else None,
        'next_num': pagination.get('page', page) + 1 if pagination.get('has_next') else None,
    }


def _today_utc8_str() -> str:
    """返回 UTC+8 今天的日期字符串（YYYY-MM-DD）。"""
    return (datetime.utcnow() + timedelta(hours=8)).date().isoformat()


# ═══════════════════════════════════════════════════════
#  页面路由
# ═══════════════════════════════════════════════════════

@auth_bp.route('/fish')
@login_required
def fish_balance():
    """余额页面 — 单次合并调用；失败 fallback 到两次调用。"""
    client = current_app.account_client

    # 主路径：1 次 HTTP（合并 balance + today_checkin）
    try:
        result = client.get_balance(current_user.id, include_today_checkin=True)
        balance = float(result['balance'])
        today_fish = float(result.get('today_checkin', 0))
    except Exception as e:
        # Fallback：账户服务暂不支持 include 或响应异常，回退到原两次调用
        logger.warning(f"账户服务合并调用失败，回退到两次调用: {e}")
        try:
            balance = client.get_balance(current_user.id)
        except Exception as e2:
            logger.warning(f"账户服务余额查询失败: {e2}")
            balance = current_user.dried_fish

        try:
            today_str = _today_utc8_str()
            ledger = client.get_ledger(
                current_user.id, page=1, per_page=50,
                entry_type='checkin',
                start=today_str, end=today_str,
            )
            today_fish = sum(float(e['amount']) for e in ledger.get('entries', []))
        except Exception:
            today_fish = get_today_checkin_fish(current_user.id)

    return render_template(
        'auth/fish.html',
        dried_fish=balance,
        today_fish=today_fish,
    )


@auth_bp.route('/fish/transactions')
@login_required
def fish_transactions():
    """流水分页页面 — 优先读远程，失败 fallback 本地。"""
    page = request.args.get('page', 1, type=int)
    type_filter = request.args.get('type', None)
    client = current_app.account_client

    try:
        # 兼容旧 type 参数：feed_all → feed_income,feed_consume
        remote_type = type_filter
        if type_filter == 'feed_all':
            remote_type = 'feed_income,feed_consume'

        data = client.get_ledger(
            current_user.id, page=page, per_page=20,
            entry_type=remote_type,
        )
        transactions = [_adapt_tx(e) for e in data.get('entries', [])]
        pagination = _adapt_pagination(data.get('pagination', {}), page)
    except Exception as e:
        logger.warning(f"账户服务流水查询失败: {e}")
        data = get_transactions(current_user.id, page=page, per_page=20, type=type_filter)
        transactions = data['transactions']
        pagination = {
            'page': data['page'],
            'pages': data['pages'],
            'total': data['total'],
            'has_prev': data['has_prev'],
            'has_next': data['has_next'],
            'prev_num': data['prev_num'],
            'next_num': data['next_num'],
        }

    return render_template(
        'auth/fish_transactions.html',
        transactions=transactions,
        pagination=pagination,
        type_filter=type_filter,
    )


# ═══════════════════════════════════════════════════════
#  JSON API — 需登录
# ═══════════════════════════════════════════════════════

@auth_bp.route('/fish/api/balance')
@_json_auth_required
def api_my_balance():
    """当前用户余额（含今日签到获得数）— 单次合并调用 + fallback。"""
    client = current_app.account_client

    # 主路径：1 次 HTTP
    try:
        result = client.get_balance(current_user.id, include_today_checkin=True)
        balance = float(result['balance'])
        today_earned = float(result.get('today_checkin', 0))
    except Exception as e:
        logger.warning(f"账户服务合并调用失败，回退到两次调用: {e}")
        try:
            balance = client.get_balance(current_user.id)
        except Exception:
            balance = current_user.dried_fish

        try:
            today_str = _today_utc8_str()
            ledger = client.get_ledger(
                current_user.id, page=1, per_page=50,
                entry_type='checkin',
                start=today_str, end=today_str,
            )
            today_earned = sum(float(e['amount']) for e in ledger.get('entries', []))
        except Exception:
            today_earned = get_today_checkin_fish(current_user.id)

    return jsonify({
        'code': 200,
        'user_id': current_user.id,
        'balance': balance,
        'today_earned': today_earned,
    })


@auth_bp.route('/fish/api/transactions')
@_json_auth_required
def api_my_transactions():
    """当前用户流水分页（JSON）— 优先远程。"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    type_filter = request.args.get('type', None)
    client = current_app.account_client

    try:
        remote_type = type_filter
        if type_filter == 'feed_all':
            remote_type = 'feed_income,feed_consume'

        data = client.get_ledger(
            current_user.id, page=page, per_page=per_page,
            entry_type=remote_type,
        )
        transactions = [_adapt_tx(e) for e in data.get('entries', [])]
        pagination = data.get('pagination', {})
        return jsonify({
            'code': 200,
            'transactions': transactions,
            'total': pagination.get('total', 0),
            'page': pagination.get('page', page),
            'per_page': pagination.get('per_page', per_page),
            'pages': pagination.get('pages', 1),
            'has_prev': pagination.get('has_prev', False),
            'has_next': pagination.get('has_next', False),
            'prev_num': pagination.get('page', page) - 1 if pagination.get('has_prev') else None,
            'next_num': pagination.get('page', page) + 1 if pagination.get('has_next') else None,
        })
    except Exception as e:
        logger.warning(f"账户服务流水 API 查询失败: {e}")
        data = get_transactions(current_user.id, page=page, per_page=per_page, type=type_filter)
        return jsonify({
            'code': 200,
            **data,
        })


# ═══════════════════════════════════════════════════════
#  JSON API — 公开（无需登录，方便外部项目调用）
# ═══════════════════════════════════════════════════════

@auth_bp.route('/fish/api/balance/<user_id>')
def api_user_balance(user_id):
    """公开接口：查询任意用户的余额 — 优先远程。"""
    client = current_app.account_client
    try:
        balance = client.get_balance(user_id)
    except Exception:
        balance = get_balance(user_id)
    return jsonify({
        'code': 200,
        'user_id': user_id,
        'balance': balance,
    })


@auth_bp.route('/fish/api/balance/batch', methods=['POST'])
def api_batch_balance():
    """公开接口：批量查询余额 — 优先远程。

    POST body: {"user_ids": ["id1", "id2", ...]}
    返回: {"code": 200, "balances": {"id1": n, "id2": m}}
    """
    data = request.get_json(silent=True)
    if not data or 'user_ids' not in data:
        return jsonify({'code': 400, 'message': '请提供 user_ids 数组'}), 400
    user_ids = data['user_ids']
    if not isinstance(user_ids, list):
        return jsonify({'code': 400, 'message': 'user_ids 必须是数组'}), 400

    client = current_app.account_client
    try:
        balances = client.get_balances(user_ids)
    except Exception:
        balances = get_balance_batch(user_ids)

    return jsonify({
        'code': 200,
        'balances': balances,
    })


@auth_bp.route('/fish/api/leaderboard')
def api_leaderboard():
    """公开接口：小鱼干排行榜 — 暂用本地（账户服务无排行榜 API）。"""
    limit = request.args.get('limit', 50, type=int)
    leaderboard = get_balance_leaderboard(limit=min(limit, 100))
    return jsonify({
        'code': 200,
        'leaderboard': leaderboard,
    })
