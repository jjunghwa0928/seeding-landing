// Google Tag Manager 컨테이너 ID (형식: GTM-XXXX). 비어 있으면 아무 것도 하지 않는다.
// GA4 등 개별 태그는 GTM 관리 화면에서 설정한다 (측정 ID를 코드에 넣지 않음).
const GTM_CONTAINER_ID = "GTM-K3RPL358";

// 운영 도메인에서만 로드한다 (github.io·localhost에서는 데이터를 보내지 않음).
if (GTM_CONTAINER_ID && location.hostname === "influencer.enclu.com") {
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  // GTM 표준 시작 이벤트 — '모든 페이지' 트리거가 이 이벤트로 실행된다.
  window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });

  const gtmScript = document.createElement("script");
  gtmScript.async = true;
  gtmScript.src = "https://www.googletagmanager.com/gtm.js?id=" + GTM_CONTAINER_ID;
  document.head.appendChild(gtmScript);
}

// 전환 이벤트 (README "분석 이벤트" 참고). 사용자가 입력한 값은 절대 넣지 않는다.
// GTM이 없는 환경에서도 dataLayer에 쌓이기만 하므로 도메인을 가리지 않는다.
(function () {
  const PAGE = /\/tool(\.html)?$/i.test(location.pathname) ? "tool" : "index";
  const KAKAO_RE = /^https?:\/\/([\w-]+\.)?kakao\.com(\/|$)/i;
  const CTA_SELECTOR = "[data-cta],[data-open-quote],[data-open-consult],a[href]";

  function push(data) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(data);
  }

  function ctaType(el) {
    const declared = el.getAttribute("data-cta");
    if (declared) return declared;
    if (el.matches("[data-open-quote],[data-open-consult]")) return "consult";
    const href = el.getAttribute("href") || "";
    if (/^tel:/i.test(href)) return "phone";
    if (/^mailto:/i.test(href)) return "email";
    if (KAKAO_RE.test(href)) return "kakao";
    return "";
  }

  function ctaLocation(el) {
    if (el.closest("dialog")) return "modal";
    if (el.closest("footer")) return "footer";
    if (el.closest(".sticky-cta")) return "sticky";
    const section = el.closest("section[id],header[id]");
    if (section) return section.id;
    if (el.closest("header,.topbar,.menu-panel,.secnav")) return "header";
    return "unknown";
  }

  // 캡처 단계: 다른 핸들러가 전파를 막거나 메뉴·모달 상태를 바꾸기 전에 읽는다.
  document.addEventListener("click", function (e) {
    const el = e.target.closest && e.target.closest(CTA_SELECTOR);
    if (!el) return;
    const type = ctaType(el);
    if (!type) return;
    push({ event: "cta_click", cta_type: type, cta_location: ctaLocation(el), page: PAGE });
  }, true);

  // assets/quote-form.js가 서버의 접수 성공 응답을 받았을 때만 폼에서 발생시킨다.
  document.addEventListener("enclu:quote-submitted", function (e) {
    const form = e.target;
    push({ event: "generate_lead", form_id: form.id || form.getAttribute("name") || "unknown", page: PAGE });
  });
})();
