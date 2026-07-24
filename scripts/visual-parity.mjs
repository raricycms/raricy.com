// Standalone visual verification — uses Playwright's library directly,
// bypassing the E2E webServer config (which requires production build).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.resolve('tests/screenshots');
await mkdir(OUT, { recursive: true });

const ROUTES = [
  { path: '/', name: 'home' },
  { path: '/login', name: 'login' },
  { path: '/register', name: 'register' },
  { path: '/game', name: 'game-menu' },
  { path: '/tool', name: 'tool-menu' },
  { path: '/terms', name: 'terms' },
  { path: '/privacy', name: 'privacy' },
  { path: '/contact', name: 'contact' },
  { path: '/story', name: 'story' },
  { path: '/admin', name: 'admin' },
  { path: '/oauth/authorize', name: 'oauth-authorize' },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const results = [];
for (const route of ROUTES) {
  const url = `${BASE}${route.path}`;
  let status = 'ERR';
  let navCount = 0;
  let footerCount = 0;
  let flaskClasses = 0;
  let apFdClasses = 0;
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    status = String(res?.status() ?? 0);
    navCount = await page.locator('header.site-navbar').count();
    footerCount = await page.locator('footer.site-footer').count();
    const html = await page.content();
    flaskClasses = (html.match(/class="[^"]*\b(site-|home-|feature-|admin-|auth-page|register-container|game-card|tool-|story-|clipboard-|image-hosting|vote-|checkin-|photo-wall|fish-|profile-|settings-|fortune-)/g) || []).length;
    apFdClasses = (html.match(/class="[^"]*\b(ap-|fd-)/g) || []).length;
    await page.screenshot({ path: path.join(OUT, `visual-${route.name}.png`), fullPage: true });
  } catch (e) {
    status = `EXC: ${e.message?.slice(0, 50)}`;
  }
  results.push({ ...route, status, navCount, footerCount, flaskClasses, apFdClasses });
  console.log(`${route.path.padEnd(20)} status=${status} nav=${navCount} footer=${footerCount} flask=${flaskClasses} ap/fd=${apFdClasses}`);
}

await browser.close();

const failed = results.filter(r => r.status.startsWith('5') || r.status.startsWith('EXC'));
const hasFlaskChrome = results.filter(r => r.navCount > 0 && r.footerCount > 0).length;
console.log(`\nRoutes with Flask navbar+footer: ${hasFlaskChrome}/${results.length}`);
console.log(`5xx/exceptions: ${failed.length}`);

if (failed.length) {
  console.error('FAILED routes:', failed);
  process.exit(1);
}