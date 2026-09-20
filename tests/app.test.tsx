import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from '../app/page';
import { GET } from '../app/api/health/route';

describe('home page', () => {
  it('renders branded Marlo Scheduling chrome (tokens + Logo) and links to the demo', () => {
    const html = renderToStaticMarkup(<HomePage />);
    assert.match(html, /Marlo Scheduling/);
    assert.match(html, /data-logo="wordmark"/);
    assert.match(html, /marlo-page/);
    assert.match(html, /marlo-btn--primary/);
    assert.match(html, /href="\/demo\/intro-30"/);
    assert.doesNotMatch(html, /Placeholder/);
    assert.doesNotMatch(html, /placeholder/);
  });

  it('the homepage source is not placeholder-only', () => {
    const source = readFileSync(path.join(process.cwd(), 'app/page.tsx'), 'utf8');
    assert.doesNotMatch(source, /Placeholder — the first scheduling slice/);
    assert.match(source, /Logo/);
  });
});

describe('GET /api/health', () => {
  it('returns { ok: true }', async () => {
    const response = await GET();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });
});

describe('README', () => {
  it('documents npm ci, npm test, npm run dev, and the demo booking path', () => {
    const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    assert.match(readme, /npm ci/);
    assert.match(readme, /npm test/);
    assert.match(readme, /npm run dev/);
    assert.match(readme, /\/demo\/intro-30/);
    assert.match(readme, /\/b\/\{token\}/);
  });
});
