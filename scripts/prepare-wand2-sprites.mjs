// 角色层由 image_gen 修补；剑、剑光和握点用确定几何拼装，防止跨格与手剑脱节。
// 修改 source/ 或 sprite-layout.json 后运行 node scripts/prepare-wand2-sprites.mjs。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public/static/games/wand2');
const SOURCE = path.join(DIR, 'source');
const QA = path.join(ROOT, 'tests/.tmp/wand2-sprite-repair');
await fs.mkdir(QA, { recursive: true });
const layout = JSON.parse(await fs.readFile(path.join(DIR, 'sprite-layout.json'), 'utf8'));
const CELL = layout.attackCellSize;
const bodiesOnly = process.argv.includes('--bodies-only');
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const blank = (width, height) => sharp({ create: { width, height, channels: 4, background: clear } });

async function alphaBounds(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] < 24) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('Empty sprite body');
  left = Math.max(0, left - 2); top = Math.max(0, top - 2);
  return { left, top, width: Math.min(info.width, right + 3) - left, height: Math.min(info.height, bottom + 3) - top };
}

function svg(content) { return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}" viewBox="0 0 ${CELL} ${CELL}">${content}</svg>`); }
const rad = angle => angle * Math.PI / 180;
function sword({ hand, angle }, name) {
  const [x, y] = hand, a = rad(angle);
  // 剑尖、护手和剑首共享同一条轴线，右手握点就是坐标原点。
  for (const [u, v] of [[-18, -5], [-18, 5], [8, -11], [15, 11], [93, 0]]) {
    const px = x + Math.cos(a) * u - Math.sin(a) * v, py = y + Math.sin(a) * u + Math.cos(a) * v;
    if (px < 9 || px > CELL - 9 || py < 9 || py > CELL - 9) throw new Error(`${name}: sword outside safe cell (${px.toFixed(1)}, ${py.toFixed(1)})`);
  }
  return svg(`<defs><linearGradient id="steel" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fafaff"/><stop offset=".45" stop-color="#c9c9e2"/><stop offset=".52" stop-color="#9592b1"/><stop offset="1" stop-color="#e9e9f3"/></linearGradient></defs>
    <g transform="translate(${x} ${y}) rotate(${angle})" stroke="#3e394c" stroke-width="1.6" stroke-linejoin="round">
      <rect x="-13" y="-3.2" width="24" height="6.4" rx="2.5" fill="#302b36"/>
      <path d="M-8-3l3 6m3-6l3 6m3-6l3 6" stroke="#666071" stroke-width="1"/>
      <ellipse cx="-14" cy="0" rx="3" ry="4" fill="#8d879f"/>
      <path d="M14-4.5L82-3L92 0L82 3L14 4.5Z" fill="url(#steel)"/>
      <path d="M17 0H87" stroke="#f5f2ff" stroke-width=".85"/>
      <rect x="9" y="-10" width="5" height="20" rx="2" fill="#a8a1bd"/>
    </g>`);
}

function slash(row, phase) {
  if (phase !== 1 && phase !== 2) return svg('');
  const base = [90, 180, 0, 270][row], sweep = phase === 1 ? -9 : 9;
  const a = rad(base - 66 + sweep), b = rad(base + 66 + sweep), cx = 192, cy = row === 3 ? 214 : 238;
  const point = (r, t) => `${(cx + Math.cos(t) * r).toFixed(2)} ${(cy + Math.sin(t) * r).toFixed(2)}`;
  return svg(`<defs><radialGradient id="mint"><stop offset=".68" stop-color="#d2f6e8" stop-opacity=".05"/><stop offset=".92" stop-color="#c4efdf" stop-opacity=".75"/><stop offset="1" stop-color="#f3fff7" stop-opacity=".95"/></radialGradient></defs>
    <path d="M${point(118, a)}A118 118 0 0 1 ${point(118, b)}L${point(96, b)}A96 96 0 0 0 ${point(96, a)}Z" fill="url(#mint)"/>
    <path d="M${point(116, a)}A116 116 0 0 1 ${point(116, b)}" fill="none" stroke="#f0fff6" stroke-opacity=".8" stroke-width="1.8" stroke-linecap="round"/>`);
}

const bodies = [], complete = [], sourceTransforms = [];
for (let row = 0; row < layout.attack.length; row++) {
  const group = layout.attack[row], source = path.join(SOURCE, group.file), crops = [];
  for (let col = 0; col < 4; col++) {
    const buffer = await sharp(source).extract({ left: col % 2 * 512, top: Math.floor(col / 2) * 512, width: 512, height: 512 }).png().toBuffer();
    crops.push({ buffer, bounds: await alphaBounds(buffer) });
  }
  // 同一方向四帧用同一缩放比例；蹲下动作不会因为逐帧 trim 而突然变大。
  const scale = Math.min(214 / Math.max(...crops.map(c => c.bounds.height)), 226 / Math.max(...crops.map(c => c.bounds.width)));
  for (let col = 0; col < 4; col++) {
    const { buffer, bounds } = crops[col];
    const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale);
    const left = Math.round((CELL - width) / 2) + (group.offsetX ?? 0), top = layout.attackFootBaseline - height;
    const body = await blank(CELL, CELL).composite([{ input: await sharp(buffer).extract(bounds).resize(width, height).png().toBuffer(), left, top }]).png().toBuffer();
    bodies.push({ input: body, left: col * CELL, top: row * CELL });
    sourceTransforms.push({ row, col, bounds, scale, left, top });
    if (bodiesOnly) continue;
    const pose = group.poses[col];
    if (!pose) throw new Error(`Missing ${group.direction} ${col} hand anchor`);
    const weapon = sword(pose, `${group.direction} ${col}`);
    const [hx, hy] = pose.hand;
    const { data: pixels } = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const point = (hy * CELL + hx) * 4;
    if (pixels[point + 3] < 128 || pixels[point] < 120 || pixels[point] < pixels[point + 1] * 1.05) {
      throw new Error(`${group.direction} ${col}: right-hand anchor does not land on the fist`);
    }
    // 先画剑，再把原来的拳头覆盖回握点；剑柄穿过掌心，手指始终位于柄的前面。
    const fist = await sharp(body).composite([{ input: svg(`<ellipse cx="${hx}" cy="${hy}" rx="${pose.gripRadius ?? 11}" ry="${pose.gripRadius ?? 11}" fill="white"/>`), blend: 'dest-in' }]).png().toBuffer();
    const finished = await sharp(body).composite([{ input: slash(row, col) }, { input: weapon }, { input: fist }]).png().toBuffer();
    const { data: finalPixels } = await sharp(finished).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      if (x >= layout.gutter && x < CELL - layout.gutter && y >= layout.gutter && y < CELL - layout.gutter) continue;
      if (finalPixels[(y * CELL + x) * 4 + 3] > 0) throw new Error(`${group.direction} ${col}: nontransparent gutter`);
    }
    complete.push({ input: finished, left: col * CELL, top: row * CELL });
  }
}
await blank(CELL * 4, CELL * 4).composite(bodies).webp({ lossless: true }).toFile(path.join(DIR, 'attack-body.webp'));
await fs.writeFile(path.join(QA, 'source-transforms.json'), JSON.stringify(sourceTransforms, null, 2));
if (bodiesOnly) { console.log('Prepared padded body-layer preview.'); process.exit(0); }
await blank(CELL * 4, CELL * 4).composite(complete).webp({ lossless: true }).toFile(path.join(DIR, 'attack.webp'));

// 四帧向下步行独立成条；以脸的中心对齐，避免低垂剑的包围盒令人物左右漂移。
const walking = [], walkCrops = [], walk = layout.walkDown;
for (let col = 0; col < 4; col++) {
  const buffer = await sharp(path.join(SOURCE, walk.file)).extract({ left: col % 2 * 512, top: Math.floor(col / 2) * 512, width: 512, height: 512 }).png().toBuffer();
  walkCrops.push({ buffer, bounds: await alphaBounds(buffer) });
}
const walkScale = walk.bodyHeight / Math.max(...walkCrops.map(c => c.bounds.height));
const walkFaceY = walk.footBaseline - Math.max(...walkCrops.map(c => (c.bounds.top + c.bounds.height - walk.sourceFaceY) * walkScale));
for (let col = 0; col < 4; col++) {
  const { buffer, bounds } = walkCrops[col];
  const width = Math.round(bounds.width * walkScale), height = Math.round(bounds.height * walkScale);
  const left = Math.round(walk.faceCenter - (walk.headCenters[col] - bounds.left) * walkScale);
  const top = Math.round(walkFaceY - (walk.sourceFaceY - bounds.top) * walkScale + walk.bob[col]);
  if (left < 4 || left + width > 252 || top < 4 || top + height > 252) throw new Error(`walk-down ${col}: sprite outside safe cell`);
  walking.push(await blank(256, 256).composite([{ input: await sharp(buffer).extract(bounds).resize(width, height).png().toBuffer(), left, top }]).png().toBuffer());
}
await blank(1024, 256).composite(walking.map((input, col) => ({ input, left: col * 256, top: 0 }))).webp({ lossless: true }).toFile(path.join(DIR, walk.file));

// 仅应用登记的帧或局部矩形，其余角色表可见像素保持不变。
const { data: character, info } = await sharp(path.join(SOURCE, 'character-original.webp')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (const patch of layout.characterPatches) {
  // 从已合成的步行条取帧，避免半透明边缘在两条合成路径中出现舍入差异。
  const input = patch.frame === undefined ? path.join(SOURCE, patch.file)
    : await sharp(path.join(DIR, walk.file)).extract({ left: patch.frame * 256, top: 0, width: 256, height: 256 }).png().toBuffer();
  const { data } = await sharp(input).resize(256, 256).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [x0, y0, width, height] = patch.region;
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
    const target = ((patch.row * 256 + y) * info.width + patch.col * 256 + x) * 4;
    const source = (y * 256 + x) * 4;
    for (let c = 0; c < 4; c++) character[target + c] = data[source + c];
  }
}
await sharp(character, { raw: info }).webp({ lossless: true }).toFile(path.join(DIR, 'character.webp'));
console.log('Wand 2: rebuilt sword frames, four down-walk phases and character patches.');
