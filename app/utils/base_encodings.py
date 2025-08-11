from __future__ import annotations

import base64
from typing import ByteString


class EncodingError(Exception):
    pass


def hex_to_bytes(hex_str: str) -> bytes:
    try:
        # Remove common prefixes/spaces
        cleaned = hex_str.strip().lower().replace('0x', '').replace(' ', '').replace('\n', '')
        return bytes.fromhex(cleaned)
    except Exception as exc:  # noqa: BLE001
        raise EncodingError(f"非法十六进制输入: {exc}") from exc


def _to_bytes(data: ByteString | str) -> bytes:
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, str):
        return data.encode('utf-8')
    raise EncodingError("不支持的输入类型")


def encode(algo: str, raw: ByteString | str) -> str:
    data = _to_bytes(raw)
    a = (algo or '').lower()

    if a in {"base16", "hex"}:
        return data.hex()
    if a == "base32":
        return base64.b32encode(data).decode('ascii')
    if a == "base36":
        # Base36 encode: treat as big-int
        if len(data) == 0:
            return ""
        num = int.from_bytes(data, 'big', signed=False)
        alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
        if num == 0:
            return '0'
        out = []
        while num:
            num, r = divmod(num, 36)
            out.append(alphabet[r])
        return ''.join(reversed(out))
    if a == "base58":
        alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        return _base_n_encode(data, 58, alphabet)
    if a == "base62":
        alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        return _base_n_encode(data, 62, alphabet)
    if a == "base64":
        return base64.b64encode(data).decode('ascii')
    if a == "base85":
        return base64.b85encode(data).decode('ascii')
    if a == "base91":
        # Minimal base91 implementation via python-base91 if available
        try:
            import base91  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise EncodingError("缺少 base91 库，请安装 python-base91") from exc
        return base91.encode(data)
    if a == "base92":
        try:
            import base92  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise EncodingError("缺少 base92 库，请安装 base92") from exc
        return base92.encode(data)

    raise EncodingError(f"不支持的编码算法: {algo}")


def decode(algo: str, text: str) -> bytes:
    a = (algo or '').lower()
    t = (text or '').strip()

    if a in {"base16", "hex"}:
        return hex_to_bytes(t)
    if a == "base32":
        try:
            return base64.b32decode(t, casefold=True)
        except Exception as exc:  # noqa: BLE001
            raise EncodingError(f"Base32 解码失败: {exc}") from exc
    if a == "base36":
        try:
            num = int(t, 36)
            # Convert big-int to minimal bytes
            if num == 0:
                return b"\x00"
            length = (num.bit_length() + 7) // 8
            return num.to_bytes(length, 'big')
        except Exception as exc:  # noqa: BLE001
            raise EncodingError(f"Base36 解码失败: {exc}") from exc
    if a == "base58":
        alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        return _base_n_decode(t, 58, alphabet)
    if a == "base62":
        alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        return _base_n_decode(t, 62, alphabet)
    if a == "base64":
        try:
            return base64.b64decode(t, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise EncodingError(f"Base64 解码失败: {exc}") from exc
    if a == "base85":
        try:
            return base64.b85decode(t)
        except Exception as exc:  # noqa: BLE001
            raise EncodingError(f"Base85 解码失败: {exc}") from exc
    if a == "base91":
        try:
            import base91  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise EncodingError("缺少 base91 库，请安装 python-base91") from exc
        try:
            return base91.decode(t)
        except Exception as exc:  # noqa: BLE001
            raise EncodingError(f"Base91 解码失败: {exc}") from exc
    if a == "base92":
        try:
            import base92  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise EncodingError("缺少 base92 库，请安装 base92") from exc
        try:
            return base92.decode(t)
        except Exception as exc:  # noqa: BLE001
            raise EncodingError(f"Base92 解码失败: {exc}") from exc

    raise EncodingError(f"不支持的解码算法: {algo}")


def _base_n_encode(data: bytes, base: int, alphabet: str) -> str:
    if len(alphabet) != base:
        raise EncodingError("alphabet 与 base 不匹配")
    if len(data) == 0:
        return ""
    # Count leading zeros for bases like base58
    leading_zeros = len(data) - len(data.lstrip(b"\x00"))
    num = int.from_bytes(data, 'big')
    out = []
    while num:
        num, r = divmod(num, base)
        out.append(alphabet[r])
    encoded = ''.join(reversed(out))
    return (alphabet[0] * leading_zeros) + encoded


def _base_n_decode(text: str, base: int, alphabet: str) -> bytes:
    if len(alphabet) != base:
        raise EncodingError("alphabet 与 base 不匹配")
    if text == "":
        return b""
    # Count leading first-char -> leading zero bytes
    leading = 0
    for ch in text:
        if ch == alphabet[0]:
            leading += 1
        else:
            break
    num = 0
    for ch in text:
        try:
            num = num * base + alphabet.index(ch)
        except ValueError as exc:  # noqa: BLE001
            raise EncodingError(f"非法字符: {ch}") from exc
    # Convert big-int to bytes
    if num == 0:
        return b"\x00" * leading
    length = (num.bit_length() + 7) // 8
    body = num.to_bytes(length, 'big')
    return (b"\x00" * leading) + body


