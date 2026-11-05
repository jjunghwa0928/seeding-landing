'use strict';

// 실행: cd api && npm test   (node --test)
// AX Hub 영업 리드 전달(sales-lead/2). 외부 네트워크를 쓰지 않도록 가짜 fetch 나 127.0.0.1 서버를 쓴다.

process.env.NODE_ENV = 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, createLeadForwarder, loadConfig, buildLead, validateQuote, MARKETING_TEXT_VERSION, PRIVACY_TEXT_VERSION } = require('../server');

const LEAD_KEY = 'test-lead-key-do-not-log';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEAD_KEYS = [
  'submittedAt', 'company', 'contactName', 'phone', 'email', 'quantity', 'message', 'page', 'inquiryType',
  'utm', 'context', 'privacyConsent', 'privacyTextVersion', 'marketingConsent'
].sort();

// 서버 로그는 화면에 내지 않고 모아서 내용을 검사한다
const origLog = console.log;
const origErr = console.error;
let logs = [];
console.log = (...args) => logs.push(args.join(' '));
console.error = (...args) => logs.push(args.join(' '));
process.on('exit', () => {
  console.log = origLog;
  console.error = origErr;
});

function config(env = { AXHUB_LEAD_KEY: LEAD_KEY }) {
  return { ...loadConfig(env), allowedOrigins: [], turnstileSecret: '' };
}

function validPayload(overrides = {}) {
  return {
    company: '엔클루코스메틱',
    contactName: '홍길동',
    phone: '010-1234-5678',
    email: 'hong@example.com',
    quantity: '50~100명',
    message: '일본 시딩을 고민 중입니다.',
    consent: true,
    source: 'index',
    website: '',
    ...overrides
  };
}

function leadFrom(overrides, at = new Date('2026-11-05T09:02:00.000Z')) {
  const v = validateQuote(validPayload(overrides));
  assert.equal(v.ok, true);
  return buildLead(v.data, at);
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

/** 정해 둔 응답을 차례로 돌려주는 가짜 fetch. Error 를 넣으면 throw 한다. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { status: next };
  };
  return { impl, calls };
}

describe('buildLead', () => {
  test('body has exactly the contract keys and never source', () => {
    const lead = leadFrom({ marketingConsent: { agreed: true, textVersion: MARKETING_TEXT_VERSION } }, new Date('2026-11-05T09:02:00.000Z'));
    assert.deepEqual(Object.keys(lead).sort(), LEAD_KEYS);
    assert.equal(lead.source, undefined);
    assert.deepEqual(Object.keys(lead.marketingConsent).sort(), ['agreed', 'agreedAt', 'textVersion']);
    assert.equal(lead.submittedAt, '2026-11-05T18:02:00.000+09:00');
    assert.equal(lead.company, '엔클루코스메틱');
    assert.equal(lead.contactName, '홍길동');
    assert.equal(lead.phone, '010-1234-5678');
    assert.equal(lead.email, 'hong@example.com');
    assert.equal(lead.quantity, '50~100명');
    assert.equal(lead.message, '일본 시딩을 고민 중입니다.');
    assert.equal(lead.inquiryType, 'quote');
    assert.equal(lead.utm, null);
    assert.equal(lead.privacyConsent, true);
    assert.equal(lead.privacyTextVersion, PRIVACY_TEXT_VERSION);
  });

  test('page: index and voucher are the landing page, tool is tool, anything else is null', () => {
    assert.equal(leadFrom({ source: 'index' }).page, 'index');
    assert.equal(leadFrom({ source: 'voucher' }).page, 'index');
    assert.equal(leadFrom({ source: 'tool' }).page, 'tool');
    assert.equal(leadFrom({ source: 'constructor' }).page, null);
    assert.equal(leadFrom({ source: undefined }).page, null);
  });

  test('empty message becomes null', () => {
    assert.equal(leadFrom({ message: '' }).message, null);
  });

  test('marketingConsent: not agreed → others null', () => {
    assert.deepEqual(leadFrom({}).marketingConsent, { agreed: false, agreedAt: null, textVersion: null });
  });

  test('marketingConsent: agreed → server time in KST with text version', () => {
    const { marketingConsent } = leadFrom({ marketingConsent: { agreed: true, agreedAt: '1999-01-01T00:00:00.000Z', textVersion: MARKETING_TEXT_VERSION } });
    assert.equal(marketingConsent.agreed, true);
    assert.equal(marketingConsent.textVersion, MARKETING_TEXT_VERSION);
    assert.match(marketingConsent.agreedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/);
    assert.ok(!marketingConsent.agreedAt.startsWith('1999'));
  });

  test('context: v6 calculator maps to the contract keys, form vouchers win over the calculator switch', () => {
    const { context } = leadFrom({
      source: 'tool',
      vouchers: ['kosme'],
      context: { category: '스킨케어', tier: '마이크로', quantity: '50건', goal: '인지도 확대', voucher: '미적용' }
    });
    assert.deepEqual(context, {
      category: '스킨케어',
      people: '마이크로 50건',
      goal: '인지도 확대',
      voucher: '중기부(중진공) 보유, 산업부(KOTRA) 미보유'
    });
  });

  test('context: people from a cached old tool.html is kept as is', () => {
    const { context } = leadFrom({ source: 'tool', context: { category: '스킨케어', people: '5–10명', goal: '인지도 확대' } });
    assert.deepEqual(context, { category: '스킨케어', people: '5–10명', goal: '인지도 확대', voucher: '미보유' });
  });

  test('context: without a calculator only voucher is sent', () => {
    assert.deepEqual(leadFrom({}).context, { voucher: '미보유' });
    assert.deepEqual(leadFrom({ vouchers: ['kosme', 'kotra'] }).context, { voucher: '중기부(중진공) 보유, 산업부(KOTRA) 보유' });
  });

  test('context: merged people stays within the value limit', () => {
    const { context } = leadFrom({ context: { tier: 'x'.repeat(100), quantity: 'y'.repeat(100) } });
    assert.equal(context.people.length, 100);
  });
});

describe('loadConfig', () => {
  test('hub forwarding is off without a key, url has a default', () => {
    assert.deepEqual(loadConfig({}).axhub, { leadKey: '', leadsUrl: 'https://axhub.enclu.com/api/sales/leads' });
    assert.equal(loadConfig({ AXHUB_LEAD_KEY: '   ' }).axhub.leadKey, '');
    assert.equal(loadConfig({ AXHUB_LEADS_URL: '' }).axhub.leadsUrl, 'https://axhub.enclu.com/api/sales/leads');
    assert.equal(loadConfig({ AXHUB_LEADS_URL: 'https://hub.example/leads' }).axhub.leadsUrl, 'https://hub.example/leads');
  });
});

describe('POST /api/quote → hub', () => {
  let server;
  let mails;
  let pending;

  // forwardLead 의 Promise 를 잡아 두어 테스트가 전달 완료를 기다릴 수 있게 한다
  async function boot({ fetchImpl, cfg = config(), sendMail, timeoutMs } = {}) {
    if (server) await new Promise((r) => server.close(r));
    mails = [];
    pending = Promise.resolve();
    const forward = createLeadForwarder(cfg, { fetchImpl, retryDelayMs: 0, timeoutMs });
    const app = createApp({
      config: cfg,
      sendMail: sendMail || (async (mail) => { mails.push(mail); return {}; }),
      forwardLead: (...args) => { pending = forward(...args); return pending; }
    });
    server = await listen(app);
  }

  beforeEach(() => { logs = []; });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    server = null;
  });

  test('empty key → no hub call, mail still sent', async () => {
    const hub = fakeFetch(201);
    await boot({ fetchImpl: hub.impl, cfg: config({}) });
    const res = await post(server, validPayload());
    await pending;
    assert.equal(res.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(hub.calls.length, 0);
    assert.ok(!logs.some((line) => line.includes('hub lead')));
  });

  test('request has the contract method, url, headers and body', async () => {
    const hub = fakeFetch(201);
    await boot({ fetchImpl: hub.impl });
    await post(server, validPayload());
    await pending;
    assert.equal(hub.calls.length, 1);
    const { url, init } = hub.calls[0];
    assert.equal(url, 'https://axhub.enclu.com/api/sales/leads');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type', 'Idempotency-Key']);
    assert.equal(init.headers.Authorization, `Bearer ${LEAD_KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.match(init.headers['Idempotency-Key'], UUID_V4);
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), LEAD_KEYS);
  });

  test('AXHUB_LEADS_URL overrides the default', async () => {
    const hub = fakeFetch(201);
    await boot({ fetchImpl: hub.impl, cfg: config({ AXHUB_LEAD_KEY: LEAD_KEY, AXHUB_LEADS_URL: 'https://hub.example/leads' }) });
    await post(server, validPayload());
    await pending;
    assert.equal(hub.calls[0].url, 'https://hub.example/leads');
  });

  test('each submission gets its own Idempotency-Key', async () => {
    const hub = fakeFetch(201);
    await boot({ fetchImpl: hub.impl });
    await post(server, validPayload({ message: '첫째' }));
    await pending;
    await post(server, validPayload({ message: '둘째' }));
    await pending;
    assert.equal(hub.calls.length, 2);
    assert.notEqual(hub.calls[0].init.headers['Idempotency-Key'], hub.calls[1].init.headers['Idempotency-Key']);
  });

  for (const status of [201, 200]) {
    test(`hub ${status} → one call, success logged`, async () => {
      const hub = fakeFetch(status);
      await boot({ fetchImpl: hub.impl });
      const res = await post(server, validPayload());
      await pending;
      assert.equal(res.status, 200);
      assert.equal(hub.calls.length, 1);
      assert.ok(logs.some((line) => line.includes('hub lead forwarded') && line.includes(`"status":${status}`)));
    });
  }

  for (const status of [404, 401, 400, 429]) {
    test(`hub ${status} → logged without retry, user still succeeds, one mail`, async () => {
      const hub = fakeFetch(status);
      await boot({ fetchImpl: hub.impl });
      const res = await post(server, validPayload());
      await pending;
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
      assert.equal(mails.length, 1);
      assert.equal(hub.calls.length, 1);
      assert.ok(logs.some((line) => line.includes('hub lead failed') && line.includes(`"status":${status}`)));
    });
  }

  test('hub 3xx is a failure and is not followed', async () => {
    const hub = fakeFetch(302);
    await boot({ fetchImpl: hub.impl });
    await post(server, validPayload());
    await pending;
    assert.equal(hub.calls.length, 1);
    assert.ok(logs.some((line) => line.includes('hub lead failed') && line.includes('"status":302')));
  });

  test('hub 5xx twice → retried once with the same key and body, logged, user still succeeds', async () => {
    const hub = fakeFetch(503, 500);
    await boot({ fetchImpl: hub.impl });
    const res = await post(server, validPayload());
    await pending;
    assert.equal(res.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(hub.calls.length, 2);
    assert.equal(hub.calls[0].init.headers['Idempotency-Key'], hub.calls[1].init.headers['Idempotency-Key']);
    assert.equal(hub.calls[0].init.body, hub.calls[1].init.body);
    assert.ok(logs.some((line) => line.includes('hub lead failed') && line.includes('"status":500')));
  });

  test('network error then 201 → same key, ends as forwarded', async () => {
    const hub = fakeFetch(new TypeError('fetch failed'), 201);
    await boot({ fetchImpl: hub.impl });
    const res = await post(server, validPayload());
    await pending;
    assert.equal(res.status, 200);
    assert.equal(hub.calls.length, 2);
    assert.equal(hub.calls[0].init.headers['Idempotency-Key'], hub.calls[1].init.headers['Idempotency-Key']);
    assert.ok(logs.some((line) => line.includes('retrying') && line.includes('"reason":"TypeError"')));
    assert.ok(logs.some((line) => line.includes('hub lead forwarded') && line.includes('"status":201')));
    assert.ok(!logs.some((line) => line.includes('hub lead failed')));
  });

  test('a hung hub → user is answered first, the call times out, retries once and is logged', async () => {
    const calls = [];
    const hang = (url, init) => new Promise((resolve, reject) => {
      calls.push(init);
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await boot({ fetchImpl: hang, timeoutMs: 50 });

    const res = await post(server, validPayload());
    assert.equal(res.status, 200, 'answered while the hub call is still open');
    assert.equal(calls.length, 1);
    assert.ok(!logs.some((line) => line.includes('hub lead failed')));

    await pending;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
    assert.ok(logs.some((line) => line.includes('hub lead failed') && line.includes('"reason":"AbortError"')));
  });

  test('mail failure → 502 as today, hub is not called, retry forwards once', async () => {
    const hub = fakeFetch(201);
    let failNext = true;
    await boot({
      fetchImpl: hub.impl,
      sendMail: async () => {
        if (failNext) { failNext = false; throw Object.assign(new Error('smtp down'), { code: 'ECONNREFUSED' }); }
        return {};
      }
    });
    const first = await post(server, validPayload());
    await pending;
    assert.equal(first.status, 502);
    assert.equal(hub.calls.length, 0);

    const retry = await post(server, validPayload());
    await pending;
    assert.equal(retry.status, 200);
    assert.equal(hub.calls.length, 1);
  });

  test('honeypot, invalid input and duplicates are not forwarded', async () => {
    const hub = fakeFetch(201);
    await boot({ fetchImpl: hub.impl });
    await post(server, validPayload({ website: 'http://spam.example' }));
    await post(server, validPayload({ email: 'nope' }));
    assert.equal(hub.calls.length, 0);
    await post(server, validPayload());
    await pending;
    const dup = await post(server, validPayload());
    await pending;
    assert.equal(dup.status, 429);
    assert.equal(hub.calls.length, 1);
  });

  test('logs never contain the key or customer data, whatever the hub does', async () => {
    const secretError = new Error(`boom ${LEAD_KEY} hong@example.com`);
    const outcomes = [[201], [200], [404], [401], [400], [429], [503, 503], [secretError, secretError]];
    for (const [i, outcome] of outcomes.entries()) {
      const hub = fakeFetch(...outcome);
      await boot({ fetchImpl: hub.impl });
      await post(server, validPayload({ marketingConsent: { agreed: i % 2 === 0, textVersion: MARKETING_TEXT_VERSION } }));
      await pending;
      assert.ok(hub.calls.length >= 1);
    }
    const all = logs.join('\n');
    assert.ok(all.includes('hub lead'), 'something was logged');
    for (const secret of [LEAD_KEY, 'Bearer', 'hong@example.com', '010-1234-5678', '홍길동', '엔클루코스메틱', '일본 시딩', 'boom']) {
      assert.ok(!all.includes(secret), secret);
    }
  });
});

describe('real fetch against a local stub hub', () => {
  test('headers and JSON arrive as sent, and a 307 does not resend the lead', async () => {
    const seen = [];
    const hub = await listen((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ path: req.url, headers: req.headers, raw });
        if (req.url === '/moved') {
          res.writeHead(307, { Location: '/elsewhere' });
          return res.end();
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"id":"lead-1"}');
      });
    });
    const base = `http://127.0.0.1:${hub.address().port}`;
    const { data } = validateQuote(validPayload());

    await createLeadForwarder(config({ AXHUB_LEAD_KEY: LEAD_KEY, AXHUB_LEADS_URL: `${base}/leads` }))(data, new Date());
    await createLeadForwarder(config({ AXHUB_LEAD_KEY: LEAD_KEY, AXHUB_LEADS_URL: `${base}/moved` }))(data, new Date());
    await new Promise((r) => { hub.close(r); hub.closeAllConnections(); });

    assert.deepEqual(seen.map((s) => s.path), ['/leads', '/moved']);
    assert.equal(seen[0].headers.authorization, `Bearer ${LEAD_KEY}`);
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.match(seen[0].headers['idempotency-key'], UUID_V4);
    assert.equal(JSON.parse(seen[0].raw).company, '엔클루코스메틱');
    assert.ok(logs.some((line) => line.includes('hub lead failed') && line.includes('"status":307')));
  });
});
