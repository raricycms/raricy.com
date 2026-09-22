// audio-upload.ts —— 音频的 magic bytes 嗅探与**声明侧归一化**。
//
// 【为什么这两件事要一起打】图床那边只有「认字节」一件事；音频多了一件：
// `.m4a` 在三种平台上被报成 `audio/mp4` / `audio/x-m4a` / `audio/m4a`，Windows 上
// 还可能是**空串**。不归一化的话，「内容与声明相符」这条闸门会把格式完全正确的文件判死。
// 而一旦为了放行去放宽比对，就同时把「内容与声明不符」那条防线也拆了 ——
// 所以下面两半都得钉住：**该放的放过去，该拦的必须拦住**。

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_AUDIO_MIMETYPES,
  MAX_AUDIO_SIZE,
  detectAudioMime,
  normalizeAudioMime,
  verifyAudioMime,
  audioExtForMime,
} from '@/lib/audio-upload';

// ── 夹具：造各格式的最小可用字节 ─────────────────────────────────────────────

/** MP3（ID3v2 标签头）。 */
function mp3WithId3(): Buffer {
  return Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.alloc(64),
  ]);
}

/** MP3（裸帧同步，无 ID3）—— 0xFF 0xFB 0x90 是一个合法的 MPEG1 Layer III 帧头。 */
function mp3FrameSync(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
}

/** M4A：偏移 4..8 是 ftyp，brand 在 8..12。 */
function m4a(brand = 'M4A '): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftyp'),
    Buffer.from(brand),
    Buffer.alloc(64),
  ]);
}

/** OGG（指定编解码器标识）。 */
function ogg(codec: string): Buffer {
  return Buffer.concat([
    Buffer.from('OggS'),
    Buffer.alloc(24),
    Buffer.from(codec),
    Buffer.alloc(64),
  ]);
}

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
}

// ═══ 一、字节识别 ════════════════════════════════════════════════════════════

describe('detectAudioMime —— 只认字节', () => {
  it('MP3：ID3 标签头与裸帧同步都认', () => {
    expect(detectAudioMime(mp3WithId3())).toBe('audio/mpeg');
    expect(detectAudioMime(mp3FrameSync())).toBe('audio/mpeg');
  });

  it('MP3：光有 0xFF 打头不算 —— 保留位/位速率那几位要核', () => {
    // 只判 `b0 === 0xFF && (b1 & 0xE0) === 0xE0` 的话，任意一段 0xFF 打头的二进制
    // 都能凑上来。下面几条各自坏在不同的字段上。
    const frameSyncOnly = Buffer.from([0xff, 0xe0, 0x00, 0x00]); // layer=0（保留）
    expect(detectAudioMime(frameSyncOnly)).not.toBe('audio/mpeg');
    const badBitrate = Buffer.from([0xff, 0xfb, 0x00, 0x00]); // bitrateIndex=0（free）
    expect(detectAudioMime(badBitrate)).not.toBe('audio/mpeg');
    const badVersion = Buffer.from([0xff, 0xe8, 0x90, 0x00]); // version=1（保留）
    expect(detectAudioMime(badVersion)).not.toBe('audio/mpeg');
  });

  it('M4A：ftyp + 音频 brand 认得出', () => {
    expect(detectAudioMime(m4a())).toBe('audio/mp4');
    expect(detectAudioMime(m4a('mp42'))).toBe('audio/mp4');
    expect(detectAudioMime(m4a('isom'))).toBe('audio/mp4');
  });

  it('M4A：ftyp 位置不对 / brand 不在白名单 → 认不出', () => {
    const wrongOffset = Buffer.concat([Buffer.from('xxftypM4A '), Buffer.alloc(64)]);
    expect(detectAudioMime(wrongOffset)).toBeNull();
    expect(detectAudioMime(m4a('qt  '))).toBeNull();
    expect(detectAudioMime(m4a('avc1'))).toBeNull();
  });

  it('OGG：认 Vorbis / Opus / FLAC 三种音频编解码器', () => {
    expect(detectAudioMime(ogg('\x01vorbis'))).toBe('audio/ogg');
    expect(detectAudioMime(ogg('OpusHead'))).toBe('audio/ogg');
    expect(detectAudioMime(ogg('fLaC'))).toBe('audio/ogg');
  });

  it('★ OGG 容器装视频（Theora）→ 拒 ★', () => {
    // Ogg 是个**容器**，只认 `OggS` 的话 .ogv 视频会被当音频收进来。
    // 这一层是刻意加的，别为了「兼容」把它去掉。
    expect(detectAudioMime(ogg('\x80theora'))).toBeNull();
    expect(detectAudioMime(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200)]))).toBeNull();
  });

  it('别的格式一律认不出（图片 / 文本 / 空）', () => {
    expect(detectAudioMime(png())).toBeNull();
    expect(detectAudioMime(Buffer.from('hello world, not audio at all'))).toBeNull();
    expect(detectAudioMime(Buffer.alloc(0))).toBeNull();
  });
});

// ═══ 二、声明侧归一化 ════════════════════════════════════════════════════════

describe('normalizeAudioMime —— 把别名折到规范形', () => {
  it('`.m4a` 的各平台别名都折成 audio/mp4', () => {
    for (const alias of ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mp4a-latm']) {
      expect(normalizeAudioMime(alias), alias).toBe('audio/mp4');
    }
  });

  it('MP3 别名折成 audio/mpeg', () => {
    for (const alias of ['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/mpeg3']) {
      expect(normalizeAudioMime(alias), alias).toBe('audio/mpeg');
    }
  });

  it('OGG 别名折成 audio/ogg（含 application/ogg）', () => {
    for (const alias of ['audio/ogg', 'audio/opus', 'audio/vorbis', 'application/ogg']) {
      expect(normalizeAudioMime(alias), alias).toBe('audio/ogg');
    }
  });

  it('带参数与大小写都能折', () => {
    expect(normalizeAudioMime('Audio/MPEG; codecs="mp3"')).toBe('audio/mpeg');
    expect(normalizeAudioMime('  AUDIO/X-M4A  ')).toBe('audio/mp4');
  });

  it('声明为空 → 按扩展名兜底', () => {
    expect(normalizeAudioMime('', 'voice.mp3')).toBe('audio/mpeg');
    expect(normalizeAudioMime(null, 'song.m4a')).toBe('audio/mp4');
    expect(normalizeAudioMime(undefined, 'a.OGG')).toBe('audio/ogg');
  });

  it('★ 空声明 + `.mp4` 扩展名 → **不认**（那是视频容器的通用扩展名）★', () => {
    // 认了就等于给「传视频」开一条明路，而 brand 白名单本来就分辨不了 isom/mp42。
    expect(normalizeAudioMime('', 'movie.mp4')).toBeNull();
  });

  it('认不出的类型与扩展名 → null', () => {
    expect(normalizeAudioMime('image/png', 'x.png')).toBeNull();
    expect(normalizeAudioMime('', 'x.wav')).toBeNull();
    expect(normalizeAudioMime('', 'x.flac')).toBeNull();
    expect(normalizeAudioMime('', 'noext')).toBeNull();
  });
});

// ═══ 三、比对（归一化 × 字节）═══════════════════════════════════════════════

describe('verifyAudioMime —— 归一化后仍要与字节严格相等', () => {
  it('格式正确 + 声明是别名 → 通过，且**返回规范形**', () => {
    // 返回规范形而不是 true，是为了让落库/下发的 Content-Type 永远是认过的那个值。
    expect(verifyAudioMime(m4a(), 'audio/x-m4a', 'v.m4a')).toBe('audio/mp4');
    expect(verifyAudioMime(mp3WithId3(), 'audio/mp3', 'v.mp3')).toBe('audio/mpeg');
    expect(verifyAudioMime(ogg('OpusHead'), 'audio/opus', 'v.opus')).toBe('audio/ogg');
  });

  it('★ 扩展名兜底不等于放水：叫 `.mp3` 的 PNG 照样拒 ★', () => {
    // 扩展名只用来补浏览器没给的那一格；权威始终是字节。
    expect(verifyAudioMime(png(), '', 'fake.mp3')).toBeNull();
    expect(verifyAudioMime(png(), 'audio/mpeg', 'fake.mp3')).toBeNull();
  });

  it('内容与声明不符（张冠李戴）→ 拒', () => {
    expect(verifyAudioMime(mp3WithId3(), 'audio/mp4', 'v.m4a')).toBeNull();
    expect(verifyAudioMime(m4a(), 'audio/ogg', 'v.ogg')).toBeNull();
    expect(verifyAudioMime(ogg('\x01vorbis'), 'audio/mpeg', 'v.mp3')).toBeNull();
  });

  it('不在白名单的声明 → 拒（哪怕字节看起来像）', () => {
    expect(verifyAudioMime(mp3WithId3(), 'audio/flac', 'v.flac')).toBeNull();
    expect(verifyAudioMime(mp3WithId3(), 'video/mp4', 'v.mp4')).toBeNull();
  });

  it('Theora 视频 .ogv → 拒（声明再对也没用，字节不过关）', () => {
    expect(verifyAudioMime(ogg('\x80theora'), 'audio/ogg', 'v.ogv')).toBeNull();
  });
});

// ═══ 四、常量 ════════════════════════════════════════════════════════════════

describe('常量', () => {
  it('白名单就是三种，扩它即放宽入站格式', () => {
    expect([...ALLOWED_AUDIO_MIMETYPES].sort()).toEqual([
      'audio/mp4',
      'audio/mpeg',
      'audio/ogg',
    ]);
  });

  it('单文件上限 10MB（与图床同值 —— 部署侧两道 12MB 闸门因此不用改）', () => {
    expect(MAX_AUDIO_SIZE).toBe(10 * 1024 * 1024);
  });

  it('规范 MIME 都能推出磁盘扩展名', () => {
    expect(audioExtForMime('audio/mpeg')).toBe('.mp3');
    expect(audioExtForMime('audio/mp4')).toBe('.m4a');
    expect(audioExtForMime('audio/ogg')).toBe('.ogg');
    expect(audioExtForMime('audio/nope')).toBe('');
  });
});
