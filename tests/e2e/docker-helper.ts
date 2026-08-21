export const E2E_CONFIG = {
  clientUrl: process.env.E2E_CLIENT_URL || 'http://localhost:8080',
  serverUrl: process.env.E2E_SERVER_URL || 'ws://localhost:2567',
  serverHttpUrl: process.env.E2E_SERVER_HTTP_URL || 'http://localhost:2567',
  defaultTimeout: 30000,
} as const;

export async function waitForServer(
  url = E2E_CONFIG.serverHttpUrl,
  timeout = E2E_CONFIG.defaultTimeout,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeout}ms`);
}

export async function waitForClient(
  url = E2E_CONFIG.clientUrl,
  timeout = E2E_CONFIG.defaultTimeout,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // client not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Client at ${url} did not become ready within ${timeout}ms`);
}
