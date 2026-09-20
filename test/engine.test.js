import assert from "node:assert/strict";
import test from "node:test";
import { Engine, EngineError } from "../src/engine.js";
import { foldTrajectory } from "../src/stateMachine.js";

const T = "2026-09-12T20:00:00+08:00";

function makeEngine() {
  const engine = new Engine({ clock: () => T });
  engine.createFlight({ flightLegId: "F1", aircraftId: "B-1", holds: ["H1"] });
  engine.registerPassenger("F1", { passengerId: "P1", bagTags: ["BAG1"] });
  engine.registerPassenger("F1", { passengerId: "P2", bagTags: ["BAG2"] });
  return engine;
}

function scan(scanId, bagTag, action, extra = {}) {
  return { scanId, bagTag, action, occurredAt: "2026-09-12T18:00:00+08:00", ...extra };
}

function bagOf(engine, tag) {
  return engine.bags("F1").find((b) => b.bagTag === tag);
}

function openExceptions(engine, type = undefined) {
  const all = engine.exceptions("F1", { status: "OPEN" });
  return type ? all.filter((e) => e.type === type) : all;
}

test("状态机：顺序扫描推进，跳级标记推定环节", () => {
  const folded = foldTrajectory([
    { scanId: "s1", action: "LOADED_CONTAINER", container: "AKE1", occurredAt: T },
    { scanId: "s2", action: "LOADED_AIRCRAFT", occurredAt: T },
  ]);
  assert.equal(folded.ok, true);
  assert.equal(folded.state, "ON_AIRCRAFT");
  assert.equal(folded.container, "AKE1");
  assert.deepEqual(folded.steps[0].implied, ["ACCEPTED", "SORTED"]);
});

test("迟到乱序扫描按发生时间归位，轨迹自愈", () => {
  const engine = makeEngine();
  // 装机扫描先到（离线补传），装箱扫描后到但发生时间更早。
  engine.ingestScan("F1", scan("s2", "BAG1", "LOADED_AIRCRAFT", { occurredAt: "2026-09-12T18:01:00+08:00" }));
  assert.equal(bagOf(engine, "BAG1").state, "ON_AIRCRAFT");
  assert.equal(bagOf(engine, "BAG1").container, null);

  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", {
    container: "AKE1",
    occurredAt: "2026-09-12T17:55:00+08:00",
  }));
  const bag = bagOf(engine, "BAG1");
  assert.equal(bag.state, "ON_AIRCRAFT");
  assert.equal(bag.container, "AKE1");

  const chain = engine.bagChain("F1", "BAG1");
  assert.deepEqual(chain.trajectory.map((s) => s.scanId), ["s1", "s2"]);
});

test("同一 scanId 重试幂等；载荷不一致则冲突", () => {
  const engine = makeEngine();
  const first = engine.ingestScan("F1", scan("s1", "BAG1", "ACCEPTED"));
  assert.equal(first.status, "APPLIED");
  const versionAfterFirst = engine.flightSummary("F1").manifestVersion;

  const retry = engine.ingestScan("F1", scan("s1", "BAG1", "ACCEPTED"));
  assert.equal(retry.duplicate, true);
  assert.equal(engine.flightSummary("F1").manifestVersion, versionAfterFirst);

  assert.throws(
    () => engine.ingestScan("F1", scan("s1", "BAG1", "SORTED")),
    (err) => err instanceof EngineError && err.code === "SCAN_CONFLICT" && err.httpStatus === 409,
  );
});

test("效果一致的重复扫描（不同 scanId）是幂等空操作", () => {
  const engine = makeEngine();
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  const again = engine.ingestScan("F1", scan("s2", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  assert.equal(again.status, "REPEAT");
  assert.equal(bagOf(engine, "BAG1").container, "AKE1");
});

test("一件行李不能同时算进两个集装器", () => {
  const engine = makeEngine();
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  const conflict = engine.ingestScan("F1", scan("s2", "BAG1", "LOADED_CONTAINER", { container: "AKE2" }));
  assert.equal(conflict.status, "REJECTED");
  assert.equal(bagOf(engine, "BAG1").container, "AKE1");
  assert.equal(openExceptions(engine, "DOUBLE_POSITION").length, 1);

  // 迟到扫描同样受约束：插入历史位置后仍会破坏一致性。
  engine.ingestScan("F1", scan("s3", "BAG1", "OFFLOADED", { occurredAt: "2026-09-12T18:10:00+08:00" }));
  engine.ingestScan("F1", scan("s4", "BAG1", "LOADED_CONTAINER", {
    container: "AKE2",
    occurredAt: "2026-09-12T18:20:00+08:00",
  }));
  const late = engine.ingestScan("F1", scan("s5", "BAG1", "LOADED_CONTAINER", {
    container: "AKE1",
    occurredAt: "2026-09-12T18:15:00+08:00",
  }));
  assert.equal(late.status, "REJECTED");
  assert.equal(bagOf(engine, "BAG1").container, "AKE2");
});

test("违反物理先后的扫描被拒绝并挂异常", () => {
  const engine = makeEngine();
  const result = engine.ingestScan("F1", scan("s1", "BAG1", "OFFLOADED"));
  assert.equal(result.status, "REJECTED");
  assert.equal(openExceptions(engine, "OUT_OF_SEQUENCE").length, 1);
  assert.equal(bagOf(engine, "BAG1").state, "EXPECTED");
});

test("减客：立即标记必须卸下，已装载行李挂异常，卸下后自动解除", () => {
  const engine = makeEngine();
  engine.boardPassenger("F1", "P1");
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  engine.ingestScan("F1", scan("s2", "BAG1", "LOADED_AIRCRAFT"));

  engine.offloadPassenger("F1", "P1", { operator: "ops.chen", at: "2026-09-12T18:30:00+08:00" });
  assert.equal(bagOf(engine, "BAG1").mustOffload, true);
  assert.equal(openExceptions(engine, "MUST_OFFLOAD").length, 1);

  // 减客决定之后的装载扫描被拒绝。
  const reload = engine.ingestScan("F1", scan("s3", "BAG2", "ACCEPTED"));
  assert.equal(reload.status, "APPLIED"); // 其他旅客不受影响
  engine.offloadPassenger("F1", "P2", { operator: "ops.chen", at: "2026-09-12T18:31:00+08:00" });
  const forbidden = engine.ingestScan("F1", scan("s4", "BAG2", "LOADED_CONTAINER", {
    container: "AKE1",
    occurredAt: "2026-09-12T18:40:00+08:00",
  }));
  assert.equal(forbidden.status, "REJECTED");

  // 卸下扫描自动解除异常。
  engine.ingestScan("F1", scan("s5", "BAG1", "OFFLOADED", { occurredAt: "2026-09-12T18:45:00+08:00" }));
  assert.equal(openExceptions(engine, "MUST_OFFLOAD").length, 0);
  assert.equal(bagOf(engine, "BAG1").state, "OFFLOADED");
});

test("减客决定之前的迟到装载扫描如实接收并立即报警", () => {
  const engine = makeEngine();
  engine.offloadPassenger("F1", "P1", { operator: "ops.chen", at: "2026-09-12T18:05:00+08:00" });
  assert.equal(openExceptions(engine, "MUST_OFFLOAD").length, 0); // 尚未装载，仅标记

  const late = engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_AIRCRAFT", {
    occurredAt: "2026-09-12T18:01:00+08:00",
  }));
  assert.equal(late.status, "APPLIED");
  assert.equal(openExceptions(engine, "MUST_OFFLOAD").length, 1);
});

test("容器更换：冻结受影响行李，要求卸下重新核对，不悄悄搬移归属", () => {
  const engine = makeEngine();
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  engine.ingestScan("F1", scan("s2", "BAG2", "LOADED_CONTAINER", { container: "AKE1" }));

  const result = engine.replaceContainer("F1", "AKE1", {
    newContainer: "AKE2",
    operator: "ops.chen",
    reason: "底板破损",
  });
  assert.deepEqual(result.frozenBags.sort(), ["BAG1", "BAG2"]);
  assert.equal(openExceptions(engine, "CONTAINER_SWAP_FROZEN").length, 2);
  // 归属未被搬移：行李仍在 AKE1。
  assert.equal(bagOf(engine, "BAG1").container, "AKE1");

  // 冻结期间只有卸下被允许。
  const frozen = engine.ingestScan("F1", scan("s3", "BAG1", "LOADED_CONTAINER", { container: "AKE2" }));
  assert.equal(frozen.status, "REJECTED");
  // 已停用容器禁止再装入。
  const retired = engine.ingestScan("F1", scan("s4", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  assert.equal(retired.status, "REJECTED");

  // 卸下 → 解冻并自动解除异常 → 装入新容器。
  engine.ingestScan("F1", scan("s5", "BAG1", "OFFLOADED", { occurredAt: "2026-09-12T18:10:00+08:00" }));
  assert.equal(bagOf(engine, "BAG1").frozen, null);
  const reloaded = engine.ingestScan("F1", scan("s6", "BAG1", "LOADED_CONTAINER", {
    container: "AKE2",
    occurredAt: "2026-09-12T18:20:00+08:00",
  }));
  assert.equal(reloaded.status, "APPLIED");
  assert.equal(bagOf(engine, "BAG1").container, "AKE2");
  assert.equal(openExceptions(engine, "CONTAINER_SWAP_FROZEN").length, 1); // BAG2 仍冻结

  // 解冻后的行李再被扫进已停用容器 → 拒绝并挂异常。
  const retiredAgain = engine.ingestScan("F1", scan("s7", "BAG1", "LOADED_CONTAINER", {
    container: "AKE1",
    occurredAt: "2026-09-12T18:30:00+08:00",
  }));
  assert.equal(retiredAgain.status, "REJECTED");
  assert.equal(openExceptions(engine, "CONTAINER_RETIRED").length, 1);
});

test("换机：已装机行李冻结，须卸下重新装机", () => {
  const engine = makeEngine();
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  engine.ingestScan("F1", scan("s2", "BAG1", "LOADED_AIRCRAFT"));

  const result = engine.changeAircraft("F1", { newAircraftId: "B-2", operator: "ops.chen" });
  assert.deepEqual(result.frozenBags, ["BAG1"]);
  assert.equal(openExceptions(engine, "AIRCRAFT_SWAP_FROZEN").length, 1);

  engine.ingestScan("F1", scan("s3", "BAG1", "OFFLOADED", { occurredAt: "2026-09-12T18:10:00+08:00" }));
  assert.equal(openExceptions(engine, "AIRCRAFT_SWAP_FROZEN").length, 0);
  engine.ingestScan("F1", scan("s4", "BAG1", "LOADED_CONTAINER", {
    container: "AKE1",
    occurredAt: "2026-09-12T18:20:00+08:00",
  }));
  const reload = engine.ingestScan("F1", scan("s5", "BAG1", "LOADED_AIRCRAFT", {
    occurredAt: "2026-09-12T18:30:00+08:00",
  }));
  assert.equal(reload.status, "APPLIED");
  assert.equal(engine.flightSummary("F1").aircraftId, "B-2");
});

test("作废：剔除目标扫描后重新折叠；破坏连续性的作废被拒绝", () => {
  const engine = makeEngine();
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1", occurredAt: "2026-09-12T18:00:00+08:00" }));
  engine.ingestScan("F1", scan("s2", "BAG1", "OFFLOADED", { occurredAt: "2026-09-12T18:10:00+08:00" }));
  engine.ingestScan("F1", scan("s3", "BAG1", "LOADED_CONTAINER", { container: "AKE2", occurredAt: "2026-09-12T18:20:00+08:00" }));

  // 作废卸下扫描会让 AKE1→AKE2 直接相接，破坏连续性 → 拒绝。
  const badVoid = engine.ingestScan("F1", scan("v1", "BAG1", "VOIDED", { voids: "s2" }));
  assert.equal(badVoid.status, "REJECTED");
  assert.equal(bagOf(engine, "BAG1").container, "AKE2");

  // 作废最后的装箱扫描 → 状态回退到已卸下。
  const goodVoid = engine.ingestScan("F1", scan("v2", "BAG1", "VOIDED", { voids: "s3" }));
  assert.equal(goodVoid.status, "APPLIED");
  assert.equal(bagOf(engine, "BAG1").state, "OFFLOADED");
  assert.equal(bagOf(engine, "BAG1").container, null);

  // 作废不存在的目标 → 拒绝并挂异常。
  const unknown = engine.ingestScan("F1", scan("v3", "BAG1", "VOIDED", { voids: "nope" }));
  assert.equal(unknown.status, "REJECTED");
});

test("未知行李牌扫描暂存，登记后自动重放并解除异常", () => {
  const engine = makeEngine();
  const parked = engine.ingestScan("F1", scan("s1", "BAGX", "LOADED_CONTAINER", { container: "AKE1" }));
  assert.equal(parked.status, "PARKED");
  assert.equal(openExceptions(engine, "UNKNOWN_BAG").length, 1);

  engine.registerPassenger("F1", { passengerId: "P3", bagTags: ["BAGX"] });
  assert.equal(bagOf(engine, "BAGX").state, "IN_CONTAINER");
  assert.equal(openExceptions(engine, "UNKNOWN_BAG").length, 0);
});

test("已登机旅客行李被卸下挂异常，重新装载自动解除", () => {
  const engine = makeEngine();
  engine.boardPassenger("F1", "P1");
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  engine.ingestScan("F1", scan("s2", "BAG1", "OFFLOADED", { occurredAt: "2026-09-12T18:10:00+08:00" }));
  assert.equal(openExceptions(engine, "BOARDED_PAX_BAG_OFFLOADED").length, 1);

  engine.ingestScan("F1", scan("s3", "BAG1", "LOADED_CONTAINER", { container: "AKE1", occurredAt: "2026-09-12T18:20:00+08:00" }));
  assert.equal(openExceptions(engine, "BOARDED_PAX_BAG_OFFLOADED").length, 0);
});

test("双人签署同一舱单版本才可关闭；撤回与重开均留痕", () => {
  const engine = makeEngine();
  engine.boardPassenger("F1", "P1");
  engine.ingestScan("F1", scan("s1", "BAG1", "LOADED_CONTAINER", { container: "AKE1" }));
  engine.ingestScan("F1", scan("s2", "BAG1", "LOADED_AIRCRAFT"));
  // P2 未登机，不参与关闭校验。

  let blockers = engine.blockers("F1");
  assert.equal(blockers.canClose, false);
  assert.deepEqual(blockers.blockers.map((b) => b.type), ["INSUFFICIENT_SIGNATURES"]);

  const version = engine.flightSummary("F1").manifestVersion;
  engine.sign("F1", { operator: "ops.a" });
  assert.throws(() => engine.sign("F1", { operator: "ops.a" }), /已签署/);
  // 签署不改变舱单版本。
  assert.equal(engine.flightSummary("F1").manifestVersion, version);

  // 撤回后重新签署。
  engine.withdraw("F1", { operator: "ops.a" });
  assert.throws(() => engine.close("F1", { operator: "ops.a" }), /阻止关闭/);
  engine.sign("F1", { operator: "ops.a" });
  engine.sign("F1", { operator: "ops.b" });

  const closed = engine.close("F1", { operator: "ops.a" });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.closedVersion, version);

  // 关闭后拒绝任何变更。
  assert.throws(
    () => engine.ingestScan("F1", scan("s9", "BAG1", "OFFLOADED")),
    (err) => err.code === "FLIGHT_CLOSED",
  );

  // 重开留痕并递增版本，原签署失效。
  engine.reopen("F1", { operator: "ops.b", reason: "补扫核对" });
  blockers = engine.blockers("F1");
  assert.deepEqual(blockers.blockers.map((b) => b.type), ["INSUFFICIENT_SIGNATURES"]);

  const events = engine.events("F1");
  const actors = Object.fromEntries(
    events.filter((e) => ["SIGNED", "WITHDRAWN", "CLOSED", "REOPENED"].includes(e.type)).map((e) => [e.type + e.seq, e.actor]),
  );
  assert.ok(Object.values(actors).every((a) => a === "ops.a" || a === "ops.b"));
});

test("已登机旅客行李未装机时阻止关闭", () => {
  const engine = makeEngine();
  engine.boardPassenger("F1", "P1");
  const blockers = engine.blockers("F1");
  const missing = blockers.blockers.find((b) => b.type === "BAGS_NOT_ON_AIRCRAFT");
  assert.deepEqual(missing.bags, [{ bagTag: "BAG1", passengerId: "P1", state: "EXPECTED" }]);
});

test("异常处置结论：所有异常关闭前都必须有结论", () => {
  const engine = makeEngine();
  engine.ingestScan("F1", scan("s1", "BAG1", "OFFLOADED")); // 触发 OUT_OF_SEQUENCE
  const [ex] = openExceptions(engine);
  assert.throws(
    () => engine.dispositionException("F1", ex.id, { operator: "", conclusion: "x" }),
    /必填/,
  );
  const done = engine.dispositionException("F1", ex.id, {
    operator: "ops.chen",
    conclusion: "扫描枪误触，现场无卸下动作",
  });
  assert.equal(done.status, "RESOLVED");
  assert.equal(done.dispositions.length, 1);
  assert.throws(
    () => engine.dispositionException("F1", ex.id, { operator: "ops.chen", conclusion: "重复" }),
    (err) => err.code === "EXCEPTION_ALREADY_RESOLVED",
  );
});

test("舱单版本随装载状态变化递增，签署不递增", () => {
  const engine = makeEngine();
  const v0 = engine.flightSummary("F1").manifestVersion;
  engine.ingestScan("F1", scan("s1", "BAG1", "ACCEPTED"));
  const v1 = engine.flightSummary("F1").manifestVersion;
  assert.ok(v1 > v0);
  engine.sign("F1", { operator: "ops.a" });
  engine.withdraw("F1", { operator: "ops.a" });
  assert.equal(engine.flightSummary("F1").manifestVersion, v1);
});
