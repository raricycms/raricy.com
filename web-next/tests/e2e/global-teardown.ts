// E2E 收尾：释放 global-setup 拿的并发锁。
//
// 锁本身是 PID 存活性判断，所以就算这里没跑到（进程被 SIGKILL），
// 下一轮也能识别出「锁的主人已经死了」并自动清掉 —— 不会留下一个永远解不开的锁。
// 这里只是把常规路径下的锁及时清掉，省得靠那条兜底。

import fs from 'node:fs';
import path from 'node:path';

const LOCK = path.resolve(__dirname, '../.tmp/e2e.lock');

export default async function globalTeardown() {
  // 只删自己写的那把锁：并发被拦时抛错的那一轮不该把别人的锁删掉。
  try {
    if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(LOCK, { force: true });
    }
  } catch {
    // 清锁失败不该让整轮测试判失败 —— 残留锁有 PID 存活性兜底
  }

  // 库名每轮唯一（见 playwright.config.ts），不清就会在 tests/.tmp 里越堆越多。
  // 只删本轮那一个：别的 e2e-*.db 可能属于正在跑的另一轮。
  const db = process.env.E2E_DB;
  if (db) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(db + suffix, { force: true });
      } catch {
        // 删不掉就算了 —— tests/.tmp 已 gitignore，最多占点磁盘
      }
    }
  }
}
