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
        if not data or not data.get('username') or not data.get('password') or not data.get('email'):
            return jsonify({'code': 400, 'message': '缺少必要参数'}), 400

        # 邀请码变为可选项
        invite_code = data.get('invite_code', '')
        is_authenticated = False
        
        # 如果提供了邀请码，则验证
        if invite_code:
            if not verify_invite_code(invite_code):
                return jsonify({'code': 400, 'message': '邀请码错误'}), 400
            is_authenticated = True

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
        user.authenticated = is_authenticated
        db.session.add(user)
        db.session.commit()
        
        success_message = '注册成功'
        if is_authenticated:
            success_message += '，您的账号已通过邀请码验证'
        
        return jsonify({'code': 200, 'message': success_message}), 200
    return render_template('auth/register.html')