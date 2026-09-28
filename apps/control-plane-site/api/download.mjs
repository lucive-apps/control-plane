const RELEASES_URL = "https://github.com/lucive-apps/control-plane/releases/latest";
const LATEST_RELEASE_API = "https://api.github.com/repos/lucive-apps/control-plane/releases/latest";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.statusCode = 405;
    res.end();
    return;
  }

  let destination = RELEASES_URL;
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "control-plane-site",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const release = await response.json();
      const asset = release.assets?.find(
        (item) =>
          /^Control-Plane-\d+\.\d+\.\d+-arm64\.dmg$/.test(item.name) &&
          item.browser_download_url?.startsWith(
            "https://github.com/lucive-apps/control-plane/releases/download/",
          ),
      );
      if (asset) destination = asset.browser_download_url;
    }
  } catch {
    // The releases page remains available if GitHub's API is unavailable.
  }

  res.setHeader("Location", destination);
  res.setHeader(
    "Cache-Control",
    destination === RELEASES_URL ? "no-store" : "public, s-maxage=300, stale-while-revalidate=600",
  );
  res.statusCode = 302;
  res.end();
}
