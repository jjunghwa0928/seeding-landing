'use strict';

// tool.html 의 예상 실적 계산·표시를 가짜 DOM 위에서 실제 스크립트로 확인한다. 레이아웃은 여기서 확인하지 못한다.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'tool.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const mainScript = scripts.find((s) => s.includes('WEEDY_BENCHMARKS'));
const stickyScript = scripts.find((s) => s.includes('sticky-reach'));

class FakeElement {
  constructor() {
    this.children = [];
    this.ownText = '';
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.classList = { add() {}, toggle() {} };
  }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, event = {}) { (this.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...event })); }
  querySelector(selector) { return this[selector] || (this[selector] = new FakeElement()); }
}

function loadPage() {
  const byId = {};
  let frames = new Map();
  let nextFrame = 1;
  const observers = [];
  const sandbox = {
    document: {
      getElementById: (id) => byId[id] || (byId[id] = new FakeElement()),
      createElement: () => new FakeElement(),
      querySelectorAll: () => []
    },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    requestAnimationFrame(fn) { frames.set(nextFrame, fn); return nextFrame++; },
    cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class {
      constructor(fn) { observers.push(fn); }
      observe() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mainScript, sandbox);
  vm.runInContext(stickyScript, sandbox);

  const page = {
    text: (id) => byId[id].textContent,
    pendingFrames: () => frames.size,
    // 이번에 쌓인 프레임을 시각 ts 로 한 번 실행한다
    runFrames(ts) {
      const current = frames;
      frames = new Map();
      current.forEach((fn) => fn(ts));
    },
    settle() {
      page.runFrames(0);
      page.runFrames(10000);
    },
    drag(pos) {
      byId['qty-range'].value = pos;
      byId['qty-range'].fire('input');
    },
    pick(group, value) {
      const btn = byId[group].children[0].children.find((c) => c.getAttribute('data-value') === value);
      btn.fire('click');
    },
    arrow(key, repeat) { byId['qty-range'].fire('keydown', { key, repeat }); },
    syncSticky() { observers.forEach((fn) => fn()); },
    setText(id, value) { byId[id].textContent = value; },
    context: () => sandbox.encluQuoteContext()
  };
  page.settle();
  return page;
}

// 슬라이더 눈금 위치: 10, 50, 100, 200, 500, 500+
const POS = { 10: 0, 50: 100, 100: 200, 200: 300, 500: 400, 510: 500 };
const ROUNDED = /^(\d{1,3}(,\d{3})*,000|[1-9]00)(명|회) 이상$/;

describe('tool.html estimate', () => {
  let page;
  beforeEach(() => {
    page = loadPage();
  });

  test('truncation: one function covers every band', () => {
    const src = mainScript.match(/function truncateEstimate\([\s\S]*?\n {2}\}/)[0];
    const fmt = (n) => n.toLocaleString('ko-KR');
    const truncate = new Function('fmt', `${src}; return truncateEstimate;`)(fmt);
    const shown = (v) => { const t = truncate(v, '명'); return t.text + t.suffix; };
    assert.equal(shown(12345), '12,000명 이상');
    assert.equal(shown(1000), '1,000명 이상');
    assert.equal(shown(999), '900명 이상');
    assert.equal(shown(100), '100명 이상');
    assert.equal(shown(99), '100명 미만');
    assert.equal(shown(999.6), '900명 이상'); // 반올림 금지 — 내림만
    assert.equal(shown(99.6), '100명 미만');
    assert.equal(truncate(0, '회').text + truncate(0, '회').suffix, '100회 미만');
  });

  test('skincare values for qty × tier match the conservative formula', () => {
    const expected = {
      micro: { 10: ['26,000명 이상', '1,000회 이상'], 50: ['131,000명 이상', '6,000회 이상'], 100: ['263,000명 이상', '13,000회 이상'], 500: ['1,316,000명 이상', '69,000회 이상'] },
      macro: { 10: ['65,000명 이상', '3,000회 이상'], 50: ['329,000명 이상', '17,000회 이상'], 100: ['658,000명 이상', '34,000회 이상'], 500: ['3,290,000명 이상', '173,000회 이상'] }
    };
    for (const [tier, byQty] of Object.entries(expected)) {
      page.pick('seg-tier', tier);
      for (const [qty, [reach, engagement]] of Object.entries(byQty)) {
        page.drag(POS[qty]);
        page.settle();
        assert.equal(page.text('out-reach'), reach, `${tier} ${qty} reach`);
        assert.equal(page.text('out-engagement'), engagement, `${tier} ${qty} engagement`);
      }
    }
  });

  test('every slider stop, tier and category follows the rounding rule', () => {
    for (const category of ['skincare', 'color', 'body', 'food']) {
      page.pick('seg-category', category);
      for (const tier of ['nano', 'micro', 'macro']) {
        page.pick('seg-tier', tier);
        page.drag(POS[10]);
        page.settle();
        for (let i = 0; i < 60; i++) {
          assert.match(page.text('out-reach'), ROUNDED, `${category} ${tier} step ${i}`);
          assert.match(page.text('out-engagement'), ROUNDED, `${category} ${tier} step ${i}`);
          page.arrow('ArrowRight', true);
          if (page.text('out-reach') === '별도 협의') break;
        }
        assert.equal(page.text('out-reach'), '별도 협의', 'the last stop is negotiable');
      }
    }
  });

  test('the widest value is the one the CSS is sized for', () => {
    page.pick('seg-category', 'color');
    page.pick('seg-tier', 'macro');
    page.drag(POS[500]);
    page.settle();
    assert.equal(page.text('out-reach'), '3,987,000명 이상');
    assert.ok(html.includes('"3,987,000명 이상"'));
  });

  test('dragging the slider sets numbers at once, without animation', () => {
    for (const pos of [0, 100, 200, 300, 400, 300, 200]) {
      page.drag(pos);
      assert.equal(page.pendingFrames(), 0, `pos ${pos}`);
      assert.match(page.text('out-reach'), ROUNDED);
    }
    assert.equal(page.text('out-reach'), '263,000명 이상');
  });

  test('a drag cancels a running animation', () => {
    page.pick('seg-tier', 'macro');
    assert.ok(page.pendingFrames() > 0);
    page.drag(POS[10]);
    page.runFrames(0);
    assert.equal(page.pendingFrames(), 0);
    assert.equal(page.text('out-reach'), '65,000명 이상');
  });

  test('discrete changes animate for at most 350ms and every frame is rounded', () => {
    page.pick('seg-tier', 'macro');
    page.runFrames(0);
    for (const ts of [50, 100, 200, 300]) {
      assert.match(page.text('out-reach'), ROUNDED, `at ${ts}`);
      page.runFrames(ts);
    }
    page.runFrames(350);
    assert.equal(page.pendingFrames(), 0, 'finished by 350ms');
    assert.equal(page.text('out-reach'), '329,000명 이상');
  });

  test('held arrow keys do not restart the animation, a single press animates', () => {
    page.arrow('ArrowRight', true);
    assert.equal(page.pendingFrames(), 0);
    page.arrow('ArrowRight', false);
    assert.ok(page.pendingFrames() > 0);
  });

  test('negotiable: mega tier and 500+ show text, then numbers come back', () => {
    page.pick('seg-tier', 'mega');
    assert.equal(page.text('out-reach'), '별도 협의');
    assert.equal(page.text('out-engagement'), '별도 협의');
    page.pick('seg-tier', 'micro');
    page.settle();
    assert.equal(page.text('out-reach'), '131,000명 이상');
    page.drag(POS[510]);
    assert.equal(page.text('out-reach'), '별도 협의');
  });

  test('sticky bar follows the main metrics and never rounds up', () => {
    page.syncSticky();
    assert.equal(page.text('sticky-reach'), '13.1만명+');
    assert.equal(page.text('sticky-eng'), '6,000회+');
    page.setText('out-reach', '1,999,000명 이상');
    page.setText('out-engagement', '100회 미만');
    page.syncSticky();
    assert.equal(page.text('sticky-reach'), '199만명+');
    assert.equal(page.text('sticky-eng'), '100회 미만');
    page.setText('out-reach', '별도 협의');
    page.syncSticky();
    assert.equal(page.text('sticky-reach'), '별도 협의');
  });

  test('the quote context carries no estimate numbers', () => {
    assert.deepEqual(Object.keys(page.context()), ['category', 'tier', 'quantity', 'goal', 'voucher']);
  });
});
