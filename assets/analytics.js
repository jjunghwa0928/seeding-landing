// GA4 측정 ID를 채운다 (형식: G-XXXX). 비어 있으면 아무 것도 하지 않는다.
const GA_MEASUREMENT_ID = "";

// 운영 도메인에서만 로드한다 (github.io·localhost에서는 데이터를 보내지 않음).
if (GA_MEASUREMENT_ID && location.hostname === "influencer.enclu.com") {
  const gaScript = document.createElement("script");
  gaScript.async = true;
  gaScript.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_MEASUREMENT_ID;
  document.head.appendChild(gaScript);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", GA_MEASUREMENT_ID);
}
