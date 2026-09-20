import { readFile } from "node:fs/promises";
import {
  createFlight,
  ingestScan,
  offloadPassenger,
  registerBag,
  registerPassenger,
  setPassengerStatus,
  swapAircraft,
  swapContainer,
} from "./domain.js";

/**
 * 把 fixtures/context.json 这类“随附记录”按数组顺序(即系统接收顺序)回放进领域层。
 * 扫描记录可携带 occurredAt/receivedAt,分别对应现场发生时间与系统接收时间;
 * 离线补传、重复扫描、减客、容器/飞机更换都按真实入口走,不做任何特殊处理。
 */
export function seedFromObject(store, data) {
  const outcomes = [];
  const flightId = data.flight.flightLegId;
  createFlight(store, { ...data.flight, operator: "seed" });

  for (const record of data.records) {
    try {
      switch (record.type) {
        case "passenger": {
          registerPassenger(store, flightId, { ...record, operator: record.operator ?? "seed" });
          if (record.status && record.status !== "EXPECTED") {
            setPassengerStatus(store, flightId, record.passengerId, { status: record.status, operator: record.operator ?? "seed", at: record.at });
          }
          break;
        }
        case "bag":
          registerBag(store, flightId, { ...record, operator: record.operator ?? "seed" });
          break;
        case "scan":
          ingestScan(store, flightId, record, { receivedAt: record.receivedAt });
          break;
        case "passengerStatus":
          setPassengerStatus(store, flightId, record.passengerId, { status: record.status, operator: record.operator ?? "seed", at: record.at });
          break;
        case "offload":
          offloadPassenger(store, flightId, { ...record, operator: record.operator ?? "seed" });
          break;
        case "containerSwap":
          swapContainer(store, flightId, { ...record, operator: record.operator ?? "seed" });
          break;
        case "aircraftSwap":
          swapAircraft(store, flightId, { ...record, operator: record.operator ?? "seed" });
          break;
        default:
          throw new Error(`未知记录类型 ${record.type}`);
      }
      outcomes.push({ record: record.type, ok: true });
    } catch (error) {
      outcomes.push({ record: record.type, ok: false, code: error.code ?? "error", message: error.message });
    }
  }
  return { flightId, outcomes };
}

export async function seedFromFile(store, filePath) {
  const data = JSON.parse(await readFile(filePath, "utf8"));
  return seedFromObject(store, data);
}
