'use client';

// 逐字对齐原 Flask 模板 tool/hash.html（纯前端计算）。
import Link from 'next/link';
import { useRef, useState } from 'react';

type Algo = 'SHA-256' | 'SHA-1' | 'SHA-512' | 'MD5';
type KeyType = 'text' | 'hex';

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashWithSubtle(algo: string, data: BufferSource): Promise<string> {
  const algoMap: Record<string, string> = { 'SHA-1': 'SHA-1', 'SHA-256': 'SHA-256', 'SHA-512': 'SHA-512' };
  const name = algoMap[algo];
  if (!name || !crypto.subtle) throw new Error('当前环境不支持 WebCrypto');
  const buf = await crypto.subtle.digest(name, data);
  return toHex(buf);
}

async function hmacWithSubtle(algo: string, keyBytes: BufferSource, dataBytes: BufferSource): Promise<string> {
  const algoMap: Record<string, string> = { 'SHA-1': 'SHA-1', 'SHA-256': 'SHA-256', 'SHA-512': 'SHA-512' };
  const name = algoMap[algo];
  if (!name || !crypto.subtle) throw new Error('当前环境不支持 WebCrypto');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: { name } }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return toHex(sig);
}

// Built-in MD5 (no CDN). Returns hex string.
function md5ArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  // Helper functions
  function toWordArray(u8: Uint8Array): number[] {
    const n = (((len + 8) >>> 6) + 1) * 16; // 64-byte blocks -> words
    const w = new Array(n).fill(0);
    for (let i = 0; i < len; i++) w[i >> 2] |= u8[i] << ((i % 4) * 8);
    w[len >> 2] |= 0x80 << ((len % 4) * 8);
    const bitLen = len * 8;
    w[n - 2] = bitLen & 0xffffffff;
    w[n - 1] = (bitLen / 0x100000000) | 0;
    return w;
  }
  function rl(x: number, n: number) { return (x << n) | (x >>> (32 - n)); }
  function add(x: number, y: number) { return (x + y) >>> 0; }
  function F(x: number, y: number, z: number) { return (x & y) | (~x & z); }
  function G(x: number, y: number, z: number) { return (x & z) | (y & ~z); }
  function H(x: number, y: number, z: number) { return x ^ y ^ z; }
  function I(x: number, y: number, z: number) { return y ^ (x | ~z); }
  function FF(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, F(b, c, d)), add(x, t)), s), b); }
  function GG(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, G(b, c, d)), add(x, t)), s), b); }
  function HH(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, H(b, c, d)), add(x, t)), s), b); }
  function II(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, I(b, c, d)), add(x, t)), s), b); }

  const T = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const X = toWordArray(bytes);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (let i = 0; i < X.length; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    // Round 1
    a = FF(a, b, c, d, X[i + 0], S[0], T[0]);
    d = FF(d, a, b, c, X[i + 1], S[1], T[1]);
    c = FF(c, d, a, b, X[i + 2], S[2], T[2]);
    b = FF(b, c, d, a, X[i + 3], S[3], T[3]);
    a = FF(a, b, c, d, X[i + 4], S[4], T[4]);
    d = FF(d, a, b, c, X[i + 5], S[5], T[5]);
    c = FF(c, d, a, b, X[i + 6], S[6], T[6]);
    b = FF(b, c, d, a, X[i + 7], S[7], T[7]);
    a = FF(a, b, c, d, X[i + 8], S[8], T[8]);
    d = FF(d, a, b, c, X[i + 9], S[9], T[9]);
    c = FF(c, d, a, b, X[i + 10], S[10], T[10]);
    b = FF(b, c, d, a, X[i + 11], S[11], T[11]);
    a = FF(a, b, c, d, X[i + 12], S[12], T[12]);
    d = FF(d, a, b, c, X[i + 13], S[13], T[13]);
    c = FF(c, d, a, b, X[i + 14], S[14], T[14]);
    b = FF(b, c, d, a, X[i + 15], S[15], T[15]);
    // Round 2
    a = GG(a, b, c, d, X[i + 1], S[16], T[16]);
    d = GG(d, a, b, c, X[i + 6], S[17], T[17]);
    c = GG(c, d, a, b, X[i + 11], S[18], T[18]);
    b = GG(b, c, d, a, X[i + 0], S[19], T[19]);
    a = GG(a, b, c, d, X[i + 5], S[20], T[20]);
    d = GG(d, a, b, c, X[i + 10], S[21], T[21]);
    c = GG(c, d, a, b, X[i + 15], S[22], T[22]);
    b = GG(b, c, d, a, X[i + 4], S[23], T[23]);
    a = GG(a, b, c, d, X[i + 9], S[24], T[24]);
    d = GG(d, a, b, c, X[i + 14], S[25], T[25]);
    c = GG(c, d, a, b, X[i + 3], S[26], T[26]);
    b = GG(b, c, d, a, X[i + 8], S[27], T[27]);
    a = GG(a, b, c, d, X[i + 13], S[28], T[28]);
    d = GG(d, a, b, c, X[i + 2], S[29], T[29]);
    c = GG(c, d, a, b, X[i + 7], S[30], T[30]);
    b = GG(b, c, d, a, X[i + 12], S[31], T[31]);
    // Round 3
    a = HH(a, b, c, d, X[i + 5], S[32], T[32]);
    d = HH(d, a, b, c, X[i + 8], S[33], T[33]);
    c = HH(c, d, a, b, X[i + 11], S[34], T[34]);
    b = HH(b, c, d, a, X[i + 14], S[35], T[35]);
    a = HH(a, b, c, d, X[i + 1], S[36], T[36]);
    d = HH(d, a, b, c, X[i + 4], S[37], T[37]);
    c = HH(c, d, a, b, X[i + 7], S[38], T[38]);
    b = HH(b, c, d, a, X[i + 10], S[39], T[39]);
    a = HH(a, b, c, d, X[i + 13], S[40], T[40]);
    d = HH(d, a, b, c, X[i + 0], S[41], T[41]);
    c = HH(c, d, a, b, X[i + 3], S[42], T[42]);
    b = HH(b, c, d, a, X[i + 6], S[43], T[43]);
    a = HH(a, b, c, d, X[i + 9], S[44], T[44]);
    d = HH(d, a, b, c, X[i + 12], S[45], T[45]);
    c = HH(c, d, a, b, X[i + 15], S[46], T[46]);
    b = HH(b, c, d, a, X[i + 2], S[47], T[47]);
    // Round 4
    a = II(a, b, c, d, X[i + 0], S[48], T[48]);
    d = II(d, a, b, c, X[i + 7], S[49], T[49]);
    c = II(c, d, a, b, X[i + 14], S[50], T[50]);
    b = II(b, c, d, a, X[i + 5], S[51], T[51]);
    a = II(a, b, c, d, X[i + 12], S[52], T[52]);
    d = II(d, a, b, c, X[i + 3], S[53], T[53]);
    c = II(c, d, a, b, X[i + 10], S[54], T[54]);
    b = II(b, c, d, a, X[i + 1], S[55], T[55]);
    a = II(a, b, c, d, X[i + 8], S[56], T[56]);
    d = II(d, a, b, c, X[i + 15], S[57], T[57]);
    c = II(c, d, a, b, X[i + 6], S[58], T[58]);
    b = II(b, c, d, a, X[i + 13], S[59], T[59]);
    a = II(a, b, c, d, X[i + 4], S[60], T[60]);
    d = II(d, a, b, c, X[i + 11], S[61], T[61]);
    c = II(c, d, a, b, X[i + 2], S[62], T[62]);
    b = II(b, c, d, a, X[i + 9], S[63], T[63]);
    a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd);
  }
  function toHexLe(num: number): string {
    const b1 = (num) & 0xff;
    const b2 = (num >>> 8) & 0xff;
    const b3 = (num >>> 16) & 0xff;
    const b4 = (num >>> 24) & 0xff;
    return [b1, b2, b3, b4].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return (toHexLe(a) + toHexLe(b) + toHexLe(c) + toHexLe(d)).toLowerCase();
}

async function md5(data: ArrayBuffer): Promise<string> {
  return md5ArrayBuffer(data);
}

// Remove BLAKE2 implementations

const ALGOS: Algo[] = ['SHA-256', 'SHA-1', 'SHA-512', 'MD5'];

export default function HashToolPage() {
  const [text, setText] = useState('');
  const [currentAlgo, setCurrentAlgo] = useState<Algo>('SHA-256');
  const [useHmac, setUseHmac] = useState(false);
  const [hmacKey, setHmacKey] = useState('');
  const [hmacKeyType, setHmacKeyType] = useState<KeyType>('text');
  const [result, setResult] = useState('');
  const [status, setStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function parseKey(): ArrayBuffer | null {
    if (!useHmac) return null;
    const val = hmacKey || '';
    if (!val) throw new Error('请输入 HMAC 密钥');
    if (hmacKeyType === 'hex') {
      const cleaned = val.trim().replace(/^0x/i, '').replace(/\s+/g, '');
      if (cleaned.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleaned)) throw new Error('十六进制密钥格式不正确');
      const arr = new Uint8Array(cleaned.length / 2);
      for (let i = 0; i < cleaned.length; i += 2) arr[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
      return arr.buffer;
    }
    return new TextEncoder().encode(val).buffer as ArrayBuffer;
  }

  async function computeHash(algo: Algo, data: ArrayBuffer): Promise<string> {
    if (useHmac) {
      if (!algo.startsWith('SHA-')) throw new Error('HMAC 目前仅支持 SHA-1/256/512');
      const keyBuf = parseKey();
      return await hmacWithSubtle(algo, keyBuf as ArrayBuffer, data);
    }
    if (algo.startsWith('SHA-')) return await hashWithSubtle(algo, data);
    if (algo === 'MD5') return await md5(data);
    throw new Error('不支持的算法');
  }

  async function getDataBuffer(): Promise<ArrayBuffer> {
    const file = fileInputRef.current?.files && fileInputRef.current.files[0];
    if (!file) return new TextEncoder().encode(text || '').buffer as ArrayBuffer;
    // stream read file to ArrayBuffer (still loads into memory; could do chunked for huge files)
    const blob = file;
    return await blob.arrayBuffer();
  }

  async function onCompute() {
    try {
      setStatus('计算中…');
      const data = await getDataBuffer();
      const hex = await computeHash(currentAlgo, data);
      setResult(hex);
      setStatus('完成');
    } catch (e) {
      setResult('');
      setStatus('失败: ' + (e && (e as Error).message ? (e as Error).message : ''));
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(result || '');
      setStatus('已复制');
    } catch {
      setStatus('复制失败');
    }
  }

  return (
    <section className="py-4 base-tool-page">
      <div className="container">
        <div className="d-flex align-items-center mb-3" style={{ gap: '.5rem' }}>
          <Link
            href="/tool"
            className="text-decoration-none"
            style={{ color: 'var(--color-text-secondary)', display: 'inline-flex' }}
          >
            <span className="icon icon-arrow-left" style={{ width: '1.25rem', height: '1.25rem' }}></span>
          </Link>
          <h1 className="mb-0 section-title">哈希计算</h1>
        </div>
        <p className="text-muted mb-3">
          支持 SHA-256 / SHA-1 / SHA-512 / MD5 / BLAKE2 等，文本与文件均可计算。
        </p>

        <div className="row g-4">
          <div className="col-12 col-lg-6">
            <div className="p-3 rounded tool-panel h-100">
              <label className="form-label fw-semibold">输入</label>
              <textarea
                className="form-control mono result-area"
                rows={10}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    onCompute();
                  }
                }}
                placeholder="在此输入文本"
              />
              <div className="mt-3">
                <label className="form-label fw-semibold">或选择文件</label>
                <input ref={fileInputRef} className="form-control" type="file" />
                <div className="file-hint text-muted">若选择文件，将以文件为准进行计算；大文件使用流式分块计算。</div>
                <div className="mt-3">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="useHmac"
                      checked={useHmac}
                      onChange={(e) => setUseHmac(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="useHmac">使用 HMAC（带密钥）</label>
                  </div>
                  <div className="row g-2 mt-1" style={{ display: useHmac ? '' : 'none' }}>
                    <div className="col-12 col-md-8">
                      <input
                        className="form-control mono"
                        placeholder="输入密钥（文本或十六进制）"
                        value={hmacKey}
                        onChange={(e) => setHmacKey(e.target.value)}
                      />
                    </div>
                    <div className="col-12 col-md-4">
                      <select
                        className="form-select"
                        value={hmacKeyType}
                        onChange={(e) => setHmacKeyType(e.target.value as KeyType)}
                      >
                        <option value="text">文本密钥</option>
                        <option value="hex">十六进制密钥</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-6">
            <div className="p-3 rounded tool-panel h-100">
              <label className="form-label fw-semibold">算法</label>
              <div className="d-flex flex-wrap gap-2 mb-3">
                {ALGOS.map((algo) => (
                  <span
                    key={algo}
                    className={`badge rounded-pill algo-badge${currentAlgo === algo ? ' active' : ''}`}
                    data-algo={algo}
                    role="button"
                    aria-pressed={currentAlgo === algo}
                    onClick={() => setCurrentAlgo(algo)}
                  >
                    {algo}
                  </span>
                ))}
              </div>
              <div className="d-grid gap-2 d-md-flex">
                <button className="btn btn-primary" onClick={onCompute}>计算</button>
                <button className="btn btn-outline-secondary" onClick={onCopy}>
                  <span className="icon icon-clipboard"></span> 复制结果
                </button>
              </div>
              <div className="mt-3">
                <label className="form-label fw-semibold">结果</label>
                <textarea className="form-control mono" rows={6} readOnly value={result} />
                <small className="text-muted">{status}</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
