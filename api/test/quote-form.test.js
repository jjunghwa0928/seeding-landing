'use strict';

// assets/quote-form.js의 제출 실패 처리를 실제 파일 그대로 실행해 확인한다.
// 브라우저가 없으므로 스크립트가 쓰는 DOM만 흉내 낸다 (vm + 가짜 document).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'quote-form.js'), 'utf8');
const VALID_VALUES = {
  'qf-company': '엔클루코스메틱',
  'qf-contactName': '홍길동',
  'qf-phone': '010-0000-0000',
  'qf-email': 'hong@example.com',
  'qf-quantity': '50~100명',
  'qf-message': '',
  'qf-website': ''
};

function fakeElement(tag) {
  const el = {
    tagName: tag,
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    focused: false,
    children: [],
    attrs: {},
    listeners: {},
    classList: { add() {}, remove() {} },
    style: {},
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; },
    getAttribute(k) { return el.attrs[k]; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    appendChild(child) { el.children.push(child); return child; },
    focus() { el.focused = true; },
    querySelectorAll() { return []; }
  };
  // textContent를 대입하면 자식이 비워지는 DOM 동작까지 따라 한다.
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text + el.children.map((c) => c.textContent).join(''); },
    set(v) { text = String(v); el.children = []; }
  });
  return el;
}

function loadForm(fetchImpl) {
  const dialog = fakeElement('dialog');
  const byId = new Map();
  dialog.querySelector = (selector) => {
    if (!byId.has(selector)) {
      const el = fakeElement('div');
      const id = selector.replace(/^#/, '');
      if (id in VALID_VALUES) el.value = VALID_VALUES[id];
      if (id === 'qf-consent') el.checked = true;
      byId.set(selector, el);
    }
    return byId.get(selector);
  };
  const documentStub = {
    createElement: (tag) => (tag === 'dialog' ? dialog : fakeElement(tag)),
    getElementById: () => null,
    addEventListener() {},
    body: fakeElement('body'),
    documentElement: fakeElement('html')
  };
  const windowStub = {
    location: { hostname: 'influencer.enclu.com', href: 'https://influencer.enclu.com/', hash: '', search: '', pathname: '/' },
    addEventListener() {}
  };
  const context = {
    window: windowStub,
    document: documentStub,
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    fetch: fetchImpl,
    setTimeout
  };
  vm.runInNewContext(SOURCE, context);
  return {
    status: dialog.querySelector('#qf-status'),
    fieldError: (key) => dialog.querySelector(`#qf-${key}-err`).textContent,
    field: (key) => dialog.querySelector(`#qf-${key}`),
    submitBtn: dialog.querySelector('.qf-submit'),
    success: dialog.querySelector('#qf-success'),
    submit() {
      const [handler] = dialog.querySelector('#qf-form').listeners.submit;
      handler({ preventDefault() {} });
      return new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function htmlResponse(status) {
  return { ok: false, status, json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
}

function jsonResponse(status, body) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

function assertMailFallback(form) {
  assert.equal(form.status.textContent, '전송에 실패했습니다. 메일 앱으로 보내기');
  const [link] = form.status.children;
  assert.match(link.href, /^mailto:mkt2@enclu\.co\.kr\?/);
  assert.doesNotMatch(form.status.textContent, /입력/);
  assert.equal(form.submitBtn.disabled, false);
}

describe('quote-form.js 제출 실패 처리', () => {
  for (const status of [404, 405, 411, 413, 500, 502, 503]) {
    test(`${status} HTML 응답은 메일 대체 링크를 보여 준다`, async () => {
      const form = loadForm(() => Promise.resolve(htmlResponse(status)));
      await form.submit();
      assertMailFallback(form);
    });
  }

  test('JSON 404도 입력을 탓하지 않는다', async () => {
    const form = loadForm(() => Promise.resolve(jsonResponse(404, { ok: false, error: 'not_found', fields: { company: 'x' } })));
    await form.submit();
    assertMailFallback(form);
    assert.equal(form.fieldError('company'), '');
  });

  test('네트워크 오류는 메일 대체 링크를 보여 준다', async () => {
    const form = loadForm(() => Promise.reject(new TypeError('Failed to fetch')));
    await form.submit();
    assertMailFallback(form);
  });

  test('400 + fields는 항목별 오류를 표시하고 첫 항목으로 이동한다', async () => {
    const form = loadForm(() => Promise.resolve(jsonResponse(400, {
      ok: false,
      error: 'invalid_input',
      fields: { phone: '연락처 형식을 확인해 주세요.', email: '이메일 형식을 확인해 주세요.' }
    })));
    await form.submit();
    assert.equal(form.fieldError('phone'), '연락처 형식을 확인해 주세요.');
    assert.equal(form.fieldError('email'), '이메일 형식을 확인해 주세요.');
    assert.equal(form.field('phone').focused, true);
    assert.equal(form.status.textContent, '');
  });

  const unusable = [
    ['fields 없음 (captcha_failed)', () => jsonResponse(400, { ok: false, error: 'captcha_failed' })],
    ['빈 fields', () => jsonResponse(400, { ok: false, fields: {} })],
    ['폼에 없는 항목뿐인 fields', () => jsonResponse(400, { ok: false, fields: { unknown: 'x' } })],
    ['문자열 fields', () => jsonResponse(400, { ok: false, fields: 'bad' })],
    ['null 본문', () => jsonResponse(400, null)],
    ['JSON이 아닌 본문', () => htmlResponse(400)]
  ];
  for (const [label, response] of unusable) {
    test(`400 ${label}: 입력을 탓하지 않고 메일 대체 링크를 보여 준다`, async () => {
      const form = loadForm(() => Promise.resolve(response()));
      await form.submit();
      assertMailFallback(form);
    });
  }

  test('429는 잠시 후 재시도 안내를 유지한다', async () => {
    const form = loadForm(() => Promise.resolve(jsonResponse(429, { ok: false, error: 'rate_limited' })));
    await form.submit();
    assert.equal(form.status.textContent, '잠시 후 다시 시도해 주세요.');
    assert.equal(form.status.children.length, 0);
    assert.equal(form.submitBtn.disabled, false);
  });

  test('200은 성공 화면을 보여 준다', async () => {
    const form = loadForm(() => Promise.resolve(jsonResponse(200, { ok: true })));
    await form.submit();
    assert.equal(form.success.hidden, false);
    assert.equal(form.status.textContent, '');
  });
});
