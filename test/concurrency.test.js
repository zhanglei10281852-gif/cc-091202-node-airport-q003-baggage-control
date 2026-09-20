import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Engine } from "../src/engine.js";
import { buildServer } from "../src/server.js";

async function startServer(context, engine) {
  const server = buildServer({ engine }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function postScan(base, scan) {
  const response = await fetch(`${base}/flights/F1/scans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scan),
  });
  return { status: response.status, data: await response.json() };
}

function makeEngine() {
  const engine = new Engine();
  engine.createFlight({ flightLegId: "F1", aircraftId: "B-1" });
  engine.registerPassenger("F1", { passengerId: "P1", bagTags: ["BAG1"] });
  return engine;
}

test("并发重试同一扫描：恰好应用一次，其余幂等吸收", async (context) => {
  const engine = makeEngine();
  const base = await startServer(context, engine);
  const payload = {
    scanId: "gun-0001",
    bagTag: "BAG1",
    action: "LOADED_CONTAINER",
    container: "AKE1",
    occurredAt: "2026-09-12T18:00:00+08:00",
  };

  const results = await Promise.all(Array.from({ length: 100 }, () => postScan(base, payload)));
  assert.equal(results.filter((r) => r.data.status === "APPLIED" && !r.data.duplicate).length, 1);
  assert.equal(results.filter((r) => r.data.duplicate === true).length, 99);

  const bag = engine.bags("F1").find((b) => b.bagTag === "BAG1");
  assert.equal(bag.state, "IN_CONTAINER");
  assert.equal(bag.container, "AKE1");
});

test("并发冲突扫描：一件行李永远只处于一个有效位置", async (context) => {
  const engine = makeEngine();
  const base = await startServer(context, engine);

  // 20 把“扫描枪”同时把同一件行李扫进两个不同集装器。
  const scans = [];
  for (let i = 0; i < 20; i += 1) {
    scans.push({
      scanId: `a-${i}`,
      bagTag: "BAG1",
      action: "LOADED_CONTAINER",
      container: "AKE-A",
      occurredAt: "2026-09-12T18:00:00+08:00",
    });
    scans.push({
      scanId: `b-${i}`,
      bagTag: "BAG1",
      action: "LOADED_CONTAINER",
      container: "AKE-B",
      occurredAt: "2026-09-12T18:00:00+08:00",
    });
  }
  const results = await Promise.all(scans.map((s) => postScan(base, s)));
  assert.equal(results.length, 40);

  const bag = engine.bags("F1").find((b) => b.bagTag === "BAG1");
  const winner = bag.container;
  assert.ok(["AKE-A", "AKE-B"].includes(winner), "行李必须处于一个且仅一个容器");

  // 胜方：一条 APPLIED，其余 REPEAT；负方：全部 REJECTED。
  const winnerResults = results.filter((_, i) => scans[i].container === winner);
  const loserResults = results.filter((_, i) => scans[i].container !== winner);
  assert.equal(winnerResults.filter((r) => r.data.status === "APPLIED").length, 1);
  assert.ok(winnerResults.every((r) => ["APPLIED", "REPEAT"].includes(r.data.status)));
  assert.ok(loserResults.every((r) => r.data.status === "REJECTED"));

  // 异常已挂出，等待人工处置；舱单中行李归属唯一。
  const open = engine.exceptions("F1", { status: "OPEN" });
  assert.ok(open.some((e) => e.type === "DOUBLE_POSITION"));
  const manifest = engine.manifest("F1");
  const memberships = manifest.containers.filter((c) => c.bags.includes("BAG1"));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].uld, winner);
});

test("并发减客与补传扫描：最终状态一致且可审计", async (context) => {
  const engine = makeEngine();
  engine.boardPassenger("F1", "P1");
  const base = await startServer(context, engine);

  const decidedAt = "2026-09-12T18:05:00+08:00";
  const tasks = [
    // 减客事件
    fetch(`${base}/flights/F1/passengers/P1/offload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operator: "ops.chen", at: decidedAt }),
    }),
    // 减客决定之前的迟到装机扫描（任何顺序下都应接收）
    postScan(base, {
      scanId: "late-1",
      bagTag: "BAG1",
      action: "LOADED_AIRCRAFT",
      occurredAt: "2026-09-12T18:01:00+08:00",
    }),
    // 与减客事件并发竞争的装载扫描（到达顺序决定接收或拒绝，两种都合法）
    postScan(base, {
      scanId: "late-2",
      bagTag: "BAG1",
      action: "LOADED_CONTAINER",
      container: "AKE1",
      occurredAt: "2026-09-12T18:09:00+08:00",
    }),
  ];
  await Promise.all(tasks);

  // 与到达顺序无关的不变量：
  const bag = engine.bags("F1").find((b) => b.bagTag === "BAG1");
  assert.equal(bag.mustOffload, true); // 减客标记一定已落下
  const chain = engine.bagChain("F1", "BAG1");
  // 18:01 的迟到装载一定在有效轨迹中（发生于减客决定之前）。
  assert.ok(chain.trajectory.some((s) => s.scanId === "late-1"));
  // 行李处于装载状态 → 必须卸下异常一定已挂出。
  assert.ok(engine.exceptions("F1", { status: "OPEN" }).some((e) => e.type === "MUST_OFFLOAD"));
  // 每条扫描都有且仅有一个结论，行李只有一个当前位置。
  const all = [...chain.trajectory, ...chain.otherScans];
  assert.equal(all.length, 2);
  assert.ok([...engine.flights.get("F1").containers.values()].filter((c) => c.bags.has("BAG1")).length <= 1);

  // 减客事件落定之后，任何发生于决定之后的装载一律拒绝（确定性防护）。
  const after = await postScan(base, {
    scanId: "late-3",
    bagTag: "BAG1",
    action: "LOADED_CONTAINER",
    container: "AKE2",
    occurredAt: "2026-09-12T18:20:00+08:00",
  });
  assert.equal(after.data.status, "REJECTED");
});

test("并发关闭：恰好一个操作者关闭成功", async (context) => {
  const engine = new Engine();
  engine.createFlight({ flightLegId: "F1", aircraftId: "B-1" });
  engine.sign("F1", { operator: "ops.a" });
  engine.sign("F1", { operator: "ops.b" });
  const base = await startServer(context, engine);

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      fetch(`${base}/flights/F1/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operator: `ops.${i}` }),
      }).then((r) => r.status),
    ),
  );
  assert.equal(results.filter((s) => s === 200).length, 1);
  assert.equal(results.filter((s) => s === 409).length, 4);
  assert.equal(engine.flightSummary("F1").status, "CLOSED");
});
