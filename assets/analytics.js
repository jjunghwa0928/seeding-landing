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
