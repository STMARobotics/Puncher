export let token = "";
export function setToken(value: string) {
  token = value;
}
export async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  options: { silentUnauthorized?: boolean } = {},
) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  let result: any = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (
    response.status === 401 &&
    !options.silentUnauthorized &&
    !path.startsWith("/kiosk/") &&
    path !== "/auth/logout"
  ) {
    token = "";
    window.dispatchEvent(new Event("puncher-auth-expired"));
  }
  if (!response.ok)
    throw Object.assign(new Error(result.message || "Request failed."), {
      status: response.status,
    });
  return result;
}
export function duration(seconds: number) {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function time(iso?: string) {
  return iso
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(iso))
    : "";
}
