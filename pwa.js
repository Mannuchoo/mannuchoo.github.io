(function registerPolySokoPwa() {
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((err) => {
            console.warn("PWA service worker registration failed:", err.message);
        });
    });
})();
