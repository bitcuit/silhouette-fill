// 글꼴 목록 — 항목을 추가하면 '글꼴' 선택에 나타납니다. 맨 위 항목이 기본값입니다.
//
//   name   : 선택 목록에 보일 이름
//   family : CSS font-family 이름. 웹폰트 CSS 안에 적힌 이름과 똑같아야 합니다.
//   css    : 웹폰트 CSS 주소 (Google Fonts, jsDelivr 등)
//   file   : css 대신 글꼴 파일을 직접 쓸 때. 예) 'fonts/MyFont.woff2' (이 저장소 안에 파일을 넣고 경로 지정)
//
// Google Fonts는 https://fonts.google.com 에서 글꼴을 고른 뒤 'Get embed code'의 href 주소를 css에 넣으면 됩니다.
// 굵게를 쓰려면 주소에 700 굵기가 포함돼야 합니다 (예: wght@400;700). 없으면 브라우저가 흉내 내서 그립니다.

window.FONT_LIST = [
  {
    name: '프리텐다드',
    family: 'Pretendard Variable',
    css: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css',
  },
  {
    name: '노토 산스',
    family: 'Noto Sans KR',
    css: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap',
  },
  {
    name: '노토 세리프',
    family: 'Noto Serif KR',
    css: 'https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap',
  },
];
