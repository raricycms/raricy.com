from flask import Blueprint, render_template, request, jsonify
from app.models import User, InviteCode
from flask_login import login_required, current_user
from app.extensions.decorators import admin_required
from app.extensions import db
from app.service.notifications import (
    admin_send_notification_to_user, admin_send_notification_to_all, 
    admin_get_notification_templates
)
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


@auth_bp.route('/delete_user', methods=['POST'])
@login_required
@admin_required
def delete_user():
    """
    删除用户。
    """
    data = request.get_json()
    user_id = data.get('user_id')
    password = data.get('password')

    if not user_id or not password:
        return jsonify({'code': 400, 'message': '缺少必要参数'}), 400

    if not current_user.check_password(password):
        return jsonify({'code': 403, 'message': '管理员密码不正确'}), 403

    user_to_delete = User.query.get(user_id)
    if not user_to_delete:
        return jsonify({'code': 404, 'message': '用户不存在'}), 404

    if user_to_delete.id == current_user.id:
        return jsonify({'code': 403, 'message': '不能删除自己'}), 403

    if user_to_delete.is_admin:
        return jsonify({'code': 403, 'message': '不能删除其他管理员'}), 403

    if user_to_delete.blogs:
        return jsonify({'code': 400, 'message': '无法删除拥有博客的用户。请先删除或转移该用户的博客。'}), 400

    InviteCode.query.filter_by(used_by=user_to_delete.id).update({'used_by': None})

    db.session.delete(user_to_delete)
    db.session.commit()

    return jsonify({'code': 200, 'message': '用户删除成功'}), 200

@auth_bp.route('/admin_notifications')
@login_required
@admin_required
def admin_notifications():
    """管理员通知发送页面"""
    user_list = User.query.filter(User.id != current_user.id).all()
    templates = admin_get_notification_templates()
    return render_template('auth/admin_notifications.html', 
                         user_list=user_list, 
                         templates=templates)

@auth_bp.route('/send_notification_to_user', methods=['POST'])
@login_required
@admin_required
def send_notification_to_user():
    """向指定用户发送通知"""
    data = request.get_json()
    
    required_fields = ['recipient_id', 'action', 'detail']
    if not all(field in data for field in required_fields):
        return jsonify({'success': False, 'message': '缺少必要参数'}), 400
    
    result = admin_send_notification_to_user(
        admin_id=current_user.id,
        recipient_id=data['recipient_id'],
        action=data['action'],
        detail=data['detail'],
        object_type=data.get('object_type'),
        object_id=data.get('object_id')
    )
    
    if result['success']:
        return jsonify(result), 200
    else:
        return jsonify(result), 400

@auth_bp.route('/send_notification_to_all', methods=['POST'])
@login_required
@admin_required
def send_notification_to_all():
    """向所有用户或特定用户组发送通知"""
    data = request.get_json()
    
    required_fields = ['action', 'detail', 'target_group']
    if not all(field in data for field in required_fields):
        return jsonify({'success': False, 'message': '缺少必要参数'}), 400
    
    result = admin_send_notification_to_all(
        admin_id=current_user.id,
        action=data['action'],
        detail=data['detail'],
        target_group=data['target_group'],
        object_type=data.get('object_type'),
        object_id=data.get('object_id')
    )
    
    if result['success']:
        return jsonify(result), 200
    else:
        return jsonify(result), 400

@auth_bp.route('/send_notification_modal/<user_id>')
@login_required
@admin_required
def send_notification_modal(user_id):
    """获取向指定用户发送通知的模态框内容"""
    user = User.query.get_or_404(user_id)
    templates = admin_get_notification_templates()
    return jsonify({
        'user': user.to_dict(),
        'templates': templates
    })
