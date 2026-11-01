/**
 * The one script `/findings` runs: a click on a row's copy button puts the
 * finding key on the clipboard and says so on the button and in a live
 * region. The server sends it from `/console.js`, which the page's CSP allows
 * as `script-src 'self'`; nothing runs inline.
 *
 * `navigator.clipboard` needs a secure context, and 127.0.0.1 is one. The
 * `execCommand('copy')` path covers a browser that still refuses.
 */
export const COPY_SCRIPT = `'use strict';
(function () {
  var LABEL = 'Copy key';
  function fallback(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(text); });
    }
    return Promise.resolve(fallback(text));
  }
  document.addEventListener('click', function (event) {
    var button = event.target instanceof Element ? event.target.closest('button.copy') : null;
    if (!button) return;
    var key = button.getAttribute('data-key') || '';
    copy(key).then(function (ok) {
      button.textContent = ok ? 'Copied' : 'Copy failed';
      button.classList.toggle('copied', ok);
      var live = document.getElementById('copy-status');
      if (live) live.textContent = ok ? 'Copied ' + key : 'Could not copy ' + key;
      clearTimeout(button.__reset);
      button.__reset = setTimeout(function () {
        button.textContent = LABEL;
        button.classList.remove('copied');
      }, 1600);
    });
  });
})();
`;
