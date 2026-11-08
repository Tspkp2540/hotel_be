# Database

PostgreSQL 17.6 ประกอบด้วย 4 business tables และ 1 infrastructure table ดู [Schema และ ER diagram](../docs/DATABASE.md)

## ไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| [001_initial.sql](migrations/001_initial.sql) | Users, sessions, rooms, bookings และ constraints |
| [002_rate_limit_buckets.sql](migrations/002_rate_limit_buckets.sql) | Shared rate-limit counters |
| [003_booking_request_key.sql](migrations/003_booking_request_key.sql) | Nullable request UUID และ unique user/key |
| [001_room.sql](seeds/001_room.sql) | Seed ห้องตัวอย่าง 5 รายการแบบไม่ overwrite |
| [constraints.sql](tests/constraints.sql) | Positive/negative constraint tests |
| [test.mjs](scripts/test.mjs) | Disposable PostgreSQL test runner |

## ติดตั้ง Schema

จาก project root ใช้ psql ที่ตั้งค่า connection ไปฐานข้อมูลว่างแล้ว:

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/001_initial.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/002_rate_limit_buckets.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/003_booking_request_key.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/seeds/001_room.sql
```

Apply migrations ครั้งเดียวตามลำดับ รันเฉพาะไฟล์ที่ยังไม่ใช้ หากมี 001/002 แล้วให้รันเฉพาะ 003; booking เดิมมี request_key=NULL Seed รันซ้ำได้และไม่เปิดห้อง inactive กลับเอง Migration role ต้องติดตั้ง btree_gist ได้

## ทดสอบ

ต้องมี Node.js และ Docker จาก project root:

```sh
node database/scripts/test.mjs
```

Runner ใช้ image postgres:17.6-bookworm สร้าง container แยก ไม่เปิด port หรือ mount ข้อมูลเครื่อง ตรวจ migrations/seed/constraints/rollback/locks แล้วลบ container และ volume ที่สร้างเอง

Concurrency ใช้ connections แยกและตรวจ lock state ก่อน commit/rollback มี timeout ควบคุมการรอ ผลผ่านต้อง exit 0 และมีข้อความ PASS all database checks

การตรวจ HTTP, service rules และ coverage ใช้ [Backend integration suite](../README.md) รายละเอียด setup/inspection อยู่ใน [คู่มือผู้ตรวจ](../README.md)

## งานส่งมอบที่เหลือ

Production migration ledger/checksum/locking, runtime roles และการจัด DB assets เข้า Backend repository อยู่ใน [งาน 08](../docs/TESTING.md)
