from cryptography.fernet import Fernet
import base64
import hashlib

def aes_encrypt(key, plaintext):
    """
    AES加密函数
    
    Args:
        key (str): 密钥字符串
        plaintext (str): 待加密的明文
    
    Returns:
        str: 加密后的密文（base64编码）
    """
    # 将密钥转换为Fernet所需的格式
    key_bytes = hashlib.sha256(key.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(key_bytes)
    
    # 创建Fernet对象
    fernet = Fernet(fernet_key)
    
    # 加密
    encrypted = fernet.encrypt(plaintext.encode('utf-8'))
    return encrypted.decode('utf-8')

def aes_decrypt(key, ciphertext):
    """
    AES解密函数
    
    Args:
        key (str): 密钥字符串
        ciphertext (str): 待解密的密文
    
    Returns:
        str: 解密后的明文
    """
    try:
        # 将密钥转换为Fernet所需的格式
        key_bytes = hashlib.sha256(key.encode()).digest()
        fernet_key = base64.urlsafe_b64encode(key_bytes)
        
        # 创建Fernet对象
        fernet = Fernet(fernet_key)
        
        # 解密
        decrypted = fernet.decrypt(ciphertext.encode('utf-8'))
        return decrypted.decode('utf-8')
    except Exception as e:
        return f"解密失败: {str(e)}"