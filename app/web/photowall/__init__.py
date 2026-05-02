from flask import Blueprint, render_template, request, jsonify
from flask_login import current_user
from app.extensions.decorators import authenticated_required
from app.web.photowall.service import PhotoWallService

photo_wall_bp = Blueprint('photowall', __name__)


@photo_wall_bp.route('/')
@authenticated_required
def wall():
    return render_template('photowall/wall.html')


@photo_wall_bp.route('/api/items')
@authenticated_required
def api_items():
    items = PhotoWallService.get_all_items()
    return jsonify({'code': 200, 'items': items})


@photo_wall_bp.route('/api/place', methods=['POST'])
@authenticated_required
def api_place():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'code': 400, 'message': '请求数据无效'}), 400

    image_id = data.get('image_id', '').strip()
    if not image_id:
        return jsonify({'code': 400, 'message': '请选择一张图片'}), 400

    x = data.get('x', 2000)
    y = data.get('y', 1500)
    rotation = data.get('rotation', 0.0)
    scale = data.get('scale', 1.0)

    result, err = PhotoWallService.place_image(
        image_id, current_user.id, x, y, rotation, scale,
    )
    if err:
        return jsonify({'code': 400, 'message': err}), 400

    return jsonify({'code': 200, 'message': '已贴到墙上', 'item': result})


@photo_wall_bp.route('/api/upload-and-place', methods=['POST'])
@authenticated_required
def api_upload_and_place():
    f = request.files.get('file')
    if not f:
        return jsonify({'code': 400, 'message': '请选择文件'}), 400

    content = f.read()
    x = float(request.form.get('x', 2000))
    y = float(request.form.get('y', 1500))
    rotation = float(request.form.get('rotation', 0.0))
    scale = float(request.form.get('scale', 1.0))
    compress = request.form.get('compress', '1') == '1'

    result, err = PhotoWallService.upload_and_place(
        content, f.mimetype, f.filename, current_user.id,
        x, y, rotation, scale, compress,
    )
    if err:
        return jsonify({'code': 400, 'message': err}), 400

    return jsonify({'code': 200, 'message': '上传并贴墙成功', 'item': result})


@photo_wall_bp.route('/api/<item_id>', methods=['PATCH'])
@authenticated_required
def api_update(item_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'code': 400, 'message': '请求数据无效'}), 400

    result, err = PhotoWallService.update_item(item_id, current_user.id, **data)
    if err:
        return jsonify({'code': 400, 'message': err}), 400

    return jsonify({'code': 200, 'item': result})


@photo_wall_bp.route('/api/<item_id>', methods=['DELETE'])
@authenticated_required
def api_remove(item_id):
    ok, err = PhotoWallService.remove_item(item_id, current_user.id)
    if not ok:
        return jsonify({'code': 400, 'message': err}), 400
    return jsonify({'code': 200, 'message': '已摘除'})


@photo_wall_bp.route('/api/<item_id>/move-layer', methods=['POST'])
@authenticated_required
def api_move_layer(item_id):
    data = request.get_json(silent=True) or {}
    direction = data.get('direction', 'up')
    if direction not in ('up', 'down'):
        return jsonify({'code': 400, 'message': '无效的方向'}), 400

    result, err = PhotoWallService.move_layer(item_id, direction, current_user.id)
    if err:
        return jsonify({'code': 400, 'message': err}), 400

    return jsonify({'code': 200, 'item': result})


@photo_wall_bp.route('/api/image-list')
@authenticated_required
def api_image_list():
    images = PhotoWallService.get_available_images(current_user.id)
    return jsonify({'code': 200, 'images': images})
