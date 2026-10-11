// 試作（実装ステップ 1）の実機確認だけに使う観測。ワーカー（root）から見た認証情報の在りかと、
// サンドボックスの前提（権限・ユーザー名前空間・bubblewrap）を調べる。検証が済んだら消す。
// 認証情報そのものは記録しない（期限や種類だけを残す）。

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const run = promisify(execFile);
const IMDS = "http://169.254.169.254";

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

async function command(file: string, args: string[]) {
  try {
    const { stdout, stderr } = await run(file, args, { timeout: 10_000 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const e = error as { code?: unknown; stderr?: string; message?: string };
    return {
      ok: false,
      code: e.code,
      stderr: (e.stderr ?? e.message ?? "").trim().slice(0, 1000),
    };
  }
}

async function imds() {
  try {
    const token = await fetch(`${IMDS}/latest/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(2000),
    });
    if (!token.ok) return { reachable: true, tokenStatus: token.status };
    const headers = { "X-aws-ec2-metadata-token": await token.text() };
    const base = `${IMDS}/latest/meta-data/iam/security-credentials/`;
    const roles = await fetch(base, { headers });
    const roleName = (await roles.text()).split("\n")[0] ?? "";
    const creds = (await (
      await fetch(base + roleName, { headers })
    ).json()) as {
      Code?: string;
      Type?: string;
      LastUpdated?: string;
      Expiration?: string;
    };
    const minutesLeft = creds.Expiration
      ? Math.round((Date.parse(creds.Expiration) - Date.now()) / 60_000)
      : undefined;
    return {
      reachable: true,
      code: creds.Code,
      type: creds.Type,
      lastUpdated: creds.LastUpdated,
      expiration: creds.Expiration,
      minutesLeft,
    };
  } catch (error) {
    return { reachable: false, error: String(error) };
  }
}

async function callerIdentity(region: string) {
  try {
    const { Arn } = await new STSClient({ region }).send(
      new GetCallerIdentityCommand({}),
    );
    return { arn: Arn?.replace(/\d{12}/g, "XXXXXXXXXXXX") };
  } catch (error) {
    return { error: String(error) };
  }
}

export async function collectProbe(
  region: string,
): Promise<Record<string, unknown>> {
  const status = readText("/proc/self/status") ?? "";
  return {
    os: readText("/etc/os-release")?.match(/PRETTY_NAME="(.*)"/)?.[1],
    kernel: (await command("uname", ["-r"])).stdout,
    uid: process.getuid?.(),
    capEff: status.match(/CapEff:\s*(\S+)/)?.[1],
    maxUserNamespaces: readText("/proc/sys/user/max_user_namespaces"),
    unprivilegedUsernsClone: readText(
      "/proc/sys/kernel/unprivileged_userns_clone",
    ),
    awsEnvNames: Object.keys(process.env)
      .filter((name) => /AWS|ECS|CONTAINER|IMDS|METADATA/.test(name))
      .sort(),
    credentialFiles: [
      "/root/.aws",
      "/root/.aws/credentials",
      "/var/run/secrets",
    ].filter((path) => existsSync(path)),
    imds: await imds(),
    callerIdentity: await callerIdentity(region),
    bwrapVersion: await command("bwrap", ["--version"]),
    bwrapTry: await command("bwrap", [
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--unshare-all",
      "true",
    ]),
    // enableWeakerNestedSandbox と同じく、/proc を新しくマウントせずに bind する形
    bwrapWeakerTry: await command("bwrap", [
      "--ro-bind",
      "/",
      "/",
      "--bind",
      "/proc",
      "/proc",
      "--dev",
      "/dev",
      "--unshare-all",
      "true",
    ]),
    socat: await command("socat", ["-V"]).then((r) => ({
      ok: r.ok,
      version: r.stdout?.split("\n").find((l) => l.includes("version")),
    })),
  };
}
