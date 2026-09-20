# 出港行李装载核对中枢

面向机场地服的行李装载核对服务：以**航班、旅客登机资格、行李牌、容器（集装器）、舱位**为核心，接收收运、分拣、装箱、装机、卸下及作废扫描，在减客、离线补传、容器/飞机更换等异常场景下保证——**任何重试或并发扫描都不会让一件行李同时处于两个有效位置**。

## 运行

```bash
npm test          # 全部测试（引擎 / API / 并发）
npm start         # 启动服务并自动回放 fixtures/context.json，端口 PORT（默认 3000）
npm run demo      # 完整场景演示：减客→离线补传→换容器→处置→双人签署→关闭→重开
docker compose up --build
```

健康探针 `GET /health`。样例均为脱敏数据，本地密钥、真实行李信息和运行日志由 `.gitignore` 排除。

## 扫描与轨迹规则

扫描动作：`ACCEPTED`（收运）→ `SORTED`（分拣）→ `LOADED_CONTAINER`（装箱）→ `LOADED_AIRCRAFT`（装机）；`OFFLOADED`（卸下）回到地面后可重新装载；`VOIDED`（作废）剔除一条已应用扫描并重新折叠轨迹。

- **迟到扫描**：按 `occurredAt`（现场发生时间）插入轨迹后整体重新验证，`receivedAt` 只用于接收审计与延迟统计；有效轨迹必须遵守物理先后。
- **重复扫描**：以 `scanId` 幂等——相同载荷返回首次结果；同一 `scanId` 不同载荷返回 `409 SCAN_CONFLICT`。效果一致的换枪重扫是幂等空操作（`REPEAT`）。
- **冲突扫描**：把一件行李算进第二个集装器/舱位的扫描被拒绝（`DOUBLE_POSITION`）并挂异常，已应用轨迹不受影响。
- **跳级扫描**：中间环节漏扫（如离线枪）可容忍，链路中以“推定环节”标注，供控制员复核。

## 减客、更换与异常

- **减客**：`POST /flights/:id/passengers/:pid/offload` 到达后立即把该旅客全部托运行李标为“必须卸下”；仍处于装载状态的行李挂 `MUST_OFFLOAD` 异常，卸下扫描到达后自动解除；减客决定之后发生的装载扫描一律拒绝（决定之前的迟到装载如实接收并报警）。
- **容器/飞机更换**：`POST .../containers/:uld/replace`、`POST .../aircraft/change` 冻结受影响行李并挂异常，**绝不悄悄搬移归属**；冻结期间仅允许卸下扫描，卸下并重新核对（重新装箱/装机）后异常自动解除。已停用容器禁止再装入。
- **异常生命周期**：所有异常（`MUST_OFFLOAD`、`DOUBLE_POSITION`、`OUT_OF_SEQUENCE`、`CONTAINER_RETIRED`、`CONTAINER_SWAP_FROZEN`、`AIRCRAFT_SWAP_FROZEN`、`BOARDED_PAX_BAG_OFFLOADED`、`UNKNOWN_BAG`）关闭装载前都必须有处置结论（`POST .../exceptions/:eid/disposition`）或被系统自动解除。未知行李牌的扫描暂存（`PARKED`），行李登记后自动重放。

## 关闭装载（双人签署）

舱单每次装载相关变更都递增版本号；签署/撤回不改变版本。关闭装载必须同时满足：

1. 所有异常都有处置结论；
2. 每个已登机旅客的托运行李去向明确（已装机）；
3. 两名不同操作者签署**同一舱单版本**。

`GET /flights/:id/blockers` 返回当前阻止关闭的具体清单。`sign` / `withdraw` / `close` / `reopen` 均在审计日志（`GET /flights/:id/events`）中留下操作者；重开递增版本，原签署自然失效，须重新双人签署。航班关闭后拒绝一切变更，重开后方可继续。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康探针 |
| POST/GET | `/flights`、`/flights/:id` | 建班 / 概要 |
| POST | `/flights/:id/passengers` | 旅客登记（含行李牌） |
| POST | `/flights/:id/passengers/:pid/board` `/offload` | 登机 / 减客 |
| POST | `/flights/:id/scans` | 扫描接收（单条或 `{scans:[...]}` 批量补传） |
| POST | `/flights/:id/containers/:uld/replace` | 容器更换（冻结待重新核对） |
| POST | `/flights/:id/aircraft/change` | 换机（冻结已装机行李） |
| GET | `/flights/:id/manifest` `/blockers` `/events` `/bags` | 舱单 / 阻止清单 / 审计日志 / 行李状态 |
| GET | `/flights/:id/bags/:tag/chain`、`/bags/:tag/chain` | 按行李牌还原扫描链路 |
| GET/POST | `/flights/:id/exceptions`、`.../exceptions/:eid/disposition` | 异常列表 / 处置结论 |
| POST | `/flights/:id/sign` `/withdraw` `/close` `/reopen` | 签署 / 撤回 / 关闭 / 重开 |
| POST | `/admin/seed`、`/admin/reset` | 回放随附记录 / 清空（联调用） |

## 随附记录场景

`fixtures/context.json`（CZ3102-20260912，Asia/Shanghai）包含：

- **一次减客**：P1001 登机后于 18:05 减客，其行李 7812345678 被标记必须卸下；
- **一组离线扫描**：`scan-2`（装机，18:01 发生 / 18:10 补传）先于 `scan-1`（装箱，17:55 发生 / 18:12 补传）到达，系统按发生时间归位；`scan-2` 稍后被原样重复补传，幂等吸收；`scan-8` 把行李误传进已停用的 AKE12001CZ，被拒绝并挂异常；
- **容器更换前后**：AKE12001CZ 底板破损更换为 AKE12002CZ，两件行李冻结，卸下旧容器、重新核对装入新容器后异常自动解除。

事件的 `occurredAt` 与 `receivedAt` 用于区分现场发生顺序和系统接收顺序。
