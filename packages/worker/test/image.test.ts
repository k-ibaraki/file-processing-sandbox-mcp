import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LIBREOFFICE_PROFILE_DIR } from "../src/preprocess";

const dockerfile = readFileSync(
  join(import.meta.dirname, "../image/Dockerfile"),
  "utf8",
);

describe("MicroVM イメージ", () => {
  test("前処理が使う LibreOffice のプロファイルを、イメージの作成時に作っておく", () => {
    // MicroVM では最初に LibreOffice を使うファイルの前処理が遅かった（実測 B1）。プロファイルの場所がずれると、作成時に作った意味が無くなる
    expect(LIBREOFFICE_PROFILE_DIR.startsWith("/tmp")).toBe(false);
    expect(dockerfile).toContain(
      `-env:UserInstallation=file://${LIBREOFFICE_PROFILE_DIR}`,
    );
  });
});
