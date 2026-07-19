export function githubRepository(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  const scp = value.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(value);
    if (!new Set(["https:", "ssh:"]).has(url.protocol) || url.hostname.toLowerCase() !== "github.com") throw new Error();
    if (url.port || url.search || url.hash) throw new Error();
    if (url.protocol === "https:" && (url.username || url.password)) throw new Error();
    if (url.protocol === "ssh:" && (url.username !== "git" || url.password)) throw new Error();
    const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error();
    return parts.join("/");
  } catch {
    throw new Error("The approved origin is not a canonical GitHub HTTPS or SSH repository");
  }
}

export function isGitHubRemote(remoteUrl) {
  try { return Boolean(githubRepository(remoteUrl)); }
  catch { return false; }
}
