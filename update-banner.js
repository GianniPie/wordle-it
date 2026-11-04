// Shows "Nuova versione disponibile" when the service worker has downloaded a newer version of the app in the
// background (the app opens with the copy on the device, see sw.js): Aggiorna reloads the page with it.
(function () {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "parle-update" || document.getElementById("parle-update")) return;
    var bar = document.createElement("div");
    bar.id = "parle-update";
    bar.setAttribute("role", "status");
    bar.style.cssText =
      "position:fixed;z-index:10000;top:calc(env(safe-area-inset-top) + 10px);left:50%;transform:translateX(-50%);" +
      "display:flex;align-items:center;gap:10px;max-width:calc(100% - 32px);padding:6px 6px 6px 16px;border-radius:999px;" +
      "background:#538d4e;color:#fff;font:600 14px/1.2 system-ui,sans-serif;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.3)";
    bar.innerHTML =
      '<span>Nuova versione disponibile</span>' +
      '<button type="button" style="border:0;border-radius:999px;padding:8px 14px;background:#fff;color:#538d4e;font:700 14px system-ui,sans-serif;cursor:pointer">Aggiorna</button>' +
      '<button type="button" aria-label="Chiudi" style="border:0;background:none;color:#fff;font:400 20px/1 system-ui,sans-serif;padding:4px 8px;cursor:pointer">×</button>';
    var buttons = bar.querySelectorAll("button");
    buttons[0].onclick = function () {
      location.reload();
    };
    buttons[1].onclick = function () {
      bar.remove();
    };
    document.body.appendChild(bar);
  });

  // The page's own files are asked again through the service worker, which checks them on the server in the
  // background: a reload in the same tab can reuse the files already in memory without asking, and an app
  // brought back from the background is not reloaded at all.
  function check() {
    if (!navigator.serviceWorker.controller || document.visibilityState !== "visible") return;
    var files = [location.pathname];
    performance.getEntriesByType("resource").forEach(function (entry) {
      var url = new URL(entry.name);
      if (url.origin === location.origin && /\.(js|css)$/.test(url.pathname) && files.indexOf(url.pathname) < 0) files.push(url.pathname);
    });
    files.forEach(function (file) {
      fetch(file).catch(function () {});
    });
  }
  window.addEventListener("load", function () {
    setTimeout(check, 1000);
  });
  document.addEventListener("visibilitychange", check);
})();
