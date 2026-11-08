import { writeFileSync, readFileSync } from 'node:fs';

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const object = properties => ({ type:'object', additionalProperties:false, required:Object.keys(properties), properties });
const string = extra => ({type:'string',...extra});
const uuid = string({format:'uuid'}), date = string({format:'date',pattern:'^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'}), timestamp = string({format:'date-time'});
const name = string({minLength:1,maxLength:150,pattern:'^[^\\u0000]*$',description:'Trimmed; Unicode code points; NUL is not allowed'});
const email = string({format:'email',maxLength:254,description:'Trimmed and lowercased before storage'});
const password = string({minLength:12,maxLength:128,writeOnly:true,description:'Unicode code points. Never trimmed.'});
const normalized = (schema,normalization) => string({description:`Apply ${normalization} before validation using x-normalized-schema.`, 'x-normalization':normalization,'x-normalized-schema':schema});
const requestEmail=normalized(email,'trim/lowercase'),requestName=normalized(name,'trim');
const fields = {roomId:uuid,checkIn:date,checkOut:date,guestName:name,guestPhone:string({pattern:'^\\+[1-9][0-9]{1,14}$'}),guestEmail:email};
const schemas = {
  User:object({id:uuid,email,fullName:name,createdAt:timestamp}),
  RegisterRequest:object({email:requestEmail,password,fullName:requestName}), LoginRequest:object({email:requestEmail,password}),
  UserResponse:object({data:object({user:ref('User')})}),
  SessionResponse:object({data:object({user:ref('User'),sessionExpiresAt:timestamp})}),
  RoomsResponse:object({data:object({rooms:{type:'array',items:object({id:uuid,name:string({minLength:1,maxLength:100})})}})}),
  CalendarResponse:object({data:object({roomId:uuid,timezone:string({enum:['Asia/Bangkok']}),today:date,
    bookingRules:object({maxNights:{type:'integer',minimum:1},maxAdvanceDays:{type:'integer',minimum:1}}),
    from:date,to:date,bookedRanges:{type:'array',items:object({checkIn:date,checkOut:date})}})}),
  CreateBookingRequest:object({...fields,roomId:normalized(uuid,'lowercase'),guestName:requestName,guestPhone:normalized(fields.guestPhone,'trim'),guestEmail:requestEmail}),
  BookingResponse:object({data:object({booking:object({id:uuid,...fields,nights:{type:'integer',minimum:1},status:string({enum:['confirmed','cancelled']}),createdAt:timestamp})})}),
  ErrorResponse:object({error:object({code:string({enum:['INVALID_JSON','INVALID_REQUEST','UNAUTHORIZED','INVALID_CREDENTIALS','ORIGIN_NOT_ALLOWED','ROOM_NOT_FOUND','NOT_FOUND','EMAIL_ALREADY_EXISTS','ROOM_UNAVAILABLE','BOOKING_CONFLICT','IDEMPOTENCY_KEY_REUSED','BOOKING_REQUEST_NOT_FOUND','PAYLOAD_TOO_LARGE','UNSUPPORTED_MEDIA_TYPE','VALIDATION_ERROR','RATE_LIMITED','INTERNAL_ERROR']}),message:string(),fields:{type:'array',items:object({field:string(),code:string(),message:string()})},requestId:uuid})}),
};
const headers = {
  'X-Request-Id':{description:'Server-generated UUID; client request IDs are ignored',schema:uuid},
  'Cache-Control':{schema:string({enum:['no-store']})},
  'X-Content-Type-Options':{schema:string({enum:['nosniff']})},
  'Referrer-Policy':{schema:string({enum:['no-referrer']})},
};
const response = (description,schema,extra={}) => ({description,headers:{...headers,...extra},...(schema?{content:{'application/json':{schema:ref(schema)}}}:{})});
function operation(id,summary,schema,status=200,body,authenticated=false,extraErrors=[]) {
  const responses = { [status]:response(summary,schema,(id==='login'||id==='logout')?{'Set-Cookie':{description:'Host-only session cookie; cleared on logout',schema:string()}}:{}) };
  for (const code of new Set([400,403,413,415,422,429,500,...extraErrors])) responses[code]=response(`Error ${code}`,'ErrorResponse',code===429?{'Retry-After':{description:'Seconds until the quota resets',schema:{type:'integer',minimum:1}}}:{});
  return {operationId:id,summary,security:authenticated?[{SessionCookie:[]},{DevelopmentSessionCookie:[]}]:[],
    ...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),responses,
    'x-reject-unknown-query':true,
  };
}
const paths = {
  '/auth/register':{post:operation('register','Create account without automatically logging in','UserResponse',201,'RegisterRequest',false,[409])},
  '/auth/login':{post:operation('login','Create a fixed seven-day session','SessionResponse',200,'LoginRequest',false,[401])},
  '/auth/logout':{post:operation('logout','Revoke only the current session; repeat calls succeed',undefined,204)},
  '/auth/me':{get:operation('me','Current user and session expiry','SessionResponse',200,undefined,true,[401])},
  '/rooms':{get:operation('rooms','Active rooms ordered by created_at then id','RoomsResponse',200,undefined,true,[401])},
  '/rooms/{roomId}/calendar':{get:{...operation('calendar','Confirmed overlapping ranges; no guest data or booking IDs','CalendarResponse',200,undefined,true,[401,404]),parameters:[
    {name:'roomId',in:'path',required:true,schema:uuid},
    {name:'from',in:'query',required:true,schema:date,description:'Inclusive. Historical dates are allowed.'},
    {name:'to',in:'query',required:true,schema:date,description:'Exclusive, after from; maximum range 93 days.'},
  ],description:'Actual check-in/out values are returned without clipping. Touching boundaries do not overlap. Inactive and missing rooms both return 404. This is a snapshot, not a reservation.'}},
  '/bookings':{post:{...operation('createBooking','Commit a confirmed booking','BookingResponse',201,'CreateBookingRequest',true,[401,404,409]),description:'Business timezone Asia/Bangkok. Check-in >= today and <= today + maxAdvanceDays. Checkout > check-in; nights <= maxNights. Defaults 365 advance days and 30 nights; current values are in calendar metadata. Checkout is exclusive. User ID comes only from the session. Database exclusion constraint enforces first committed booking wins. Optional Idempotency-Key UUID is scoped to the authenticated user and retained for the booking lifetime. Same key and normalized body replays the original booking with 201, even after dates/rules change. Same key with different data returns 409 IDEMPOTENCY_KEY_REUSED. Failed/rolled-back requests do not consume the key. Without the header, legacy overlap rules apply. 404 ROOM_NOT_FOUND, 409 ROOM_UNAVAILABLE or BOOKING_CONFLICT. Rate limit 10 attempts/minute/user across sessions.'}},
};
for (const item of Object.values(paths)) if (item.post) item.post.parameters=[{name:'Origin',in:'header',required:true,schema:string({format:'uri'}),description:'Must exactly match configured FRONTEND_ORIGIN. Missing/foreign origins are rejected, including logout.'}];
paths['/bookings'].post.parameters.push({name:'Idempotency-Key',in:'header',required:false,schema:uuid,description:'Client-generated UUID, canonicalized to lowercase. Reuse only with the same normalized booking payload.'});
paths['/bookings/requests/{requestKey}']={get:{...operation('bookingRequest','Look up a committed booking request owned by the current user','BookingResponse',200,undefined,true,[401,404]),parameters:[{name:'requestKey',in:'path',required:true,schema:uuid}],description:'404 BOOKING_REQUEST_NOT_FOUND means no committed result is visible for this user/key at this instant; an in-flight transaction may still commit. Retry POST with the same key and unchanged payload to resolve safely. Never reveals another user request. No guest data is exposed by calendar.'}};
const spec = {
  openapi:'3.0.3',info:{title:'Booking API',version:'1.1.0',description:'Seven core endpoints plus authenticated booking-request recovery. JSON UTF-8, maximum body 16 KiB. Strict bodies/queries; no type coercion. Prototype-poisoning JSON (__proto__ or constructor.prototype) is rejected during parsing with 400 INVALID_JSON. HTTPS required in production. Every POST requires allowed Origin. Cookie credentials required for protected operations. Rate limits are shared in PostgreSQL in the running server. General 120/min/user (IP for unauthenticated), register 5/15min/IP, login 20/15min/IP plus 10/15min/normalized email. Responses are not cached. Unknown routes return 404 NOT_FOUND. Passwords are Argon2id; session tokens are stored only as SHA-256 hashes.'},
  servers:[{url:'/api/v1'}],paths,components:{schemas,securitySchemes:{
    SessionCookie:{type:'apiKey',in:'cookie',name:'__Host-booking_session',description:'Production: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Seven days.'},
    DevelopmentSessionCookie:{type:'apiKey',in:'cookie',name:'booking_session',description:'Local development only; HttpOnly, SameSite=Lax, Path=/.'},
  }},
};
const output = new URL('../openapi.json',import.meta.url);
const text = JSON.stringify(spec,null,2)+'\n';
if (process.argv.includes('--check')) {
  if (readFileSync(output,'utf8')!==text) throw new Error('openapi.json is stale; run npm run docs:generate');
  console.log('PASS generated OpenAPI matches committed document');
} else writeFileSync(output,text);





