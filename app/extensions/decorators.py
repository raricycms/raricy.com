
from functools import wraps
from flask import jsonify, abort
from flask_login import current_user

def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not getattr(current_user, 'is_authenticated', False) or not getattr(current_user, 'has_admin_rights', False):
            abort(403)
        return f(*args, **kwargs)
    return wrapper

def authenticated_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not getattr(current_user, 'is_authenticated', False) or not getattr(current_user, 'is_core_user', False):
            return jsonify({'code': 403, 'message': '请先验证邀请码！'}), 403
        return f(*args, **kwargs)
    return wrapper