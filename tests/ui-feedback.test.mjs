import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const stylesheetPaths = ['/css/main.css', '/css/observatory.css', '/css/contact-edit.css', '/css/settings.css', '/css/auth.css'];
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${stylesheetPaths.map(path => `<link rel="stylesheet" href="${path}">`).join('')}</head><body><main id="main-content" tabindex="-1"><button id="confirm-trigger">Confirm</button><button id="prompt-trigger">Prompt</button><button id="form-trigger">Form dialog</button><button id="space-form-trigger">Whitespace form</button><button id="toast-trigger">Toast</button><label id="field-wrap">Workspace name<input id="name-field" autocomplete="off"></label><section class="contact-edit-grid"><label class="contact-edit-field">Contact email<input class="form-input" id="contact-email" type="email"></label><label class="contact-edit-field">Contact website<input class="form-input" id="contact-url" type="url"></label></section><form class="auth-form"><label>Password<input id="auth-password" type="password"></label></form><form class="settings-scoring-form"><label>Maximum score<input id="settings-number" type="number"></label><label>Schedule<select id="settings-select"><option>Weekdays</option></select></label></form><label>Notes<textarea id="settings-notes"></textarea></label><div class="command-input"><input id="command-query" aria-label="Command search"></div></main><script type="module">
import {clearFieldError,confirmAction,notify,openDialog,promptText,showFieldError} from '/js/ui.js';
window.results={};
window.emitTestToast=notify;
document.getElementById('confirm-trigger').addEventListener('click',async()=>{window.results.confirm=await confirmAction({title:'Archive this campaign?',message:'Recipients and history remain saved.',confirmLabel:'Archive campaign',danger:true});});
document.getElementById('prompt-trigger').addEventListener('click',async()=>{window.results.prompt=await promptText({title:'Duplicate campaign',message:'Give the new draft a name.',label:'Campaign name',value:'Campaign copy',submitLabel:'Create draft'});});
document.getElementById('form-trigger').addEventListener('click',()=>{window.formDialog=openDialog({title:'Create contact',body:'<label class="studio-field"><span>Email</span><input name="email" type="email" required></label>',submitLabel:'Save contact',onSubmit:async form=>{if(form.get('email')==='fail@example.test')throw new Error('Synthetic validation failure');window.results.email=form.get('email');}});});
document.getElementById('space-form-trigger').addEventListener('click',()=>{window.spaceDialog=openDialog({title:'Required text',body:'<label class="studio-field"><span>Workspace name</span><input name="value" required></label>',submitLabel:'Save value',onSubmit:async form=>{window.results.space=form.get('value');}});});
document.getElementById('toast-trigger').addEventListener('click',()=>{notify('A/B data <ready>','info');notify('SMTP failed','error');});
window.showTestFieldError=()=>showFieldError(document.getElementById('name-field'),'Enter a workspace name.');
window.clearTestFieldError=()=>clearFieldError(document.getElementById('name-field'));
</script></body></html>`;

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  const asset = pathname === '/js/ui.js' ? path.join(root, 'js', 'ui.js')
    : pathname.startsWith('/css/') && stylesheetPaths.includes(pathname) ? path.join(root, 'css', path.basename(pathname)) : null;
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
  fs.createReadStream(asset).pipe(response);
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('workspace action feedback is accessible, keyboard-operable, field-linked and free of native dialogs', async t => {
  if (!fs.existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const nativeDialogs = [];
  const pageErrors = [];
  page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Confirm' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Archive this campaign?' });
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Recipients and history remain saved/);
    const dialogMotion = await confirm.evaluate(node => ({ name: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration }));
    assert.equal(dialogMotion.name, 'dialog-enter', 'workspace dialogs use the shared entrance motion');
    assert.equal(dialogMotion.duration, '0.16s', 'dialog motion stays short');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => window.results.confirm === false);
    assert.equal(await page.evaluate(() => window.results.confirm), false, 'cancel keeps the destructive action from being confirmed');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-trigger', 'closing returns keyboard focus to the action that opened the dialog');

    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('button', { name: 'Archive campaign' }).click();
    await page.waitForFunction(() => window.results.confirm === true);
    assert.equal(await page.evaluate(() => window.results.confirm), true, 'the explicit primary action confirms');

    await page.getByRole('button', { name: 'Prompt' }).click();
    const promptField = page.getByRole('textbox', { name: 'Campaign name' });
    await promptField.fill('   ');
    await promptField.press('Enter');
    assert.equal(await promptField.getAttribute('aria-invalid'), 'true', 'blank prompt values receive an inline field error');
    await promptField.fill('  Follow-up draft  ');
    await promptField.press('Enter');
    await page.waitForFunction(() => window.results.prompt === 'Follow-up draft');
    assert.equal(await page.evaluate(() => window.results.prompt), 'Follow-up draft', 'prompt trims the value and submits from the keyboard');
    await page.getByRole('button', { name: 'Prompt' }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.results.prompt === null);
    assert.equal(await page.evaluate(() => window.results.prompt), null, 'Escape cancels text entry');
    await page.getByRole('button', { name: 'Confirm' }).click();
    const backdropDialog = page.getByRole('alertdialog', { name: 'Archive this campaign?' });
    await backdropDialog.waitFor();
    const box = await backdropDialog.boundingBox();
    await page.mouse.click(4, 4);
    await page.waitForFunction(() => window.results.confirm === false);
    assert.equal(await backdropDialog.count(), 0, 'clicking outside the modal dismisses it as a cancellation');
    assert.ok(box, 'confirmation dialog is laid out before backdrop interaction');

    await page.getByRole('button', { name: 'Form dialog' }).click();
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('not-an-email');
    await page.getByRole('button', { name: 'Save contact' }).click();
    const dialogEmail = page.locator('.studio-dialog input[name="email"]');
    assert.equal(await dialogEmail.getAttribute('aria-invalid'), 'true', 'invalid email fields show an inline error instead of a browser validation popup');
    await dialogEmail.fill('fail@example.test');
    await page.getByRole('button', { name: 'Save contact' }).click();
    await page.getByRole('alert').getByText('Synthetic validation failure').waitFor();
    assert.equal(await page.locator('.studio-dialog').count(), 1, 'a failed save keeps its dialog open with an inline error');
    await dialogEmail.fill('valid@example.test');
    await page.getByRole('button', { name: 'Save contact' }).click();
    assert.equal(await page.evaluate(() => window.results.email), 'valid@example.test', 'a successful save returns the submitted form data');

    await page.getByRole('button', { name: 'Whitespace form' }).click();
    const requiredText = page.locator('.studio-dialog input[name="value"]');
    await requiredText.fill('   ');
    await page.getByRole('button', { name: 'Save value' }).click();
    assert.equal(await requiredText.getAttribute('aria-invalid'), 'true', 'required fields reject whitespace-only values before submission');
    assert.equal(await page.locator('.studio-dialog .field-error').innerText(), 'Enter a value before continuing.');
    assert.equal(await page.evaluate(() => window.results.space), undefined, 'invalid whitespace never reaches the save handler');
    await requiredText.fill('Launch workspace');
    assert.equal(await requiredText.getAttribute('aria-invalid'), null, 'typing a value clears the whitespace validation state');
    await page.getByRole('button', { name: 'Save value' }).click();
    assert.equal(await page.evaluate(() => window.results.space), 'Launch workspace', 'valid text submits after inline recovery');

    await page.evaluate(() => window.showTestFieldError());
    const field = page.locator('#name-field');
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
    const errorId = await field.getAttribute('aria-describedby');
    assert.equal(await page.locator(`#${errorId}`).innerText(), 'Enter a workspace name.');
    await field.fill('Launch workspace');
    assert.equal(await field.getAttribute('aria-invalid'), null, 'editing an invalid field clears its inline error');

    await page.getByRole('button', { name: 'Toast' }).click();
    const error = page.getByRole('alert').getByText('SMTP failed');
    await error.waitFor();
    assert.equal(await page.locator('#notification-region .studio-toast').count(), 1, 'a new desktop notification replaces the toast that would otherwise stack over page content');
    assert.equal(await page.getByRole('status').count(), 0, 'the replaced status notification is removed from the live region');
    assert.deepEqual(await page.locator('#notification-region .studio-toast').evaluate(node => ({
      region: getComputedStyle(node.parentElement).pointerEvents,
      toast: getComputedStyle(node).pointerEvents,
      dismiss: getComputedStyle(node.querySelector('.studio-toast-dismiss')).pointerEvents,
    })), { region: 'none', toast: 'none', dismiss: 'auto' }, 'desktop notification surfaces do not block controls underneath them');
    const toastMotion = await page.locator('.studio-toast').first().evaluate(node => ({ name: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration }));
    assert.equal(toastMotion.name, 'toast-enter');
    assert.equal(toastMotion.duration, '0.16s', 'notifications use the shared, short overlay motion');
    await error.locator('..').getByRole('button', { name: 'Dismiss notification' }).click();
    assert.equal(await page.getByRole('alert').count(), 0, 'notifications can be dismissed without blocking the page');
    await page.evaluate(() => window.emitTestToast('A/B data <ready>', 'info'));
    const info = page.getByRole('status').getByText('A/B data <ready>');
    await info.waitFor();
    assert.equal(await page.locator('#notification-region').innerText().then(text => text.includes('<ready>')), true, 'notification text is inserted as text, not interpreted as HTML');
    await info.locator('..').getByRole('button', { name: 'Dismiss notification' }).click();
    assert.equal(await page.locator('#notification-region .studio-toast').count(), 0);

    const controlStyle = await field.evaluate(node => ({ height: parseFloat(getComputedStyle(node).height), transition: getComputedStyle(node).transitionDuration }));
    assert.ok(controlStyle.height >= 42, `text input has a usable height (${controlStyle.height}px)`);
    assert.match(controlStyle.transition, /0\.15s|150ms/);
    const fieldMetrics = await page.evaluate(() => ['contact-email', 'contact-url', 'auth-password', 'settings-number', 'settings-select', 'settings-notes'].map(id => {
      const node = document.getElementById(id);
      const style = getComputedStyle(node);
      return { id, height: parseFloat(style.height), fontSize: parseFloat(style.fontSize), borderColor: style.borderTopColor, backgroundColor: style.backgroundColor };
    }));
    for (const metric of fieldMetrics) {
      assert.ok(metric.height >= 42, `${metric.id} has a usable control height (${metric.height}px)`);
      assert.ok(metric.fontSize >= 12, `${metric.id} text stays readable (${metric.fontSize}px)`);
      assert.notEqual(metric.borderColor, 'rgba(0, 0, 0, 0)', `${metric.id} has a visible boundary`);
    }
    assert.notEqual(fieldMetrics.find(metric => metric.id === 'auth-password').backgroundColor, fieldMetrics.find(metric => metric.id === 'contact-email').backgroundColor, 'page-specific control surfaces are no longer flattened by a global important override');
    assert.equal(await page.locator('#command-query').evaluate(node => getComputedStyle(node).borderTopWidth), '0px', 'the command-palette search remains intentionally integrated into its own control');
    await page.getByRole('button', { name: 'Confirm' }).hover();
    assert.notEqual(await page.getByRole('button', { name: 'Confirm' }).evaluate(node => getComputedStyle(node).transform), 'none', 'every enabled button gets a restrained hover response');
    const buttonMotion = await page.getByRole('button', { name: 'Confirm' }).evaluate(node => getComputedStyle(node).transitionDuration);
    assert.match(buttonMotion, /0\.14s/, 'button feedback uses the shared fast-motion token');
    assert.match(appSource, /view\.className\s*=\s*`page-view view-\$\{viewId\}`/, 'the actual SPA route renderer attaches the animated page-view class');
    await page.evaluate(() => {
      const view = document.createElement('div');
      view.id = 'route-motion-probe';
      view.className = 'page-view view-leads';
      view.textContent = 'Lead pipeline';
      document.querySelector('#main-content').append(view);
    });
    const routeMotion = await page.locator('#route-motion-probe').evaluate(node => ({
      name: getComputedStyle(node).animationName,
      duration: getComputedStyle(node).animationDuration,
      easing: getComputedStyle(node).animationTimingFunction,
      playState: node.getAnimations()[0]?.playState,
      keyframes: node.getAnimations()[0]?.effect.getKeyframes(),
    }));
    assert.equal(routeMotion.name, 'workspace-reveal');
    assert.equal(routeMotion.duration, '0.18s', 'route changes finish their content entrance quickly');
    assert.equal(routeMotion.easing, 'cubic-bezier(0.2, 0.75, 0.25, 1)');
    assert.equal(routeMotion.playState, 'running', 'route content actually animates in the browser');
    assert.equal(routeMotion.keyframes[0].transform, undefined, 'route entrance avoids transforms that would reposition fixed overlays');
    await page.locator('#route-motion-probe').evaluate(node => node.getAnimations()[0].finished);
    assert.equal(await page.locator('#route-motion-probe').evaluate(node => getComputedStyle(node).opacity), '1', 'route content settles cleanly after the transition');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#toast-trigger').evaluate(node => getComputedStyle(node).transitionDuration), '0s', 'reduced motion disables control transitions');
    assert.equal(await page.locator('#route-motion-probe').evaluate(node => getComputedStyle(node).animationName), 'none', 'reduced motion disables route movement');
    await page.getByRole('button', { name: 'Confirm' }).hover();
    assert.equal(await page.getByRole('button', { name: 'Confirm' }).evaluate(node => getComputedStyle(node).transform), 'none', 'reduced motion disables hover movement');
    await page.getByRole('button', { name: 'Confirm' }).click();
    const reducedDialog = page.getByRole('alertdialog', { name: 'Archive this campaign?' });
    await reducedDialog.waitFor();
    assert.equal(await reducedDialog.evaluate(node => getComputedStyle(node).animationName), 'none', 'reduced motion also disables dialog entrances');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.setViewportSize({ width: 390, height: 360 });
    await page.evaluate(() => {
      document.body.innerHTML = '';
      const shell = document.createElement('div');
      shell.id = 'app';
      shell.innerHTML = `<main class="auth-page"><section class="auth-card" aria-labelledby="setup-title"><div class="auth-brand">oddecosys</div><span class="eyebrow">LOCAL WORKSPACE ACCESS</span><h1 id="setup-title">Create your workspace account</h1><p class="auth-description">Create the first local administrator account. Your password is stored as a one-way hash.</p><form class="auth-form"><label>Email address<input id="setup-email" type="email"></label><label>Private setup token<input id="setup-token" type="password"></label><label>Password<input id="setup-password" type="password"></label><label>Confirm password<input id="setup-confirm" type="password"></label><button id="setup-submit" class="btn btn-primary auth-submit" type="button">Create local account</button></form><p class="auth-footnote">One local workspace · protected by a private session</p></section></main>`;
      document.body.append(shell);
    });
    const authScroller = page.locator('#app .auth-page');
    const scrollMetrics = await authScroller.evaluate(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, overflowY: getComputedStyle(node).overflowY }));
    assert.equal(scrollMetrics.overflowY, 'auto', 'the auth screen owns scrolling inside the clipped workspace shell');
    assert.ok(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, `short setup screen exposes overflow for scrolling (${JSON.stringify(scrollMetrics)})`);
    const setupHeadingBounds = await page.locator('#setup-title').boundingBox();
    await page.mouse.move(setupHeadingBounds.x + 10, setupHeadingBounds.y + 10);
    await page.mouse.wheel(0, 480);
    await page.waitForFunction(() => document.querySelector('#app .auth-page').scrollTop > 0, null, { timeout: 2000 });
    await authScroller.evaluate(node => { node.scrollTop = 0; });
    await page.locator('#setup-email').focus();
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'setup-submit', 'keyboard navigation reaches the primary setup action');
    const submitBounds = await page.locator('#setup-submit').boundingBox();
    const scrollerBounds = await authScroller.boundingBox();
    assert.ok(submitBounds && scrollerBounds && submitBounds.y + submitBounds.height <= scrollerBounds.y + scrollerBounds.height, `focusing the submit action scrolls it into the visible auth panel (${JSON.stringify({ submitBounds, scrollerBounds, scrollTop: await authScroller.evaluate(node => node.scrollTop) })})`);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const centeredLayout = await page.locator('#app .auth-card').evaluate(card => ({ top: card.getBoundingClientRect().top, shellHeight: document.querySelector('#app .auth-page').clientHeight }));
    assert.ok(centeredLayout.top > 0 && centeredLayout.top < centeredLayout.shellHeight / 2, 'setup card remains centered when the full form fits');
    assert.deepEqual(nativeDialogs, [], 'actions never invoke a browser-native alert, confirm or prompt');
    assert.deepEqual(pageErrors, [], 'browser reports no runtime errors');
  } finally {
    await page.close();
    await browser.close();
  }
});
