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
}
