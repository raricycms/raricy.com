from flask import Blueprint, render_template, request, jsonify, session, url_for
from app.models import User
from flask_login import logout_user, login_required, current_user
from flask import send_from_directory, abort, current_app
from app.extensions import db
import os

from . import auth_bp

@auth_bp.route('/profile/<user_id>')
def profile(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    return render_template('auth/profile.html', user=user)


@auth_bp.route('/avatar/<user_id>')
def get_avatar(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    avatar_dir = os.path.normpath(os.path.join(current_app.instance_path, 'avatars', f'{user.id}.png'))
    if not os.path.exists(avatar_dir):
        abort(404)
    return send_from_directory(
        directory=os.path.dirname(avatar_dir),
        path=os.path.basename(avatar_dir),
        mimetype='image/png'
    )

@auth_bp.route('/notification_settings', methods=['GET', 'POST'])
@login_required
def notification_settings():
    """用户通知设置页面"""
    if request.method == 'GET':
        return render_template('auth/notification_settings.html', user=current_user)
    
    elif request.method == 'POST':
        data = request.get_json()
        
        # 更新通知设置
        current_user.notify_like = data.get('notify_like', True)
        current_user.notify_edit = data.get('notify_edit', True) 
        current_user.notify_delete = data.get('notify_delete', True)
        current_user.notify_admin = data.get('notify_admin', True)
        
        db.session.commit()
        
        return jsonify({'code': 200, 'message': '通知设置已更新'})


@auth_bp.route('/change_password', methods=['POST'])
@login_required
def change_password():
    data = request.get_json() or {}

    current_password = (data.get('current_password') or '').strip()
    new_password = (data.get('new_password') or '').strip()
    confirm_password = (data.get('confirm_password') or '').strip()

    if not current_password or not new_password or not confirm_password:
        return jsonify({'code': 400, 'message': '请填写完整的信息'}), 400

    if not current_user.check_password(current_password):
        return jsonify({'code': 400, 'message': '原密码不正确'}), 400

    if new_password != confirm_password:
        return jsonify({'code': 400, 'message': '两次输入的新密码不一致'}), 400

    if len(new_password) < 8:
        return jsonify({'code': 400, 'message': '新密码长度至少为 8 位'}), 400

    if current_password == new_password:
        return jsonify({'code': 400, 'message': '新密码不能与原密码相同'}), 400

    current_user.set_password(new_password)
    current_user.session_version = int(current_user.session_version or 0) + 1
    db.session.commit()

    logout_user()
    session.pop('session_version', None)

    return jsonify({
        'code': 200,
        'message': '密码修改成功，请使用新密码重新登录。',
        'redirect_url': url_for('auth.login')
    }), 200