from flask import Blueprint, json, render_template, current_app, jsonify, abort, request
from flask_login import current_user
from app.extensions.decorators import authenticated_required
from app.web.clipboard.service import ClipService

clip_bp = Blueprint('clip', __name__)

def validator(data):
    # 检查 'publicity' 键
    if 'publicity' not in data or not isinstance(data['publicity'], bool):
        return False, 'wrong publicity format'
    
    # 检查 'content' 键
    if 'content' not in data or not isinstance(data['content'], str) or len(data['content']) > 30000:
        return False, 'content too long'
    
    # 检查 'title' 键
    if 'title' not in data or not isinstance(data['title'], str) or len(data['title']) > 40 or len(data['title']) < 1:
        return False, 'title too long'
    
    return True, 'success'

@clip_bp.route('/')
@authenticated_required
def menu():
   clip_lst = ClipService.get_clipboard_byuserid(current_user.id)
   return render_template('clipboard/menu.html', clip_lst=clip_lst)

@clip_bp.route('/<clip_id>', methods=['GET'])
@authenticated_required
def detail(clip_id):
    clip = ClipService.get_clipboard_with_content(clip_id=clip_id)
    if not clip:
        abort(404)
    if not clip['publicity'] and clip['author_id'] != current_user.id and not current_user.is_owner:
        abort(403)
    if 'raw' in request.args:
        return jsonify(clip)
    return render_template('clipboard/detail.html', clip=clip)


@clip_bp.route('/upload', methods=['GET'])
@authenticated_required
def upload_page():
    return render_template('clipboard/upload.html')

@clip_bp.route('/upload', methods=['POST'])
@authenticated_required
def upload():
    clip_dict = request.get_json()
    valid, message = validator(clip_dict)
    if not valid:
        return jsonify({'code': 400, "message": message})
    clip_id = ClipService.create_clipboard(clip_dict)
    if not clip_id:
        return jsonify({'code': 400, "message": '一个用户只能发布200篇云剪贴板！'})
    return jsonify({"code": 200, "message": 'success', 'id': clip_id})

@clip_bp.route('/<clip_id>/edit', methods=['GET'])
@authenticated_required
def edit_page(clip_id):
    clip = ClipService.get_clipboard_with_content(clip_id=clip_id)
    if not clip:
        abort(404)
    if clip["author_id"] !=current_user.id:
        abort(403)
    return render_template('clipboard/upload.html', clip=clip)

@clip_bp.route('/<clip_id>/edit', methods=['POST'])
@authenticated_required
def edit(clip_id):
        
    clip = ClipService.get_clipboard(clip_id=clip_id)
    if not clip:
        abort(404)
    if clip["author_id"] !=current_user.id:
        return jsonify({"code": 403, "message": "您不是该文章作者，无法编辑！"})
    clip_dict = request.get_json()
    
    valid, message = validator(clip_dict)
    if not valid:
        return jsonify({'code': 400, "message": message})
    ClipService.update_clipboard(clip_id, clip_dict)
    
    return jsonify({"code": 200, "message": 'success', 'id': clip_id})

@clip_bp.route('/<clip_id>', methods=['DELETE'])
@authenticated_required
def delete(clip_id): 
    clip = ClipService.get_clipboard(clip_id=clip_id)
    if not clip:
        abort(404)
    if clip['author_id'] != current_user.id and not current_user.is_owner:
        abort(403)
    ClipService.delete_clipboard(clip_id=clip_id)
    return jsonify({"code": 200, "message": 'success'})
