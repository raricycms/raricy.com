import random
from app.models import InviteCode
from app.extensions import db
from base62 import encode as base62_encode

def generate_invite_code():
    # 生成8字节随机数 (64位)
    raw = random.getrandbits(64)
    # 转换为12字符的base62编码
    code = base62_encode(raw).ljust(12, '0')[:12]
    
    # 存储到数据库
    new_code = InviteCode(code=code)
    db.session.add(new_code)
    db.session.commit()
    return code
    # 验证邀请码

def verify_invite_code(code):
    # 检查长度
    if len(code) != 12:
        return False
    
    # 查询数据库
    record = InviteCode.query.filter_by(code=code).first()
    return record and not record.is_used

def mark_invite_code_used(code, user_id):
    record = InviteCode.query.filter_by(code=code).first()
    if record and not record.is_used:
        record.is_used = True
        record.used_by = user_id
        db.session.commit()
