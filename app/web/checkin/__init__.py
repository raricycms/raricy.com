from functools import wraps
from flask import Blueprint, render_template, jsonify
from flask_login import login_required, current_user
from app.service.checkin import check_in, get_today_status, get_leaderboard

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
    """Render the check-in page with personal stats and leaderboard."""
    today_status = get_today_status(current_user.id)
    leaderboard = get_leaderboard()

    return render_template(
        'checkin/index.html',
        today_status=today_status,
        leaderboard=leaderboard,
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
        })
    else:
        return jsonify({
            'code': 400,
            'message': result['message'],
            'total_count': result['total_count'],
        }), 400


@checkin_bp.route('/api/today-status')
@_json_auth_required
def api_today_status():
    """AJAX endpoint to get today's check-in status."""
    status = get_today_status(current_user.id)
    return jsonify(status)
