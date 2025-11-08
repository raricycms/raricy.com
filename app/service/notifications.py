from app.models import User, Notification
from app.extensions import db
from datetime import datetime, timedelta
from sqlalchemy import and_, or_

def send_notification(recipient_id, action, actor_id=None, object_type=None, object_id=None, detail=None, force=False):
    """
    发送通知。
    
    Args:
        recipient_id: 接收者ID
        action: 通知动作类型
        actor_id: 动作发起者ID
        object_type: 关联对象类型
        object_id: 关联对象ID
        detail: 通知详情
        force: 是否强制发送（忽略用户通知偏好）
    """ 
    recipient = User.query.get(recipient_id)
    if not recipient:
        return
    
    # 检查用户通知偏好（除非强制发送）
    if not force:
        # 根据不同的通知类型检查用户设置
        if action == "文章点赞" and not getattr(recipient, 'notify_like', True):
            return
        elif action == "文章编辑" and not getattr(recipient, 'notify_edit', True):
            return
        elif action == "文章删除" and not getattr(recipient, 'notify_delete', True):
            return
        elif action in ["系统公告", "维护通知", "功能更新", "用户提醒", "警告通知", "活动通知", "禁言通知", "解除禁言"] and not getattr(recipient, 'notify_admin', True):
            return
    
    notification = Notification(
        recipient_id=recipient_id,
        action=action,
        actor_id=actor_id,
        object_type=object_type,
        object_id=object_id,
        detail=detail
    )

    db.session.add(notification)
    db.session.commit()
    return notification

def get_unread_notification_count(user_id):
    """
    获取未读通知的数量。
    """
    return Notification.query.filter_by(recipient_id=user_id, read=False).count()

def mark_notification_read(notification_id, user_id=None):
    """
    标记单个通知为已读。
    
    Args:
        notification_id: 通知ID
        user_id: 用户ID，用于安全检查，确保只能标记自己的通知
    
    Returns:
        bool: 标记成功返回True，失败返回False
    """
    try:
        query = Notification.query.filter_by(id=notification_id)
        if user_id:
            query = query.filter_by(recipient_id=user_id)
        
        notification = query.first()
        if not notification:
            return False
        
        notification.read = True
        db.session.commit()
        return True
    except Exception as e:
        db.session.rollback()
        return False

def mark_all_notifications_read(user_id):
    """
    标记用户的所有通知为已读。
    
    Args:
        user_id: 用户ID
        
    Returns:
        int: 成功标记的通知数量
    """
    try:
        count = Notification.query.filter_by(
            recipient_id=user_id, 
            read=False
        ).update({'read': True})
        db.session.commit()
        return count
    except Exception as e:
        db.session.rollback()
        return 0

def get_user_notifications(user_id, page=1, per_page=20, unread_only=False):
    """
    获取用户的通知列表，支持分页和过滤。
    
    Args:
        user_id: 用户ID
        page: 页码，从1开始
        per_page: 每页数量
        unread_only: 是否只获取未读通知
        
    Returns:
        dict: 包含通知列表、分页信息的字典
    """
    query = Notification.query.filter_by(recipient_id=user_id)
    
    if unread_only:
        query = query.filter_by(read=False)
    
    query = query.order_by(Notification.timestamp.desc())
    
    pagination = query.paginate(
        page=page, 
        per_page=per_page, 
        error_out=False
    )
    
    return {
        'notifications': [notification.to_dict() for notification in pagination.items],
        'total': pagination.total,
        'page': page,
        'per_page': per_page,
        'pages': pagination.pages,
        'has_prev': pagination.has_prev,
        'has_next': pagination.has_next,
        'prev_num': pagination.prev_num,
        'next_num': pagination.next_num
    }

def delete_notification(notification_id, user_id=None):
    """
    删除单个通知。
    
    Args:
        notification_id: 通知ID
        user_id: 用户ID，用于安全检查
        
    Returns:
        bool: 删除成功返回True，失败返回False
    """
    try:
        query = Notification.query.filter_by(id=notification_id)
        if user_id:
            query = query.filter_by(recipient_id=user_id)
        
        notification = query.first()
        if not notification:
            return False
        
        db.session.delete(notification)
        db.session.commit()
        return True
    except Exception as e:
        db.session.rollback()
        return False

def delete_read_notifications(user_id):
    """
    删除用户的所有已读通知。
    
    Args:
        user_id: 用户ID
        
    Returns:
        int: 成功删除的通知数量
    """
    try:
        notifications = Notification.query.filter_by(
            recipient_id=user_id, 
            read=True
        ).all()
        
        count = len(notifications)
        for notification in notifications:
            db.session.delete(notification)
        
        db.session.commit()
        return count
    except Exception as e:
        db.session.rollback()
        return 0

def cleanup_old_notifications(days_threshold=30):
    """
    清理指定天数之前的已读通知。
    
    Args:
        days_threshold: 天数阈值，默认30天
        
    Returns:
        int: 清理的通知数量
    """
    try:
        threshold_date = datetime.now() - timedelta(days=days_threshold)
        old_notifications = Notification.query.filter(
            and_(
                Notification.read == True,
                Notification.timestamp < threshold_date
            )
        ).all()
        
        count = len(old_notifications)
        for notification in old_notifications:
            db.session.delete(notification)
        
        db.session.commit()
        return count
    except Exception as e:
        db.session.rollback()
        return 0

def batch_mark_notifications_read(notification_ids, user_id=None):
    """
    批量标记通知为已读。
    
    Args:
        notification_ids: 通知ID列表
        user_id: 用户ID，用于安全检查
        
    Returns:
        int: 成功标记的通知数量
    """
    try:
        query = Notification.query.filter(Notification.id.in_(notification_ids))
        if user_id:
            query = query.filter_by(recipient_id=user_id)
        
        count = query.update({'read': True}, synchronize_session=False)
        db.session.commit()
        return count
    except Exception as e:
        db.session.rollback()
        return 0

def batch_delete_notifications(notification_ids, user_id=None):
    """
    批量删除通知。
    
    Args:
        notification_ids: 通知ID列表
        user_id: 用户ID，用于安全检查
        
    Returns:
        int: 成功删除的通知数量
    """
    try:
        query = Notification.query.filter(Notification.id.in_(notification_ids))
        if user_id:
            query = query.filter_by(recipient_id=user_id)
        
        notifications = query.all()
        count = len(notifications)
        
        for notification in notifications:
            db.session.delete(notification)
        
        db.session.commit()
        return count
    except Exception as e:
        db.session.rollback()
        return 0

def admin_send_notification_to_user(admin_id, recipient_id, action, detail=None, object_type=None, object_id=None):
    """
    管理员向指定用户发送通知。
    
    Args:
        admin_id: 管理员用户ID
        recipient_id: 接收通知的用户ID
        action: 通知动作类型
        detail: 通知详情
        object_type: 关联对象类型
        object_id: 关联对象ID
        
    Returns:
        dict: 包含成功状态和消息的字典
    """
    try:
        # 验证管理员权限
        admin = User.query.get(admin_id)
        if not admin or not getattr(admin, 'has_admin_rights', False):
            return {'success': False, 'message': '没有管理员权限'}
        
        # 验证接收者存在
        recipient = User.query.get(recipient_id)
        if not recipient:
            return {'success': False, 'message': '接收者不存在'}
        
        # 发送通知
        notification = send_notification(
            recipient_id=recipient_id,
            action=action,
            actor_id=admin_id,
            object_type=object_type,
            object_id=object_id,
            detail=detail
        )
        
        if notification:
            return {'success': True, 'message': f'通知已发送给 {recipient.username}', 'notification_id': notification.id}
        else:
            return {'success': False, 'message': '发送失败'}
            
    except Exception as e:
        return {'success': False, 'message': f'发送失败: {str(e)}'}

def admin_send_notification_to_all(admin_id, action, detail=None, object_type=None, object_id=None, target_group='all'):
    """
    管理员向所有用户或特定用户组发送通知。
    
    Args:
        admin_id: 管理员用户ID
        action: 通知动作类型
        detail: 通知详情
        object_type: 关联对象类型
        object_id: 关联对象ID
        target_group: 目标用户组 ('all', 'authenticated', 'normal')
        
    Returns:
        dict: 包含成功状态和消息的字典
    """
    try:
        # 验证管理员权限
        admin = User.query.get(admin_id)
        if not admin or not getattr(admin, 'has_admin_rights', False):
            return {'success': False, 'message': '没有管理员权限'}
        
        # 根据目标组选择用户
        if target_group == 'all':
            users = User.query.filter(User.id != admin_id).all()  # 排除管理员自己
        elif target_group == 'authenticated':
            users = User.query.filter(and_(User.role.in_(['core', 'admin', 'owner']), User.id != admin_id)).all()
        elif target_group == 'normal':
            users = User.query.filter(and_(User.role == 'user', User.id != admin_id)).all()
        else:
            return {'success': False, 'message': '无效的目标用户组'}
        
        if not users:
            return {'success': False, 'message': '没有找到符合条件的用户'}
        
        # 批量发送通知
        sent_count = 0
        failed_users = []
        
        for user in users:
            try:
                notification = send_notification(
                    recipient_id=user.id,
                    action=action,
                    actor_id=admin_id,
                    object_type=object_type,
                    object_id=object_id,
                    detail=detail
                )
                if notification:
                    sent_count += 1
                else:
                    failed_users.append(user.username)
            except Exception as e:
                failed_users.append(user.username)
        
        if sent_count > 0:
            message = f'成功发送 {sent_count} 个通知'
            if failed_users:
                message += f'，{len(failed_users)} 个用户发送失败'
            return {'success': True, 'message': message, 'sent_count': sent_count, 'failed_users': failed_users}
        else:
            return {'success': False, 'message': '所有通知发送失败'}
            
    except Exception as e:
        return {'success': False, 'message': f'发送失败: {str(e)}'}

def admin_get_notification_templates():
    """
    获取管理员通知模板列表。
    
    Returns:
        list: 通知模板列表
    """
    templates = [
        {
            'action': '系统公告',
            'description': '重要系统公告通知',
            'placeholder': '请输入公告内容...'
        },
        {
            'action': '维护通知',
            'description': '系统维护相关通知',
            'placeholder': '请输入维护计划详情...'
        },
        {
            'action': '功能更新',
            'description': '新功能上线通知',
            'placeholder': '请描述新功能特性...'
        },
        {
            'action': '用户提醒',
            'description': '一般用户提醒',
            'placeholder': '请输入提醒内容...'
        },
        {
            'action': '警告通知',
            'description': '用户行为警告',
            'placeholder': '请说明警告原因...'
        },
        {
            'action': '活动通知',
            'description': '网站活动相关通知',
            'placeholder': '请输入活动详情...'
        },
        {
            'action': '禁言通知',
            'description': '用户禁言通知',
            'placeholder': '请输入禁言原因...'
        },
        {
            'action': '解除禁言',
            'description': '解除用户禁言通知',
            'placeholder': '解除禁言说明...'
        }
    ]
    return templates

def send_ban_notification(user_id, admin_id, ban_until, reason):
    """
    发送禁言通知。
    
    Args:
        user_id: 被禁言用户ID
        admin_id: 执行禁言的管理员ID
        ban_until: 禁言结束时间
        reason: 禁言原因
    """
    from datetime import datetime
    
    ban_duration = ""
    if ban_until:
        remaining_hours = (ban_until - datetime.now()).total_seconds() / 3600
        if remaining_hours > 24:
            ban_duration = f"约{remaining_hours/24:.1f}天"
        else:
            ban_duration = f"约{remaining_hours:.1f}小时"
    
    detail = f"您已被禁言，禁言时长：{ban_duration}。原因：{reason}"
    
    return send_notification(
        recipient_id=user_id,
        action="禁言通知",
        actor_id=admin_id,
        detail=detail,
        force=True  # 强制发送，忽略用户通知偏好
    )

def send_unban_notification(user_id, admin_id=None, reason=""):
    """
    发送解除禁言通知。
    
    Args:
        user_id: 用户ID
        admin_id: 执行解除的管理员ID（可选）
        reason: 解除原因
    """
    detail = f"您的禁言已被解除。{reason}" if reason else "您的禁言已被解除。"
    
    return send_notification(
        recipient_id=user_id,
        action="解除禁言",
        actor_id=admin_id,
        detail=detail,
        force=True  # 强制发送，忽略用户通知偏好
    )