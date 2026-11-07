'use client';

// 纯前端计算，使用 Web Crypto。
import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ArrowRight } from 'lucide-react';
import { errorText } from '@/lib/dev-tools/response-read';

const te = new TextEncoder();
const td = new TextDecoder();

/** 加解密失败时的兜底提示（原始错误没有 message 时，给用户一句能照着改的说明）。 */
const FAIL_HINT = '操作失败，请检查密钥、IV 与密文格式';

function hexToBytes(hex: string): Uint8Array {
  const cleaned = (hex || '').trim().replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(cleaned)) throw new Error('包含非法十六进制字符');
  if (cleaned.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  return out;
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}
function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKeyBytes(keyStr: string, keyType: string, keyLenBits: number): Promise<Uint8Array> {
  const lenBytes = keyLenBits / 8;
  if (keyType === 'hex') {
    const kb = hexToBytes(keyStr);
    if (kb.length !== lenBytes) throw new Error(`十六进制密钥长度必须为 ${lenBytes} 字节`);
    return kb;
  }
  const raw = te.encode(keyStr || '');
  // 使用 SHA-256 对文本密钥做哈希，截取所需长度，保证加/解密一致
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const full = new Uint8Array(digest);
  return full.slice(0, lenBytes);
}

export default function AesToolPage() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [mode, setMode] = useState('GCM');
  const [keyLen, setKeyLen] = useState('128');
  const [key, setKey] = useState('');
  const [keyType, setKeyType] = useState('text');
  const [iv, setIv] = useState('');
  const [ivAuto, setIvAuto] = useState(true);
  const [outFormat, setOutFormat] = useState('hex');
  const [status, setStatus] = useState('');
  // R3-487 / D 桶：手填 GCM Nonce 时记录上一次用过的值 —— 同一 Nonce 加密两次在
  // GCM 下是**致命**错误（泄露密钥流），必须阻止而不是默默复用。
  const [lastManualIv, setLastManualIv] = useState('');

  const invalidate = () => {
    setRight('');
    setStatus('');
  };

  function ivLength(m: string): number {
    return m === 'GCM' ? 12 : 16;
  }

  async function getKey(m: string): Promise<CryptoKey> {
    const keyLenBits = parseInt(keyLen, 10);
    const keyBytes = await deriveKeyBytes(key || '', keyType, keyLenBits);
    const algoName = 'AES-' + m;
    return await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: algoName }, false, ['encrypt', 'decrypt']);
  }

  function getIv(m: string): Uint8Array {
    const len = ivLength(m);
    let ivBytes: Uint8Array;
    if (iv && !ivAuto) {
      ivBytes = hexToBytes(iv);
    } else {
      // 每次加密都换新 IV/Nonce；只有用户手填过（ivAuto=false）才复用。
      ivBytes = crypto.getRandomValues(new Uint8Array(len));
      setIv(bytesToHex(ivBytes));
      setIvAuto(true);
    }
    if (ivBytes.length !== len) {
      throw new Error(`${m} 需要 ${len} 字节 ${m === 'GCM' ? 'Nonce' : 'IV/计数器'}`);
    }
    return ivBytes;
  }

  function encodeOut(bytes: Uint8Array): string {
    return outFormat === 'hex' ? bytesToHex(bytes) : bytesToBase64(bytes);
  }
  function decodeIn(str: string): Uint8Array {
    return outFormat === 'hex' ? hexToBytes(str) : base64ToBytes(str);
  }

  async function encrypt() {
    try {
      // D 桶 R3-487：空密钥不得静默用 `SHA-256('')` 派生固定密钥 —— 用户会以为已加密。
      if ((key || '').trim() === '') {
        setRight('');
        setStatus('失败: 请先填写密钥');
        return;
      }
      const m = mode;
      const manualIv = !ivAuto && iv.trim() !== '';
      if (m === 'GCM' && manualIv) {
        if (iv.trim().toLowerCase() === lastManualIv) {
          setStatus(
            '已阻止：GCM 下同一个 Nonce 不能复用（同一 Nonce 加密两次会泄露密钥流）；请换一个 Nonce，或切回自动生成'
          );
          return;
        }
      }
      const cryptoKey = await getKey(m);
      const ivBytes = getIv(m);
      const data = te.encode(left || '');
      let result: ArrayBuffer;
      if (m === 'GCM') {
        result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes as BufferSource }, cryptoKey, data);
      } else if (m === 'CBC') {
        // WebCrypto 的 AES-CBC 自己会补 PKCS#7；这里再手工补一层会让密文多一整块。
        result = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ivBytes as BufferSource }, cryptoKey, data);
      } else {
        // CTR 的 counter 是完整的 16 字节分组；12 字节会直接抛 OperationError。
        result = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: ivBytes as BufferSource, length: 64 }, cryptoKey, data);
      }
      const out = new Uint8Array(result);
      const combined = new Uint8Array(ivBytes.length + out.length);
      combined.set(ivBytes, 0);
      combined.set(out, ivBytes.length);
      setRight(encodeOut(combined));
      setLastManualIv(manualIv ? iv.trim().toLowerCase() : '');
      setStatus('完成（输出已包含 IV/Nonce 前缀）');
    } catch (e) {
      setRight('');
      setStatus('失败: ' + errorText(e, FAIL_HINT));
    }
  }

  async function decrypt() {
    try {
      if ((key || '').trim() === '') {
        setStatus('失败: 请先填写密钥');
        return;
      }
      const m = mode;
      const cryptoKey = await getKey(m);
      const input = decodeIn(right || '');
      const ivLen = ivLength(m);
      // D 桶 R3-487：手填 IV/Nonce 时**解密也用它**（以前只按密文前缀切，输入框白填）。
      // 允许两种粘贴形态：带前缀（加密输出原样）或去掉前缀的纯密文。
      let ivBytes: Uint8Array;
      let ciphertext: Uint8Array;
      if (!ivAuto && iv.trim() !== '') {
        ivBytes = hexToBytes(iv);
        if (ivBytes.length !== ivLen) {
          throw new Error(`${m} 需要 ${ivLen} 字节 ${m === 'GCM' ? 'Nonce' : 'IV/计数器'}`);
        }
        const prefix = input.slice(0, ivLen);
        const hasPrefix =
          prefix.length === ivLen && prefix.every((byte, index) => byte === ivBytes[index]);
        ciphertext = hasPrefix ? input.slice(ivLen) : input;
        if (ciphertext.length === 0) throw new Error('密文为空');
      } else {
        // 密文自带 IV/Nonce 前缀（自动模式与加密输出同口径）。
        if (input.length <= ivLen) throw new Error('密文长度不足，或缺少 IV/Nonce 前缀');
        ivBytes = input.slice(0, ivLen);
        ciphertext = input.slice(ivLen);
      }
      let plainBuf: ArrayBuffer;
      if (m === 'GCM') {
        plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes as BufferSource }, cryptoKey, ciphertext as BufferSource);
      } else if (m === 'CBC') {
        // WebCrypto 解密时会自己校验并去掉 PKCS#7，不需要再手工去填充。
        plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes as BufferSource }, cryptoKey, ciphertext as BufferSource);
      } else {
        plainBuf = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ivBytes as BufferSource, length: 64 }, cryptoKey, ciphertext as BufferSource);
      }
      setLeft(td.decode(new Uint8Array(plainBuf)));
      setStatus('完成');
    } catch (e) {
      // 解密失败不要把用户已经输入的明文清掉。
      setStatus('失败: ' + errorText(e, FAIL_HINT));
    }
  }

  const swap = () => {
    const t = left;
    setLeft(right);
    setRight(t);
    setStatus('已交换');
  };
  const copyRight = async () => {
    try {
      await navigator.clipboard.writeText(right || '');
      setStatus('已复制');
    } catch {
      setStatus('复制失败');
    }
  };

  return (
    <section className="py-4 base-tool-page">
      <div className="container">
        <div className="d-flex align-items-center mb-3">
          <Link
            href="/tool"
            className="text-decoration-none me-2"
            aria-label="返回工具箱"
          >
            <ArrowLeft aria-hidden="true" />
          </Link>
          <h1 className="mb-0 tool-new-hero__title">AES 加/解密</h1>
        </div>
        <p className="tool-new-hero__description">
          前端完成 AES-CBC/CTR/GCM 加解密，支持十六进制或文本密钥，IV/Nonce 自定义。
        </p>

        <div className="row g-4 align-items-stretch">
          <div className="col-12 col-lg-5">
            <div className="p-3 rounded tool-panel h-100">
              <label className="form-label fw-semibold">左侧（明文 / 输入）</label>
              <textarea
                className="form-control mono result-area"
                rows={12}
                value={left}
                onChange={(e) => setLeft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    encrypt();
                  }
                }}
                placeholder="输入待加密明文，或在右侧粘贴密文以解密"
              />

              <div className="row g-3 mt-2 tool-options">
                <div className="col-12 col-md-6">
                  <label className="form-label">模式</label>
                  <select
                    className="form-select"
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value);
                      invalidate();
                      if (ivAuto) setIv('');
                    }}
                  >
                    <option value="GCM">GCM</option>
                    <option value="CBC">CBC</option>
                    <option value="CTR">CTR</option>
                  </select>
                </div>
                <div className="col-12 col-md-6">
                  <label className="form-label">密钥长度</label>
                  <select
                    className="form-select"
                    value={keyLen}
                    onChange={(e) => {
                      setKeyLen(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="128">128</option>
                    <option value="192">192</option>
                    <option value="256">256</option>
                  </select>
                </div>
                <div className="col-12 tool-options__wide">
                  <label className="form-label">密钥（文本或十六进制）</label>
                  <input
                    className="form-control mono"
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      invalidate();
                    }}
                    placeholder="示例：secret or 001122... (hex)"
                  />
                </div>
                <div className="col-12 col-md-6">
                  <label className="form-label">密钥类型</label>
                  <select
                    className="form-select"
                    value={keyType}
                    onChange={(e) => {
                      setKeyType(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="text">文本</option>
                    <option value="hex">十六进制</option>
                  </select>
                </div>
                <div className="col-12 col-md-6">
                  <label className="form-label">密文格式（输入 / 输出）</label>
                  <select
                    className="form-select"
                    value={outFormat}
                    onChange={(e) => {
                      setOutFormat(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="hex">Hex</option>
                    <option value="base64">Base64</option>
                  </select>
                </div>
                <div className="col-12 tool-options__wide">
                  <label className="form-label">IV/Nonce（十六进制，加密 / 解密都用）</label>
                  <input
                    className="form-control mono"
                    value={iv}
                    onChange={(e) => {
                      setIv(e.target.value);
                      setIvAuto(false);
                      invalidate();
                    }}
                    placeholder="GCM 12 字节；CBC / CTR 16 字节；留空则自动生成"
                  />
                  <small className="text-muted">
                    加密会使用这里填的值并把 IV 拼在密文前面；解密会用它读取密文（带不带前缀都行）。
                    GCM 下同一个 Nonce 不能复用 —— 复用会被阻止。
                  </small>
                </div>
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-2">
            <div className="mid-actions h-100">
              <div className="d-flex flex-column gap-3 w-100 align-items-center">
                <button className="btn btn-primary" onClick={encrypt}>
                  加密 <ArrowRight aria-hidden="true" />
                </button>
                <button className="btn btn-outline-primary" onClick={decrypt}>
                  <ArrowLeft aria-hidden="true" /> 解密
                </button>
                <button className="btn btn-outline-secondary" onClick={swap}>
                  <ArrowLeftRight aria-hidden="true" /> 交换两侧
                </button>
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-5">
            <div className="p-3 rounded tool-panel h-100 position-relative">
              <label className="form-label fw-semibold">右侧（密文 / 输出）</label>
              <button
                className="btn btn-sm btn-outline-secondary btn-copy"
                onClick={copyRight}
              >
                复制
              </button>
              <textarea
                className="form-control mono result-area"
                rows={12}
                value={right}
                onChange={(e) => setRight(e.target.value)}
                placeholder="密文在此显示或粘贴密文以解密"
              />
              <div className="d-flex justify-content-between mt-2">
                <small className="text-muted">
                  快捷键：<span className="kbd">Ctrl</span> +{' '}
                  <span className="kbd">Enter</span> 加密（左 → 右）
                </small>
                <span className="text-muted numeric">{status}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
