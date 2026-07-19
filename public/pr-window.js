function httpsUrl(value) {
  try {
    const parsed = new URL(String(value));
    const pullRequestPath = /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/.*)?$/;
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.port &&
      !parsed.username && !parsed.password && pullRequestPath.test(parsed.pathname)
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

export function reservePrWindow(hostWindow, action) {
  if (action !== "pr") return null;
  try {
    const reserved = hostWindow.open("about:blank", "_blank");
    if (reserved) reserved.opener = null;
    return reserved;
  } catch {
    return null;
  }
}

export function closeReservedPrWindow(reserved) {
  try {
    if (reserved && !reserved.closed) reserved.close();
  } catch {}
}

export function openReservedPrWindow(hostWindow, reserved, value) {
  const url = httpsUrl(value);
  if (!url) {
    closeReservedPrWindow(reserved);
    return false;
  }
  try {
    if (reserved && !reserved.closed) {
      reserved.location.replace(url);
      return true;
    }
  } catch {}
  // Electron denies the about:blank reservation and routes this HTTPS URL to
  // the system browser. In a normal browser, the rendered PR link remains the
  // fallback if an extension closes the already-reserved window.
  try {
    hostWindow.open(url, "_blank", "noopener");
    return true;
  } catch {
    return false;
  }
}
