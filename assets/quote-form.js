/*
 * 견적 문의 모달: index.html과 tool.html이 함께 쓰는 단일 구현입니다.
 *
 * 여는 방법
 *  - [data-open-quote] 또는 [data-open-consult] 요소 클릭
 *    (data-quote-message="..."가 있으면 문의 내용을 미리 채움)
 *  - 페이지 주소의 #quote (tool.html의 기존 #consult, ?form=1 링크도 지원)
 *
 * 페이지가 window.encluQuoteContext()를 정의하면 제출 시점에 호출해
 * 반환값 {category, size, goal, voucher}를 화면에 표시하지 않고 전송 내용에 덧붙입니다.
 */
(function(){
  "use strict";

  // ==================================================================
  // SUBMIT ENDPOINT HOOK:
  // Set SUBMIT_ENDPOINT below to a real URL to POST the JSON payload
  // there (fetch, method POST, JSON body). When left as '', the form
  // falls back to opening a prefilled mailto: to mkt2@enclu.co.kr with
  // the payload written out as readable Korean lines in the body.
  // ==================================================================
  var SUBMIT_ENDPOINT = '';
  var CONSULT_EMAIL = 'mkt2@enclu.co.kr';

  var QUANTITY_OPTIONS = ["50명 미만", "50~100명", "100~300명", "300명 이상", "미정 / 상담 후 결정"];
  var CONTEXT_LABELS = { category:"카테고리", size:"인원", goal:"목표", voucher:"수출바우처" };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RE = /^[0-9+()\-\s]+$/;

  // FIELDS drives rendering, validation and the mail body. Add new fields here only.
  var FIELDS = [
    { key:"company",  label:"업체명 / 브랜드명", type:"text",  required:true, autocomplete:"organization", placeholder:"예) OOO코스메틱 / OOO브랜드",
      validate:function(v){ return v ? "" : "업체명 또는 브랜드명을 입력해 주세요."; } },
    { key:"phone",    label:"연락처",           type:"tel",   required:true, autocomplete:"tel", placeholder:"예) 010-0000-0000",
      validate:function(v){
        if(!v) return "연락처를 입력해 주세요.";
        var digits = v.replace(/\D/g, "").length;
        return (PHONE_RE.test(v) && digits >= 9 && digits <= 15) ? "" : "연락처 형식을 확인해 주세요. 예) 010-0000-0000";
      } },
    { key:"email",    label:"이메일",           type:"email", required:true, autocomplete:"email", placeholder:"예) name@company.com",
      validate:function(v){
        if(!v) return "이메일을 입력해 주세요.";
        return EMAIL_RE.test(v) ? "" : "이메일 형식을 확인해 주세요. 예) name@company.com";
      } },
    { key:"quantity", label:"희망 진행 수량",    type:"select", required:true, options:QUANTITY_OPTIONS,
      validate:function(v){ return v ? "" : "희망 진행 수량을 선택해 주세요."; } },
    { key:"message",  label:"문의 내용",         type:"textarea", required:false, placeholder:"희망 플랫폼, 제품명, 예산, 진행 일정 등 자유롭게 작성해 주세요." }
  ];

  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function fieldHtml(f){
    var id = "qf-" + f.key;
    var attrs = 'id="' + id + '" name="' + f.key + '" class="qf-input" aria-describedby="' + id + '-err"' + (f.required ? ' aria-required="true"' : '');
    var control;
    if(f.type === "select"){
      control = '<select ' + attrs + '><option value="">선택해 주세요</option>' +
        f.options.map(function(o){ return '<option value="' + o + '">' + o + '</option>'; }).join("") + '</select>';
    } else if(f.type === "textarea"){
      control = '<textarea ' + attrs + ' rows="4" placeholder="' + f.placeholder + '"></textarea>';
    } else {
      control = '<input ' + attrs + ' type="' + f.type + '" autocomplete="' + f.autocomplete + '" placeholder="' + f.placeholder + '">';
    }
    return '<div class="qf-field">' +
      '<label class="qf-label" for="' + id + '">' + f.label +
        (f.required ? '<span class="qf-req" aria-hidden="true">*</span>' : '<span class="qf-opt">(선택)</span>') +
      '</label>' + control +
      '<p class="qf-error" id="' + id + '-err"></p>' +
    '</div>';
  }

  // TODO 법무 확인 필요: 개인정보 수집·이용 안내의 항목, 목적, 보유 기간 문구.
  var CONSENT_HTML =
    '<div class="qf-field">' +
      '<label class="qf-consent" for="qf-consent">' +
        '<input type="checkbox" id="qf-consent" name="consent" aria-required="true" aria-describedby="qf-consent-err">' +
        '<span>개인정보 수집·이용 동의<span class="qf-req" aria-hidden="true">*</span> <span class="qf-opt">(필수)</span></span>' +
      '</label>' +
      '<details class="qf-notice">' +
        '<summary>수집·이용 안내 보기</summary>' +
        '<ul>' +
          '<li><b>수집 항목</b>업체명·브랜드명, 연락처, 이메일, 문의 내용</li>' +
          '<li><b>이용 목적</b>견적 상담 및 회신</li>' +
          '<li><b>보유 기간</b>상담 종료 후 1년</li>' +
        '</ul>' +
      '</details>' +
      '<p class="qf-error" id="qf-consent-err"></p>' +
    '</div>';

  var dialog = document.createElement("dialog");
  dialog.className = "qf-dialog";
  dialog.id = "quoteDialog";
  dialog.setAttribute("aria-labelledby", "qf-title");
  dialog.innerHTML =
    '<button type="button" class="qf-close" data-qf-close aria-label="닫기">' + ICON_CLOSE + '</button>' +
    '<div class="qf-scroll">' +
      '<form class="qf-form" id="qf-form" novalidate>' +
        '<h2 class="qf-title" id="qf-title" tabindex="-1" autofocus>일본 시딩 견적 문의</h2>' +
        '<p class="qf-lead">간단한 정보만 남겨주시면 담당자가 상담을 도와드립니다.</p>' +
        FIELDS.map(fieldHtml).join("") +
        CONSENT_HTML +
        '<button type="submit" class="btn btn-blue qf-submit">견적 문의 하기</button>' +
        '<p class="qf-status" id="qf-status" role="alert"></p>' +
      '</form>' +
      '<div class="qf-success" id="qf-success" hidden>' +
        '<div class="qf-success-icon">' + ICON_CHECK + '</div>' +
        '<h2 class="qf-title" id="qf-success-title" tabindex="-1"></h2>' +
        '<p id="qf-success-text"></p>' +
        '<p id="qf-success-mail" hidden>메일 앱이 열리지 않았다면 <a id="qf-mail-link" href="#">여기를 눌러 다시 열거나</a> ' + CONSULT_EMAIL + '로 보내 주세요.</p>' +
        '<button type="button" class="btn btn-blue" data-qf-close>닫기</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(dialog);

  var form = dialog.querySelector("#qf-form");
  var success = dialog.querySelector("#qf-success");
  var statusEl = dialog.querySelector("#qf-status");
  var submitBtn = dialog.querySelector(".qf-submit");
  var messageEl = dialog.querySelector("#qf-message");
  var prefilled = "";
  var finished = false;

  function setError(id, msg){
    var el = dialog.querySelector("#" + id);
    dialog.querySelector("#" + id + "-err").textContent = msg;
    if(msg) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
  }

  function validateAll(){
    var firstInvalid = null;
    FIELDS.forEach(function(f){
      if(!f.validate) return;
      var el = dialog.querySelector("#qf-" + f.key);
      var msg = f.validate(el.value.trim());
      setError("qf-" + f.key, msg);
      if(msg && !firstInvalid) firstInvalid = el;
    });
    var consent = dialog.querySelector("#qf-consent");
    var consentMsg = consent.checked ? "" : "개인정보 수집·이용에 동의해 주세요.";
    setError("qf-consent", consentMsg);
    if(consentMsg && !firstInvalid) firstInvalid = consent;
    return firstInvalid;
  }

  function resetForm(){
    form.reset();
    FIELDS.forEach(function(f){ setError("qf-" + f.key, ""); });
    setError("qf-consent", "");
    statusEl.textContent = "";
    submitBtn.disabled = false;
    submitBtn.textContent = "견적 문의 하기";
    form.hidden = false;
    success.hidden = true;
    dialog.setAttribute("aria-labelledby", "qf-title");
    prefilled = "";
    finished = false;
  }

  function buildPayload(){
    var contact = {};
    FIELDS.forEach(function(f){ contact[f.key] = dialog.querySelector("#qf-" + f.key).value.trim(); });
    contact.consent = true;
    var payload = { contact:contact, pageUrl:window.location.href, timestamp:new Date().toISOString() };
    if(typeof window.encluQuoteContext === "function") payload.selection = window.encluQuoteContext();
    return payload;
  }

  function buildMailto(payload){
    var subject = "[일본 시딩 견적 문의] " + payload.contact.company;
    var lines = FIELDS.map(function(f){ return f.label + ": " + (payload.contact[f.key] || "-"); });
    lines.push("개인정보 수집·이용 동의: 동의함");
    if(payload.selection){
      lines.push("", "=== 예상 실적 확인에서 선택한 조건 ===");
      Object.keys(CONTEXT_LABELS).forEach(function(k){ lines.push(CONTEXT_LABELS[k] + ": " + payload.selection[k]); });
    }
    lines.push("", "페이지: " + payload.pageUrl, "요청 시각: " + payload.timestamp);
    return "mailto:" + CONSULT_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
  }

  function showSuccess(title, text, mailto){
    var titleEl = dialog.querySelector("#qf-success-title");
    titleEl.textContent = title;
    dialog.querySelector("#qf-success-text").textContent = text;
    dialog.querySelector("#qf-success-mail").hidden = !mailto;
    if(mailto) dialog.querySelector("#qf-mail-link").href = mailto;
    form.hidden = true;
    success.hidden = false;
    dialog.setAttribute("aria-labelledby", "qf-success-title");
    finished = true;
    dialog.querySelector(".qf-scroll").scrollTop = 0;
    titleEl.focus();
  }

  form.addEventListener("submit", function(e){
    e.preventDefault();
    statusEl.textContent = "";
    var firstInvalid = validateAll();
    if(firstInvalid){ firstInvalid.focus(); return; }

    var payload = buildPayload();
    if(SUBMIT_ENDPOINT){
      submitBtn.disabled = true;
      submitBtn.textContent = "전송 중…";
      fetch(SUBMIT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function(res){
        if(!res.ok) throw new Error("bad status");
        showSuccess("문의가 접수되었습니다", "담당자가 확인 후 입력하신 연락처로 연락드립니다.");
      }).catch(function(){
        submitBtn.disabled = false;
        submitBtn.textContent = "견적 문의 하기";
        statusEl.textContent = "전송에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      });
    } else {
      // mailto는 메일 앱을 여는 것까지만 하므로, 접수 완료로 안내하지 않습니다.
      var mailto = buildMailto(payload);
      window.location.href = mailto;
      showSuccess("메일 앱에서 전송을 완료해 주세요", "작성하신 내용을 메일에 옮겨 두었습니다. 메일 앱에서 보내기를 누르면 문의가 접수됩니다.", mailto);
    }
  });

  // 입력을 고치는 즉시 해당 항목의 오류를 지웁니다.
  function clearOnEdit(e){
    var t = e.target;
    if(t.id && t.getAttribute("aria-invalid") === "true") setError(t.id, "");
  }
  form.addEventListener("input", clearOnEdit);
  form.addEventListener("change", clearOnEdit);

  function open(opts){
    if(finished) resetForm();
    var message = opts && opts.message;
    // 사용자가 직접 쓴 문의 내용은 덮어쓰지 않습니다.
    if(message && (!messageEl.value.trim() || messageEl.value === prefilled)){
      messageEl.value = message;
      prefilled = message;
    } else if(!message && prefilled && messageEl.value === prefilled){
      messageEl.value = "";
      prefilled = "";
    }
    if(dialog.open) return;
    var scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.classList.add("qf-lock");
    if(scrollbar > 0) document.body.style.paddingRight = scrollbar + "px";
    dialog.showModal();
  }

  dialog.addEventListener("close", function(){
    document.documentElement.classList.remove("qf-lock");
    document.body.style.paddingRight = "";
    if(/^#(quote|consult)$/.test(window.location.hash)){
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  });

  // 백드롭 클릭으로 닫기. 입력창에서 시작한 드래그가 바깥에서 끝나도 닫히지 않도록 누른 지점도 확인합니다.
  var pressedBackdrop = false;
  dialog.addEventListener("pointerdown", function(e){ pressedBackdrop = e.target === dialog; });
  dialog.addEventListener("click", function(e){
    if(e.target === dialog && pressedBackdrop) dialog.close();
    else if(e.target.closest("[data-qf-close]")) dialog.close();
  });

  document.addEventListener("click", function(e){
    var opener = e.target.closest && e.target.closest("[data-open-quote],[data-open-consult]");
    if(!opener) return;
    e.preventDefault();
    open({ message: opener.getAttribute("data-quote-message") || "" });
  });

  function openFromUrl(){
    if(/^#(quote|consult)$/.test(window.location.hash) || /[?&]form=1\b/.test(window.location.search)) open();
  }
  window.addEventListener("hashchange", openFromUrl);
  openFromUrl();
})();
