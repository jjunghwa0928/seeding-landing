'use strict';

// 실행: cd api && npm test   (node --test)
// 네트워크를 쓰지 않도록 가짜 메일 전송기·가짜 Turnstile 검증기를 주입한다.

process.env.NODE_ENV = 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp, loadConfig, startupError, QUANTITY_OPTIONS } = require('../server');

// 테스트 중 서버 로그는 숨긴다
const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};
process.on('exit', () => {
  console.log = origLog;
  console.error = origErr;
});

function baseConfig(overrides = {}) {
  return {
    ...loadConfig({}),
    mailTo: 'mkt2@enclu.co.kr',
    mailFrom: 'mkt2@enclu.co.kr',
    turnstileSecret: '',
    allowedOrigins: [],
    ...overrides
  };
}

function validPayload(overrides = {}) {
  return {
    company: '엔클루코스메틱',
    phone: '010-0000-0000',
    email: 'hong@example.com',
    quantity: '50~100명',
    message: '일본 시딩을 고민 중입니다.',
    consent: true,
    source: 'index',
    website: '',
    ...overrides
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, path, body, headers = {}) {
  const { port } = server.address();
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe('quote api', () => {
  let server;
  let sent;
  let turnstileResult;

  async function boot(configOverrides = {}, sendMail) {
    sent = [];
    turnstileResult = true;
    const app = createApp({
      config: baseConfig(configOverrides),
      sendMail: sendMail || (async (mail) => {
        sent.push(mail);
        return { messageId: 'fake' };
      }),
      verifyTurnstile: async () => turnstileResult
    });
    server = await listen(app);
  }

  async function reboot(configOverrides, sendMail) {
    await new Promise((r) => server.close(r));
    await boot(configOverrides, sendMail);
  }

  beforeEach(() => boot());
  afterEach(() => new Promise((r) => server.close(r)));

  test('GET /api/health → {ok:true}', async () => {
    const res = await request(server, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });

  test('success: sends mail with subject and Reply-To', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(sent.length, 1);

    const mail = sent[0];
    assert.equal(mail.to, 'mkt2@enclu.co.kr');
    assert.equal(mail.from, 'mkt2@enclu.co.kr');
    assert.equal(mail.replyTo, 'hong@example.com');
    assert.equal(mail.subject, '[시딩 견적 문의] 엔클루코스메틱 / 50~100명');
    assert.ok(mail.text.includes('연락처: 010-0000-0000'));
    assert.ok(mail.text.includes('문의 경로: 랜딩 페이지'));
    assert.ok(mail.text.includes('일본 시딩을 고민 중입니다.'));
  });

  test('message is optional', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({ message: '' }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });

  test('missing required fields → 400 with a field error for each, nothing sent', async () => {
    for (const field of ['company', 'phone', 'email', 'quantity']) {
      const res = await request(server, 'POST', '/api/quote', validPayload({ [field]: '' }));
      assert.equal(res.status, 400, `field ${field}`);
      assert.equal(res.json.error, 'invalid_input');
      assert.deepEqual(Object.keys(res.json.fields), [field]);
    }
    assert.equal(sent.length, 0);
  });

  test('empty body reports every required field', async () => {
    const res = await request(server, 'POST', '/api/quote', {});
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.json.fields).sort(), ['company', 'consent', 'email', 'phone', 'quantity']);
  });

  test('bad email → 400', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({ email: 'not-an-email' }));
    assert.equal(res.status, 400);
    assert.ok(res.json.fields.email);
    assert.equal(sent.length, 0);
  });

  test('bad phone → 400', async () => {
    for (const phone of ['12345', '010-abcd-0000']) {
      const res = await request(server, 'POST', '/api/quote', validPayload({ phone }));
      assert.equal(res.status, 400, phone);
      assert.ok(res.json.fields.phone);
    }
    assert.equal(sent.length, 0);
  });

  test('consent must be exactly true', async () => {
    for (const consent of [false, 'true', 1, undefined]) {
      const res = await request(server, 'POST', '/api/quote', validPayload({ consent }));
      assert.equal(res.status, 400, String(consent));
      assert.ok(res.json.fields.consent);
    }
    assert.equal(sent.length, 0);
  });

  test('unknown quantity → 400', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({ quantity: '1000명' }));
    assert.equal(res.status, 400);
    assert.ok(res.json.fields.quantity);
    assert.equal(sent.length, 0);
  });

  test('every form quantity option is accepted, and the lists match', async () => {
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'quote-form.js'), 'utf8');
    const match = js.match(/var QUANTITY_OPTIONS = (\[[^\]]*\]);/);
    assert.ok(match, 'QUANTITY_OPTIONS not found in assets/quote-form.js');
    assert.deepEqual(JSON.parse(match[1]), QUANTITY_OPTIONS);

    for (const quantity of QUANTITY_OPTIONS) {
      const app = createApp({ config: baseConfig(), sendMail: async () => ({}) });
      const s = await listen(app);
      const res = await request(s, 'POST', '/api/quote', validPayload({ quantity }));
      await new Promise((r) => s.close(r));
      assert.equal(res.status, 200, quantity);
    }
  });

  test('over-length fields → 400', async () => {
    let res = await request(server, 'POST', '/api/quote', validPayload({ message: 'x'.repeat(3001) }));
    assert.equal(res.status, 400);
    res = await request(server, 'POST', '/api/quote', validPayload({ company: 'x'.repeat(101) }));
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  test('honeypot filled → 200 without calling the transport', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({ website: 'http://spam.example' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(sent.length, 0);
  });

  test('header injection in company is stripped from the subject', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({ company: '엔클루\r\nBcc: victim@example.com' }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].subject, /[\r\n]/);
    assert.equal(sent[0].subject, '[시딩 견적 문의] 엔클루 Bcc: victim@example.com / 50~100명');
    assert.equal(sent[0].bcc, undefined);
  });

  test('CRLF in email is rejected, so Reply-To cannot carry extra headers', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({ email: 'hong@example.com\r\nCc: x@example.com' }));
    assert.equal(res.status, 400);
    assert.ok(res.json.fields.email);
    assert.equal(sent.length, 0);
  });

  test('HTML in the body is escaped in the html part', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({
      company: '<b>회사</b>',
      message: '<script>alert("x")</script>\n둘째 줄',
      context: { goal: '<img src=x>' }
    }));
    assert.equal(res.status, 200);
    const { html } = sent[0];
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>회사'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>둘째 줄'));
  });

  test('context: known keys are included, anything else is dropped', async () => {
    const res = await request(server, 'POST', '/api/quote', validPayload({
      source: 'tool',
      context: { category: '스킨케어', people: '5–10명', goal: { nested: 'x' }, voucher: '적용\r\nBcc: x@example.com', extra: 'nope' }
    }));
    assert.equal(res.status, 200);
    const { text } = sent[0];
    assert.ok(text.includes('문의 경로: 예상 실적 확인'));
    assert.ok(text.includes('계산기 카테고리: 스킨케어'));
    assert.ok(text.includes('계산기 인원: 5–10명'));
    assert.ok(text.includes('계산기 수출바우처: 적용 Bcc: x@example.com'));
    assert.ok(!text.includes('nested'));
    assert.ok(!text.includes('nope'));
  });

  test('non-object context and unknown source are ignored, not fatal', async () => {
    for (const [context, source] of [['문자열', 'evil'], [[1, 2], 'constructor'], [null, '__proto__']]) {
      const res = await request(server, 'POST', '/api/quote', validPayload({ context, source, message: `${source}` }));
      assert.equal(res.status, 200, String(source));
    }
    assert.ok(sent.every((m) => m.text.includes('문의 경로: -') && !m.text.includes('계산기')));
  });

  test('rate limit: 6th request within 10 min → 429', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await request(server, 'POST', '/api/quote', validPayload({ message: `문의 ${i}` }));
      assert.equal(res.status, 200, `request ${i}`);
    }
    const res = await request(server, 'POST', '/api/quote', validPayload({ message: '문의 6' }));
    assert.equal(res.status, 429);
    assert.equal(res.json.error, 'rate_limited');
    assert.equal(sent.length, 5);
  });

  test('rate limit: ARR-style X-Forwarded-For ports count as one client', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await request(server, 'POST', '/api/quote', validPayload({ message: `문의 ${i}` }), { 'X-Forwarded-For': `203.0.113.5:${50000 + i}` });
      assert.equal(res.status, 200, `request ${i}`);
    }
    let res = await request(server, 'POST', '/api/quote', validPayload({ message: '문의 6' }), { 'X-Forwarded-For': '203.0.113.5:50006' });
    assert.equal(res.status, 429);
    res = await request(server, 'POST', '/api/quote', validPayload({ message: '다른 IP' }), { 'X-Forwarded-For': '203.0.113.6:50007' });
    assert.equal(res.status, 200, 'another client is not limited');
  });

  test('duplicate guard: same content twice → 429', async () => {
    const first = await request(server, 'POST', '/api/quote', validPayload());
    assert.equal(first.status, 200);
    const second = await request(server, 'POST', '/api/quote', validPayload());
    assert.equal(second.status, 429);
    assert.equal(second.json.error, 'duplicate');
    assert.equal(sent.length, 1);
  });

  test('smtp failure → 502 generic error, and an identical retry is not blocked', async () => {
    let failNext = true;
    await reboot({}, async (mail) => {
      if (failNext) {
        failNext = false;
        const e = new Error('ECONNREFUSED secret-host');
        e.code = 'ECONNREFUSED';
        throw e;
      }
      sent.push(mail);
      return {};
    });
    const first = await request(server, 'POST', '/api/quote', validPayload());
    assert.equal(first.status, 502);
    assert.deepEqual(first.json, { ok: false, error: 'send_failed' });
    assert.ok(!first.raw.includes('secret-host'));

    const retry = await request(server, 'POST', '/api/quote', validPayload());
    assert.equal(retry.status, 200);
    assert.equal(sent.length, 1);
  });

  test('startup: production needs SMTP_PASS, Turnstile stays optional', () => {
    const smtp = (pass) => ({ ...baseConfig().smtp, pass });
    assert.match(startupError(baseConfig({ nodeEnv: 'production', smtp: smtp('') })), /SMTP_PASS/);
    assert.equal(startupError(baseConfig({ nodeEnv: 'production', smtp: smtp('x'), turnstileSecret: '' })), null);
    assert.equal(startupError(baseConfig({ nodeEnv: 'development', smtp: smtp('') })), null);
  });

  test('startup: the process really exits 1 in production without SMTP_PASS', () => {
    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production', SMTP_PASS: '', PORT: '0' },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refusing to start/);
  });

  test('config defaults: port 3201', () => {
    assert.equal(loadConfig({}).port, 3201);
  });

  test('turnstile: optional when unset, enforced when set', async () => {
    await reboot({ turnstileSecret: 'secret-123' });

    let res = await request(server, 'POST', '/api/quote', validPayload());
    assert.equal(res.status, 400, 'token missing');
    assert.equal(res.json.error, 'captcha_failed');

    turnstileResult = false;
    res = await request(server, 'POST', '/api/quote', validPayload({ turnstileToken: 'tok-bad' }));
    assert.equal(res.status, 400, 'verifier false');
    assert.equal(sent.length, 0);

    turnstileResult = true;
    res = await request(server, 'POST', '/api/quote', validPayload({ turnstileToken: 'tok-good' }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });

  test('malformed / oversized JSON → JSON error, not HTML', async () => {
    let res = await request(server, 'POST', '/api/quote', '{not json');
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);

    res = await request(server, 'POST', '/api/quote', validPayload({ message: 'x'.repeat(20000) }));
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'too_large');
  });

  test('CORS: no header by default, header only for allowed origin', async () => {
    let res = await request(server, 'GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.equal(res.headers['access-control-allow-origin'], undefined);

    await reboot({ allowedOrigins: ['https://www.enclu.co.kr'] });
    res = await request(server, 'GET', '/api/health', undefined, { Origin: 'https://www.enclu.co.kr' });
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.enclu.co.kr');
    res = await request(server, 'GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('source paths proxied by IIS return 404 JSON', async () => {
    for (const p of ['/api/.env', '/api/server.js', '/api/node_modules/express/package.json', '/api/nope']) {
      const res = await request(server, 'GET', p);
      assert.equal(res.status, 404, p);
      assert.equal(res.json.error, 'not_found');
    }
  });

  test('security headers from helmet are present', async () => {
    const res = await request(server, 'GET', '/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('web.config proxies to the same port the API defaults to', () => {
    const xml = fs.readFileSync(path.join(__dirname, '..', '..', 'web.config'), 'utf8');
    assert.ok(xml.includes('url="http://localhost:3201/api/{R:1}"'));
    assert.ok(xml.includes('<add segment=".env" />'));
    assert.ok(xml.includes('<add segment="node_modules" />'));
  });
});
