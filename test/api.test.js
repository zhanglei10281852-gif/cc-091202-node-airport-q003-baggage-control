import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { seedFromFile } from "../src/seed.js";

async function startServer(context, { seed = false } = {}) {
  const server = buildServer();
  if (seed) {
    await seedFromFile(server.store, new URL("../fixtures/context.json", import.meta.url).pathname);
  }
  server.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    store: server.store,
    get: async (path) => fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.json() })),
    post: async (path, payload) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) }).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      })),
    del: async (path) => fetch(`${base}${path}`, { method: "DELETE" }).then(async (r) => ({ status: r.status, body: await r.json() })),
  };
}

test("fixture 全流程:减客、离线补传、容器更换,处置后双人签署关闭", async (context) => {
  const api = await startServer(context, { seed: true });
  const F = "/flights/CZ3102-20260912";

  // 减客行李已卸下并留证据
  const trace1 = await api.get(`${F}/bags/7812345678/trace`);
  assert.equal(trace1.body.state, "OFFLOADED");
  assert.deepEqual(
    trace1.body.events.map((ev) => ev.scanId),
    ["acc-1", "srt-1", "scan-1", "scan-2", "scan-3"],
  );
  assert.deepEqual(
    trace1.body.events.find((ev) => ev.scanId === "scan-3").result,
    "APPLIED",
  );

  // 容器更换:行李重新核对后进入新容器,旧容器已停用
  const trace2 = await api.get(`${F}/bags/7812345679/trace`);
  assert.equal(trace2.body.state, "IN_CONTAINER");
  assert.equal(trace2.body.container, "AKE12002CZ");
  assert.equal(trace2.body.frozen, null);

  // 离线补传:重复扫描幂等,冲突扫描被拦下
  const trace3 = await api.get(`${F}/bags/7812345680/trace`);
  assert.equal(trace3.body.container, "AKE12003CZ");
  assert.equal(trace3.body.events.filter((ev) => ev.scanId === "scan-5").length, 1);
  assert.equal(trace3.body.events.find((ev) => ev.scanId === "scan-6").result, "CONTESTED");

  // 阻止签署的清单:三条未结案异常 + 舱单未出
  const before = await api.get(`${F}/blockers`);
  const openExceptions = before.body.blockers.filter((b) => b.code === "OPEN_EXCEPTION");
  assert.equal(openExceptions.length, 3);
  assert.ok(before.body.blockers.some((b) => b.code === "MANIFEST_STALE"));

  // 关闭被阻塞,返回具体清单
  const blocked = await api.post(`${F}/close`, { operator: "ctl-01" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "close_blocked");
  assert.ok(blocked.body.error.details.blockers.length > 0);

  // 逐条处置:减客卸下(已有卸下证据)、容器更换(已重新核对)、冲突(作废错误扫描)
  const exceptions = (await api.get(`${F}/exceptions?status=OPEN`)).body;
  for (const exception of exceptions) {
    if (exception.type === "LOCATION_CONFLICT") {
      const res = await api.post(`${F}/exceptions/${exception.exceptionId}/dispositions`, { operator: "sup-01", action: "VOID_SCAN", scanId: "scan-6" });
      assert.equal(res.status, 200);
    } else {
      const res = await api.post(`${F}/exceptions/${exception.exceptionId}/dispositions`, { operator: "sup-01", action: "ACKNOWLEDGE" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  }

  // 已登机旅客的行李装机
  for (const [bagTag, position] of [["7812345679", "11P"], ["7812345680", "12P"]]) {
    const res = await api.post(`${F}/scans`, { scanId: `final-${bagTag}`, bagTag, action: "LOADED_AIRCRAFT", position, occurredAt: "2026-09-12T19:10:00+08:00", actor: "ramp-03" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  // 出舱单、双人签署同一版本、关闭
  const manifest = await api.post(`${F}/manifests`, { operator: "lm-01" });
  assert.equal(manifest.status, 201);
  assert.equal(manifest.body.snapshot.bags.onAircraft.length, 2);
  assert.equal((await api.post(`${F}/manifests/${manifest.body.version}/signatures`, { operator: "lm-01" })).status, 200);
  assert.equal((await api.post(`${F}/manifests/${manifest.body.version}/signatures`, { operator: "ctl-01" })).status, 200);

  const closed = await api.post(`${F}/close`, { operator: "ctl-01" });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, "CLOSED");
  assert.equal(closed.body.counts.onAircraft, 2);

  // 操作者留痕:减客、换容器、处置、签署、关闭都可查
  const audit = (await api.get(`${F}/audit`)).body;
  for (const action of ["PASSENGER_OFFLOADED", "CONTAINER_SWAPPED", "EXCEPTION_DISPOSITIONED", "MANIFEST_SIGNED", "FLIGHT_CLOSED"]) {
    assert.ok(audit.some((entry) => entry.action === action), `审计缺少 ${action}`);
  }
});

test("离线扫描枪批量补传:逐条独立判定,重复幂等", async (context) => {
  const api = await startServer(context);
  await api.post("/flights", { flightLegId: "F9", aircraftId: "B-9" });
  await api.post("/flights/F9/passengers", { passengerId: "P1" });
  await api.post("/flights/F9/bags", { bagTag: "T1", passengerId: "P1" });

  const batch = await api.post("/flights/F9/scans/batch", {
    scans: [
      { scanId: "b1", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" },
      { scanId: "b2", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" },
      { scanId: "b2", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" },
      { scanId: "b3", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE2", occurredAt: "2026-09-12T17:01:00+08:00" },
      { scanId: "b4", bagTag: "NOPE", action: "SORTED", occurredAt: "2026-09-12T17:02:00+08:00" },
    ],
  });
  assert.equal(batch.status, 200);
  const [accepted, loaded, dup, conflict, unknown] = batch.body.results;
  assert.equal(accepted.status, "accepted");
  assert.equal(loaded.status, "accepted");
  assert.equal(dup.status, "duplicate");
  assert.equal(conflict.result, "CONTESTED"); // 同批冲突也被拦下
  assert.equal(unknown.status, "rejected");
  assert.equal(unknown.code, "unknown_bag");

  const bag = (await api.get("/flights/F9/bags/T1/trace")).body;
  assert.equal(bag.container, "AKE1"); // 唯一有效位置
  assert.equal(bag.events.filter((ev) => ev.scanId === "b2").length, 1);
});

test("并发重试同一扫描:只有一次生效,行李不会双挂", async (context) => {
  const api = await startServer(context);
  await api.post("/flights", { flightLegId: "F8", aircraftId: "B-8" });
  await api.post("/flights/F8/passengers", { passengerId: "P1" });
  await api.post("/flights/F8/bags", { bagTag: "T1", passengerId: "P1" });
  await api.post("/flights/F8/scans", { scanId: "acc", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });

  const payload = { scanId: "race", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" };
  const responses = await Promise.all(Array.from({ length: 20 }, () => api.post("/flights/F8/scans", payload)));
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200 && r.body.duplicate).length, 19);

  const bag = (await api.get("/flights/F8/bags/T1/trace")).body;
  assert.equal(bag.events.length, 2); // acc + race 各一次
  assert.equal(bag.container, "AKE1");
});

test("并发扫描进两个容器:有且仅有一个有效位置", async (context) => {
  const api = await startServer(context);
  await api.post("/flights", { flightLegId: "F7", aircraftId: "B-7" });
  await api.post("/flights/F7/passengers", { passengerId: "P1" });
  await api.post("/flights/F7/bags", { bagTag: "T1", passengerId: "P1" });
  await api.post("/flights/F7/scans", { scanId: "acc", bagTag: "T1", action: "ACCEPTED", occurredAt: "2026-09-12T16:00:00+08:00" });

  await Promise.all([
    api.post("/flights/F7/scans", { scanId: "g1", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: "2026-09-12T17:00:00+08:00" }),
    api.post("/flights/F7/scans", { scanId: "g2", bagTag: "T1", action: "LOADED_CONTAINER", container: "AKE2", occurredAt: "2026-09-12T17:00:01+08:00" }),
  ]);
  const bag = (await api.get("/flights/F7/bags/T1/trace")).body;
  assert.equal(bag.container, "AKE1"); // 按发生时间先到者为准
  assert.equal(bag.events.find((ev) => ev.scanId === "g2").result, "CONTESTED");
  const exceptions = (await api.get("/flights/F7/exceptions?status=OPEN")).body;
  assert.ok(exceptions.some((ex) => ex.type === "LOCATION_CONFLICT"));
});

test("输入校验与未知资源", async (context) => {
  const api = await startServer(context);
  await api.post("/flights", { flightLegId: "F6", aircraftId: "B-6" });

  const badAction = await api.post("/flights/F6/scans", { scanId: "x", bagTag: "T", action: "TELEPORT", occurredAt: "2026-09-12T16:00:00+08:00" });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error.code, "invalid_field");

  const unknownBag = await api.post("/flights/F6/scans", { scanId: "y", bagTag: "T", action: "SORTED", occurredAt: "2026-09-12T16:00:00+08:00" });
  assert.equal(unknownBag.status, 404);
  assert.equal(unknownBag.body.error.code, "unknown_bag");

  const missingFlight = await api.get("/flights/NOPE/blockers");
  assert.equal(missingFlight.status, 404);

  const noOperator = await api.post("/flights/F6/close", {});
  assert.equal(noOperator.status, 400);
});
