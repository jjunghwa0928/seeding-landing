/*
 * 견적 문의 모달: index.html과 tool.html이 함께 쓰는 단일 구현입니다.
 *
 * 여는 방법
 *  - [data-open-quote] 또는 [data-open-consult] 요소 클릭
 *    (data-quote-message="..."가 있으면 문의 내용을 미리 채우고, data-quote-source="..."는 문의 경로로 전송)
 *  - 페이지 주소의 #quote (tool.html의 기존 #consult, ?form=1 링크도 지원)
 *
 * 페이지가 window.encluQuoteContext()를 정의하면 제출 시점에 호출해
 * 반환값 {category, tier, quantity, goal, voucher}를 화면에 표시하지 않고 전송 내용에 덧붙입니다.
 * window.encluQuoteVouchers()를 정의하면 모달을 열 때 반환한 키(["kita"] 등)로 수출바우처 칸을 미리 체크합니다.
 *
 * 열 때 history 항목을 하나 추가해 브라우저 뒤로 가기가 페이지 이탈 대신 모달 닫기가 되게 합니다.
 * X/ESC/백드롭으로 닫으면 그 항목을 history.back()으로 되돌려 흔적을 남기지 않습니다.
 */
(function(){
  "use strict";

  // ==================================================================
  // SUBMIT ENDPOINT (api/server.js, IIS가 /api/*를 프록시):
  // The form POSTs JSON here. mailto: to mkt2@enclu.co.kr is only a
  // fallback: offered inline on a network error or 5xx, and used right
  // away on GitHub Pages, which has no API.
  // ==================================================================
  var SUBMIT_ENDPOINT = '/api/quote';
  var HAS_API = !/\.github\.io$/i.test(window.location.hostname);
  var CONSULT_EMAIL = 'mkt2@enclu.co.kr';

  // api/server.js의 QUANTITY_OPTIONS와 같아야 합니다 (api/test/quote.test.js가 확인).
  var QUANTITY_OPTIONS = ["50명 미만", "50~100명", "100~300명", "300명 이상", "미정 / 상담 후 결정"];
  // 수출바우처 문구는 여기서만 고칩니다. api/server.js, tool.html의 VOUCHERS와 같아야 합니다 (api/test/quote.test.js가 확인).
  var VOUCHERS = [
    {"key":"kita","label":"한국무역협회 수출바우처","short":"한국무역협회"},
    {"key":"kosme","label":"중소벤처기업진흥공단 수출바우처","short":"중소벤처기업진흥공단"}
  ];
  // people은 이전 버전 tool.html(캐시)이 보내는 값입니다.
  var CONTEXT_LABELS = { category:"카테고리", tier:"인플루언서 등급", quantity:"시딩 수량", people:"인원", goal:"목표", voucher:"수출바우처" };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RE = /^[0-9+()\-\s]+$/;

  // FIELDS drives rendering, validation and the mail body. Add new fields here only.
  var FIELDS = [
    { key:"company",  label:"업체명 / 브랜드명", type:"text",  required:true, maxlength:100, autocomplete:"organization", placeholder:"예) OOO코스메틱 / OOO브랜드",
      validate:function(v){ return v ? "" : "업체명 또는 브랜드명을 입력해 주세요."; } },
    { key:"contactName", label:"담당자명",       type:"text",  required:true, maxlength:100, autocomplete:"name", placeholder:"예) 홍길동",
      validate:function(v){ return v ? "" : "담당자명을 입력해 주세요."; } },
    { key:"phone",    label:"연락처",           type:"tel",   required:true, maxlength:30, autocomplete:"tel", placeholder:"예) 010-0000-0000",
      validate:function(v){
        if(!v) return "연락처를 입력해 주세요.";
        var digits = v.replace(/\D/g, "").length;
        return (PHONE_RE.test(v) && digits >= 9 && digits <= 15) ? "" : "연락처 형식을 확인해 주세요. 예) 010-0000-0000";
      } },
    { key:"email",    label:"이메일",           type:"email", required:true, maxlength:200, autocomplete:"email", placeholder:"예) name@company.com",
      validate:function(v){
        if(!v) return "이메일을 입력해 주세요.";
        return EMAIL_RE.test(v) ? "" : "이메일 형식을 확인해 주세요. 예) name@company.com";
      } },
    { key:"quantity", label:"희망 진행 수량",    type:"select", required:true, options:QUANTITY_OPTIONS,
      validate:function(v){ return v ? "" : "희망 진행 수량을 선택해 주세요."; } },
    { key:"vouchers", label:"수출바우처 보유 여부", type:"checkboxes", required:false, options:VOUCHERS },
    { key:"message",  label:"문의 내용",         type:"textarea", required:false, maxlength:3000, placeholder:"희망 플랫폼, 제품명, 예산, 진행 일정 등 자유롭게 작성해 주세요." }
  ];

  var HOME_URL = "index.html";
  var IS_LANDING = !!document.getElementById("hero");

  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function checkboxesHtml(f){
    var id = "qf-" + f.key;
    return '<div class="qf-field">' +
      '<div class="qf-label" id="' + id + '-label">' + f.label + '<span class="qf-opt">(선택)</span></div>' +
      '<div class="qf-checks" id="' + id + '" role="group" tabindex="-1" aria-labelledby="' + id + '-label" aria-describedby="' + id + '-err">' +
        f.options.map(function(o){
          return '<label class="qf-consent" for="' + id + '-' + o.key + '">' +
            '<input type="checkbox" id="' + id + '-' + o.key + '" name="' + f.key + '" value="' + o.key + '"><span>' + o.label + '</span>' +
          '</label>';
        }).join("") +
      '</div>' +
      '<p class="qf-error" id="' + id + '-err"></p>' +
    '</div>';
  }

  function fieldHtml(f){
    if(f.type === "checkboxes") return checkboxesHtml(f);
    var id = "qf-" + f.key;
    var attrs = 'id="' + id + '" name="' + f.key + '" class="qf-input" aria-describedby="' + id + '-err"' + (f.required ? ' aria-required="true"' : '') + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '');
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
          '<li><b>수집 항목</b>업체명·브랜드명, 담당자명, 연락처, 이메일, 희망 진행 수량, 수출바우처 보유 여부, 문의 내용, 예상 실적 계산 조건(예상 실적 확인 페이지에서 문의한 경우)</li>' +
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
    '<div class="qf-topbar">' +
      '<a class="qf-home" href="' + HOME_URL + '" data-qf-home><span aria-hidden="true">←</span> 홈으로</a>' +
      '<div class="qf-brand"><img src="assets/enclu_logo.png" width="28" height="28" alt=""><span>ENCLU</span></div>' +
    '</div>' +
    '<button type="button" class="qf-close" data-qf-close aria-label="닫기">' + ICON_CLOSE + '</button>' +
    '<div class="qf-scroll">' +
      '<form class="qf-form" id="qf-form" novalidate>' +
        '<h2 class="qf-title" id="qf-title" tabindex="-1" autofocus>일본 시딩 견적 문의</h2>' +
        '<p class="qf-lead">간단한 정보만 남겨주시면 담당자가 상담을 도와드립니다.</p>' +
        FIELDS.map(fieldHtml).join("") +
        CONSENT_HTML +
        '<div class="qf-hp" aria-hidden="true"><label for="qf-website">웹사이트</label><input type="text" id="qf-website" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"></div>' +
        '<button type="submit" class="btn btn-blue qf-submit">견적 문의 하기</button>' +
        '<p class="qf-status" id="qf-status" role="alert"></p>' +
      '</form>' +
      '<div class="qf-success" id="qf-success" hidden>' +
        '<div class="qf-success-icon">' + ICON_CHECK + '</div>' +
        '<h2 class="qf-title" id="qf-success-title" tabindex="-1"></h2>' +
        '<p id="qf-success-text"></p>' +
        '<p id="qf-success-mail" hidden>메일 앱이 열리지 않았다면 <a id="qf-mail-link" href="#">여기를 눌러 다시 열거나</a> ' + CONSULT_EMAIL + '로 보내 주세요.</p>' +
        '<a class="btn btn-blue" href="' + HOME_URL + '" data-qf-home>홈으로 돌아가기</a>' +
        '<button type="button" class="qf-textlink" data-qf-close>닫기</button>' +
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
  var source = IS_LANDING ? "index" : "tool";
  var voucherSynced = null; // 폼에 마지막으로 옮긴 계산기 스위치 값

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
    voucherSynced = null;
    finished = false;
  }

  function voucherBoxes(){
    return Array.prototype.slice.call(dialog.querySelectorAll('input[name="vouchers"]'));
  }

  // 계산기 스위치가 바뀌었을 때만 옮깁니다. 스위치 그대로면 사용자가 폼에서 고친 값을 덮어쓰지 않습니다.
  function syncVouchers(){
    if(typeof window.encluQuoteVouchers !== "function") return;
    var keys = window.encluQuoteVouchers();
    var synced = keys.join(",");
    if(synced === voucherSynced) return;
    voucherSynced = synced;
    voucherBoxes().forEach(function(box){ box.checked = keys.indexOf(box.value) !== -1; });
  }

  // api/server.js의 formatVouchers와 같은 표기입니다.
  function voucherSummary(keys){
    if(!keys.length) return "미보유";
    return VOUCHERS.map(function(o){ return o.short + (keys.indexOf(o.key) !== -1 ? " 보유" : " 미보유"); }).join(", ");
  }

  function buildPayload(){
    var payload = {};
    FIELDS.forEach(function(f){
      if(f.type === "checkboxes") return;
      payload[f.key] = dialog.querySelector("#qf-" + f.key).value.trim();
    });
    payload.vouchers = voucherBoxes().filter(function(box){ return box.checked; }).map(function(box){ return box.value; });
    payload.consent = dialog.querySelector("#qf-consent").checked;
    payload.source = source;
    payload.website = dialog.querySelector("#qf-website").value;
    if(typeof window.encluQuoteContext === "function") payload.context = window.encluQuoteContext();
    return payload;
  }

  function buildMailto(payload){
    var subject = "[일본 시딩 견적 문의] " + payload.company;
    var lines = FIELDS.map(function(f){
      return f.label + ": " + (f.type === "checkboxes" ? voucherSummary(payload[f.key]) : (payload[f.key] || "-"));
    });
    lines.push("개인정보 수집·이용 동의: 동의함");
    if(payload.context){
      lines.push("", "=== 예상 실적 확인에서 선택한 조건 ===");
      Object.keys(CONTEXT_LABELS).forEach(function(k){
        if(payload.context[k] !== undefined) lines.push(CONTEXT_LABELS[k] + ": " + payload.context[k]);
      });
    }
    lines.push("", "페이지: " + window.location.href, "요청 시각: " + new Date().toISOString());
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
    if(!HAS_API){
      // mailto는 메일 앱을 여는 것까지만 하므로, 접수 완료로 안내하지 않습니다.
      var mailto = buildMailto(payload);
      window.location.href = mailto;
      showSuccess("메일 앱에서 전송을 완료해 주세요", "작성하신 내용을 메일에 옮겨 두었습니다. 메일 앱에서 보내기를 누르면 문의가 접수됩니다.", mailto);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "전송 중…";
    fetch(SUBMIT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(res){
      if(res.ok){
        showSuccess("견적 문의가 접수되었습니다", "담당자가 확인 후 영업일 기준 1~2일 내 회신드립니다.");
        return;
      }
      enableSubmit();
      if(res.status >= 500){ showMailFallback(payload); return; }
      if(res.status === 429){ statusEl.textContent = "잠시 후 다시 시도해 주세요."; return; }
      return res.json().catch(function(){ return {}; }).then(function(body){
        showServerErrors(res.status === 400 ? body.fields : null);
      });
    }).catch(function(){
      enableSubmit();
      showMailFallback(payload);
    });
  });

  function enableSubmit(){
    submitBtn.disabled = false;
    submitBtn.textContent = "견적 문의 하기";
  }

  function showMailFallback(payload){
    var link = document.createElement("a");
    link.href = buildMailto(payload);
    link.textContent = "메일 앱으로 보내기";
    statusEl.textContent = "전송에 실패했습니다. ";
    statusEl.appendChild(link);
  }

  // 서버가 돌려준 항목별 오류를 폼의 오류 자리에 표시합니다.
  function showServerErrors(fields){
    var firstInvalid = null;
    FIELDS.map(function(f){ return f.key; }).concat("consent").forEach(function(key){
      if(!fields || !fields[key]) return;
      setError("qf-" + key, String(fields[key]));
      if(!firstInvalid) firstInvalid = dialog.querySelector("#qf-" + key);
    });
    if(firstInvalid) firstInvalid.focus();
    else statusEl.textContent = "전송하지 못했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요.";
  }

  // 입력을 고치는 즉시 해당 항목의 오류를 지웁니다.
  function clearOnEdit(e){
    var t = e.target;
    if(t.name === "vouchers") setError("qf-vouchers", "");
    else if(t.id && t.getAttribute("aria-invalid") === "true") setError(t.id, "");
  }
  form.addEventListener("input", clearOnEdit);
  form.addEventListener("change", clearOnEdit);

  var HISTORY_KEY = "qfDialog";
  var pushed = false;       // 현재 history 항목이 이 모달이 추가한 항목인지
  var pendingBack = false;  // 닫으면서 호출한 history.back()의 popstate를 기다리는 중인지
  var goTop = false;        // 닫은 뒤 페이지 맨 위로 이동할지 (랜딩의 홈으로)
  var leaving = false;      // 다른 페이지로 이동 중인지 (tool.html의 홈으로)

  function onOurEntry(){
    return !!(history.state && history.state[HISTORY_KEY]);
  }

  function pushEntry(){
    var state = {};
    state[HISTORY_KEY] = true;
    history.pushState(state, "", window.location.href);
    pushed = true;
  }

  function afterClose(){
    if(/^#(quote|consult)$/.test(window.location.hash)){
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if(!goTop) return;
    goTop = false;
    // history 이동의 스크롤 복원이 끝난 뒤에 실행되도록 다음 태스크로 미룹니다.
    setTimeout(function(){
      var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top:0, behavior: reduced ? "auto" : "smooth" });
    }, 0);
  }

  function goHome(){
    if(IS_LANDING){
      goTop = true;
      dialog.close();
      return;
    }
    // 추가한 항목을 index.html로 교체하므로 되돌릴 항목이 남지 않습니다.
    leaving = true;
    pushed = false;
    dialog.close();
    window.location.replace(HOME_URL);
  }

  // resume: 이미 이 모달의 history 항목에 있을 때(새로고침, 앞으로 가기) 항목을 또 추가하지 않습니다.
  function open(opts, resume){
    goTop = false;
    if(finished) resetForm();
    syncVouchers();
    source = (opts && opts.source) || (IS_LANDING ? "index" : "tool");
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
    if(resume) pushed = true;
    else if(!pendingBack) pushEntry();
  }

  dialog.addEventListener("close", function(){
    document.documentElement.classList.remove("qf-lock");
    document.body.style.paddingRight = "";
    if(leaving) return;
    if(pushed){
      pushed = false;
      pendingBack = true;
      history.back();
    } else {
      afterClose();
    }
  });

  window.addEventListener("popstate", function(){
    if(pendingBack){
      pendingBack = false;
      // back을 기다리는 사이 다시 열었다면 그때 미룬 항목을 이제 추가합니다.
      if(dialog.open) pushEntry();
      else afterClose();
      return;
    }
    if(onOurEntry() && !dialog.open){
      open(null, true);
    } else if(!onOurEntry() && dialog.open){
      pushed = false;
      dialog.close();
    }
  });

  // 백드롭 클릭으로 닫기. 입력창에서 시작한 드래그가 바깥에서 끝나도 닫히지 않도록 누른 지점도 확인합니다.
  var pressedBackdrop = false;
  dialog.addEventListener("pointerdown", function(e){ pressedBackdrop = e.target === dialog; });
  dialog.addEventListener("click", function(e){
    if(e.target === dialog && pressedBackdrop) dialog.close();
    else if(e.target.closest("[data-qf-close]")) dialog.close();
    else if(e.target.closest("[data-qf-home]") && !e.metaKey && !e.ctrlKey && !e.shiftKey){
      e.preventDefault();
      goHome();
    }
  });

  document.addEventListener("click", function(e){
    var opener = e.target.closest && e.target.closest("[data-open-quote],[data-open-consult]");
    if(!opener) return;
    e.preventDefault();
    open({ message: opener.getAttribute("data-quote-message") || "", source: opener.getAttribute("data-quote-source") || "" });
  });

  function openFromUrl(){
    if(/^#(quote|consult)$/.test(window.location.hash) || /[?&]form=1\b/.test(window.location.search)) open();
  }
  window.addEventListener("hashchange", openFromUrl);
  if(onOurEntry()) open(null, true);
  else openFromUrl();
})();
