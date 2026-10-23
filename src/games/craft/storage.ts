// 手工间草稿的读写只做两件事：吞掉 localStorage 的异常，并把「写失败」告诉页面。
// 隐私模式 / 禁用存储时读与写都可能抛（Safari 老版本甚至是「读得到、写就抛」），
// 所以这里不假设任何一次调用是安全的。

export function readCraftDraft(key: string): { raw: string | null; failed: boolean } {
  try {
    return { raw: window.localStorage.getItem(key), failed: false };
  } catch {
    return { raw: null, failed: true };
  }
}

export function writeCraftDraft(key: string, raw: string): boolean {
  try {
    window.localStorage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}
