import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (process.env.APP_TEST_GRANDCHILD === '1') {
  spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, APP_TEST_GRANDCHILD: '0', APP_TEST_READY: `${process.env.APP_TEST_READY}.child` },
    stdio: 'ignore', windowsHide: true,
  });
}
const server = createServer((req, res) => {
  res.end('ok');
  if (req.url === '/exit') setTimeout(() => process.exit(17), 10);
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.APP_TEST_READY, JSON.stringify({ port: server.address().port, pid: process.pid }));
});
process.on('SIGTERM', () => server.close());
