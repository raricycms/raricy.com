"""小鱼干模块 — 余额页面 + 流水页面 + JSON API"""
from functools import wraps
from flask import render_template, jsonify, request
from flask_login import login_required, current_user
from . import auth_bp
from app.service.fish import (
    get_balance,
    get_balance_batch,
    get_transactions,
    get_balance_leaderboard,
    get_today_checkin_fish,
)


def _json_auth_required(f):
    """Like @login_required but returns JSON 401 instead of redirecting."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({'code': 401, 'message': '请先登录'}), 401
        return f(*args, **kwargs)
    return decorated


# ═══════════════════════════════════════════════════════
#  页面路由
# ═══════════════════════════════════════════════════════

@auth_bp.route('/fish')
@login_required
def fish_balance():
    """余额页面"""
    return render_template(
        'auth/fish.html',
        dried_fish=current_user.dried_fish,
        today_fish=get_today_checkin_fish(current_user.id),
    )


@auth_bp.route('/fish/transactions')
@login_required
def fish_transactions():
    """流水分页页面"""
    page = request.args.get('page', 1, type=int)
    type_filter = request.args.get('type', None)
    data = get_transactions(current_user.id, page=page, per_page=20, type=type_filter)
    return render_template(
        'auth/fish_transactions.html',
        transactions=data['transactions'],
        pagination={
            'page': data['page'],
            'pages': data['pages'],
            'total': data['total'],
            'has_prev': data['has_prev'],
            'has_next': data['has_next'],
            'prev_num': data['prev_num'],
            'next_num': data['next_num'],
        },
        type_filter=type_filter,
    )


# ═══════════════════════════════════════════════════════
#  JSON API — 需登录
# ═══════════════════════════════════════════════════════

@auth_bp.route('/fish/api/balance')
@_json_auth_required
def api_my_balance():
    """当前用户余额（含今日签到获得数）"""
    return jsonify({
        'code': 200,
        'user_id': current_user.id,
        'balance': current_user.dried_fish,
        'today_earned': get_today_checkin_fish(current_user.id),
    })


@auth_bp.route('/fish/api/transactions')
@_json_auth_required
def api_my_transactions():
    """当前用户流水分页（JSON）"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    type_filter = request.args.get('type', None)
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
    """公开接口：查询任意用户的余额"""
    balance = get_balance(user_id)
    return jsonify({
        'code': 200,
        'user_id': user_id,
        'balance': balance,
    })


@auth_bp.route('/fish/api/balance/batch', methods=['POST'])
def api_batch_balance():
    """公开接口：批量查询余额

    POST body: {"user_ids": ["id1", "id2", ...]}
    返回: {"code": 200, "balances": {"id1": n, "id2": m}}
    """
    data = request.get_json(silent=True)
    if not data or 'user_ids' not in data:
        return jsonify({'code': 400, 'message': '请提供 user_ids 数组'}), 400
    user_ids = data['user_ids']
    if not isinstance(user_ids, list):
        return jsonify({'code': 400, 'message': 'user_ids 必须是数组'}), 400
    balances = get_balance_batch(user_ids)
    return jsonify({
        'code': 200,
        'balances': balances,
    })


@auth_bp.route('/fish/api/leaderboard')
def api_leaderboard():
    """公开接口：小鱼干排行榜"""
    limit = request.args.get('limit', 50, type=int)
    leaderboard = get_balance_leaderboard(limit=min(limit, 100))
    return jsonify({
        'code': 200,
        'leaderboard': leaderboard,
    })
