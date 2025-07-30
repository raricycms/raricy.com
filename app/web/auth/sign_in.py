from flask import Blueprint, render_template, request, jsonify
from app.models import User
from flask_login import login_user, logout_user, login_required

from . import auth_bp

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user)
            return jsonify({'code': 200, 'message': '登录成功！'}), 200
        else:
            return jsonify({'code': 400, 'message': '用户名或密码错误！'}), 400
    return render_template('auth/login.html')

@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return jsonify({'code': 200, 'message': '已成功登出！'}), 200