
from functools import wraps
from flask import jsonify, abort
from flask_login import current_user

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_admin:
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

def authenticated_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.authenticated:
            return jsonify({'code': 403, 'message': '请先验证邀请码！'}), 403
        return f(*args, **kwargs)
    return decorated_function
