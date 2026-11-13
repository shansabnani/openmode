// Plays the demo: types the request, then walks through the steps and ends on
// the finished film. Without this file the demo is still usable: the steps are
// radio tabs and the page opens on the last one.
(function () {
  var root = document.getElementById("replay");
  if (!root) return;

  var ask = document.getElementById("replay-ask");
  var again = root.querySelector(".replay-again");
  var video = root.querySelector("video");
  var steps = [1, 2, 3, 4, 5].map(function (n) {
    return document.getElementById("rs-" + n);
  });
  var text = ask.textContent;
  var holds = [2600, 3400, 3000, 2800]; // how long steps 1 to 4 stay up
  var timers = [];
  var playing = false;

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function stop() {
    timers.forEach(clearTimeout);
    timers = [];
    playing = false;
    ask.textContent = text;
    ask.classList.remove("typing");
    root.classList.remove("asking");
  }

  function show(index) {
    steps[index].checked = true;
    if (index === steps.length - 1) {
      playing = false;
      var saving = navigator.connection && navigator.connection.saveData;
      if (video && !saving) {
        video.muted = true;
        var started = video.play();
        if (started && started.catch) started.catch(function () {});
      }
      return;
    }
    later(function () {
      show(index + 1);
    }, holds[index]);
  }

  function play() {
    stop();
    playing = true;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    steps[0].checked = true;
    ask.style.minHeight = ask.offsetHeight + "px";
    ask.textContent = "";
    ask.classList.add("typing");
    root.classList.add("asking");
    var typed = 0;
    (function type() {
      typed += 2;
      ask.textContent = text.slice(0, typed);
      if (typed < text.length) {
        later(type, 28);
      } else {
        ask.classList.remove("typing");
        later(function () {
          root.classList.remove("asking");
          show(0);
        }, 450);
      }
    })();
  }

  // Anything the visitor does takes over from the replay.
  root.querySelectorAll(".replay-tabs label").forEach(function (label) {
    label.addEventListener("click", function () {
      if (playing) stop();
    });
  });

  again.hidden = false;
  again.addEventListener("click", play);

  var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (calm || !("IntersectionObserver" in window)) return;

  var seen = new IntersectionObserver(
    function (entries) {
      if (entries[0].isIntersecting) {
        seen.disconnect();
        play();
      }
    },
    { threshold: 0.4 },
  );
  seen.observe(root);
})();
