import random
import string

def generate_id(length=8):
    # 定义字符集：包含小写字母、大写字母和数字
    charset = string.ascii_lowercase + string.digits
    # 随机选择字符并拼接成字符串
    return ''.join(random.choice(charset) for _ in range(length))

# 示例

