import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createHookServer, HOOK_PATH_PREFIX } from "../src/hook-server";

const servers: Array<{ close: () => void }> = [];

async function start(handlers: Parameters<typeof createHookServer>[0]) {
  const server = createHookServer(handlers);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return (path: string, body?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const runBody = JSON.stringify({
  microvmId: "mvm-0001",
  runHookPayload: JSON.stringify({ jobId: "01JOB", modelId: "m" }),
});

describe("createHookServer", () => {
  test("/ready は 200 を返す", async () => {
    const post = await start({ onRun: vi.fn(), onTerminate: vi.fn() });
    const response = await post(`${HOOK_PATH_PREFIX}/ready`);
    expect(response.status).toBe(200);
  });

  test("/run はジョブを始めて、終わりを待たずに 200 を返す", async () => {
    const onRun = vi.fn(() => new Promise<void>(() => {}));
    const post = await start({ onRun, onTerminate: vi.fn() });
    const response = await post(`${HOOK_PATH_PREFIX}/run`, runBody);
    expect(response.status).toBe(200);
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ microvmId: "mvm-0001", jobId: "01JOB" }),
    );
  });

  test("/run の本文が不正なら 400 を返し、ジョブを始めない", async () => {
    const onRun = vi.fn();
    const post = await start({ onRun, onTerminate: vi.fn() });
    const response = await post(`${HOOK_PATH_PREFIX}/run`, "{}");
    expect(response.status).toBe(400);
    expect(onRun).not.toHaveBeenCalled();
  });

  test("/terminate は終了処理を待ってから 200 を返す", async () => {
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    const post = await start({ onRun: vi.fn(), onTerminate });
    const response = await post(`${HOOK_PATH_PREFIX}/terminate`);
    expect(response.status).toBe(200);
    expect(onTerminate).toHaveBeenCalledOnce();
  });

  test("知らないパスは 404 を返す", async () => {
    const post = await start({ onRun: vi.fn(), onTerminate: vi.fn() });
    const response = await post("/unknown");
    expect(response.status).toBe(404);
  });
});
