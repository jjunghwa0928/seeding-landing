'use strict';

// 실행: cd api && npm test   (node --test)
// 보낸 사람 이름은 코드 상수이고, MAIL_FROM 은 주소로만 읽는지 확인한다.

process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const { loadConfig, validateQuote, buildMail, MAIL_FROM_NAME } = require('../server');

const NAME = 'ENCLU 시딩 견적 문의';

describe('mail from', () => {
  test('the display name is the code constant', () => {
    assert.equal(MAIL_FROM_NAME, NAME);
  });

  test('legacy "Name <addr>" with a garbled name → address only, constant name', () => {
    const garbled = 'ENCLU ?쐳붙 寃ъ젹 뀏몄쓽 <mkt2@enclu.co.kr>';
    assert.deepEqual(loadConfig({ MAIL_FROM: garbled }).mailFrom, { name: NAME, address: 'mkt2@enclu.co.kr' });
    assert.deepEqual(loadConfig({ MAIL_FROM: '"Other" <other@enclu.co.kr>' }).mailFrom, { name: NAME, address: 'other@enclu.co.kr' });
  });

  test('bare address is used as is', () => {
    assert.deepEqual(loadConfig({ MAIL_FROM: ' other@enclu.co.kr ' }).mailFrom, { name: NAME, address: 'other@enclu.co.kr' });
  });

  test('empty MAIL_FROM → SMTP_USER, then the default address', () => {
    assert.deepEqual(loadConfig({ MAIL_FROM: '', SMTP_USER: 'user@enclu.co.kr' }).mailFrom, { name: NAME, address: 'user@enclu.co.kr' });
    assert.deepEqual(loadConfig({}).mailFrom, { name: NAME, address: 'mkt2@enclu.co.kr' });
  });

  test('the generated From header encodes the constant name in UTF-8', async () => {
    const config = loadConfig({ MAIL_FROM: 'ENCLU ?쐳붙 寃ъ젹 뀏몄쓽 <mkt2@enclu.co.kr>' });
    const v = validateQuote({
      company: '엔클루코스메틱',
      contactName: '홍길동',
      phone: '010-0000-0000',
      email: 'hong@example.com',
      quantity: '50~100명',
      consent: true
    });
    assert.equal(v.ok, true);
    const mail = buildMail(config, v.data, { receivedAt: '2026-11-06T00:00:00.000Z' });

    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await transport.sendMail(mail);
    const raw = info.message.toString('utf8');
    const header = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
    const from = header.split(/\r?\n/).find((l) => /^From: /i.test(l));
    assert.ok(from, 'From header missing');
    assert.match(from, /^From: (=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= ?)+ <mkt2@enclu\.co\.kr>$/);

    const decoded = [...from.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)]
      .map((m) => Buffer.from(m[1], 'base64'))
      .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))
      .toString('utf8');
    assert.equal(decoded, NAME);
  });
});
