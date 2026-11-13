// Copy buttons.
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

  // A control either names the element it copies (data-copy) or copies the
  // install command of whichever client tab is selected (data-copy-active).
  function sourceFor(control) {
    if (control.hasAttribute("data-copy")) {
      return document.getElementById(control.getAttribute("data-copy"));
    }
    var box = document.getElementById(control.getAttribute("data-copy-active"));
    var picked = box && box.querySelector('input[type="radio"]:checked');
    return picked ? document.getElementById(picked.id.replace("tab-", "cmd-")) : null;
  }

  document.querySelectorAll("[data-copy], [data-copy-active]").forEach(function (control) {
    var label = control.innerHTML;
    var timer;
    control.addEventListener("click", function (event) {
      var source = sourceFor(control);
      if (!source) return;
      event.preventDefault();
      copyText(source.textContent).then(
        function () {
          control.textContent = "Copied";
        },
        function () {
          control.textContent = "Select it";
        },
      ).then(function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          control.innerHTML = label;
        }, 1600);
      });
    });
  });
})();
