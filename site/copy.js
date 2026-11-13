// Copy buttons. Each button names the element whose text it copies.
(function () {
  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  document.querySelectorAll("button[data-copy]").forEach(function (button) {
    var label = button.textContent;
    var timer;
    button.addEventListener("click", function () {
      var source = document.getElementById(button.getAttribute("data-copy"));
      if (!source) return;
      copyText(source.textContent).then(
        function () {
          button.textContent = "Copied";
        },
        function () {
          button.textContent = "Select it";
        },
      ).then(function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          button.textContent = label;
        }, 1600);
      });
    });
  });
})();
