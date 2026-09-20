# 出港行李装载核对中枢

以航班、旅客登机资格、行李牌、容器(集装器)和舱位为核心,接收收运、分拣、装箱、装机、卸下及作废六类扫描,为装载控制员提供签署前核对与关闭装载的强制闸口。

## 核心规则

- **事件溯源**:行李当前状态由扫描事件按 `occurredAt`(现场发生时间)折叠得出,`receivedAt`(系统接收时间)只用于幂等、冻结与证据判定。扫描可以迟到、乱序、重复,有效轨迹始终遵守物理先后;违反先后的扫描判为 `CONTESTED` 并开立 `ORDER_VIOLATION` 异常,不改变状态。
- **幂等与并发**:`scanId` 在航班内唯一,重试返回首次结果;所有领域变更都是同步函数,HTTP 层解析完请求体后调用,Node 单线程下天然串行——一件行李绝不会同时处于两个有效位置。同一件行李被扫进第二个集装器/舱位时,后者判为冲突并开立 `LOCATION_CONFLICT`,归属保持不动。
- **减客**:减客事件到达后立即把该旅客已装载的行李标为 `mustOffload` 并开立 `OFFLOAD_PENDING`;此后禁止装载其行李(拒收留痕)。卸下/作废扫描自动回填证据,异常须有处置结论才算结案。
- **容器/飞机更换**:旧容器停用、更换飞机时,仍挂在失效位置上的行李被**冻结**并开立重新核对异常;归属绝不悄悄搬移,只有在用容器/新飞机上的重新扫描才能解冻并留下证据。
- **关闭装载**:仅当 ① 所有异常都有处置结论、② 每个已登机旅客的托运行李去向明确(在当前飞机上或已作废,或有已结案的放行结论)、③ 已装机行李的旅客均已登机、④ 双人(不同操作者)签署基于同一**当前**舱单版本时,航班才可关闭。任何内容变化都会使旧舱单失效,需重新出单签署。
- **留痕**:减客、更换、处置、签署、撤回、关闭、重开全部记录操作者,可按航班查询审计链;控制员可按行李牌还原完整扫描链路(含被拒收、被作废的扫描)。

## 运行

```bash
npm test                                # 全部测试(领域规则 + HTTP 端到端)
npm start                               # 空库启动,默认端口 3000
SEED_FILE=fixtures/context.json npm start   # 装载随附样例后启动
docker compose up --build               # 容器方式启动并自动装载样例
```

`fixtures/context.json` 包含一次旅客减客、一组离线补传(迟到、重复、双枪冲突)和容器更换前后的完整数据,事件的 `occurredAt` 与 `receivedAt` 区分现场发生顺序和系统接收顺序。样例均为脱敏数据,本地密钥、真实行李信息和运行日志由 `.gitignore` 排除。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康探针 |
| POST | `/flights` | 建立航班 `{flightLegId, aircraftId, route?}` |
| GET | `/flights` / `/flights/{fid}` | 航班列表 / 概要(计数、舱单与签署状态) |
| POST | `/flights/{fid}/passengers` | 登记旅客 `{passengerId, name?}` |
| POST | `/flights/{fid}/passengers/{pid}/status` | 登机资格 `{status: EXPECTED\|CHECKED_IN\|BOARDED\|NO_SHOW, operator}`(减客专用 `/offloads`) |
| POST | `/flights/{fid}/bags` | 登记行李 `{bagTag, passengerId}` |
| GET | `/flights/{fid}/bags?state=` | 行李列表,可按状态过滤 |
| GET | `/flights/{fid}/bags/{bagTag}/trace` | 按行李牌还原扫描链路(含异常) |
| GET | `/bags/{bagTag}/trace` | 跨航班按行李牌还原链路 |
| POST | `/flights/{fid}/scans` | 接收单条扫描 `{scanId, bagTag, action, container?, position?, occurredAt, actor?}`;重复 `scanId` 返回首次结果 |
| POST | `/flights/{fid}/scans/batch` | 离线扫描枪批量补传 `{scans: [...]}`,逐条独立判定 |
| POST | `/flights/{fid}/offloads` | 减客 `{passengerId, operator, reason?}`,立即标出待卸行李 |
| POST | `/flights/{fid}/container-swaps` | 容器更换 `{oldContainerId, newContainerId, operator, reason?}`,冻结受影响行李 |
| POST | `/flights/{fid}/aircraft-swap` | 更换飞机 `{newAircraftId, operator, reason?}`,冻结已装机行李 |
| GET | `/flights/{fid}/exceptions?status=` | 异常列表 |
| POST | `/flights/{fid}/exceptions/{eid}/dispositions` | 处置 `{operator, action: ACKNOWLEDGE\|VOID_SCAN, scanId?, note?}` |
| GET | `/flights/{fid}/blockers` | 当前阻止签署/关闭的具体清单 |
| POST | `/flights/{fid}/manifests` | 生成舱单版本 `{operator}`(内容快照) |
| GET | `/flights/{fid}/manifests/latest` | 最新舱单 |
| POST | `/flights/{fid}/manifests/{v}/signatures` | 签署 `{operator}` |
| DELETE | `/flights/{fid}/manifests/{v}/signatures/{operator}` | 撤回签署(留痕) |
| POST | `/flights/{fid}/close` | 关闭装载 `{operator}`,有阻塞项则 409 并返回清单 |
| POST | `/flights/{fid}/reopen` | 重开 `{operator, reason}`,原舱单失效 |
| GET | `/flights/{fid}/audit` | 操作审计链 |
| GET | `/flights/{fid}/snapshot` | 当前装载快照(舱位/容器/行李) |

## 扫描动作与状态机

`ACCEPTED`(收运)→ `SORTED`(分拣)→ `LOADED_CONTAINER`(装箱)→ `LOADED_AIRCRAFT`(装机),`UNLOADED`(卸下)与 `VOIDED`(作废)可从中间态转出。允许跳步(如漏扫分拣)与散装直装,但不允许倒退或双位置;卸下扫描若携带的容器/舱位与当前不符,判冲突而不改变归属。扫描判定结果:`APPLIED` / `REDUNDANT`(重复内容)/ `CONTESTED`(违规,入异常)/ `REJECTED`(准入拒收,留痕)/ `VOIDED_BY_OPERATOR`(处置作废)。

异常类型:`OFFLOAD_PENDING`、`LOCATION_CONFLICT`、`ORDER_VIOLATION`、`CONTAINER_SWAP_REVERIFY`、`AIRCRAFT_SWAP_REVERIFY`、`BOARDED_BAG_NOT_LOADED`。`ACKNOWLEDGE` 结案对减客与更换类异常有安全闸(行李须已卸下/已重新核对),`VOID_SCAN` 用于作废错误扫描并触发重新折叠。
