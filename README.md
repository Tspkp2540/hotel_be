# Booking Backend

Node.js + TypeScript + Fastify + PostgreSQL 17.6 รองรับ auth, โรงแรม/จังหวัด, calendar, booking/history/cancellation และ idempotent recovery สำหรับ [FUNCHZ assignment](https://github.com/FUNCHZ/fullstack-dev-assignment)

[Frontend](https://github.com/Tspkp2540/frontend) · [Testing/CI](docs/TESTING.md) · [API](docs/API.md)

## ติดตั้งและตรวจ

ต้องมี Node.js ≥22.18.0, npm และ Docker Linux engine จาก repository root:

```sh
npm ci
npm run test:db
npm run test:integration
```

Integration runner สร้าง PostgreSQL ชั่วคราวและลบเมื่อจบ ไม่ต้องมี Frontend checkout หรือ .env ดูผลล่าสุดใน [Testing](docs/TESTING.md)

## เปิด API กับฐานข้อมูลของผู้ตรวจ

เตรียม PostgreSQL database ว่างและ role ที่เชื่อมต่อได้ ตั้ง psql connection แล้วรัน migrations ตามลำดับ:

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/001_initial.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/002_rate_limit_buckets.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/003_booking_request_key.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/migrations/004_hotels.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f database/seeds/001_room.sql
```

Migration role ต้องติดตั้ง btree_gist ได้ รันเฉพาะ migrations ที่ยังไม่ใช้ Seed รันซ้ำได้ คัดลอก .env.example เป็น .env แล้วตั้ง DATABASE_URL และ FRONTEND_ORIGIN เช่น http://127.0.0.1:3000 จากนั้น:

```sh
npm run dev
```

API เริ่มที่ http://localhost:3001 ทุก POST ต้องส่ง Origin ตรง FRONTEND_ORIGIN มีโรงแรมตัวอย่าง 8 แห่งใน 8 จังหวัด รวม 12 ห้อง ไม่มีบัญชีเริ่มต้น ให้สมัครสมาชิกผ่านหน้าเว็บหรือ API

## ข้อมูล DB อยู่ที่ไหน

- test:db, test:integration และ test:mutation ใช้ Docker DB แยกบนเครื่องที่รัน แล้วลบเมื่อจบ
- หากเปิดผ่าน Frontend dev:system ฐานข้อมูล preview จะถูกลบเมื่อปิดระบบ
- npm run dev/npm start ใช้ฐานข้อมูลตาม DATABASE_URL; หากต้องการเก็บบัญชี/การจองถาวร ใช้ PostgreSQL หรือ Docker volume ของผู้ตรวจเอง
- GitHub Actions ใช้ DB ชั่วคราวบน runner ไม่มีการเชื่อมต่อฐานข้อมูล production

Git เก็บ source, migrations และ seed ไม่รวมข้อมูลที่ผู้ใช้สร้างใน DB ข้อมูลของแต่ละเครื่องไม่ซิงก์กันเอง

## คำสั่งอื่น

| คำสั่ง | หน้าที่ |
|---|---|
| npm run build | TypeScript → dist/ |
| npm run docs:check | ตรวจ OpenAPI และ generated contract |
| npm run test:mutation | 14/14 targeted mutants ในชุดที่กำหนด |
| npm run test:classifier | 10 tests ของตัวแยกผล mutation |
| npm run test:ci-guards | ป้องกัน focused tests ใน CI |

Production ใช้ npm run build แล้ว npm start หลัง HTTPS reverse proxy ดู [Security และข้อจำกัด](SECURITY.md) ยังไม่มี deployment จริงหรือ production migration ledger/runtime-role provisioning

## เอกสารและโครงสร้าง

[API](docs/API.md) · [OpenAPI](openapi.json) · [Schema/ER diagram](docs/DATABASE.md) · [Database setup](database/README.md) · [Testing/CI](docs/TESTING.md)

src/ API · tests/ unit/integration · database/ migrations/seed/DB tests · scripts/ test runners · docs/ contracts/schema/testing

Required check ชื่อ CI required ดู [workflow](.github/workflows/ci.yml) ฟีเจอร์ล่าสุดยังไม่ได้commit/push ไม่มี payment, Admin หรือ API แก้ไขวันพัก
