from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required, current_user
from app.service import audit_log as audit_service
from app.extensions.decorators import admin_required, authenticated_required, owner_required
from app.models.audit import AdminActionAppeal


audit_bp = Blueprint('audit', __name__)

@audit_bp.route('/logs')
@authenticated_required
def public_logs():
    page = request.args.get('page', 1, type=int)
    action = request.args.get('action')
    pagination = audit_service.list_public_logs(page=page, per_page=20, action=action)

    log_ids = [log.id for log in pagination.items]

    pending_appeals = AdminActionAppeal.query.filter(
        AdminActionAppeal.log_id.in_(log_ids),
        AdminActionAppeal.status == 'pending'
    ).all()

    # 创建映射：日志ID -> 是否有待处理申诉
    has_pending = {appeal.log_id: True for appeal in pending_appeals}

    return render_template('auth/admin_action_logs.html',
                         pagination=pagination,
                         action=action,
                         has_pending=has_pending)

@audit_bp.route('/logs/<int:log_id>')
@authenticated_required
def log_detail(log_id: int):
    log = audit_service.get_log(log_id)
    appeals = log.appeals.order_by(AdminActionAppeal.created_at.desc()).all()
    return render_template('auth/admin_action_log_detail.html', log=log, appeals=appeals)

@audit_bp.route('/appeals', methods=['POST'])
@authenticated_required
@login_required
def create_appeal():
    data = request.get_json(silent=True) or {}
    log_id = data.get('log_id')
    content = (data.get('content') or '').strip()
    if not log_id or not content:
        return jsonify({'code': 400, 'message': '缺少参数'}), 400
    ok, msg, appeal = audit_service.create_appeal(log_id=int(log_id), appellant_id=current_user.id, content=content)
    if ok:
        return jsonify({'code': 200, 'message': msg, 'appeal_id': appeal.id})
    return jsonify({'code': 400, 'message': msg}), 400


@audit_bp.route('/appeals/<int:appeal_id>/decision', methods=['POST'])
@login_required
@admin_required
@owner_required
def decide_appeal(appeal_id: int):
    data = request.get_json(silent=True) or {}
    status = data.get('status')          # accepted / rejected
    decision = data.get('decision')      # 处理说明
    ok, msg, _ = audit_service.decide_appeal(appeal_id=appeal_id, decider_id=current_user.id, status=status, decision_text=decision)
    if ok:
        return jsonify({'code': 200, 'message': msg})
    return jsonify({'code': 400, 'message': msg}), 400


