import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopTree(child, graceMs) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Windows 的 kill() 只杀直接子进程；Next dev 与 Node watch 都还会创建子进程。
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('exit', resolve);
    });
    return;
  }
  const signal = (value) => {
    try { process.kill(-child.pid, value); return true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  };
  if (!signal('SIGTERM')) return;
  const deadline = performance.now() + graceMs;
  while (signal(0)) {
    if (performance.now() >= deadline) { signal('SIGKILL'); return; }
    await delay(50);
  }
}

/**
 * 任一子进程退出即停止整组，让外层唯一的服务管理器负责重新启动。
 * @param {{name: string, args: string[], env: NodeJS.ProcessEnv}[]} commands
 * @param {{cwd?: string, graceMs?: number, signals?: import('node:events').EventEmitter}} [options]
 */
export async function runAppProcesses(commands, { cwd, graceMs = 5000, signals = process } = {}) {
  const children = [];
  let stopping = false;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    void Promise.all(children.map((child) => stopTree(child, graceMs))).then(() => resolveStopped(code)).catch((error) => {
      console.error('[app] 停止子进程失败:', error.message);
      resolveStopped(1);
    });
  };
  const onSignal = () => stop(0);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.on(signal, onSignal);
  try {
    for (const command of commands) {
      if (stopping) break;
      const child = spawn(process.execPath, command.args, {
        cwd, env: command.env, stdio: 'inherit', windowsHide: true,
        // 独立进程组是为了向整棵开发进程树发信号；不 unref，父进程始终托管它们。
        detached: process.platform !== 'win32',
      });
      children.push(child);
      child.once('error', (error) => {
        console.error(`[app] ${command.name} 启动失败:`, error.message);
        stop(1);
      });
      child.once('exit', (code, signal) => {
        if (stopping) return;
        console.error(`[app] ${command.name} 已退出 (${signal || code})，停止全部服务`);
        stop(code || 1);
      });
    }
    return await stopped;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.off(signal, onSignal);
  }
}
