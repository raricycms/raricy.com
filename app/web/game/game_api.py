from itsdangerous import URLSafeTimedSerializer
from flask import current_app, request, jsonify
from flask_login import login_required, current_user


def register_game_api(game_bp):
    @game_bp.route('/api/game_token', methods=['POST'])
    @login_required
    def get_game_token():
        serializer = URLSafeTimedSerializer(current_app.config['GAME_SECRET_KEY'])
        user_id = current_user.id
        token = serializer.dumps({'user_id': user_id})
        return jsonify({'token': token, 'expires_in': 60})
