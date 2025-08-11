# todo

from flask import Blueprint, render_template, request, jsonify
from ...utils import base_encodings

tool_bp = Blueprint('tool', __name__)

@tool_bp.route('/')
def menu():
    return render_template('tool/menu.html')


@tool_bp.route('/base')
def base():
    return render_template('tool/base.html')


@tool_bp.route('/api/base', methods=['POST'])
def api_base():
    try:
        data = request.get_json(silent=True) or {}
        algo: str = (data.get('algo') or '').lower()
        action: str = (data.get('action') or 'encode').lower()  # 'encode' | 'decode'
        input_payload: str = data.get('input') or ''
        input_type: str = (data.get('inputType') or 'text').lower()  # 'text' | 'hex'

        if not algo:
            return jsonify({"code": 400, "message": "缺少算法类型 algo"}), 400

        if action not in {"encode", "decode"}:
            return jsonify({"code": 400, "message": "非法 action，必须为 encode 或 decode"}), 400

        if input_type not in {"text", "hex"}:
            return jsonify({"code": 400, "message": "非法 inputType，必须为 text 或 hex"}), 400

        # Convert input to bytes
        try:
            if input_type == 'hex':
                input_bytes = base_encodings.hex_to_bytes(input_payload)
            else:
                input_bytes = input_payload.encode('utf-8')
        except Exception as e:
            return jsonify({"code": 400, "message": f"输入解析失败: {e}"}), 400

        # Dispatch
        try:
            if action == 'encode':
                result = base_encodings.encode(algo, input_bytes)
            else:
                # For decode, the input is considered encoded text, not bytes
                result_bytes = base_encodings.decode(algo, input_payload)
                result = result_bytes.decode('utf-8', errors='replace')
            return jsonify({"code": 200, "data": {"result": result}})
        except base_encodings.EncodingError as ee:
            return jsonify({"code": 400, "message": str(ee)}), 400
        except Exception as e:
            return jsonify({"code": 500, "message": f"内部错误: {e}"}), 500
    except Exception as e:
        return jsonify({"code": 500, "message": f"请求处理失败: {e}"}), 500


@tool_bp.route('/hex')
def hex_page():
    return render_template('tool/hex.html')


@tool_bp.route('/url')
def url_page():
    return render_template('tool/url.html')


@tool_bp.route('/html')
def html_page():
    return render_template('tool/html.html')


@tool_bp.route('/qp')
def qp_page():
    return render_template('tool/qp.html')


@tool_bp.route('/hash')
def hash_page():
    return render_template('tool/hash.html')


@tool_bp.route('/aes')
def aes_page():
    return render_template('tool/aes.html')