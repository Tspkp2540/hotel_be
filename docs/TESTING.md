# Backend testing

รันจาก repository root หลัง npm ci ต้องมี Node.js ≥22.18.0 และ Docker Linux engine

| คำสั่ง | ผลล่าสุด |
|---|---|
| npm run test:integration | 176 tests ผ่าน PostgreSQL จริง; รวม OpenAPI/build/HTTP smoke |
| npm run test:db | Migrations/seed/constraints/rollback/concurrency ผ่าน |
| npm run test:mutation | 12/12 mutants จับได้; ไม่มี survived/invalid/timeout |
| npm run test:classifier | 10 tests ของตัวแยกผล mutation |
| npm run test:ci-guards | ปฏิเสธ focused tests เมื่อ CI=true |

Coverage: Statements/Lines/Functions 100%, Branches 99.52% Gate รวม ≥90/90/90/85 และ branches ของ auth/date/calendar/booking service ต้อง 100% ยกเว้น server.ts bootstrap ที่ตรวจด้วย HTTP smoke แยก รายงานอยู่ที่ coverage/index.html

## Mutation scope

เป็น targeted catalog ของ date boundaries, auth expiry/password, lookup ownership และ idempotency ไม่ใช่ mutation coverage ทั้งโครงการ

Runner สร้าง source copy ภายใน .mutation-work/, รัน baseline โดยไม่มี skip, แก้ทีละจุด และตรวจ SHA-256 ว่า source ต้นฉบับไม่เปลี่ยน ใช้ PostgreSQL แยกและไม่รับ TEST_DATABASE_URL ภายนอก Compile/import error, timeout และ skipped tests ไม่นับเป็น killed; survived/invalid/timeout ทำให้ exit nonzero

ดูรายการและกรองเคส:

```sh
npm run test:mutation -- --list
npm run test:mutation -- --id=BE-KEY-02
```

ผลอยู่ที่ mutation-report/summary.json; การกรองเก็บใน mutation-report/<ID>/ ไม่ทับชุดเต็ม [Catalog](../scripts/mutation-catalog.mjs) และ [classifier](../scripts/mutation-results.mjs) อยู่ใน repository นี้

## CI และการส่งงาน

[Workflow](../.github/workflows/ci.yml) ตรวจ DB, build, coverage, mutations และเก็บรายงาน 7 วัน Required check ชื่อ CI required บน main ตั้งแล้ว

หลักฐานตรวจบน GitHub วันที่ 9 พฤศจิกายน 2026:

| การตรวจ | ผล |
|---|---|
| [Backend quality](https://github.com/Tspkp2540/hotel_be/actions/runs/42524914709) | ผ่าน รวม CI required |
| [Frontend quality](https://github.com/Tspkp2540/frontend/actions/runs/42524975877) | ผ่าน รวม CI required |
| [Paired integration](https://github.com/Tspkp2540/frontend/actions/runs/42525412974) | 27 browser flows ผ่าน |

Integration ใช้ Backend commit [0e56e76](https://github.com/Tspkp2540/hotel_be/commit/0e56e76e1c553f9f132fb74e2a2047a840b21d07) และ Frontend commit [d5eabbd](https://github.com/Tspkp2540/frontend/commit/d5eabbd719951b9340deecddff01c93187be4b01) ผลเป็นหลักฐานของคู่ commits นี้ ไม่ใช่การรับรอง commits ในอนาคต

ยังไม่มี deployment จริง, load/penetration test หรือ production migration ledger/runtime-role provisioning

[API](API.md) · [Database/ER diagram](DATABASE.md) · [Security](../SECURITY.md)
