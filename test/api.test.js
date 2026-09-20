import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { seedFromFixture } from "../src/seed.js";
import { buildServer } from "../src/server.js";

async function startServer(context, { seed = false } = {}) {
  const engine = new Engine();
  if (seed) await seedFromFixture(engine);
  const server = buildServer({ engine }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

const FLIGHT = "CZ3102-20260912";

test("随附记录回放：减客、离线扫描、容器更换全部落位", async (context) => {
  const base = await startServer(context, { seed: true });

  const summary = await call(base, "GET", `/flights/${FLIGHT}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.openExceptions, 1); // 仅剩扫描枪误传进已停用容器一条

  // 减客行李：迟到扫描按发生时间归位，卸下后异常自动解除。
  const chain = await call(base, "GET", `/flights/${FLIGHT}/bags/7812345678/chain`);
  assert.equal(chain.data.state, "OFFLOADED");
  assert.equal(chain.data.mustOffload, true);
  assert.deepEqual(
    chain.data.trajectory.map((s) => s.scanId),
    ["scan-1", "scan-2", "scan-4"],
  );
  const mustOffload = chain.data.exceptions.find((e) => e.type === "MUST_OFFLOAD");
  assert.equal(mustOffload.status, "RESOLVED");

  // 容器更换行李：卸下旧容器后装入新容器并装机；误传扫描被拒。
  const swapped = await call(base, "GET", `/flights/${FLIGHT}/bags/7812345679/chain`);
  assert.equal(swapped.data.state, "ON_AIRCRAFT");
  assert.equal(swapped.data.container, "AKE12002CZ");
  const rejected = swapped.data.otherScans.filter((s) => s.status === "REJECTED");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].scanId, "scan-8");

  // 重复补传被幂等吸收。
  const scans = await call(base, "GET", `/flights/${FLIGHT}/events`);
  const dupes = scans.data.filter((e) => e.summary.includes("scan-2") && e.type === "SCAN_APPLIED");
  assert.equal(dupes.length, 1);
});

test("完整关闭流程：阻止清单 → 处置 → 双人签署 → 关闭 → 重开", async (context) => {
  const base = await startServer(context, { seed: true });

  // 阻止清单：一条未决异常 + 签署不足。
  let blockers = await call(base, "GET", `/flights/${FLIGHT}/blockers`);
  assert.equal(blockers.data.canClose, false);
  assert.deepEqual(
    blockers.data.blockers.map((b) => b.type).sort(),
    ["INSUFFICIENT_SIGNATURES", "OPEN_EXCEPTIONS"],
  );

  // 未处置即关闭 → 409 并返回清单。
  const premature = await call(base, "POST", `/flights/${FLIGHT}/close`, { operator: "ops.chen" });
  assert.equal(premature.status, 409);
  assert.equal(premature.data.error, "CLOSE_BLOCKED");

  // 处置唯一未决异常。
  const open = await call(base, "GET", `/flights/${FLIGHT}/exceptions?status=OPEN`);
  assert.equal(open.data.length, 1);
  const disposition = await call(
    base,
    "POST",
    `/flights/${FLIGHT}/exceptions/${open.data[0].id}/disposition`,
    { operator: "ops.chen", conclusion: "GUN-09 离线缓存误传，实物复核在 AKE12002CZ" },
  );
  assert.equal(disposition.data.status, "RESOLVED");

  // 双人签署同一版本；同一操作者不能签两次；签署后新扫描会使签署失效。
  const version = (await call(base, "GET", `/flights/${FLIGHT}/manifest`)).data.version;
  assert.equal((await call(base, "POST", `/flights/${FLIGHT}/sign`, { operator: "ops.chen" })).status, 200);
  const dupSign = await call(base, "POST", `/flights/${FLIGHT}/sign`, { operator: "ops.chen" });
  assert.equal(dupSign.status, 409);
  assert.equal((await call(base, "POST", `/flights/${FLIGHT}/sign`, { operator: "ops.li" })).status, 200);

  const closed = await call(base, "POST", `/flights/${FLIGHT}/close`, { operator: "ops.chen" });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closedVersion, version);

  // 关闭后扫描被拒绝。
  const lateScan = await call(base, "POST", `/flights/${FLIGHT}/scans`, {
    scanId: "scan-late",
    bagTag: "7812345679",
    action: "OFFLOADED",
  });
  assert.equal(lateScan.status, 409);
  assert.equal(lateScan.data.error, "FLIGHT_CLOSED");

  // 重开留痕，版本递增，签署失效。
  const reopened = await call(base, "POST", `/flights/${FLIGHT}/reopen`, {
    operator: "ops.li",
    reason: "补扫核对",
  });
  assert.equal(reopened.data.status, "OPEN");
  blockers = await call(base, "GET", `/flights/${FLIGHT}/blockers`);
  assert.deepEqual(blockers.data.blockers.map((b) => b.type), ["INSUFFICIENT_SIGNATURES"]);

  // 审计：关键操作均留操作者。
  const events = await call(base, "GET", `/flights/${FLIGHT}/events`);
  for (const type of ["PASSENGER_OFFLOADED", "CONTAINER_REPLACED", "EXCEPTION_DISPOSITION", "SIGNED", "CLOSED", "REOPENED"]) {
    assert.ok(
      events.data.some((e) => e.type === type && e.actor && e.actor !== ""),
      `缺少 ${type} 的操作者留痕`,
    );
  }
});

test("扫描接口：批量接收互不影响，载荷冲突返回 409", async (context) => {
  const base = await startServer(context);
  await call(base, "POST", "/flights", { flightLegId: "F9", aircraftId: "B-9" });
  await call(base, "POST", "/flights/F9/passengers", { passengerId: "P1", bagTags: ["BAG1"] });

  const batch = await call(base, "POST", "/flights/F9/scans", {
    scans: [
      { scanId: "s1", bagTag: "BAG1", action: "LOADED_CONTAINER", container: "AKE1" },
      { scanId: "s2", bagTag: "BAG1", action: "LOADED_CONTAINER", container: "AKE2" },
      { scanId: "s3", bagTag: "GHOST", action: "ACCEPTED" },
    ],
  });
  assert.equal(batch.status, 200);
  assert.deepEqual(
    batch.data.results.map((r) => r.status),
    ["APPLIED", "REJECTED", "PARKED"],
  );

  // 同一 scanId 相同载荷 → 幂等返回首次结果；不同载荷 → 409。
  const retry = await call(base, "POST", "/flights/F9/scans", {
    scanId: "s9",
    bagTag: "BAG1",
    action: "SORTED",
    occurredAt: "2026-09-12T18:00:00+08:00",
  });
  assert.equal(retry.status, 200);
  const retryAgain = await call(base, "POST", "/flights/F9/scans", {
    scanId: "s9",
    bagTag: "BAG1",
    action: "SORTED",
    occurredAt: "2026-09-12T18:00:00+08:00",
  });
  assert.equal(retryAgain.data.duplicate, true);
  const conflict = await call(base, "POST", "/flights/F9/scans", {
    scanId: "s9",
    bagTag: "BAG1",
    action: "SORTED",
    occurredAt: "2026-09-12T18:05:00+08:00",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "SCAN_CONFLICT");

  // 未知航班 / 未知行李牌 → 404。
  assert.equal((await call(base, "GET", "/flights/NOPE/manifest")).status, 404);
  assert.equal((await call(base, "GET", "/bags/0000000000/chain")).status, 404);
});

test("跨航班按行李牌还原链路", async (context) => {
  const base = await startServer(context, { seed: true });
  const found = await call(base, "GET", "/bags/7812345678/chain");
  assert.equal(found.status, 200);
  assert.equal(found.data.flights.length, 1);
  assert.equal(found.data.flights[0].flightLegId, FLIGHT);
  assert.equal(found.data.flights[0].passengerStatus, "OFFLOADED");
});
