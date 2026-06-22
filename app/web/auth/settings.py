from flask import render_template, request, jsonify, session, url_for
from flask_login import logout_user, login_required, current_user
from app.extensions import db

from . import auth_bp


@auth_bp.route('/settings')
@login_required
def settings():
    """账号设置页面"""
    return render_template('auth/settings.html', user=current_user)


@auth_bp.route('/settings/bio', methods=['POST'])
@login_required
def update_bio():
    """编辑个人简介"""
    data = request.get_json() or {}
    bio = (data.get('bio') or '').strip()

    if len(bio) > 500:
        return jsonify({'code': 400, 'message': '个人简介不能超过 500 字'}), 400

    current_user.bio = bio if bio else None
    db.session.commit()

    return jsonify({
        'code': 200,
        'message': '资料已保存',
        'bio': bio,
    })


@auth_bp.route('/settings/privacy', methods=['POST'])
@login_required
def update_privacy():
    """更新个人主页隐私设置"""
    data = request.get_json() or {}

    if 'show_recent_blogs' in data:
        current_user.show_recent_blogs = bool(data['show_recent_blogs'])
    if 'show_recent_comments' in data:
        current_user.show_recent_comments = bool(data['show_recent_comments'])

    db.session.commit()

    return jsonify({
        'code': 200,
        'message': '隐私设置已保存',
        'show_recent_blogs': current_user.show_recent_blogs,
        'show_recent_comments': current_user.show_recent_comments,
    })


@auth_bp.route('/settings/change-password', methods=['POST'])
@login_required
def change_password():
    """修改密码"""
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
