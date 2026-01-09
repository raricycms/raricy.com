from datetime import datetime
from typing import Optional, Tuple
from app.extensions import db
from app.models.audit import AdminActionLog, AdminActionAppeal
from app.models import User
from app.service.notifications import send_notification


def log_admin_action(
    *,
    action: str,
    admin_id: str,
    target_user_id: Optional[str] = None,
    object_type: Optional[str] = None,
    object_id: Optional[str] = None,
    reason: Optional[str] = None,
    metadata: Optional[dict] = None,
    visibility: str = 'public'
) -> AdminActionLog:
    """
    记录管理员操作日志。
    """
    log = AdminActionLog(
        action=action,
        admin_id=admin_id,
        target_user_id=target_user_id,
        object_type=object_type,
        object_id=object_id,
        reason=reason,
        extra=metadata or {},
        visibility=visibility
    )
    db.session.add(log)
    db.session.commit()
    return log


def list_public_logs(page: int = 1, per_page: int = 20, action: Optional[str] = None):
    """
    公示日志分页列表（仅 public）。
    """
    query = AdminActionLog.query.filter_by(visibility='public').order_by(AdminActionLog.created_at.desc())
    if action:
        query = query.filter_by(action=action)
    return query.paginate(page=page, per_page=per_page, error_out=False)


def get_log(log_id: int) -> AdminActionLog:
    return AdminActionLog.query.get_or_404(log_id)


def create_appeal(*, log_id: int, appellant_id: str, content: str) -> Tuple[bool, str, Optional[AdminActionAppeal]]:
    """
    提交申诉：同一用户对同一日志仅允许1条待处理。
    """
    content = (content or '').strip()
    if not content:
        return False, '申诉内容不能为空', None
    if len(content) > 2000:
        return False, '申诉内容过长（最多2000字）', None

    # 若该操作已有通过的申诉，禁止再次申诉
    accepted_exists = AdminActionAppeal.query.filter_by(
        log_id=log_id, status='accepted'
    ).first()
    if accepted_exists:
        return False, '该操作申诉已被通过，无法再次申诉', None

    # 当日频控：一个用户每天最多申诉 20 次（含任意操作）
    start_of_day = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    today_count = AdminActionAppeal.query.filter(
        AdminActionAppeal.appellant_id == appellant_id,
        AdminActionAppeal.created_at >= start_of_day
    ).count()
    if today_count >= 20:
        return False, '今日申诉次数已达上限（20次）', None

    exists_pending = AdminActionAppeal.query.filter_by(
        log_id=log_id, appellant_id=appellant_id, status='pending'
    ).first()
    if exists_pending:
        return False, '该日志已存在你提交的待处理申诉', None

    appeal = AdminActionAppeal(
        log_id=log_id,
        appellant_id=appellant_id,
        content=content,
        status='pending'
    )
    db.session.add(appeal)
    db.session.commit()

    # 通知管理员/站长
    admins = User.query.filter(User.role.in_(['owner'])).all()
    for admin in admins:
        try:
            send_notification(
                recipient_id=admin.id,
                action='申诉提交',
                actor_id=appellant_id,
                object_type='admin_action_log',
                object_id=str(log_id),
                detail='有新的操作日志申诉等待处理'
            )
        except Exception:
            pass

    return True, '申诉已提交', appeal


def decide_appeal(*, appeal_id: int, decider_id: str, status: str, decision_text: Optional[str] = None) -> Tuple[bool, str, Optional[AdminActionAppeal]]:
    """
    审核申诉：accepted/rejected。
    """
    appeal = AdminActionAppeal.query.get_or_404(appeal_id)
    if appeal.status != 'pending':
        return False, '申诉已处理', None
    if status not in ('accepted', 'rejected'):
        return False, '无效处理结果', None

    appeal.status = status
    appeal.decision = decision_text or ''
    appeal.decided_by = decider_id
    appeal.decided_at = datetime.now()
    db.session.commit()

    # 若申诉通过，自动撤回原动作（尽力而为）
    if status == 'accepted':
        try:
            log = appeal.log
            if not log:
                raise Exception('日志不存在')
            # 撤销禁言：解禁
            if log.action == 'ban_user' and log.target_user_id:
                user = User.query.get(log.target_user_id)
                if user and user.is_currently_banned():
                    user.lift_ban(admin_id=decider_id)
            # 恢复文章：ignore=False
            elif log.action == 'delete_blog' and log.object_type == 'blog' and log.object_id:
                from app.models import Blog
                blog = Blog.query.get(log.object_id)
                if blog and getattr(blog, 'ignore', False):
                    blog.ignore = False
                    db.session.commit()
            # 恢复评论：is_deleted=False 并回补计数
            elif log.action == 'delete_comment' and log.object_type == 'comment' and log.object_id:
                from app.models import Blog, BlogComment
                comment = BlogComment.query.get(log.object_id)
                if comment and getattr(comment, 'is_deleted', False):
                    comment.is_deleted = False
                    blog = Blog.query.get(comment.blog_id)
                    if blog:
                        blog.comments_count = (blog.comments_count or 0) + 1
                    db.session.commit()
        except Exception:
            # 撤回失败不影响申诉结果，但可在 decision 附注
            pass

    # 通知申诉人
    try:
        send_notification(
            recipient_id=appeal.appellant_id,
            action='申诉结果',
            actor_id=decider_id,
            object_type='admin_action_appeal',
            object_id=str(appeal.id),
            detail=('申诉通过' if status == 'accepted' else '申诉驳回') + (f'：{appeal.decision}' if appeal.decision else '')
        )
    except Exception:
        pass
    return True, '处理完成', appeal


