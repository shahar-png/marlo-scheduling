import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from '../app/page';
import { GET } from '../app/api/health/route';

describe('home page', () => {
  it('renders Marlo Scheduling placeholder copy', () => {
    const html = renderToStaticMarkup(<HomePage />);
    assert.match(html, /Marlo Scheduling/);
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
  it('documents npm ci, npm test, and npm run dev', () => {
    const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    assert.match(readme, /npm ci/);
    assert.match(readme, /npm test/);
    assert.match(readme, /npm run dev/);
  });
});
