import os
from flask import (Blueprint, render_template, request, jsonify,
                   current_app, send_file, abort, url_for)
from flask_login import current_user
from app.extensions.decorators import authenticated_required, owner_required
from app.web.image_hosting.service import ImageService

image_bp = Blueprint('image', __name__)


@image_bp.route('/')
@authenticated_required
def menu():
    quota = ImageService.get_user_quota(current_user)
    images = ImageService.get_user_images(current_user.id)
    return render_template('image_hosting/menu.html',
                           images=images,
                           quota=quota)


@image_bp.route('/upload', methods=['POST'])
@authenticated_required
def upload():
    if 'file[]' in request.files:
        # Vditor upload format
        files = request.files.getlist('file[]')
        succ_map = {}
        err_files = []
        for f in files:
            content = f.read()
            ok, err = ImageService.validate_upload(
                current_user, content, f.mimetype, f.filename)
            if not ok:
                err_files.append(f.filename)
                continue
            compress = request.form.get('compress', '1') == '1'  # Vditor uploads compress by default
            result, err2 = ImageService.upload_image(
                current_user, content, f.mimetype, f.filename, compress=compress)
            if result:
                image_url = url_for('image.serve_image',
                                    image_id=result['id'],
                                    _external=True)
                succ_map[f.filename] = image_url
            else:
                err_files.append(f.filename)
        return jsonify({
            'msg': '',
            'code': 0,
            'data': {
                'errFiles': err_files,
                'succMap': succ_map,
            }
        })
    else:
        # Direct upload (single file, form field "file")
        f = request.files.get('file')
        if not f:
            return jsonify({'code': 400, 'message': '请选择文件'}), 400
        content = f.read()
        ok, err = ImageService.validate_upload(
            current_user, content, f.mimetype, f.filename)
        if not ok:
            return jsonify({'code': 400, 'message': err}), 400
        compress = request.form.get('compress', '0') == '1'
        result, err2 = ImageService.upload_image(
            current_user, content, f.mimetype, f.filename, compress=compress)
        if not result:
            return jsonify({'code': 500, 'message': err2}), 500
        image_url = url_for('image.serve_image',
                            image_id=result['id'],
                            _external=True)
        return jsonify({
            'code': 200,
            'message': '上传成功',
            'image': result,
            'url': image_url,
        })


@image_bp.route('/api/quota')
@authenticated_required
def api_quota():
    quota = ImageService.get_user_quota(current_user)
    return jsonify({'code': 200, 'quota': quota})


@image_bp.route('/<image_id>', methods=['DELETE'])
@authenticated_required
def delete_image(image_id):
    ok, err = ImageService.soft_delete_image(image_id, current_user)
    if not ok:
        return jsonify({'code': 400, 'message': err}), 400
    return jsonify({'code': 200, 'message': '已删除'})


@image_bp.route('/i/<image_id>')
def serve_image(image_id):
    image = ImageService.get_image_by_id(image_id)
    if not image or image.ignore:
        abort(404)

    filepath = image.storage_path
    if not os.path.exists(filepath):
        abort(404)

    # For SVG, serve with Content-Disposition to mitigate XSS
    if image.mime_type == 'image/svg+xml':
        return send_file(filepath, mimetype=image.mime_type,
                         as_attachment=True,
                         download_name=image.filename)
    return send_file(filepath, mimetype=image.mime_type)


# --- Admin routes (owner only) ---

@image_bp.route('/admin')
@owner_required
def admin():
    page = request.args.get('page', 1, type=int)
    search = request.args.get('search', '').strip() or None
    data = ImageService.get_all_images(page=page, search=search)
    total_bytes = ImageService.get_total_storage_bytes()
    return render_template('image_hosting/admin.html',
                           images=data['images'],
                           total=data['total'],
                           pages=data['pages'],
                           page=data['page'],
                           search=search,
                           total_mb=round(total_bytes / (1024 * 1024), 2))


@image_bp.route('/admin/<image_id>', methods=['DELETE'])
@owner_required
def admin_delete_image(image_id):
    ok, err = ImageService.hard_delete_image(image_id)
    if not ok:
        return jsonify({'code': 400, 'message': err}), 400
    return jsonify({'code': 200, 'message': '已永久删除'})
