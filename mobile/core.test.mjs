import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  flattenRegistry,
  queryHistory,
  validateRegistry,
  verifyAuthorizationState,
} from "./core.mjs";

const qq = "123456789";
const sourceHash = "00".repeat(32);
const fingerprint = "e3895bcdd0e05ecc2352c05f28cdd3c35b948c331a5dab487261c01d30bdc382";

test("flattens v2 distribution records", () => {
  const rows = flattenRegistry({
    format: "RED-DISTRIBUTION-REGISTRY-V2",
    source_name: "主题.red",
    source_sha256: sourceHash,
    records: [{ qq, fingerprint, watermark_token: "token" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_name, "主题.red");
  assert.equal(rows[0].source_sha256, sourceHash);
});

test("flattens v3 distribution records", () => {
  const rows = flattenRegistry({
    format: "ERROR-DOOR-DISTRIBUTION-3",
    schema_version: 3,
    batch_id: "BATCH-1",
    sources: [{ source_id: "S001", name: "主题.red", sha256: sourceHash }],
    recipients: [{ qq, label: "薄巧", email: `${qq}@qq.com`, generated_files: [{ source_id: "S001", fingerprint, relative_path: `${qq}/主题_${qq}.red` }] }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "薄巧");
  assert.equal(rows[0].batch_id, "BATCH-1");
  assert.equal(rows[0].source_sha256, sourceHash);
});

test("QQ plus verification key reproduces desktop fingerprint", async () => {
  const registry = {
    format: "RED-DISTRIBUTION-REGISTRY-V2",
    source_name: "主题.red",
    source_sha256: sourceHash,
    records: [{ qq, fingerprint }],
  };
  const report = await queryHistory(qq, "测试密钥-123456", [{ registry }]);
  assert.equal(report.matches.length, 1);
  const wrong = await queryHistory(qq, "错误密钥-123456", [{ registry }]);
  assert.equal(wrong.matches.length, 0);
  assert.equal(wrong.candidateCount, 1);
});

test("rejects unrelated JSON", () => {
  assert.throws(() => validateRegistry({ hello: "world" }), /不是错误的门/);
});

test("verifies the published signed authorization state", async () => {
  const state = JSON.parse(await readFile(new URL("../license-state.json", import.meta.url), "utf8"));
  const verified = await verifyAuthorizationState(state);
  assert.equal(verified.revision >= 1, true);
});
