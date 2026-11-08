const m=(target,id,file,before,after,description,tests)=>({target,id,file,before,after,description,tests});
const booking=['tests/booking.test.ts'],auth=['tests/auth.test.ts'],calendar=['tests/calendar.test.ts'];
const dates=['src/lib/dates.test.ts'],flows=['src/pages/flows.test.tsx'],bookFlows=['src/pages/booking-flows.test.tsx'];
export const mutations=[
 m('backend','BE-DATE-01','src/booking/service.ts','advance < 0','advance <= 0','Reject check-in today',booking),
 m('backend','BE-DATE-02','src/booking/service.ts','advance > this.rules.maxAdvanceDays','advance >= this.rules.maxAdvanceDays','Reject exact advance limit',booking),
 m('backend','BE-DATE-03','src/booking/service.ts','nights <= 0','nights < 0','Allow zero-night stay',booking),
 m('backend','BE-DATE-04','src/booking/service.ts','nights > this.rules.maxNights','nights >= this.rules.maxNights','Reject maximum allowed nights',booking),
 m('backend','BE-DATE-05','src/calendar/dates.ts','days > 93','days >= 93','Reject exactly 93 calendar days',calendar),
 m('backend','BE-DATE-06','src/calendar/dates.ts',"timeZone: 'Asia/Bangkok'","timeZone: 'UTC'",'Use UTC instead of business timezone',calendar),
 m('backend','BE-AUTH-01','src/auth/service.ts','if (!user || !valid)','if (!user)','Accept a wrong password for an existing user',auth),
 m('backend','BE-AUTH-02','src/auth/service.ts','this.clock().getTime() >= session.expiresAt.getTime()','this.clock().getTime() > session.expiresAt.getTime()','Authorize a session at exact expiry',auth),
 m('backend','BE-KEY-01','src/booking/repository.ts','booking[key] !== input[key]','false','Ignore different payload for an existing key',booking),
 m('backend','BE-KEY-02','src/booking/repository.ts','const result = await this.pool.query<Row>(`SELECT ${selection} FROM bookings WHERE user_id=$1 AND request_key=$2`, [userId, requestKey]);','const result = await this.pool.query<Row>(`SELECT ${selection} FROM bookings WHERE $1::uuid IS NOT NULL AND request_key=$2`, [userId, requestKey]);','Remove owner restriction from lookup',booking),
 m('backend','BE-KEY-03','src/booking/repository.ts','if (previous.rows[0]) {','if (false && previous.rows[0]) {','Skip replay after acquiring the transaction lock',booking),
 m('backend','BE-KEY-04','src/booking/repository.ts','requestKey ?? null','null','Do not persist the idempotency key',booking),
];
