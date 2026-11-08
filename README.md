# Booking Backend

Node.js + TypeScript + Fastify + PostgreSQL 17.6 ระบบ auth, calendar, booking และ idempotent recovery ดู [API](docs/API.md) / [OpenAPI](openapi.json)

## ติดตั้งและตรวจ

ต้องมี Node.js ≥22.18.0, npm และ Docker Linux engine จาก repository root:

```sh
npm ci
npm run test:db
npm run test:integration
```

Integration runner สร้าง PostgreSQL ชั่วคราวและลบเมื่อจบ ไม่ต้องมี Frontend checkout หรือ .env

## เปิด API

เตรียมฐานข้อมูลว่างและตั้ง psql connection แล้วรัน migrations ตามลำดับ:

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/001_initial.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/002_rate_limit_buckets.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/003_booking_request_key.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/seeds/001_room.sql
```

รันเฉพาะ migrations ที่ยังไม่ใช้ Seed รันซ้ำได้ คัดลอก .env.example เป็น .env ตั้ง DATABASE_URL และ FRONTEND_ORIGIN ให้ตรงกับหน้าเว็บ จากนั้น:

```sh
npm run dev
```

API เริ่มที่ http://localhost:3001 Production ใช้ `npm run build` แล้ว `npm start` ผ่าน HTTPS ดู [Security](SECURITY.md)

## คำสั่ง

| คำสั่ง | งาน |
|---|---|
| npm run build | TypeScript → dist/ |
| npm run docs:check | OpenAPI ตรงกับ implementation contract |
| npm run test:integration | Build, HTTP smoke, PostgreSQL tests และ coverage |
| npm run test:db | Migrations/seed/constraints/concurrency |
| npm run test:mutation | 12 critical mutants กับ PostgreSQL จริง |
| npm run test:classifier | ตรวจตัวแยกผล mutation |
| npm run test:ci-guards | ตรวจว่า CI ไม่ยอมรับ test.only |

CI อยู่ที่ [.github/workflows/ci.yml](.github/workflows/ci.yml) ใช้งานได้จาก repository นี้โดยไม่อ่านไฟล์ภายนอก ดู [ผลตรวจและขอบเขต](docs/TESTING.md)

## โครงสร้าง

src/ API · tests/ unit/integration · database/ migrations/seed/DB tests · scripts/ test runners · docs/ API/schema/testing

มีห้องตัวอย่าง 5 ห้อง ไม่มี accounts/passwords เริ่มต้น สมัครผ่าน API ก่อนใช้งาน การจองต้อง login; ช่วงทับกันตอบ 409; Idempotency-Key ป้องกันรายการซ้ำและ GET /bookings/requests/:requestKey ตรวจผลได้เฉพาะเจ้าของ

[Schema และ ER diagram](docs/DATABASE.md) · [Database setup](database/README.md)
