#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-instance.mjs —— 初始化运行时数据目录骨架
//
// 【为什么需要】`instance/` 是 gitignored 的运行数据底盘，里面分四类：
//   · avatars/        用户头像 PNG（web-next /api/avatar/[id] 读取）
//   · database/       SQLite 主库（Prisma 直连；DATABASE_URL 指向这里）
//   · images/         图床落盘目录（image-upload.ts 写入）
//   · stories/        故事磁盘目录（story-service.ts 读取）
//   · blogs/          历史遗留目录；当前已无写入，但保留以兼容老路径
//
// 部署侧一般由挂载点保证存在；本地开发或新机器无 instance/ 时，本脚本一键建好。
//
// 【历史】这是 Python 时代 `check_instance.py` 的等价移植 —— 老脚本只 os/pathlib，
// 与 Flask 解耦；新版本照搬行为，但用 Node 跑、不再依赖 Python。
//
// 用法：node scripts/check-instance.mjs
// 退出码：0 全部已存在（创建 0 个）/ 创建成功；1 任何系统错误（如权限）。
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 锚定 ROOT（项目根）：和原 Python 在 `cd project && python check_instance.py`
// 时的行为等价。node 脚本若从其它目录被调用，固定写 ROOT 下符合直觉。
const instanceRoot = path.join(ROOT, 'instance');

const SUBDIRS = ['avatars', 'database', 'images', 'stories', 'blogs'];

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
