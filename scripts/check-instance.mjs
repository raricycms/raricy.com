#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-instance.mjs —— 初始化运行时数据目录骨架
//
// 【为什么需要】`instance/` 是 gitignored 的运行数据底盘，里面分六类：
//   · avatars/        用户头像 PNG（src/app/api/avatar/[id] 读取）
//   · database/       SQLite 主库（Prisma 直连；DATABASE_URL 指向这里）
//   · images/         图床落盘目录（image-upload.ts 写入）
//   · stories/        故事磁盘目录（story-service.ts 读取）
//   · stickers/       表情包素材目录（sticker-service.ts 读取；
//                     <合集>/<表情>.gif|webp|png|jpg|jpeg —— 五种，见该文件 EXT_PRIORITY）
//   · blogs/          历史遗留目录；当前已无写入，但保留以兼容老路径
//
// ⚠️ **头像框素材曾经在这里，已经搬走** —— 它是我们自己画的（源码 =
//    scripts/make-frame-demos.mjs），所以与代码一起入库、住 public/static/frames/。
//    理由是「部署时把 instance/frames/ 拷到服务器」曾是一个**没有报错**的步骤，
//    漏拷 = 全站静默不显示头像框。搬走之后 instance/ 只剩真正的运行时数据。
//    老机器上那个 instance/frames/ 目录已经没人读了，可以删。
//
// 部署侧一般由挂载点保证存在；本地开发或新机器无 instance/ 时，本脚本一键建好。
//
// 【行为】mkdir -p 语义：只补缺失的目录，已存在的原样保留，重复执行安全；
// 不写任何文件、也不删任何东西 —— 目录里有数据时更不会被碰到。
//
// 用法：node scripts/check-instance.mjs
// 退出码：0 全部已存在（创建 0 个）/ 创建成功；1 任何系统错误（如权限）。
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 锚定 ROOT（项目根）：本脚本可能从任意 cwd 被调用，固定写 ROOT 下符合直觉，
// 也避免「在哪跑就建到哪」的坑。
const instanceRoot = path.join(ROOT, 'instance');

const SUBDIRS = ['avatars', 'database', 'images', 'stories', 'stickers', 'blogs'];

let created = 0;
for (const sub of SUBDIRS) {
  const full = path.join(instanceRoot, sub);
  try {
    mkdirSync(full, { recursive: true });
  } catch (e) {
    console.error(`✗ 创建失败 ${full}: ${e.message}`);
    process.exit(1);
  }
  created++;
}

console.log(`✓ instance/ 骨架已就绪（${instanceRoot}）`);
