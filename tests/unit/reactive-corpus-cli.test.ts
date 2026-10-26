import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const root = path.resolve(import.meta.dirname, '../..');
const temporaryRoot = path.join(root, 'tests/.tmp');
const directories: string[] = [];
function directory() {
  const dir = mkdtempSync(path.join(temporaryRoot, 'reactive-corpus-cli-'));
  directories.push(dir);
  return dir;
}
function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reactive-corpus-report.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    if (!path.resolve(dir).startsWith(temporaryRoot + path.sep)) throw new Error('Unexpected test directory');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('read-only corpus CLI', () => {
  it('rejects using the JSON input as the output, preserving its bytes', () => {
    const file = path.join(directory(), 'input.json');
    const input = JSON.stringify([{ id: 'b1', kind: 'blog', content: 'private source' }]);
    writeFileSync(file, input);
    const result = run(['--input', file, '--out', file]);
    expect(result.status).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(input);
  });
  it('scans a SQLite fixture without changing it or including deleted documents and body text', () => {
    const dir = directory();
    const file = path.join(dir, 'source.db');
    const output = path.join(dir, 'report.json');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE blogs(id TEXT PRIMARY KEY,ignore BOOLEAN); CREATE TABLE blog_contents(blog_id TEXT,content TEXT,format TEXT); INSERT INTO blogs VALUES('b1',0),('deleted',1); INSERT INTO blog_contents VALUES('b1','PRIVATE_BODY_DO_NOT_EXPORT','markdown'),('deleted','deleted body','markdown');");
    db.close();
    const before = readFileSync(file);
    const result = run(['--db', file, '--out', output]);
    expect(result.status, result.stderr).toBe(0);
    const report = readFileSync(output, 'utf8');
    expect(JSON.parse(report).totals.documents).toBe(1);
    expect(report).not.toContain('PRIVATE_BODY_DO_NOT_EXPORT');
    expect(readFileSync(file)).toEqual(before);
    const collision = run(['--db', file, '--out', file]);
    expect(collision.status).toBe(2);
    expect(readFileSync(file)).toEqual(before);
  });
});
