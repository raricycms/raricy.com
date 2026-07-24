// Visual parity test — capture screenshots of all major Next.js pages
// and verify they render with Flask-style class names.
import { test, expect } from '@playwright/test';

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

for (const route of ROUTES) {
  test(`screenshot ${route.name} (${route.path})`, async ({ page }) => {
    const response = await page.goto(`http://localhost:3000${route.path}`, { waitUntil: 'networkidle' });
    // 4xx is OK for auth-gated routes
    if (response && response.status() >= 500) {
      throw new Error(`Server error ${response.status()} for ${route.path}`);
    }
    // Verify Flask-style navbar/footer are present
    const navCount = await page.locator('header.site-navbar').count();
    const footerCount = await page.locator('footer.site-footer').count();
    expect(navCount, `Flask site-navbar missing on ${route.path}`).toBeGreaterThanOrEqual(1);
    expect(footerCount, `Flask site-footer missing on ${route.path}`).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: `tests/screenshots/visual-${route.name}.png`, fullPage: true });
  });
}