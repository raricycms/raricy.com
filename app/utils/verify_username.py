import regex as re

def validate_username(username):
    """
    验证用户名格式有效性
    参数:
        username (str): 待验证的用户名字符串
    返回:
        tuple: (是否有效, 错误消息)
    """
    # 长度验证 (3-20字符)
    if len(username) < 3:
        return False, "用户名过短（至少3个字符）"
    if len(username) > 20:
        return False, "用户名过长（最多20个字符）"
    
    # 字符集验证（支持多语言字母+数字+下划线+减号）
    pattern = r'^[\w\p{L}-]+$' if re.search(r'\\p{L}', '\\p{L}') else r'^[a-zA-Z0-9_\u4e00-\u9fa5-]+$'
    
    if not re.fullmatch(pattern, username, re.UNICODE):
        invalid_chars = set(re.findall(r'[^\w\p{L}-]', username, re.UNICODE))
        if invalid_chars:
            return False, f"用户名含非法字符: {', '.join(invalid_chars)}"
    
    # 首尾字符验证（禁止以减号/下划线开头结尾）
    if username.startswith(('-', '_')):
        return False, "用户名不能以 _ 或 - 开头"
    if username.endswith(('-', '_')):
        return False, "用户名不能以 _ 或 - 结尾"
    
    return True, "✅ 用户名格式有效"

if __name__ == "__main__":
    test_cases = [
        "user_name",      # 有效
        "张三-李四",       # 有效（中文+减号）
        "user@name",      # 无效（特殊字符@）
        "a",              # 无效（过短）
        "_invalid_start", # 无效（下划线开头）
        "toolongusernamex12345", # 无效（超长）
        "end_with-",      # 无效（减号结尾）
        "русский-язык"   # 有效（俄语）
    ]
    
    print("用户名验证测试结果:")
    print("-" * 40)
    for uname in test_cases:
        valid, msg = validate_username(uname)
        print(f"{uname:<20} → {msg}")
