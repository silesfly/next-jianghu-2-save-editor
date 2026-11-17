'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function resolvePlaywright() {
  const candidates = [
    'playwright',
    '/home/jiyoung/.local/lib/node_modules/@playwright/mcp/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    path.join(os.homedir(), '.npm-global/lib/node_modules/playwright'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  throw new Error('Could not resolve playwright package');
}

const { chromium } = resolvePlaywright();
const ROOT = path.resolve(__dirname, '..');
const DIST_HTML = path.join(ROOT, 'dist', 'NextJianghu2SaveEditor-v1.0.html');
const HANZI_OR_KANA_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff]/g;

async function runModeA(browser) {
  assert.ok(fs.existsSync(DIST_HTML), 'dist HTML missing: ' + DIST_HTML);
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const badUrls = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    badUrls.push(url);
    return route.abort();
  });

  await page.goto(pathToFileURL(DIST_HTML).href, { waitUntil: 'load' });
  await page.click('#btn-load-demo');
  await page.waitForTimeout(150);

  // Visit every tab and verify clean activation
  const tabs = ['summary', 'stats', 'skills', 'inventory', 'graphs', 'companions', 'diff'];
  for (const tab of tabs) {
    await page.click(`#tab-${tab}`);
    const active = await page.getAttribute(`#panel-${tab}`, 'class');
    assert.ok(active && active.includes('is-active'), `panel-${tab} should become active`);
  }

  // Apply rich_start preset & verify coin=10000000
  await page.click('#tab-summary');
  await page.locator('#preset-chips button', { hasText: '부유한 시작' }).click();
  await page.click('#tab-stats');
  const coinVal = await page.inputValue('input[data-attr="68"]');
  assert.strictEqual(Number(coinVal), 10000000);

  // Edit summary playername & apply
  await page.click('#tab-summary');
  await page.fill('#f-playername', '테스트협객');
  await page.click('#btn-apply-summary');

  // Add item
  await page.click('#tab-inventory');
  await page.click('#btn-add-item');

  // Toggle jingmai & jingjie
  await page.click('#tab-graphs');
  await page.locator('#m8-grid button.node').first().click();

  // Check diff count > 0 and body text clean
  await page.click('#tab-diff');
  const diffText = await page.textContent('#diff-count');
  const diffNum = parseInt(String(diffText).replace(/[^0-9]/g, ''), 10);
  assert.ok(diffNum > 0, 'Expected diff count > 0, got: ' + diffText);

  const bodyText = await page.evaluate(() => document.body.innerText || '');
  const matches = bodyText.match(HANZI_OR_KANA_RE) || [];
  assert.strictEqual(matches.length, 0, 'Unexpected Hanzi/Kana in UI: ' + matches.slice(0, 10).join(','));
  assert.ok(!bodyText.includes('[object Object]'), 'Unexpected [object Object] in UI');
  assert.ok(!/\bundefined\b/.test(bodyText), 'Unexpected undefined in UI');

  assert.deepStrictEqual(pageErrors, []);
  assert.deepStrictEqual(consoleErrors, []);
  assert.deepStrictEqual(badUrls, []);

  await context.close();
  console.log('PASS  Mode A (offline single-file HTML, all 7 tabs, zero errors/leaks/Hanzi)');
}

async function runModeB(browser) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nj2-e2e-'));
  let proc;
  try {
    execFileSync('python3', [path.join(ROOT, 'nj2_editor.py'), 'demo', '--out-dir', tmpDir], {
      cwd: ROOT, encoding: 'utf-8',
    });
    const savePath = path.join(tmpDir, 'savefile0.json');
    const origBytes = fs.readFileSync(savePath);

    proc = spawn('python3', [path.join(ROOT, 'nj2_editor.py'), 'serve', '--port', '0', '--no-browser', '--root', tmpDir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const serverInfo = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Timed out waiting for serve JSON line: ' + buf)), 15000);
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('serve exited early: ' + code));
      });
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(serverInfo.url, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const sel = document.querySelector('#slot-select');
      return sel && sel.options && sel.options.length > 1;
    }, { timeout: 10000 });

    const targetOpt = await page.evaluate(() => {
      const sel = document.querySelector('#slot-select');
      return sel.options[1].value;
    });
    await page.selectOption('#slot-select', targetOpt);
    await page.waitForFunction(() => document.querySelector('#f-playername').value === 'DemoHero', { timeout: 10000 });

    await page.locator('#preset-chips button', { hasText: '부유한 시작' }).click();
    await page.click('#btn-save-file');

    await page.waitForFunction(() => {
      const badge = document.querySelector('#status-badge');
      return badge && badge.textContent && badge.textContent.includes('저장됨');
    }, { timeout: 10000 });

    const updated = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    const player = Object.values(updated.playerentity)[0];
    assert.strictEqual(player.m_valueBase['68'], 10000000);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('savefile0.json.backup-') && f.endsWith('.bak'));
    assert.ok(backups.length > 0, 'Backup file should exist');
    assert.deepStrictEqual(fs.readFileSync(path.join(tmpDir, backups[0])), origBytes);
    assert.deepStrictEqual(pageErrors, []);

    await context.close();
    console.log('PASS  Mode B (loopback serve, slot load, rich_start edit, atomic save + verified backup)');
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function resolveChromiumExecutable() {
  try {
    const def = chromium.executablePath();
    if (def && fs.existsSync(def)) return undefined;
  } catch (_) {}
  const cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = path.join(cacheDir, entry, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

(async () => {
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch(Object.assign({ headless: true }, executablePath ? { executablePath } : {}));
  try {
    await runModeA(browser);
    await runModeB(browser);
    console.log('\n===== test_playwright_e2e.cjs: 2/2 passed =====');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
