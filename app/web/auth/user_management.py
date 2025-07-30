from flask import Blueprint, render_template, request, jsonify
from app.models import User
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.extensions import db
from . import auth_bp

@auth_bp.route('/user_management')
@login_required
@admin_required
def user_management():
    user_list = User.query.all()
    return render_template('auth/management.html', user_list=user_list)

@auth_bp.route('/promote', methods=['POST'])
@login_required
@admin_required
def promote():
    data = request.get_json()
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少必要参数'}), 400
    user = User.query.get(user_id)
    if not user:
        return jsonify({'code': 400, 'message': '用户不存在'}), 400
    user.authenticated = True
    db.session.commit()
    return jsonify({'code': 200, 'message': '提升成功'}), 200

@auth_bp.route('/demote', methods=['POST'])
@login_required
@admin_required
def demote():
    data = request.get_json()
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少必要参数'}), 400
    user = User.query.get(user_id)
    if not user:
        return jsonify({'code': 400, 'message': '用户不存在'}), 400
    user.authenticated = False
    db.session.commit()
    return jsonify({'code': 200, 'message': '降级成功'}), 200
