from functools import wraps
from flask import Blueprint, render_template, jsonify, request
from flask_login import login_required, current_user
from app.clients.account_client import AccountClientError
from app.service.checkin import (
    check_in,
    claim_fortune,
    get_today_status,
    get_leaderboard,
    get_fortune_leaderboard,
)

checkin_bp = Blueprint('checkin', __name__)


def _json_auth_required(f):
    """Like @login_required but returns JSON 401 instead of redirecting to login page."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({'code': 401, 'message': '请先登录'}), 401
        return f(*args, **kwargs)
    return decorated


@checkin_bp.route('/')
@login_required
def index():
    """Render the check-in page with personal stats and both leaderboards."""
    today_status = get_today_status(current_user.id)
    count_leaderboard = get_leaderboard()
    fortune_leaderboard = get_fortune_leaderboard()

    return render_template(
        'checkin/index.html',
        today_status=today_status,
        count_leaderboard=count_leaderboard,
        fortune_leaderboard=fortune_leaderboard,
    )


@checkin_bp.route('/api/do-checkin', methods=['POST'])
@_json_auth_required
def api_do_checkin():
    """AJAX endpoint to perform a daily check-in."""
    result = check_in(current_user.id)
    if result['success']:
        return jsonify({
            'code': 200,
            'message': result['message'],
            'total_count': result['total_count'],
            'fortune_pending': result['fortune_pending'],
            'show_fortune': result['show_fortune'],
        })
    else:
        return jsonify({
            'code': 400,
            'message': result['message'],
            'total_count': result.get('total_count'),
            'already_checked': result.get('already_checked', False),
            'fortune_value': result.get('fortune_value'),
            'fortune_pending': result.get('fortune_pending', False),
            'show_fortune': False,
        }), 400


@checkin_bp.route('/api/claim-fortune', methods=['POST'])
@_json_auth_required
def api_claim_fortune():
    """User picks a fortune card after check-in."""
    data = request.get_json()
    if not data:
        return jsonify({'code': 400, 'message': '无效的请求'}), 400

    chosen_index = data.get('chosen_index')
    if chosen_index is None:
        return jsonify({'code': 400, 'message': '请选择一个卡牌'}), 400

    try:
        chosen_index = int(chosen_index)
    except (ValueError, TypeError):
        return jsonify({'code': 400, 'message': '无效的选择'}), 400

    try:
        result = claim_fortune(current_user.id, chosen_index)
    except AccountClientError as e:
        # 远端账户服务不可用/失败 → fail-closed，本地已回滚
        return jsonify({
            'code': 503,
            'message': '鱼干服务暂不可用，请稍后再试',
            'detail': str(e),
        }), 503

    if result['success']:
        return jsonify({
            'code': 200,
            'fortune_value': result['fortune_value'],
            'pool': result['pool'],
            'total_fortune': result['total_fortune'],
            'dried_fish': result.get('dried_fish', 0),
            'already_claimed': result.get('already_claimed', False),
        })
    else:
        return jsonify({
            'code': 400,
            'message': result['message'],
        }), 400


@checkin_bp.route('/api/today-status')
@_json_auth_required
def api_today_status():
    """AJAX endpoint to get today's check-in status."""
    status = get_today_status(current_user.id)
    return jsonify({
        'checked_in': status['checked_in'],
        'total_count': status['total_count'],
        'today': status['today'],
        'fortune_value': status['fortune_value'],
        'total_fortune': status['total_fortune'],
        'dried_fish': status['dried_fish'],
        'fortune_pending': status['fortune_pending'],
    })


@checkin_bp.route('/api/leaderboard')
@_json_auth_required
def api_leaderboard():
    """AJAX endpoint to get both leaderboards as JSON."""
    from flask import url_for

    count_lb = get_leaderboard()
    fortune_lb = get_fortune_leaderboard()

    # Attach avatar URLs for client-side rendering
    for entry in count_lb:
        if entry.get('avatar_path'):
            entry['avatar_url'] = url_for('auth.get_avatar', user_id=entry['user_id'])

    for entry in fortune_lb:
        if entry.get('avatar_path'):
            entry['avatar_url'] = url_for('auth.get_avatar', user_id=entry['user_id'])

    return jsonify({
        'code': 200,
        'count_leaderboard': count_lb,
        'fortune_leaderboard': fortune_lb,
    })
