const FIRST_DOWNLOAD_KEY = "control-plane-first-download-click-v1";

for (const link of document.querySelectorAll("a[data-download-location]")) {
  link.addEventListener("click", () => {
    if (typeof window.va !== "function") return;

    window.va("event", "Mac download click", { location: link.dataset.downloadLocation });
    try {
      if (localStorage.getItem(FIRST_DOWNLOAD_KEY) === null) {
        window.va("event", "First Mac download click");
        localStorage.setItem(FIRST_DOWNLOAD_KEY, "1");
      }
    } catch {
      // Storage can be disabled; the total click event still records the action.
    }
  });
}
