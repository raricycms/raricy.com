import io, base64
from flask import Blueprint, render_template, request, session, jsonify
from deepcaptcha import DeepCaptcha

deepcaptcha_bp = Blueprint('deepcaptcha', __name__)

CAPTCHA_KEY = 'deepcaptcha_answer'


@deepcaptcha_bp.route('/deepcaptcha', methods=['GET', 'POST'])
def deepcaptcha_demo():
    if request.method == 'POST':
        user_input = (request.form.get('captcha', '') or '').strip()
        correct = session.get(CAPTCHA_KEY, '')
        session.pop(CAPTCHA_KEY, None)
        if user_input.lower() != correct.lower():
            return jsonify({'success': False, 'message': f'验证码错误，你输入的是 "{user_input}"，正确的是 "{correct}"'})
        return jsonify({'success': True, 'message': '验证码正确'})

    gen = DeepCaptcha(ai_resistance_level=2, width=220, height=70, text_length=4)
    image, text = gen.generate()
    session[CAPTCHA_KEY] = text

    buf = io.BytesIO()
    image.save(buf, format='PNG')
    img_base64 = base64.b64encode(buf.getvalue()).decode()

    return render_template('test/deepcaptcha_demo.html', captcha_b64=img_base64)
