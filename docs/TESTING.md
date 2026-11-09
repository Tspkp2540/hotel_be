# Backend testing

รันจาก Backend repository หลัง `npm ci` ต้องมี Node.js ≥22.18.0 และ Docker Linux engine

| คำสั่ง | ผลล่าสุดในเครื่อง |
|---|---|
| npm run format:check | ตรวจรูปแบบ source/tests แบบเดียวกับ CI |
| npm run test:integration | 186 tests; OpenAPI/build/HTTP smoke และ PostgreSQL จริง |
| npm run test:db | Fresh/upgrade migrations, seed, constraints, rollback และ concurrency ผ่าน |
| npm run test:mutation | 14/14 killed; ไม่มี survived/invalid/timeout |
| npm run test:classifier | 10 tests ของตัวแยกผล mutation |
| npm run test:ci-guards | ปฏิเสธ focused tests ใน CI |

Coverage: statements/lines/functions100%, branches99.56% Gates ≥90/90/90/85 และ branches ของ auth/date/calendar/booking service100% ไม่รวม server.ts bootstrap ซึ่งตรวจด้วย HTTP smoke

รูปแบบโค้ด: `npm run format` จัดรูปแบบ และ `npm run format:check` ตรวจแบบเดียวกับCI ใช้ .prettierrc.json และ LFตาม.gitattributes การปรับmutation anchorsหลังformatคงกฎที่ทดสอบเดิม

## ขอบเขตที่ตรวจ

- Auth/session/Origin/rate limits และไม่เปิดเผยข้อมูลภายในใน response/log
- วันที่ตามเวลาไทย วันติดกันไม่ชน ช่วงวันทับกันต้องแพ้ที่ DB
- Concurrent booking: ผู้ commit ก่อนชนะ; อีกคำขอรอ lock และทำต่อได้เมื่อรายการแรก rollback
- Idempotency/recovery แยกตามเจ้าของ; keyเดิม/ข้อมูลเดิมไม่สร้างรายการซ้ำ
- ประวัติแบบ cursor ไม่ข้ามรายการระดับ microsecond; รวม cancelled/inactive room
- ยกเลิกเฉพาะเจ้าของก่อนวันเข้าพัก; ส่งซ้ำคงเวลาเดิมและคืนวันว่าง
- Migration004 เก็บห้องเดิม/ความสัมพันธ์ไว้; seed8โรงแรม/8จังหวัด/12ห้องรันซ้ำไม่ overwrite
- OpenAPI1.4.0 รวม10 operations; HTTP responses ในชุดทดสอบตรวจตาม contract

## Mutation และรายงาน

Catalogue14เคสครอบคลุม date boundaries, auth, ownership, idempotency และ cancellation ไม่ใช่ exhaustive mutation coverage Runner ใช้ source copy + PostgreSQL แยก รัน baseline และตรวจ SHA-256 ของต้นฉบับ Compile/import error, timeout และ skip ไม่นับเป็น killed

`npm run test:mutation -- --list` ดูรายการ; `-- --id=BE-CANCEL-01` เลือกรายเคส ผลอยู่ใน mutation-report/summary.json และ coverage/index.html

## CI และสถานะส่งมอบ

[Workflow](../.github/workflows/ci.yml) ตรวจ DB/build/coverage/mutation และเก็บรายงาน7วัน Required checkชื่อ CI required

หลักฐาน GitHub ที่ยืนยันแล้ว วันที่10พฤศจิกายน2026:

| การตรวจ | Commit ที่ใช้ | ผล |
|---|---|---|
| Backend quality | d7fe382e488f1ca0ada7d2ccd2073f7b06c195f8 | [ผ่าน](https://github.com/Tspkp2540/hotel_be/actions/runs/42670436874) |
| Frontend quality | 85162adb597a15b9c2905d5a9903aa8fcf0db44e | [ผ่าน](https://github.com/Tspkp2540/frontend/actions/runs/42704414399) |
| Browser integration | คู่ commit ข้างบน | [35 flows ผ่าน](https://github.com/Tspkp2540/frontend/actions/runs/42704667964) |

ผลแต่ละ run รับรองเฉพาะ commit ที่ระบุ การแก้ไขหลังจากนั้นต้องตรวจใหม่ ตารางนี้ไม่อ้างว่าผ่าน CI สำหรับ working tree ที่ยังไม่ได้ commit

ยังไม่มี deploymentจริง, load/penetration test หรือ production migration ledger/runtime-role provisioning รายละเอียด [Security](../SECURITY.md) · [API](API.md) · [Schema](DATABASE.md)
