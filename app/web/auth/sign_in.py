from flask import Blueprint, render_template, request, jsonify, url_for, session
from app.models import User
from flask_login import login_user, logout_user, login_required

from . import auth_bp

from urllib.parse import urlparse, urljoin
from flask import request

def is_safe_url(target: str) -> bool:
    if not target:
        return False
    ref = urlparse(request.host_url)
    test = urlparse(urljoin(request.host_url, target))
    return (test.scheme in ("http", "https")) and (ref.netloc == test.netloc)

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user)
            session['session_version'] = int(user.session_version or 0)
            next_url = data.get('next') or request.args.get('next')
            if not next_url or not is_safe_url(next_url):
                next_url = url_for('home.index')
            return jsonify({'code': 200, 'message': '登录成功！', 'redirect_url': next_url}), 200
        else:
            return jsonify({'code': 400, 'message': '用户名或密码错误！'}), 400
    return render_template('auth/login.html')

@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    session.pop('session_version', None)
    return jsonify({'code': 200, 'message': '已成功登出！'}), 200