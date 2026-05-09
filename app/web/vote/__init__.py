from flask import Blueprint, render_template, request, jsonify, abort
from flask_login import current_user
from app.extensions.decorators import authenticated_required
from app.web.vote.service import VoteService

vote_bp = Blueprint('vote', __name__)


def validator(data):
    if 'title' not in data or not isinstance(data['title'], str) or len(data['title']) > 200 or len(data['title']) < 1:
        return False, '标题长度必须在1-200字符之间'
    if 'options' not in data or not isinstance(data['options'], list):
        return False, '请提供选项列表'
    if len(data['options']) < 2 or len(data['options']) > 10:
        return False, '选项数量必须在2-10个之间'
    for opt in data['options']:
        if not isinstance(opt, str) or len(opt) > 200 or len(opt) < 1:
            return False, '每个选项长度必须在1-200字符之间'
    return True, 'success'


@vote_bp.route('/')
@authenticated_required
def menu():
    vote_lst = VoteService.list_user_votes(current_user.id)
    return render_template('vote/menu.html', vote_lst=vote_lst)


@vote_bp.route('/create', methods=['GET'])
@authenticated_required
def create_page():
    return render_template('vote/create.html')


@vote_bp.route('/create', methods=['POST'])
@authenticated_required
def create_api():
    data = request.get_json(silent=True) or {}
    valid, message = validator(data)
    if not valid:
        return jsonify({'code': 400, 'message': message}), 400
    vote_id, error = VoteService.create_vote(current_user.id, data['title'], data['options'])
    if error:
        return jsonify({'code': 400, 'message': error}), 400
    return jsonify({'code': 200, 'message': 'success', 'data': {'id': vote_id}})


@vote_bp.route('/<vote_id>', methods=['GET'])
@authenticated_required
def detail(vote_id):
    if 'raw' in request.args:
        data = VoteService.get_vote_api(vote_id, current_user.id)
        if not data:
            abort(404)
        return jsonify({'code': 200, 'data': data})
    vote = VoteService.get_vote(vote_id, current_user.id)
    if not vote:
        abort(404)
    return render_template('vote/detail.html', vote=vote)


@vote_bp.route('/<vote_id>/cast', methods=['POST'])
@authenticated_required
def cast_vote(vote_id):
    data = request.get_json(silent=True) or {}
    option_id = data.get('option_id')
    if not option_id:
        return jsonify({'code': 400, 'message': '请选择一个选项'}), 400
    ok, error = VoteService.cast_vote(vote_id, int(option_id), current_user.id)
    if not ok:
        return jsonify({'code': 400, 'message': error}), 400
    return jsonify({'code': 200, 'message': '投票成功'})


@vote_bp.route('/<vote_id>/lock', methods=['POST'])
@authenticated_required
def lock_vote(vote_id):
    ok, error = VoteService.lock_vote(vote_id, current_user.id)
    if not ok:
        return jsonify({'code': 403, 'message': error}), 403
    return jsonify({'code': 200, 'message': '已锁定'})


@vote_bp.route('/<vote_id>/unlock', methods=['POST'])
@authenticated_required
def unlock_vote(vote_id):
    ok, error = VoteService.unlock_vote(vote_id, current_user.id)
    if not ok:
        return jsonify({'code': 403, 'message': error}), 403
    return jsonify({'code': 200, 'message': '已解锁'})


@vote_bp.route('/<vote_id>', methods=['DELETE'])
@authenticated_required
def delete_vote(vote_id):
    ok, error = VoteService.delete_vote(vote_id, current_user.id)
    if not ok:
        return jsonify({'code': 403, 'message': error}), 403
    return jsonify({'code': 200, 'message': '已删除'})
