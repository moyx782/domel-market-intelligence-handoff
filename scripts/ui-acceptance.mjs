// Browser acceptance for the single-user demo. Requires a running frontend
// and API (npm run demo:lan or demo:api + dev) and Chrome/Chromium.
//
//   BASE=http://192.168.1.10:5174 npm run test:ui
//
// Screenshots go to evidence/ui-acceptance/. CHROME_PATH overrides the browser.
import {chromium} from 'playwright-core';
import {mkdirSync} from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const SHOTS = process.env.SHOTS || 'evidence/ui-acceptance';
mkdirSync(SHOTS, {recursive: true});

const browser = await chromium.launch({
 executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
 headless: true,
 args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'en-GB'});
const page = await context.newPage();
const problems = [];
const check = (name, ok, detail = '') => {
 console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
 if (!ok) problems.push(name);
};
page.on('pageerror', error => problems.push('pageerror: ' + error.message));
page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
page.on('response', response => { if (response.status() >= 400) console.log('HTTP', response.status(), response.url()); });
const shot = async name => page.screenshot({path: `${SHOTS}/${name}.png`});

try {
 // 1. Dashboard over LAN
 await page.goto(BASE, {waitUntil: 'networkidle'});
 await page.getByRole('heading', {name: 'Research dashboard'}).waitFor({timeout: 15000});
 check('dashboard loads over LAN', true);
 check('local demo badge', await page.getByText('LOCAL DEMO').isVisible());
 check('project row', await page.getByText('Live check · EC motors Q3').first().isVisible());
 check('approved finding count', (await page.locator('.stat').filter({hasText: 'Approved findings'}).innerText()).includes('01'));
 check('saved report count', (await page.locator('.stat').filter({hasText: 'Saved reports'}).innerText()).includes('01'));
 await shot('01-dashboard');

 // 1b. Chinese hot switch, persistence and switch back
 await page.getByRole('button', {name: '中文', exact: true}).click();
 await page.getByRole('heading', {name: '研究工作台'}).waitFor({timeout: 10000});
 check('switch to Chinese without reload', true);
 check('Chinese navigation label', await page.getByRole('button', {name: '数据来源'}).isVisible());
 check('Chinese document title', (await page.title()).includes('市场情报'));
 await shot('01b-dashboard-zh');
 await page.reload({waitUntil: 'networkidle'});
 await page.getByRole('heading', {name: '研究工作台'}).waitFor({timeout: 10000});
 check('Chinese choice persists after reload', true);
 await page.getByRole('button', {name: 'EN', exact: true}).click();
 await page.getByRole('heading', {name: 'Research dashboard'}).waitFor({timeout: 10000});
 check('switch back to English without reload', true);

 // 2. Open project (completed project opens insights)
 await page.getByRole('button', {name: /Live check · EC motors Q3/}).first().click();
 await page.getByRole('heading', {name: 'Insights & evidence'}).waitFor({timeout: 10000});
 check('project opens insights', true);
 check('accepted badge present', await page.locator('.finding-card .badge.accepted').first().isVisible());
 check('accepted total shown', (await page.locator('.review-total').innerText()).includes('1 / 1'));
 await shot('02-insights');

 // 3. Review filters
 await page.getByRole('button', {name: /^Accepted/}).click();
 check('accepted filter keeps finding', (await page.locator('.finding-card').count()) === 1);
 await page.getByRole('button', {name: /^Rejected/}).click();
 check('rejected filter empties list', (await page.locator('.finding-card').count()) === 0);
 await page.getByRole('button', {name: /^All findings/}).click();
 check('all filter restores finding', (await page.locator('.finding-card').count()) === 1);

 // 4. Evidence review
 await page.getByRole('button', {name: 'Review evidence'}).first().click();
 await page.getByRole('heading', {name: 'Evidence review'}).waitFor({timeout: 10000});
 check('evidence review page', true);
 check('supporting quote rendered', await page.locator('blockquote').first().isVisible());
 check('source link present', await page.getByText('Open public source').isVisible());
 check('save disabled when unchanged', await page.getByRole('button', {name: 'Save changes'}).isDisabled());
 check('accept available for pending decision', await page.getByRole('button', {name: /Accept/}).isEnabled());
 await shot('03-evidence');
 await page.getByRole('button', {name: /Back to insights/}).click();
 await page.getByRole('heading', {name: 'Insights & evidence'}).waitFor({timeout: 10000});

 // 5. Progress page
 await page.getByRole('button', {name: /Research progress/}).click();
 await page.getByRole('heading', {name: 'Research progress'}).waitFor({timeout: 10000});
 check('progress page', true);
 check('sources saved count', (await page.locator('.progress-stats').innerText()).includes('1'));
 check('host queue shown', await page.getByText('Host execution queue').isVisible());
 check('assistant panel shown', await page.getByText('Ask about this project').isVisible());
 await shot('04-progress');

 // 5b. Coverage notices follow the interface language
 await page.getByRole('button', {name: '中文', exact: true}).click();
 await page.waitForTimeout(400);
 const notices = await page.locator('.log-row').allInnerTexts();
 check('coverage notices localized', !notices.some(text => /Publication date unknown|No readable page content|DeepSeek fetch/.test(text)));
 check('localized notice present', notices.some(text => text.includes('发布日期未知')));
 await shot('04b-progress-zh');
 await page.getByRole('button', {name: 'EN', exact: true}).click();
 await page.waitForTimeout(300);

 // 6. Assistant interaction over SSE
 const assistantInput = page.locator('input[aria-label="Ask the research assistant"]');
 await assistantInput.fill('Which finding is accepted and what does its quote say? One sentence.');
 await page.getByRole('button', {name: 'Send'}).click();
 await page.waitForFunction(() => {
  const nodes = document.querySelectorAll('.assistant-turn.assistant p');
  const last = nodes[nodes.length - 1];
  return last && last.textContent.length > 20;
 }, {timeout: 30000});
 await page.waitForFunction(() => !document.querySelector('.assistant-status'), {timeout: 30000});
 const answer = await page.locator('.assistant-turn.assistant p').last().innerText();
 check('assistant answered over SSE', answer.length > 20, answer.slice(0, 120));
 check('streaming state cleared', (await page.locator('.assistant-status').count()) === 0);
 check('assistant cites the finding', /nidec|accepted|quote/i.test(answer));
 await page.locator('section.assistant').scrollIntoViewIfNeeded();
 await shot('05-assistant');

 // 7. Report page
 await page.getByRole('button', {name: /Comparison & report/}).click();
 await page.getByRole('heading', {name: 'Comparison & report'}).waitFor({timeout: 10000});
 check('report page', true);
 const selector = page.locator('select[aria-label="Select saved report version"]');
 const options = await selector.locator('option').count();
 check('saved report option listed', options > 1, `${options} options`);
 await selector.selectOption({index: 1});
 await page.locator('.report-document').waitFor({timeout: 10000});
 await page.locator('.report-document').scrollIntoViewIfNeeded();
 check('report document rendered', await page.locator('.report-document h1').isVisible());
 check('approved finding in report', (await page.locator('.report-document').innerText()).includes('Nidec'));
 check('limitations listed', (await page.locator('.report-document').innerText()).includes('Only human-approved findings'));
 await shot('06-report');

 // 7b. Report limitations follow the interface language
 await page.getByRole('button', {name: '中文', exact: true}).click();
 await page.waitForTimeout(400);
 const limitations = await page.locator('.report-document li').allInnerTexts();
 check('report limitations localized', limitations.some(text => text.includes('只包含人工批准的发现')) && !limitations.some(text => /Only human-approved|Publication date unknown/.test(text)));
 await shot('06b-report-zh');
 await page.getByRole('button', {name: 'EN', exact: true}).click();
 await page.waitForTimeout(300);

 // 7c. Settings page (admin view)
 await page.getByRole('button', {name: 'Settings', exact: true}).click();
 await page.getByRole('heading', {name: 'Settings', exact: true}).waitFor({timeout: 10000});
 check('settings page', true);
 check('role selector present', await page.locator('select').first().isVisible());
 check('agent tools section present', await page.getByText('Agent tools').isVisible());
 check('OCR section present', await page.getByRole('heading', {name: 'Document parsing'}).isVisible());
 const provider = page.getByLabel('OCR provider');
 const endpoint = page.getByLabel('API endpoint');
 await provider.selectOption('official');
 check('official endpoint autofilled', (await endpoint.inputValue()) === 'https://mineru.net/api/v4');
 await provider.selectOption('local');
 check('local endpoint autofilled', (await endpoint.inputValue()) === 'http://127.0.0.1:8000');
 await shot('09-settings');

 // 8. Mobile viewport
 await page.setViewportSize({width: 390, height: 844});
 await page.goto(BASE, {waitUntil: 'networkidle'});
 await page.getByRole('heading', {name: 'Research dashboard'}).waitFor({timeout: 10000});
 check('mobile dashboard renders', await page.getByText('Research dashboard').isVisible());
 check('mobile navigation toggle', await page.getByRole('button', {name: 'Open navigation'}).isVisible());
 await shot('07-mobile-dashboard');
 check('mobile status column visible', await page.locator('.projects-table .badge').first().isVisible());
 await page.getByRole('button', {name: 'Open navigation'}).click();
 check('mobile sidebar opens', await page.getByRole('button', {name: /New Research/}).isVisible());
 check('mobile backdrop shown', await page.locator('.nav-backdrop').isVisible());
 await shot('08-mobile-nav');
 await page.locator('.mobile-close').click();
 check('close button dismisses sidebar', (await page.locator('.sidebar.open').count()) === 0);
 await page.getByRole('button', {name: 'Open navigation'}).click();
 await page.locator('.nav-backdrop').click({position: {x: 380, y: 400}});
 check('backdrop dismisses sidebar', (await page.locator('.sidebar.open').count()) === 0);
} catch (error) {
 problems.push('script: ' + error.message);
 console.log('FAIL  script —', error.message);
} finally {
 await browser.close();
}
console.log('\nconsole/page errors:', problems.length ? problems : 'none');
if (problems.length) process.exitCode = 1;
