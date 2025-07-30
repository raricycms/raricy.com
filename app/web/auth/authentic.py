from flask import request, jsonify, render_template, Blueprint
from app.extensions import db
from flask_login import login_required, current_user
from app.utils.invite_code import verify_invite_code, mark_invite_code_used, generate_invite_code

from . import auth_bp

@auth_bp.route('/authentic', methods=['GET', 'POST'])
@login_required
def authentic():
    if request.method == 'POST':
        data = request.get_json()
        if not data or not data.get("authentic_code"):
            return jsonify({'code': 400, 'message': '缺少必要参数'}), 400
        code = data.get("authentic_code")
        if verify_invite_code(code):
            mark_invite_code_used(code, current_user.id)
            current_user.authenticated = True
            db.session.commit()
            return jsonify({'code': 200, 'message': '验证成功'}), 200
        else:
            return jsonify({'code': 400, 'message': '邀请码无效'}), 400
    return render_template('auth/authentic.html', user=current_user)

