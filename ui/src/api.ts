export let token = "";
export function setToken(value: string) {
  token = value;
}
export async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
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
  const result = await response.json();
  if (response.status === 401 && token && !path.startsWith("/kiosk/")) {
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
