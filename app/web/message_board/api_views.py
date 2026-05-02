from flask import request
from flask_login import login_required, current_user
from app.web.blog.utils.response_utils import success_response, error_response
from app.web.message_board.services.message_service import MessageService
from app.web.message_board.validators.message_validator import MessageValidator


def register_api_views(bp):

    @bp.route('/api/messages', methods=['GET'])
    def list_messages():
        uid = current_user.id if current_user.is_authenticated else None
        tree = MessageService.list_messages(current_user_id=uid)
        return success_response('ok', messages=tree)

    @bp.route('/api/messages', methods=['POST'])
    @login_required
    def create_message():
        data = request.get_json(silent=True) or {}
        ok, msg, validated = MessageValidator.validate_create_data(data)
        if not ok:
            return error_response(msg, 400)

        success, msg_text, result = MessageService.create_message(
            content=validated['content'],
            is_anonymous=validated['is_anonymous'],
            parent_id=validated.get('parent_id'),
        )
        if success:
            return success_response(msg_text, data=result)
        else:
            code = 429 if '频繁' in msg_text else 400
            return error_response(msg_text, code)

    @bp.route('/api/messages/<message_id>', methods=['DELETE'])
    @login_required
    def delete_message(message_id):
        data = request.get_json(silent=True) or {}
        reason = (data.get('reason') or '').strip() or None
        success, msg = MessageService.delete_message(message_id, reason=reason)
        if success:
            return success_response(msg)
        else:
            code = 403 if '无权' in msg else 404 if '不存在' in msg else 400
            return error_response(msg, code)

    @bp.route('/api/messages/<message_id>/like', methods=['POST'])
    @login_required
    def toggle_like(message_id):
        success, msg, liked, likes_count = MessageService.toggle_like(message_id)
        if success:
            return success_response(msg, liked=liked, likes_count=likes_count)
        else:
            return error_response(msg, 404)
