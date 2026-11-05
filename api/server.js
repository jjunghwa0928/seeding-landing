'use strict';

/**
 * 엔클루 시딩 랜딩 견적 문의 API
 *
 *   POST /api/quote   — 견적 문의 폼 → SMTP 메일 발송
 *   GET  /api/health  — 상태 확인
 *
 * 보호 계층 (안쪽부터):
 *   helmet 기본 헤더 → CORS(허용 목록) → 전역 60req/min → /api/quote 5req/10min → JSON 16kb 제한
 *   → 허니팟 → 필드 검증·헤더 제어문자 제거 → Turnstile 검증(TURNSTILE_SECRET 이 있을 때만)
 *   → 중복 전송 가드(10분, 발송 성공 후 기록) → 메일 발송
 *   → AX Hub 영업 리드 전달(AXHUB_LEAD_KEY 가 있을 때만, 응답을 기다리게 하지 않음)
 *
 * 테스트에서는 createApp({ config, sendMail, verifyTurnstile, forwardLead }) 로
 * 네트워크를 쓰지 않는 가짜 구현을 주입한다.
 */

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const nodemailer = require('nodemailer');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-\s]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

const LIMITS = {
  company: 100,
  contactName: 100,
  email: 200,
  phone: 30,
  message: 3000,
  contextValue: 100,
  turnstileToken: 2048
};

// assets/quote-form.js 의 QUANTITY_OPTIONS 와 같아야 한다 (test/quote.test.js 가 확인).
const QUANTITY_OPTIONS = ['50명 미만', '50~100명', '100~300명', '300명 이상', '미정 / 상담 후 결정'];
// people 은 이전 버전 tool.html(캐시)이 보내는 값이다.
const CONTEXT_LABELS = { category: '카테고리', tier: '인플루언서 등급', quantity: '시딩 수량', people: '인원', goal: '목표', voucher: '수출바우처' };
const SOURCE_LABELS = { index: '랜딩 페이지', tool: '예상 실적 확인', voucher: '수출바우처 문의' };
// 수출바우처 문구는 여기서만 고친다. assets/quote-form.js, tool.html 의 VOUCHERS 와 같아야 한다 (test/quote.test.js 가 확인).
const VOUCHERS = [
  {"key":"kosme","label":"중기부(중진공) 수출바우처","short":"중기부(중진공)"},
  {"key":"kotra","label":"산업부(KOTRA) 수출바우처","short":"산업부(KOTRA)"}
];
// 광고성 정보 수신 동의 문구의 버전. assets/quote-form.js 와 같아야 한다 (test/quote.test.js 가 확인).
const MARKETING_TEXT_VERSION = 'marketing-2026-11-04';
// 개인정보 수집·이용 안내 문구(assets/quote-form.js 의 CONSENT_HTML)의 버전. 문구를 고치면 함께 올린다.
const PRIVACY_TEXT_VERSION = 'privacy-2026-11-04';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const AXHUB_LEADS_URL = 'https://axhub.enclu.com/api/sales/leads';
const AXHUB_TIMEOUT_MS = 5000;
const AXHUB_RETRY_DELAY_MS = 1000;
// 수출바우처 버튼(data-quote-source="voucher")은 index.html 에만 있다.
const LEAD_PAGES = { index: 'index', tool: 'tool', voucher: 'index' };

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

function loadConfig(env = process.env) {
  const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: Number(env.PORT) || 3201,
    nodeEnv: env.NODE_ENV || 'development',
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 465,
      secure: bool(env.SMTP_SECURE, true),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || ''
    },
    mailFrom: env.MAIL_FROM || env.SMTP_USER || 'mkt2@enclu.co.kr',
    mailTo: env.MAIL_TO || 'mkt2@enclu.co.kr',
    turnstileSecret: env.TURNSTILE_SECRET || '',
    axhub: {
      leadKey: String(env.AXHUB_LEAD_KEY || '').trim(),
      leadsUrl: String(env.AXHUB_LEADS_URL || '').trim() || AXHUB_LEADS_URL
    },
    allowedOrigins
  };
}

// ---------------------------------------------------------------------------
// 로깅 — 본문·비밀값은 절대 기록하지 않는다
// ---------------------------------------------------------------------------

function log(level, msg, meta) {
  const line = `${new Date().toISOString()} [quote-api] ${level.toUpperCase()} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta && Object.keys(meta).length) out(line, JSON.stringify(meta));
  else out(line);
}

// ---------------------------------------------------------------------------
// 외부 연동 (기본 구현 — 테스트에서는 교체)
// ---------------------------------------------------------------------------

async function verifyTurnstileRemote(secret, token, ip) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body, signal: ctrl.signal });
    if (!res.ok) {
      log('warn', 'turnstile siteverify non-200', { status: res.status });
      return false;
    }
    const json = await res.json();
    if (json.success !== true) {
      log('warn', 'turnstile rejected', { codes: json['error-codes'] || [] });
    }
    return json.success === true;
  } catch (err) {
    log('warn', 'turnstile siteverify failed', { reason: err.name });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function createSmtpSender(config) {
  const { smtp } = config;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    // ARR 프록시 타임아웃(기본 30초) 안에 실패를 돌려줘야 브라우저가 메일 앱 안내로 넘어간다.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return (mail) => transport.sendMail(mail);
}

/**
 * AX Hub 영업 리드 전달 (계약 sales-lead/2). 만든 함수는 절대 reject 하지 않으므로 기다리지 않고 호출한다.
 * 메일이 정식 접수 경로이고 허브는 병행 전달이다. 실패해도 상태 코드나 오류 이름만 남긴다.
 * 네트워크 오류·시간 초과·5xx 는 같은 Idempotency-Key 로 한 번만 다시 보낸다.
 */
function createLeadForwarder(config, { fetchImpl = fetch, timeoutMs = AXHUB_TIMEOUT_MS, retryDelayMs = AXHUB_RETRY_DELAY_MS } = {}) {
  const { leadKey, leadsUrl } = config.axhub;

  async function post(body, idempotencyKey) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(leadsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${leadKey}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json'
        },
        body,
        redirect: 'manual', // 고객 정보와 키를 다른 주소로 따라 보내지 않는다
        signal: ctrl.signal
      });
      if (res.body) res.body.cancel().catch(() => {}); // 응답 본문은 쓰지 않는다. 연결만 돌려준다
      return { status: res.status };
    } catch (err) {
      return { reason: err && err.name ? err.name : 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function forwardLead(data, submittedAt) {
    if (!leadKey) return;
    try {
      const body = JSON.stringify(buildLead(data, submittedAt));
      const idempotencyKey = crypto.randomUUID();

      let result = await post(body, idempotencyKey);
      if (result.reason || result.status >= 500) {
        log('warn', 'hub lead attempt failed, retrying', result);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        result = await post(body, idempotencyKey);
      }

      if (result.status === 200 || result.status === 201) log('info', 'hub lead forwarded', result);
      else log('error', 'hub lead failed', result);
    } catch (err) {
      log('error', 'hub lead failed', { reason: err && err.name ? err.name : 'unknown' });
    }
  };
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

/** 한 줄 값: 헤더에 들어갈 수 있으므로 CR/LF 등 제어문자를 공백으로 바꾼다 */
function singleLine(v) {
  return typeof v === 'string' ? v.replace(CONTROL_RE, ' ').trim() : '';
}

/** 계산기 조건: 허용한 키의 원시값만 짧은 문자열로 남긴다 */
function sanitizeContext(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const key of Object.keys(CONTEXT_LABELS)) {
    if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
    const raw = v[key];
    if (!['string', 'number', 'boolean'].includes(typeof raw)) continue;
    const value = singleLine(String(raw)).slice(0, LIMITS.contextValue);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** 수출바우처 보유: 없으면 [], 허용 키만 중복 없이 받는다. 형식이 틀리면 null */
function parseVouchers(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  // 'kita'는 PR #14 때의 잘못된 키(한국무역협회) — 캐시된 옛 폼이 보내도 거절하지 않고 kotra로 읽는다
  v = v.map((key) => (key === 'kita' ? 'kotra' : key));
  if (new Set(v).size !== v.length) return null;
  const keys = VOUCHERS.map((item) => item.key);
  if (!v.every((key) => keys.includes(key))) return null;
  return keys.filter((key) => v.includes(key)); // 순서가 달라도 중복 판정이 같도록 정렬
}

/** 메일 표기: "중기부(중진공) 보유, 산업부(KOTRA) 미보유" / 전부 없으면 "미보유" */
function formatVouchers(keys) {
  if (!keys.length) return '미보유';
  return VOUCHERS.map((item) => `${item.short} ${keys.includes(item.key) ? '보유' : '미보유'}`).join(', ');
}

/**
 * 광고성 정보 수신 동의: 없으면 미동의, 형식이 틀리면 null.
 * agreedAt 은 클라이언트 시계를 믿지 않고 서버 수신 시각으로 정한다. 미동의면 다른 값은 보지 않는다.
 */
function parseMarketingConsent(v) {
  const notAgreed = { agreed: false, agreedAt: null, textVersion: null };
  if (v === undefined) return notAgreed;
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.agreed !== 'boolean') return null;
  if (!v.agreed) return notAgreed;
  if (v.textVersion !== MARKETING_TEXT_VERSION) return null;
  return { agreed: true, agreedAt: new Date().toISOString(), textVersion: MARKETING_TEXT_VERSION };
}

/** 메일 표기: "동의 (2026-11-04 18:02, 문구 marketing-2026-11-04)" (한국 시각) / "미동의" */
function formatMarketingConsent(consent) {
  if (!consent.agreed) return '미동의';
  const kst = new Date(Date.parse(consent.agreedAt) + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
  return `동의 (${kst}, 문구 ${consent.textVersion})`;
}

/**
 * 입력 검증. 통과하면 { ok:true, data }, 실패하면 { ok:false, fields }.
 * fields 의 문구는 폼(assets/quote-form.js)의 안내와 같고 그대로 화면에 표시된다.
 */
function validateQuote(body) {
  const data = {
    company: singleLine(body.company),
    contactName: singleLine(body.contactName),
    phone: singleLine(body.phone),
    email: singleLine(body.email),
    quantity: singleLine(body.quantity),
    vouchers: parseVouchers(body.vouchers),
    marketingConsent: parseMarketingConsent(body.marketingConsent),
    message: typeof body.message === 'string' ? body.message.replace(/\r\n?/g, '\n').trim() : '',
    context: sanitizeContext(body.context),
    source: typeof body.source === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_LABELS, body.source) ? body.source : 'unknown'
  };

  const fields = {};
  if (!data.company) fields.company = '업체명 또는 브랜드명을 입력해 주세요.';
  else if (data.company.length > LIMITS.company) fields.company = `${LIMITS.company}자 이내로 입력해 주세요.`;

  if (!data.contactName) fields.contactName = '담당자명을 입력해 주세요.';
  else if (data.contactName.length > LIMITS.contactName) fields.contactName = `${LIMITS.contactName}자 이내로 입력해 주세요.`;

  const digits = data.phone.replace(/\D/g, '').length;
  if (!data.phone) fields.phone = '연락처를 입력해 주세요.';
  else if (data.phone.length > LIMITS.phone || !PHONE_RE.test(data.phone) || digits < 9 || digits > 15) {
    fields.phone = '연락처 형식을 확인해 주세요. 예) 010-0000-0000';
  }

  if (!data.email) fields.email = '이메일을 입력해 주세요.';
  else if (data.email.length > LIMITS.email || !EMAIL_RE.test(data.email)) {
    fields.email = '이메일 형식을 확인해 주세요. 예) name@company.com';
  }

  if (!QUANTITY_OPTIONS.includes(data.quantity)) fields.quantity = '희망 진행 수량을 선택해 주세요.';
  if (!data.vouchers) fields.vouchers = '수출바우처 보유 여부를 다시 선택해 주세요.';
  if (data.message.length > LIMITS.message) fields.message = `${LIMITS.message}자 이내로 입력해 주세요.`;
  if (body.consent !== true) fields.consent = '개인정보 수집·이용에 동의해 주세요.';
  if (!data.marketingConsent) fields.marketingConsent = '광고성 정보 수신 동의를 다시 선택해 주세요.';

  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, data };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMail(config, data, meta) {
  const rows = [
    ['업체명 / 브랜드명', data.company],
    ['담당자명', data.contactName],
    ['연락처', data.phone],
    ['이메일', data.email],
    ['희망 진행 수량', data.quantity],
    ['수출바우처 보유', formatVouchers(data.vouchers)],
    ['개인정보 수집·이용 동의', '동의함'],
    ['광고성 정보 수신 동의', formatMarketingConsent(data.marketingConsent)],
    ['문의 경로', SOURCE_LABELS[data.source] || '-']
  ];
  if (data.context) {
    for (const key of Object.keys(CONTEXT_LABELS)) {
      if (data.context[key]) rows.push([`계산기 ${CONTEXT_LABELS[key]}`, data.context[key]]);
    }
  }
  rows.push(['접수 시각', meta.receivedAt]);

  const footer = '엔클루 시딩 랜딩의 견적 문의 폼에서 자동 발송된 메일입니다.';
  const text = [
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    '문의 내용:',
    data.message || '-',
    '',
    `— ${footer}`
  ].join('\n');

  const htmlRows = rows
    .map(([label, value]) => `<tr><th align="left" style="padding:4px 16px 4px 0;white-space:nowrap">${escapeHtml(label)}</th><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`)
    .join('');
  const html = `<table cellspacing="0" cellpadding="0">${htmlRows}</table>` +
    `<h3>문의 내용</h3><p>${escapeHtml(data.message || '-').replace(/\n/g, '<br>')}</p>` +
    `<hr><p style="color:#666">${escapeHtml(footer)}</p>`;

  return {
    from: config.mailFrom,
    to: config.mailTo,
    replyTo: singleLine(data.email),
    subject: singleLine(`[시딩 견적 문의] ${data.company} / ${data.quantity}`),
    text,
    html
  };
}

/** "2026-11-05T18:02:00.000+09:00" (한국 시각) */
function toKstIso(date) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().replace('Z', '+09:00');
}

/**
 * 허브 context. 값이 있는 키만 보낸다. voucher 는 폼의 보유 여부(메일 표기와 같음)라서 계산기 없는 문의에도 들어간다.
 * 허브에는 등급·수량 칸이 없으므로 v6 계산기의 tier·quantity 는 people 에 합친다 (이전 버전 tool.html 은 people 을 보낸다).
 */
function buildLeadContext(data) {
  const calc = data.context || {};
  const people = calc.people || [calc.tier, calc.quantity].filter(Boolean).join(' ').slice(0, LIMITS.contextValue);
  const context = {};
  if (calc.category) context.category = calc.category;
  if (people) context.people = people;
  if (calc.goal) context.goal = calc.goal;
  context.voucher = formatVouchers(data.vouchers);
  return context;
}

/** 허브 계약 sales-lead/2 본문. 알 수 없는 키는 허브가 400 으로 거부하므로 여기 있는 키만 보낸다. */
function buildLead(data, submittedAt) {
  const marketing = data.marketingConsent;
  return {
    submittedAt: toKstIso(submittedAt),
    company: data.company,
    contactName: data.contactName,
    phone: data.phone || null,
    email: data.email,
    quantity: data.quantity || null,
    message: data.message || null,
    page: LEAD_PAGES[data.source] || null,
    inquiryType: 'quote',
    utm: null, // 폼이 페이지 주소나 utm 값을 보내지 않는다
    context: buildLeadContext(data),
    privacyConsent: true, // validateQuote 가 consent === true 만 통과시킨다
    privacyTextVersion: PRIVACY_TEXT_VERSION,
    marketingConsent: {
      agreed: marketing.agreed,
      agreedAt: marketing.agreed ? toKstIso(new Date(marketing.agreedAt)) : null,
      textVersion: marketing.textVersion
    }
  };
}

// ---------------------------------------------------------------------------
// 중복 전송 가드 (메모리)
// ---------------------------------------------------------------------------

function createDuplicateGuard(windowMs = DUPLICATE_WINDOW_MS) {
  const seen = new Map(); // hash -> timestamp
  let lastPrune = 0;

  function prune(now) {
    if (now - lastPrune < 60 * 1000) return;
    lastPrune = now;
    for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
  }

  function hashOf(data) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify([data.email.toLowerCase(), data.company, data.contactName, data.quantity, data.vouchers, data.message]))
      .digest('hex');
  }

  return {
    /** 같은 내용이 창 안에 있으면 true (= 중복). 기록하지는 않는다. */
    isDuplicate(data, now = Date.now()) {
      prune(now);
      const prev = seen.get(hashOf(data));
      return prev !== undefined && now - prev < windowMs;
    },
    /** 발송이 성공한 뒤에만 호출 — 실패한 전송은 재시도를 막지 않는다 */
    remember(data, now = Date.now()) {
      seen.set(hashOf(data), now);
    }
  };
}

/**
 * 기동 전 설정 점검. 문제가 있으면 메시지를 돌려주고, 없으면 null.
 * production 에서 SMTP_PASS 가 없으면 모든 문의가 발송 실패하므로 기동을 거부한다.
 */
function startupError(config) {
  if (config.nodeEnv === 'production' && !config.smtp.pass) {
    return 'SMTP_PASS is required when NODE_ENV=production (every quote mail would fail). Set it in api/.env.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 미들웨어
// ---------------------------------------------------------------------------

function corsMiddleware(allowedOrigins) {
  const allow = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

/**
 * ARR 는 기본 설정에서 X-Forwarded-For 에 포트를 붙인다 (1.2.3.4:51234).
 * 포트를 지우지 않으면 연결마다 키가 달라져 IP 기준 속도 제한이 동작하지 않는다.
 */
function clientIp(req) {
  const ip = String(req.ip || '');
  const v4 = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4) return v4[1];
  const v6 = ip.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/);
  return v6 ? v6[1] : ip;
}

function limiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIp,
    handler(req, res) {
      log('warn', 'rate limited', { path: req.path, ip: clientIp(req) });
      res.status(429).json({ ok: false, error: 'rate_limited' });
    }
  });
}

// ---------------------------------------------------------------------------
// 앱
// ---------------------------------------------------------------------------

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const sendMail = options.sendMail || createSmtpSender(config);
  const verifyTurnstile = options.verifyTurnstile || verifyTurnstileRemote;
  const duplicates = options.duplicateGuard || createDuplicateGuard();
  const forwardLead = options.forwardLead || createLeadForwarder(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // IIS ARR 뒤에서 X-Forwarded-For 첫 홉만 신뢰

  app.use(helmet());
  app.use(corsMiddleware(config.allowedOrigins));
  app.use('/api', limiter(60 * 1000, 60));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/quote', limiter(10 * 60 * 1000, 5), express.json({ limit: '16kb' }), async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const ip = clientIp(req);

    // 1) 허니팟 — 봇이 학습하지 못하도록 성공처럼 응답
    if (singleLine(body.website)) {
      log('info', 'honeypot hit', { ip });
      return res.json({ ok: true });
    }

    // 2) 필드 검증
    const v = validateQuote(body);
    if (!v.ok) {
      log('info', 'rejected', { ip, reason: Object.keys(v.fields) });
      return res.status(400).json({ ok: false, error: 'invalid_input', fields: v.fields });
    }
    const data = v.data;

    // 3) Turnstile (시크릿을 설정한 경우에만)
    if (config.turnstileSecret) {
      const token = singleLine(body.turnstileToken);
      if (!token || token.length > LIMITS.turnstileToken) {
        log('info', 'rejected', { ip, reason: 'turnstile:missing' });
        return res.status(400).json({ ok: false, error: 'captcha_failed' });
      }
      const passed = await verifyTurnstile(config.turnstileSecret, token, ip);
      if (!passed) {
        log('info', 'rejected', { ip, reason: 'turnstile:failed' });
        return res.status(400).json({ ok: false, error: 'captcha_failed' });
      }
    }

    // 4) 중복 전송 (기록은 발송 성공 후에만)
    if (duplicates.isDuplicate(data)) {
      log('info', 'rejected', { ip, reason: 'duplicate' });
      return res.status(429).json({ ok: false, error: 'duplicate' });
    }

    // 5) 발송
    const receivedAt = new Date();
    const mail = buildMail(config, data, { receivedAt: receivedAt.toISOString() });
    try {
      await sendMail(mail);
      duplicates.remember(data);
      log('info', 'sent', { ip, source: data.source });
      // 메일이 실패하면 사용자가 다시 보내므로 성공한 건만 넘긴다. 결과를 기다리지 않는다.
      forwardLead(data, receivedAt);
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'send failed', { ip, reason: err && err.code ? err.code : 'unknown' });
      return res.status(502).json({ ok: false, error: 'send_failed' });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // 바디 파서 오류 등 — 항상 JSON, 내부 정보 노출 없음
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) log('error', 'unhandled', { reason: err && err.name ? err.name : 'unknown' });
    res.status(status).json({ ok: false, error: status === 413 ? 'too_large' : status >= 500 ? 'server_error' : 'bad_request' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// 기동
// ---------------------------------------------------------------------------

function start() {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
  const config = loadConfig();

  const fatal = startupError(config);
  if (fatal) {
    log('error', `refusing to start: ${fatal}`);
    process.exit(1);
  }
  if (!config.turnstileSecret) {
    const level = config.nodeEnv === 'production' ? 'warn' : 'info';
    log(level, 'TURNSTILE_SECRET is not set — relying on honeypot and rate limit only');
  }
  if (!config.smtp.host) {
    log('warn', 'SMTP_HOST is not set — mail sending will fail');
  }

  const app = createApp({ config });
  app.listen(config.port, () => {
    log('info', `listening on :${config.port}`, {
      env: config.nodeEnv,
      mailTo: config.mailTo,
      hubLeads: config.axhub.leadKey ? 'on' : 'off',
      cors: config.allowedOrigins.length ? config.allowedOrigins : 'same-origin'
    });
  });
}

if (require.main === module) start();

module.exports = { createApp, createLeadForwarder, loadConfig, startupError, validateQuote, buildMail, buildLead, clientIp, createDuplicateGuard, LIMITS, QUANTITY_OPTIONS, VOUCHERS, MARKETING_TEXT_VERSION, PRIVACY_TEXT_VERSION };
