from flask import current_app
from .AES import aes_encrypt, aes_decrypt
import random

def generate_invite_code():
    secret_key = current_app.config['SECRET_KEY']
    return aes_encrypt(secret_key, str(random.randint(1, 99999))+'invite_code'+str(random.randint(1, 99999)))

def verify_invite_code(code):
    secret_key = current_app.config['SECRET_KEY']
    return True if 'invite_code' in aes_decrypt(secret_key, code) else False

