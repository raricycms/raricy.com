from flask import current_app, Blueprint, jsonify, render_template, request
from flask_login import current_user, login_required
from app.extensions import db
from app.models import Notification
from app.service.notifications import (
    get_user_notifications, mark_notification_read, mark_all_notifications_read,
    delete_notification, delete_read_notifications, batch_mark_notifications_read,
    batch_delete_notifications, get_unread_notification_count
)
from datetime import datetime

notifications_bp = Blueprint('notifications', __name__)

@notifications_bp.route('/')
@login_required
def notification_page():
    """通知页面，支持分页和过滤"""
    page = request.args.get('page', 1, type=int)
    unread_only = request.args.get('unread_only', False, type=bool)
    
    result = get_user_notifications(
        user_id=current_user.id,
        page=page,
        per_page=20,
        unread_only=unread_only
    )
    
    return render_template('notification/notifications.html', 
                         data=result['notifications'],
                         pagination=result,
                         unread_only=unread_only)

@notifications_bp.route('/api/unread-count')
@login_required
def api_unread_count():
    """获取未读通知数量的 API"""
    count = get_unread_notification_count(current_user.id)
    return jsonify({'count': count})

@notifications_bp.route('/api/mark-read/<notification_id>', methods=['POST'])
@login_required
def api_mark_read(notification_id):
    """标记单个通知为已读的 API"""
    success = mark_notification_read(notification_id, current_user.id)
    if success:
        return jsonify({'success': True, 'message': '通知已标记为已读'})
    else:
        return jsonify({'success': False, 'message': '标记失败，通知不存在或无权限'}), 404

@notifications_bp.route('/api/mark-all-read', methods=['POST'])
@login_required
def api_mark_all_read():
    """标记所有通知为已读的 API"""
    count = mark_all_notifications_read(current_user.id)
    return jsonify({'success': True, 'count': count, 'message': f'已标记 {count} 个通知为已读'})

@notifications_bp.route('/api/delete/<notification_id>', methods=['DELETE'])
@login_required
def api_delete_notification(notification_id):
    """删除单个通知的 API"""
    success = delete_notification(notification_id, current_user.id)
    if success:
        return jsonify({'success': True, 'message': '通知已删除'})
    else:
        return jsonify({'success': False, 'message': '删除失败，通知不存在或无权限'}), 404

@notifications_bp.route('/api/delete-read', methods=['DELETE'])
@login_required
def api_delete_read_notifications():
    """删除所有已读通知的 API"""
    count = delete_read_notifications(current_user.id)
    return jsonify({'success': True, 'count': count, 'message': f'已删除 {count} 个已读通知'})

@notifications_bp.route('/api/batch-mark-read', methods=['POST'])
@login_required
def api_batch_mark_read():
    """批量标记通知为已读的 API"""
    data = request.get_json()
    if not data or 'notification_ids' not in data:
        return jsonify({'success': False, 'message': '缺少必要的参数'}), 400
    
    notification_ids = data['notification_ids']
    if not isinstance(notification_ids, list):
        return jsonify({'success': False, 'message': '通知ID必须是数组'}), 400
    
    count = batch_mark_notifications_read(notification_ids, current_user.id)
    return jsonify({'success': True, 'count': count, 'message': f'已标记 {count} 个通知为已读'})

@notifications_bp.route('/api/batch-delete', methods=['DELETE'])
@login_required
def api_batch_delete():
    """批量删除通知的 API"""
    data = request.get_json()
    if not data or 'notification_ids' not in data:
        return jsonify({'success': False, 'message': '缺少必要的参数'}), 400
    
    notification_ids = data['notification_ids']
    if not isinstance(notification_ids, list):
        return jsonify({'success': False, 'message': '通知ID必须是数组'}), 400
    
    count = batch_delete_notifications(notification_ids, current_user.id)
    return jsonify({'success': True, 'count': count, 'message': f'已删除 {count} 个通知'})

@notifications_bp.route('/api/list')
@login_required
def api_notification_list():
    """获取通知列表的 API，支持分页和过滤"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    unread_only = request.args.get('unread_only', False, type=bool)
    
    # 限制每页数量，防止过大的请求
    per_page = min(per_page, 100)
    
    result = get_user_notifications(
        user_id=current_user.id,
        page=page,
        per_page=per_page,
        unread_only=unread_only
    )
    
    return jsonify(result)    