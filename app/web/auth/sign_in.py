from flask import Blueprint, render_template, request

sign_in_bp = Blueprint('sign_in', __name__)

@sign_in_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        data = request.get_json()
    return render_template('auth/login.html')