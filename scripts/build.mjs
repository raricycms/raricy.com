// 生产构建入口 —— `npm run build`。
//
// 【为什么从 package.json 里挪成一个脚本】原来的构建命令是一串 && 串联，
// 而它缺了一步：**没有先删 `.next/types`**。
//
// 那个坑是这样的：`.next/types/` 是 Next 生成的路由类型，`next build` 自己的
// 类型检查要读它。它不随源码删改即时更新，于是删掉/改过一个路由之后它仍然指着
// 旧路由的 `page.js`，构建就挂在这一步：
//
//   Failed to compile. Type error: File '.../.next/types/app/admin/appeals/layout.ts' not found
//
// 报的是个**存在**的路由，所以特别迷惑。而「跑一次 build 就好了」这个解药在这里
// **正好失效 —— 解药就是它本身**。唯一的出路是先把陈旧产物删掉再 build。
// （CLAUDE.md「常用命令」第 2 条记着整件事的来龙去脉与 4 条幻影错误。）
//
// 所以这一步不该靠人记着 —— 每次 build 都从干净的 `.next/types` 起步。
// **只删 `.next/types`，不删整个 `.next`**：后者常被别的进程占着，Windows 上
// `rm -rf` 会以 `Directory not empty` 半途失败，而失败信息看着像权限问题
// （同样记在 CLAUDE.md 里）。
//
// 其余步骤与原命令逐字一致，顺序未动：prisma generate（client 必须先于 next build）
// → copy-converter-assets（转换器引擎资产）→ next build → realtime:build。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** 跑一条命令，失败即止（与原 `&&` 串联的语义一致）。 */
function run(label, command, args) {
  console.log(`\n[build] ${label}`);
  const r = spawnSync(command, args, {
    cwd: root,
    // Windows 上 npm/npx 是 .cmd 批处理，必须经 shell 才能拉起（同 tests 里的既有注解）。
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[build] 失败：${label}（exit ${r.status ?? 'null'}）`);
    process.exit(r.status ?? 1);
  }
}

// 先删陈旧的生成类型。删不掉不算错误 —— 可能只是没有（首次构建）。
const typesDir = path.join(root, '.next', 'types');
try {
  fs.rmSync(typesDir, { recursive: true, force: true });
  console.log('[build] 已清理 .next/types（避免陈旧路由类型让类型检查报幻影错误）');
} catch (e) {
  console.warn(`[build] 清理 .next/types 失败（忽略，继续构建）：${e.message}`);
}

run('prisma generate', 'npx', ['prisma', 'generate']);
run('复制转换器引擎资产', 'node', ['scripts/copy-converter-assets.mjs']);
run('next build', 'npx', ['next', 'build']);
run('realtime 构建', 'npx', ['tsc', '-p', 'services/realtime/tsconfig.json']);

console.log('\n[build] 完成');
