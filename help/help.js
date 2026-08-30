(() => {
  const radios = [...document.querySelectorAll('input[name="language"]')];
  const sections = [...document.querySelectorAll('[data-lang]')];
  const saved = localStorage.getItem('mwc-help-language');
  const preferred = saved || (navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en');

  function setLanguage(language) {
    for (const section of sections) section.hidden = section.dataset.lang !== language;
    for (const radio of radios) radio.checked = radio.value === language;
    document.documentElement.lang = language;
    localStorage.setItem('mwc-help-language', language);
  }

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      if (radio.checked) setLanguage(radio.value);
    });
  }

  setLanguage(preferred === 'en' ? 'en' : 'ko');
})();
