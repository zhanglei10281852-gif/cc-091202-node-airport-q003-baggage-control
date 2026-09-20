// 随附记录播种器：把 fixtures/context.json 中的场景记录按接收顺序回放进引擎。
// 记录类型：checkin / board / offload-passenger / scan / replace-container / change-aircraft。

import { readFile } from "node:fs/promises";

const DEFAULT_FIXTURE = new URL("../fixtures/context.json", import.meta.url);

export async function seedFromFixture(engine, fixtureUrl = DEFAULT_FIXTURE) {
  const data = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const flightId = data.flight.flightLegId;

  if (!engine.flights.has(flightId)) {
    engine.createFlight(data.flight);
  }

  const summary = {
    flightLegId: flightId,
    records: 0,
    scansApplied: 0,
    scansRepeat: 0,
    scansRejected: 0,
    scansDuplicate: 0,
    scansParked: 0,
    openExceptions: 0,
  };

  for (const record of data.records) {
    summary.records += 1;
    switch (record.type) {
      case "checkin":
        engine.registerPassenger(flightId, {
          passengerId: record.passengerId,
          bagTags: [record.bagTag],
          name: record.name,
        });
        break;
      case "board":
        engine.boardPassenger(flightId, record.passengerId);
        break;
      case "offload-passenger":
        engine.offloadPassenger(flightId, record.passengerId, {
          operator: record.operator ?? "system",
          reason: record.reason ?? "",
          at: record.at,
        });
        break;
      case "scan": {
        const result = engine.ingestScan(flightId, record, { source: record.source ?? "fixture" });
        if (result.status === "APPLIED") summary.scansApplied += 1;
        else if (result.status === "REPEAT") summary.scansRepeat += 1;
        else if (result.status === "REJECTED") summary.scansRejected += 1;
        else if (result.status === "PARKED") summary.scansParked += 1;
        if (result.duplicate) summary.scansDuplicate += 1;
        break;
      }
      case "replace-container":
        engine.replaceContainer(flightId, record.container, {
          newContainer: record.newContainer,
          operator: record.operator ?? "system",
          reason: record.reason ?? "",
        });
        break;
      case "change-aircraft":
        engine.changeAircraft(flightId, {
          newAircraftId: record.newAircraftId,
          operator: record.operator ?? "system",
          reason: record.reason ?? "",
        });
        break;
      default:
        throw new Error(`未知的记录类型: ${record.type}`);
    }
  }

  summary.openExceptions = engine.exceptions(flightId, { status: "OPEN" }).length;
  return summary;
}
