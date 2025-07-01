from flask import Blueprint, render_template, request
from app.models import User
from app.utils.invite_code import verify_invite_code
from app.utils.verify_username import validate_username
from app.extensions import db
from flask import jsonify
from app.utils.verify_email import validate_email
sign_up_bp = Blueprint('sign_up', __name__)

@sign_up_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        data = request.get_json()
        if not data or not data.get('username') or not data.get('password') or not data.get('email') or not data.get('invite_code'):
            return jsonify({'code': 400, 'message': '缺少参数'}), 400

        if not verify_invite_code(data['invite_code']):
            return jsonify({'code': 400, 'message': '邀请码错误'}), 400

        if User.query.filter_by(username=data['username']).first():
            return jsonify({'code': 400, 'message': '用户名已存在'}), 400

        if_username_valid, username_error = validate_username(data['username'])
        if not if_username_valid:
            return jsonify({'code': 400, 'message': f'{username_error}'}), 400

        if User.query.filter_by(email=data['email']).first():
            return jsonify({'code': 400, 'message': '邮箱已存在'}), 400

        if not validate_email(data['email']):
            return jsonify({'code': 400, 'message': '邮箱格式不正确'}), 400
        
        if len(data['password']) > 100:
            return jsonify({'code': 400, 'message': '密码过长！'}), 400

        if len(data['email']) > 100:
            return jsonify({'code': 400, 'message': '邮箱过长!'}), 400

        user = User(username=data['username'], email=data['email'])
        user.set_password(data['password'])
        db.session.add(user)
        db.session.commit()
        return jsonify({'code': 200, 'message': '注册成功'}), 200
    return render_template('auth/register.html')