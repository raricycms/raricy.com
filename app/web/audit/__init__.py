from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required, current_user
from app.service import audit_log as audit_service
from app.extensions.decorators import admin_required
from app.models.audit import AdminActionAppeal


audit_bp = Blueprint('audit', __name__)


@audit_bp.route('/logs')
def public_logs():
    page = request.args.get('page', 1, type=int)
    action = request.args.get('action')
    pagination = audit_service.list_public_logs(page=page, per_page=20, action=action)
    return render_template('auth/admin_action_logs.html', pagination=pagination, action=action)


@audit_bp.route('/logs/<int:log_id>')
def log_detail(log_id: int):
    log = audit_service.get_log(log_id)
    appeals = log.appeals.order_by(AdminActionAppeal.created_at.desc()).all()
    return render_template('auth/admin_action_log_detail.html', log=log, appeals=appeals)


@audit_bp.route('/appeals', methods=['POST'])
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
def decide_appeal(appeal_id: int):
    data = request.get_json(silent=True) or {}
    status = data.get('status')          # accepted / rejected
    decision = data.get('decision')      # 处理说明
    ok, msg, _ = audit_service.decide_appeal(appeal_id=appeal_id, decider_id=current_user.id, status=status, decision_text=decision)
    if ok:
        return jsonify({'code': 200, 'message': msg})
    return jsonify({'code': 400, 'message': msg}), 400


