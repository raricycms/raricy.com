import regex as re

def validate_email(email):
    """
    验证邮箱格式的有效性
    正则表达式说明（综合自[[1, 5, 6, 9, 11, 16, 17]]）：
    1. ^[a-zA-Z0-9_.+-]+  本地部分：允许字母/数字/._%+-
    2. @[a-zA-Z0-9-]+    域名部分：字母/数字/中划线
    3. \\.[a-zA-Z0-9-.]+$ 顶级域名：必须包含点号且2位以上字母
    """
    pattern = r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]{2,}$'
    return bool(re.match(pattern, email))

if __name__ == "__main__":
    email = input("请输入邮箱地址: ")
    if validate_email(email):
        print("✅ 邮箱格式正确")
    else:
        print("❌ 邮箱格式错误")