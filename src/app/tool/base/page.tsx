'use client';

import Link from 'next/link';
import { useState } from 'react';

type Algo =
  | 'base16'
  | 'base32'
  | 'base36'
  | 'base58'
  | 'base62'
  | 'base64'
  | 'base85'
  | 'base91'
  | 'base92';

const ALGOS: [Algo, string][] = [
  ['base16', 'Base16'],
  ['base32', 'Base32'],
  ['base36', 'Base36'],
  ['base58', 'Base58'],
  ['base62', 'Base62'],
  ['base64', 'Base64'],
  ['base85', 'Base85'],
  ['base91', 'Base91'],
  ['base92', 'Base92'],
];

const alphabets = {
  base16: '0123456789abcdef',
  base32: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  base36: '0123456789abcdefghijklmnopqrstuvwxyz',
  base58: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  base62: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
};

const te = new TextEncoder();
const td = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function hexToBytes(hex: string): Uint8Array {
  const cleaned = (hex || '')
    .trim()
    .toLowerCase()
    .replace(/^0x/, '')
    .replace(/\s+/g, '');
  if (!/^[0-9a-f]*$/.test(cleaned)) throw new Error('包含非法十六进制字符');
  if (cleaned.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    const byte = parseInt(cleaned.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('包含非法十六进制字符');
    out[i / 2] = byte;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function base64ToBytes(text: string): Uint8Array {
  const bin = atob((text || '').trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase32(bytes: Uint8Array): string {
  const ALPH = alphabets.base32;
  let bits = 0,
    value = 0,
    output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPH[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPH[(value << (5 - bits)) & 31];
  }
  while (output.length % 8 !== 0) output += '=';
  return output;
}
function base32ToBytes(text: string): Uint8Array {
  const clean = (text || '').toUpperCase().replace(/=+$/, '');
  const ALPH = alphabets.base32;
  const map = new Map(Array.from(ALPH).map((c, i) => [c, i]));
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    if (!map.has(ch)) continue;
    value = (value << 5) | (map.get(ch) as number);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
function bigIntToBytes(bi: bigint): Uint8Array {
  if (bi === 0n) return new Uint8Array([]);
  const tmp: number[] = [];
  while (bi > 0n) {
    tmp.push(Number(bi & 0xffn));
    bi >>= 8n;
  }
  return new Uint8Array(tmp.reverse());
}

function baseNEncode(bytes: Uint8Array, alphabet: string): string {
  if (bytes.length === 0) return '';
  const base = BigInt(alphabet.length);
  const zeroByte = alphabet[0];
  let n = bytesToBigInt(bytes);
  let out = '';
  while (n > 0n) {
    const r = n % base;
    n = n / base;
    out = alphabet[Number(r)] + out;
  }
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }
  return zeroByte.repeat(leadingZeros) + out;
}

function baseNDecode(text: string, alphabet: string): Uint8Array {
  if (!text) return new Uint8Array([]);
  const base = BigInt(alphabet.length);
  let leading = 0;
  for (const ch of text) {
    if (ch === alphabet[0]) leading++;
    else break;
  }
  let n = 0n;
  for (const ch of text) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`非法字符: ${ch}`);
    n = n * base + BigInt(idx);
  }
  const body = bigIntToBytes(n);
  const zeros = new Uint8Array(leading);
  return new Uint8Array([...zeros, ...body]);
}

function ascii85Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.slice(i, i + 4);
    const pad = 4 - chunk.length;
    let val = 0;
    for (let j = 0; j < 4; j++) {
      val = (val << 8) | (chunk[j] ?? 0);
    }
    if (val === 0 && pad === 0) {
      out += 'z';
      continue;
    }
    const digits = new Array(5);
    for (let k = 4; k >= 0; k--) {
      digits[k] = (val % 85) + 33;
      val = Math.floor(val / 85);
    }
    const emitLen = 5 - pad;
    for (let k = 0; k < emitLen; k++) out += String.fromCharCode(digits[k]);
  }
  return out;
}
function ascii85Decode(text: string): Uint8Array {
  const cleaned = (text || '').replace(/\s+/g, '').replace(/<~|~>/g, '');
  const out: number[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === 'z') {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const group = cleaned.slice(i, i + 5);
    const pad = 5 - group.length;
    if (group.length < 5) {
      const padded = group + 'u'.repeat(pad);
      let val = 0;
      for (let k = 0; k < 5; k++) {
        const code = padded.charCodeAt(k) - 33;
        if (code < 0 || code > 84) throw new Error('包含非法 Base85 字符');
        val = val * 85 + code;
      }
      const tmp = [
        (val >>> 24) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 8) & 0xff,
        val & 0xff,
      ];
      const emitLen = 4 - pad;
      for (let k = 0; k < emitLen; k++) out.push(tmp[k]);
      break;
    } else {
      let val = 0;
      for (let k = 0; k < 5; k++) {
        const code = group.charCodeAt(k) - 33;
        if (code < 0 || code > 84) throw new Error('包含非法 Base85 字符');
        val = val * 85 + code;
      }
      out.push(
        (val >>> 24) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 8) & 0xff,
        val & 0xff
      );
      i += 5;
    }
  }
  return new Uint8Array(out);
}

// Base91 implementation
const B91_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
const B91_DEC = (() => {
  const arr = new Array(256).fill(-1);
  for (let i = 0; i < B91_ALPHABET.length; i++)
    arr[B91_ALPHABET.charCodeAt(i)] = i;
  return arr;
})();
function base91Encode(bytes: Uint8Array): string {
  let b = 0,
    n = 0,
    out = '';
  for (let i = 0; i < bytes.length; i++) {
    b |= bytes[i] << n;
    n += 8;
    if (n > 13) {
      let v = b & 8191;
      if (v > 88) {
        b >>= 13;
        n -= 13;
      } else {
        v = b & 16383;
        b >>= 14;
        n -= 14;
      }
      out += B91_ALPHABET[v % 91] + B91_ALPHABET[Math.floor(v / 91)];
    }
  }
  if (n) {
    out += B91_ALPHABET[b % 91];
    if (n > 7 || b > 90) out += B91_ALPHABET[Math.floor(b / 91)];
  }
  return out;
}
function base91Decode(text: string): Uint8Array {
  const input = (text || '').replace(/\s+/g, '');
  let v = -1,
    b = 0,
    n = 0;
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = B91_DEC[input.charCodeAt(i)];
    if (c === -1) continue;
    if (v < 0) v = c;
    else {
      v += c * 91;
      b |= v << n;
      n += (v & 8191) > 88 ? 13 : 14;
      do {
        out.push(b & 255);
        b >>= 8;
        n -= 8;
      } while (n > 7);
      v = -1;
    }
  }
  if (v + 1) out.push((b | (v << n)) & 255);
  return new Uint8Array(out);
}

// Base92 implementation (common fixed 92-char alphabet)
const B92_ALPHABET = (() => {
  const arr: string[] = [];
  for (let c = 33; c <= 126; c++) {
    if (c !== 34 && c !== 92) arr.push(String.fromCharCode(c));
  }
  return arr.join('');
})();
const B92_DEC = (() => {
  const arr = new Array(256).fill(-1);
  for (let i = 0; i < B92_ALPHABET.length; i++)
    arr[B92_ALPHABET.charCodeAt(i)] = i;
  return arr;
})();
function base92Encode(bytes: Uint8Array): string {
  let b = 0,
    n = 0,
    out = '';
  for (let i = 0; i < bytes.length; i++) {
    b = (b << 8) | bytes[i];
    n += 8;
    while (n >= 13) {
      n -= 13;
      const v = (b >>> n) & 0x1fff;
      out += B92_ALPHABET[Math.floor(v / 92)] + B92_ALPHABET[v % 92];
    }
  }
  if (n > 0) {
    const v = (b << (13 - n)) & 0x1fff;
    out += B92_ALPHABET[Math.floor(v / 92)] + B92_ALPHABET[v % 92];
  }
  return out;
}
function base92Decode(text: string): Uint8Array {
  const input = (text || '').replace(/\s+/g, '');
  let b = 0,
    n = 0;
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 2) {
    const c1 = B92_DEC[input.charCodeAt(i)];
    const c2 = B92_DEC[input.charCodeAt(i + 1)] ?? -1;
    if (c1 === -1 || c2 === -1) throw new Error('包含非法 Base92 字符');
    const v = c1 * 92 + c2;
    b = (b << 13) | v;
    n += 13;
    while (n >= 8) {
      n -= 8;
      out.push((b >>> n) & 0xff);
    }
  }
  if (n > 0 && input.length % 2 === 1) {
    out.push((b << (8 - n)) & 0xff);
  }
  return new Uint8Array(out);
}

function encodeAlgo(algo: Algo, inputStr: string): string {
  const bytes = te.encode(inputStr);
  switch (algo) {
    case 'base16':
      return bytesToHex(bytes);
    case 'base32':
      return bytesToBase32(bytes);
    case 'base36':
      return baseNEncode(bytes, alphabets.base36);
    case 'base58':
      return baseNEncode(bytes, alphabets.base58);
    case 'base62':
      return baseNEncode(bytes, alphabets.base62);
    case 'base64':
      return bytesToBase64(bytes);
    case 'base85':
      return ascii85Encode(bytes);
    case 'base91':
      return base91Encode(bytes);
    case 'base92':
      return base92Encode(bytes);
    default:
      throw new Error('不支持的算法');
  }
}

function decodeAlgo(algo: Algo, inputStr: string): string {
  switch (algo) {
    case 'base16':
      return td.decode(hexToBytes(inputStr));
    case 'base32':
      return td.decode(base32ToBytes(inputStr));
    case 'base36':
      return td.decode(baseNDecode(inputStr.toLowerCase(), alphabets.base36));
    case 'base58':
      return td.decode(baseNDecode(inputStr, alphabets.base58));
    case 'base62':
      return td.decode(baseNDecode(inputStr, alphabets.base62));
    case 'base64':
      return td.decode(base64ToBytes(inputStr));
    case 'base85':
      return td.decode(ascii85Decode(inputStr));
    case 'base91':
      return td.decode(base91Decode(inputStr));
    case 'base92':
      return td.decode(base92Decode(inputStr));
    default:
      throw new Error('不支持的算法');
  }
}

export default function BaseToolPage() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [algo, setAlgo] = useState<Algo>('base64');
  const [status, setStatus] = useState('');

  const encodeLeftToRight = () => {
    try {
      setRight(encodeAlgo(algo, left || ''));
      setStatus('完成');
    } catch (e) {
      setRight('');
      setStatus((e as Error).message || '出错了');
    }
  };
  const decodeRightToLeft = () => {
    try {
      setLeft(decodeAlgo(algo, right || ''));
      setStatus('完成');
    } catch (e) {
      setLeft('');
      setStatus((e as Error).message || '出错了');
    }
  };
  const copyRight = async () => {
    try {
      await navigator.clipboard.writeText(right || '');
      setStatus('已复制');
    } catch {
      setStatus('复制失败');
    }
  };
  const swap = () => {
    setLeft(right);
    setRight(left);
    setStatus('已交换');
  };

  return (
    <section className="py-4 base-tool-page">
      <div className="container">
        <div className="d-flex align-items-center mb-3" style={{ gap: '.5rem' }}>
          <Link
            href="/tool"
            className="text-decoration-none"
            style={{ color: 'var(--color-text-secondary)', display: 'inline-flex' }}
          >
            <span
              className="icon icon-arrow-left"
              style={{ width: '1.25rem', height: '1.25rem' }}
            ></span>
          </Link>
          <h1 className="mb-0 tool-new-hero__title">Base 编码 / 解码</h1>
        </div>
        <p className="tool-new-hero__description mb-4">
          覆盖 Base16/32/36/58/62/64/85/91/92 的通用在线编解码工具。
        </p>

        <div className="mb-3">
          <label className="form-label fw-semibold">算法</label>
          <div className="algo-grid d-flex flex-wrap gap-2">
            {ALGOS.map(([key, label]) => {
              const isActive = algo === key;
              return (
                <span
                  key={key}
                  className={`badge rounded-pill algo-badge${
                    isActive ? ' active' : ' bg-light text-dark'
                  }`}
                  data-algo={key}
                  aria-pressed={isActive ? 'true' : 'false'}
                  onClick={() => setAlgo(key)}
                >
                  {label}
                </span>
              );
            })}
          </div>
        </div>

        <div className="row g-4 align-items-stretch">
          <div className="col-12 col-lg-5">
            <div className="p-3 rounded tool-panel h-100">
              <label className="form-label fw-semibold">左侧（原文/明文）</label>
              <textarea
                className="form-control mono result-area"
                rows={12}
                value={left}
                onChange={(e) => setLeft(e.target.value)}
                onDragEnter={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const text = e.dataTransfer.getData('text');
                  if (text) setLeft(text);
                }}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    encodeLeftToRight();
                  }
                }}
                placeholder="原文在此输入。编码时 → 右侧，解码结果将从右侧 → 左侧"
              />
            </div>
          </div>

          <div className="col-12 col-lg-2">
            <div className="mid-actions h-100">
              <div className="d-flex flex-column gap-3 w-100 align-items-center">
                <button className="btn btn-primary" onClick={encodeLeftToRight}>
                  编码 →
                </button>
                <button
                  className="btn btn-outline-primary"
                  onClick={decodeRightToLeft}
                >
                  ← 解码
                </button>
                <button className="btn btn-outline-secondary" onClick={swap}>
                  ⇄ 交换两侧
                </button>
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-5">
            <div className="p-3 rounded tool-panel h-100 position-relative">
              <label className="form-label fw-semibold">右侧（编码/密文）</label>
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
                onDragEnter={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const text = e.dataTransfer.getData('text');
                  if (text) setRight(text);
                }}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    decodeRightToLeft();
                  }
                }}
                placeholder="编码/密文在此输入。解码时 → 左侧"
              />
              <div className="d-flex justify-content-between mt-2">
                <small className="text-muted">
                  快捷键：<span className="kbd">Ctrl</span> +{' '}
                  <span className="kbd">Enter</span> 编码（左 → 右）
                </small>
                <div>
                  <span className="text-muted">{status}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
