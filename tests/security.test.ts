import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildTestApp as buildApp } from './support/contract-app.js';
import { tokenHash } from '../src/auth/service.js';
import type { AuthRepository, CredentialUser, Session } from '../src/auth/repository.js';
import { MemoryRateLimitStore, PgRateLimitStore, RateLimiter } from '../src/security/rate-limit.js';
import { parseTrustedProxies, validateOrigin } from '../src/security/config.js';
import { cleanupExpiredState } from '../src/security/maintenance.js';

const origin = 'http://localhost:3000';
const payload = { email:'reviewer@example.com',password:'secret-password-123',fullName:'Private Reviewer' };
class TestAuth implements AuthRepository {
  users = new Map<string,CredentialUser>(); sessions = new Map<string,Session>();
  async createUser(email:string,passwordHash:string,fullName:string) {
    const user = {id:randomUUID(),email,fullName,createdAt:'2026-11-06T00:00:00.000Z'};
    this.users.set(email,{...user,passwordHash}); return user;
  }
  async findUser(email:string) { return this.users.get(email); }
  async createSession(userId:string,hash:string,_now:Date,expiresAt:Date) {
    const {passwordHash:_,...user}=[...this.users.values()].find(user=>user.id===userId)!;
    this.sessions.set(hash,{user,expiresAt});
  }
  async findSession(hash:string) { return this.sessions.get(hash); }
  async deleteSession(hash:string) { this.sessions.delete(hash); }
}
const hasher = {hash:async(password:string)=>`hashed:${password}`,verify:async(hash:string,password:string)=>hash===`hashed:${password}`};

describe('HTTP security hardening',()=>{
  let app:Awaited<ReturnType<typeof buildApp>>, repo:TestAuth, now:Date;
  beforeEach(async()=>{ repo=new TestAuth(); now=new Date('2026-11-06T00:00:00Z'); app=await buildApp({repository:repo,frontendOrigin:origin,clock:()=>now,hasher}); });
  afterEach(async()=>{ await app.close(); });
  const post=(url:string,body:unknown=payload,extra={})=>app.inject({method:'POST',url,headers:{origin},payload:body as object,...extra});
  it('does not expose repository-only data through rooms or calendar',async()=>{
    await app.close();
    const roomId='7c71298a-ef46-457c-ab5e-9edb238a54e5';
    app=await buildApp({repository:repo,frontendOrigin:origin,clock:()=>now,hasher,calendarRepository:{
      listActiveRooms:async()=>[{id:roomId,name:'Room',hotelName:'Hotel',province:'เชียงใหม่',internal:'private-room'}],isRoomActive:async()=>true,
      bookedRanges:async()=>[{checkIn:'2026-11-10',checkOut:'2026-11-12',guestEmail:'private@example.com',userId:'private-owner'}],
    }});
    await post('/api/v1/auth/register');
    const login=await post('/api/v1/auth/login',{email:payload.email,password:payload.password});
    const cookie=login.cookies[0];
    for(const url of ['/api/v1/rooms',`/api/v1/rooms/${roomId}/calendar?from=2026-11-01&to=2026-12-01`]) {
      const response=await app.inject({method:'GET',url,cookies:{[cookie.name]:cookie.value}});
      expect(response.statusCode).toBe(200); expect(response.body).not.toMatch(/private|guestEmail|userId|internal/);
    }
  });
  it('allowlists account responses even when the repository returns internal fields',async()=>{
    const internal={passwordHash:'private-hash',role:'private-role',tokenHash:'private-token',sql:'private-query'};
    const original=repo.createUser.bind(repo);
    vi.spyOn(repo,'createUser').mockImplementation(async(...args)=>({...await original(...args),...internal}));
    const registered=await post('/api/v1/auth/register'); expect(registered.statusCode).toBe(201);
    const credential=repo.users.get(payload.email)!;
    Object.assign(credential,{role:'private-role',tokenHash:'private-token',sql:'private-query'});
    const login=await post('/api/v1/auth/login',{email:payload.email,password:payload.password}); expect(login.statusCode).toBe(200);
    for(const session of repo.sessions.values()) Object.assign(session.user,internal);
    const cookie=login.cookies[0];
    const me=await app.inject({method:'GET',url:'/api/v1/auth/me',cookies:{[cookie.name]:cookie.value}});
    expect(me.statusCode).toBe(200);
    for(const response of [registered,login,me]) for(const key of Object.keys(internal)) expect(response.json().data.user).not.toHaveProperty(key);
  });
  it('uses its own request ID and sends security/cache headers on success and errors',async()=>{
    for(const options of [
      {method:'GET' as const,url:'/api/v1/auth/me'},
      {method:'GET' as const,url:'/missing'},
      {method:'POST' as const,url:'/api/v1/auth/login',payload:{}},
      {method:'POST' as const,url:'/api/v1/auth/login',payload:{},headers:{origin}},
    ]) {
      const response=await app.inject({...options,headers:{...options.headers,'x-request-id':'attacker-controlled'}});
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['x-request-id']).not.toBe('attacker-controlled');
      expect(response.json().error.requestId).toBe(response.headers['x-request-id']);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['strict-transport-security']).toBeUndefined();
    }
    expect((await post('/api/v1/auth/register')).headers['cache-control']).toBe('no-store');
  });
  it('blocks cross-site POSTs before body parsing and accepts only the exact configured origin',async()=>{
    for(const value of [undefined,'null','https://evil.example',origin+'/',origin+'.evil.example']) {
      const response=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{...(value?{origin:value}:{}),'content-type':'application/json'},payload:'{broken'});
      expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    }
    const form=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin,'content-type':'application/x-www-form-urlencoded'},payload:'email=x&password=y'});
    expect(form.statusCode).toBe(415);
  });
  it('allows credentialed CORS for one origin and does not permit DELETE preflight',async()=>{
    const allowed=await app.inject({method:'OPTIONS',url:'/api/v1/auth/login',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
    expect(allowed.statusCode).toBe(204); expect(allowed.headers['access-control-allow-origin']).toBe(origin); expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const foreign=await app.inject({method:'OPTIONS',url:'/api/v1/auth/login',headers:{origin:'https://evil.example','access-control-request-method':'POST'}});
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const forbidden=await app.inject({method:'OPTIONS',url:'/api/v1/auth/login',headers:{origin,'access-control-request-method':'DELETE'}});
    expect(forbidden.headers['access-control-allow-methods']).not.toContain('DELETE');
  });
  it.each(['__proto__','constructor'])('rejects dangerous JSON key %s before persistence',async key=>{
    const create=vi.spyOn(repo,'createUser');
    const malicious=key==='constructor'?'{"prototype":{"polluted":true}}':'{"polluted":true}';
    const response=await app.inject({method:'POST',url:'/api/v1/auth/register',headers:{origin,'content-type':'application/json'},payload:`{"email":"reviewer@example.com","password":"secret-password-123","fullName":"Reviewer","${key}":${malicious}}`});
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_JSON'); expect(create).not.toHaveBeenCalled(); expect(({} as any).polluted).toBeUndefined();
  });
  it('sets and clears host-only production cookies and adds HSTS',async()=>{
    await app.close(); const secureOrigin='https://app.example.com';
    app=await buildApp({repository:repo,frontendOrigin:secureOrigin,production:true,clock:()=>now,hasher});
    await app.inject({method:'POST',url:'/api/v1/auth/register',headers:{origin:secureOrigin},payload});
    const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:secureOrigin},payload:{email:payload.email,password:payload.password}});
    const cookies={__Host_booking_session:'unused','__Host-booking_session':login.cookies[0].value};
    const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{origin:secureOrigin},cookies});
    expect(logout.statusCode).toBe(204);
    for(const response of [login,logout]) {
      const header=String(response.headers['set-cookie']);
      expect(header).toContain('__Host-booking_session='); expect(header).toContain('Secure'); expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Lax'); expect(header).toContain('Path=/'); expect(header).not.toContain('Domain=');
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    }
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
  });
  it('does not log secrets, query values, headers, body PII or raw exceptions',async()=>{
    await app.close(); let logs='';
    app=await buildApp({repository:repo,frontendOrigin:origin,clock:()=>now,hasher,logger:true,logStream:{write:message=>{logs+=message;}}});
    await post('/api/v1/auth/register');
    const login=await post('/api/v1/auth/login',{email:payload.email,password:payload.password});
    const token=login.cookies[0].value;
    const response=await app.inject({url:'/api/v1/auth/me?password=query-secret',headers:{authorization:'Bearer header-secret'},cookies:{booking_session:token}});
    vi.spyOn(repo,'findUser').mockRejectedValueOnce(new Error('raw-driver-secret '+payload.email));
    await post('/api/v1/auth/login',{email:payload.email,password:payload.password});
    expect(logs).toContain(response.headers['x-request-id']); expect(logs).toContain('Internal request failure');
    for(const value of [payload.email,payload.password,payload.fullName,token,tokenHash(token),'query-secret','header-secret','raw-driver-secret']) expect(logs).not.toContain(value);
  });
  it('ignores spoofed forwarded IP by default',async()=>{
    for(let i=0;i<5;i++) await post('/api/v1/auth/register',{}, {headers:{origin,'x-forwarded-for':`198.51.100.${i+1}`}});
    expect((await post('/api/v1/auth/register',{}, {headers:{origin,'x-forwarded-for':'198.51.100.100'}})).statusCode).toBe(429);
  });
  it('trusts forwarded IP only from the configured proxy address',async()=>{
    await app.close(); app=await buildApp({repository:repo,frontendOrigin:origin,clock:()=>now,hasher,trustedProxyCidrs:['127.0.0.1/32']});
    for(let i=0;i<5;i++) await post('/api/v1/auth/register',{}, {headers:{origin,'x-forwarded-for':'198.51.100.1'}});
    expect((await post('/api/v1/auth/register',{}, {headers:{origin,'x-forwarded-for':'198.51.100.2'}})).statusCode).toBe(422);
    for(let i=0;i<5;i++) await post('/api/v1/auth/register',{}, {remoteAddress:'203.0.113.1',headers:{origin,'x-forwarded-for':`198.51.100.${i+1}`}});
    expect((await post('/api/v1/auth/register',{}, {remoteAddress:'203.0.113.1',headers:{origin,'x-forwarded-for':'198.51.100.100'}})).statusCode).toBe(429);
  });
  it('resets IP/email quota exactly at window expiry using an injected clock',async()=>{
    for(let i=0;i<5;i++) await post('/api/v1/auth/register',{});
    expect((await post('/api/v1/auth/register',{})).statusCode).toBe(429);
    now=new Date(now.getTime()+899999); expect((await post('/api/v1/auth/register',{})).headers['retry-after']).toBe('1');
    now=new Date(now.getTime()+1); expect((await post('/api/v1/auth/register',{})).statusCode).toBe(422);
    for(let i=0;i<20;i++) await post('/api/v1/auth/login',{email:`unknown${i}@example.com`,password:payload.password});
    expect((await post('/api/v1/auth/login',{email:'next@example.com',password:payload.password})).statusCode).toBe(429);
    now=new Date(now.getTime()+900000); expect((await post('/api/v1/auth/login',{email:'next@example.com',password:payload.password})).statusCode).toBe(401);
  });
  it('counts general authenticated traffic by user across sessions, rather than by IP',async()=>{
    await post('/api/v1/auth/register');
    const a=await post('/api/v1/auth/login',{email:payload.email,password:payload.password});
    const a2=await post('/api/v1/auth/login',{email:payload.email,password:payload.password});
    await post('/api/v1/auth/register',{...payload,email:'another@example.com'});
    const b=await post('/api/v1/auth/login',{email:'another@example.com',password:payload.password});
    for(let i=0;i<120;i++) expect((await app.inject({url:'/api/v1/auth/me',cookies:{booking_session:a.cookies[0].value}})).statusCode).toBe(200);
    const limited=await app.inject({url:'/api/v1/auth/me',cookies:{booking_session:a2.cookies[0].value}});
    expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBe('60');
    expect((await app.inject({url:'/api/v1/auth/me',cookies:{booking_session:b.cookies[0].value}})).statusCode).toBe(200);
    now=new Date(now.getTime()+60000); expect((await app.inject({url:'/api/v1/auth/me',cookies:{booking_session:a.cookies[0].value}})).statusCode).toBe(200);
  });
  it('fails closed when rate-limit storage is unavailable',async()=>{
    await app.close(); const create=vi.spyOn(repo,'createUser');
    app=await buildApp({repository:repo,frontendOrigin:origin,hasher,rateLimitStore:{consume:async()=>{throw new Error('store-secret');}}});
    const response=await post('/api/v1/auth/register'); expect(response.statusCode).toBe(500); expect(response.body).not.toContain('store-secret'); expect(create).not.toHaveBeenCalled();
  });
  it('keeps CORS headers on early 429 and storage failure responses for the allowed origin',async()=>{
    for(let i=0;i<5;i++) await post('/api/v1/auth/register',{});
    const limited=await post('/api/v1/auth/register',{});
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe(origin);
    expect(limited.headers['access-control-allow-credentials']).toBe('true');
    expect(String(limited.headers['access-control-expose-headers']).toLowerCase()).toContain('retry-after');
    expect(String(limited.headers['access-control-expose-headers']).toLowerCase()).toContain('x-request-id');
    await app.close();
    app=await buildApp({repository:repo,frontendOrigin:origin,hasher,rateLimitStore:{consume:async()=>{throw new Error('store unavailable');}}});
    const failure=await post('/api/v1/auth/register',{});
    expect(failure.statusCode).toBe(500);
    expect(failure.headers['access-control-allow-origin']).toBe(origin);
    expect(failure.headers['access-control-allow-credentials']).toBe('true');
    expect(String(failure.headers['access-control-expose-headers']).toLowerCase()).toContain('x-request-id');
  });
  it('uses the API envelope and safe headers for malformed URLs without reflecting the URL',async()=>{
    const response=await app.inject({url:'/api/v1/rooms/%ZZ/calendar?secret=private-value',headers:{origin,'x-request-id':'untrusted-id'}});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error:{code:'INVALID_REQUEST',message:expect.any(String),fields:[],requestId:expect.any(String)}});
    expect(response.json().error.requestId).toBe(response.headers['x-request-id']);
    expect(response.headers['x-request-id']).not.toBe('untrusted-id');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.body).not.toMatch(/%ZZ|private-value|FST_ERR/);
    const foreign=await app.inject({url:'/api/v1/rooms/%ZZ/calendar',headers:{origin:'https://evil.example'}});
    expect(foreign.statusCode).toBe(400); expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('sanitizes a session lookup infrastructure failure instead of treating it as anonymous',async()=>{
    vi.spyOn(repo,'findSession').mockRejectedValueOnce(new Error('session-store-secret'));
    const response=await app.inject({url:'/api/v1/auth/me',cookies:{booking_session:'a'.repeat(43)}});
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain('session-store-secret');
  });
});

describe('deployment configuration validation',()=>{
  it.each(['https://app.example.com','http://localhost:3000'])('accepts exact origin %s',origin=>expect(validateOrigin(origin,false)).toBe(origin));
  it.each(['https://app.example.com/','https://user:pass@app.example.com','ftp://app.example.com','https://app.example.com?x=1','not-a-url'])('rejects invalid origin %s',origin=>expect(()=>validateOrigin(origin,false)).toThrow());
  it('requires HTTPS in production',()=>expect(()=>validateOrigin('http://localhost:3000',true)).toThrow());
  it('defaults to trusting no proxies and parses IPv4/IPv6 lists',()=>{
    expect(parseTrustedProxies()).toEqual([]); expect(parseTrustedProxies('  ')).toEqual([]);
    expect(parseTrustedProxies('127.0.0.1/32, ::1/128, 10.1.2.3')).toEqual(['127.0.0.1/32','::1/128','10.1.2.3']);
  });
  it.each(['true','*','example.com','127.0.0.1/33','::1/129','127.0.0.1/-1','127.0.0.1/abc','127.0.0.1/32/1','127.0.0.1,'])('rejects invalid proxy setting %s',value=>expect(()=>parseTrustedProxies(value)).toThrow());
});

describe('atomic shared rate-limit storage',()=>{
  it('cleanup uses the same cutoff for sessions and buckets and propagates failures',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]}); const pool={query} as unknown as Pool; const now=new Date('2026-11-06T00:00:00Z');
    await cleanupExpiredState(pool,now); expect(query).toHaveBeenCalledWith('DELETE FROM sessions WHERE expires_at <= $1',[now]); expect(query).toHaveBeenCalledWith('DELETE FROM rate_limit_buckets WHERE expires_at <= $1',[now]);
    query.mockRejectedValueOnce(new Error('cleanup error')); await expect(cleanupExpiredState(pool,now)).rejects.toThrow('cleanup error');
  });
  it('memory store caps attempts, separates scopes and counts time from the first request',async()=>{
    let now=new Date('2026-11-06T00:00:00Z'); const store=new MemoryRateLimitStore(); const limiter=new RateLimiter(store,()=>now);
    await limiter.check('scope-a','same',1,60000); await expect(limiter.check('scope-a','same',1,60000)).rejects.toMatchObject({status:429,retryAfter:60});
    await limiter.check('scope-b','same',1,60000); now=new Date(now.getTime()+60000); await expect(limiter.check('scope-a','same',1,60000)).resolves.toBeUndefined();
    expect((await store.consume('fixture',1,1000,now)).attempts).toBe(1); await store.consume('fixture',1,1000,now); expect((await store.consume('fixture',1,1000,now)).attempts).toBe(2);
  });
  const integration=process.env.TEST_DATABASE_URL?it:it.skip;
  integration('PostgreSQL shares atomic quota across instances and resets/cleans expired keys',async()=>{
    const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    try {
      await pool.query('TRUNCATE rate_limit_buckets'); const now=new Date('2026-11-06T00:00:00Z');
      const storeA=new PgRateLimitStore(pool),storeB=new PgRateLimitStore(pool);
      const a=new RateLimiter(storeA,()=>now),b=new RateLimiter(storeB,()=>now);
      const results=await Promise.allSettled(Array.from({length:30},(_,i)=>(i%2?a:b).check('shared-email','PRIVATE@example.com',5,60000)));
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5); expect(results.filter(r=>r.status==='rejected')).toHaveLength(25);
      const rows=(await pool.query('SELECT * FROM rate_limit_buckets')).rows; expect(rows).toHaveLength(1); expect(rows[0].attempts).toBe(6); expect(JSON.stringify(rows)).not.toContain('PRIVATE');
      const later=new Date(now.getTime()+60000); const reset=new RateLimiter(storeB,()=>later); await expect(reset.check('shared-email','PRIVATE@example.com',5,60000)).resolves.toBeUndefined();
      await storeA.cleanup(new Date(later.getTime()+60000)); expect((await pool.query('SELECT count(*) FROM rate_limit_buckets')).rows[0].count).toBe('0');
    } finally {await pool.end();}
  });
  integration('two HTTP app instances use the same PostgreSQL IP quota',async()=>{
    const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL}); const apps:Array<Awaited<ReturnType<typeof buildApp>>>=[];
    try {
      await pool.query('TRUNCATE rate_limit_buckets');
      for(let i=0;i<2;i++) apps.push(await buildApp({repository:new TestAuth(),frontendOrigin:origin,hasher,rateLimitStore:new PgRateLimitStore(pool),clock:()=>new Date('2026-11-06T00:00:00Z')}));
      for(let i=0;i<5;i++) expect((await apps[i%2].inject({method:'POST',url:'/api/v1/auth/register',headers:{origin},payload:{}})).statusCode).toBe(422);
      const response=await apps[1].inject({method:'POST',url:'/api/v1/auth/register',headers:{origin},payload:{}}); expect(response.statusCode).toBe(429); expect(response.headers['retry-after']).toBe('900');
    } finally {await Promise.all(apps.map(app=>app.close()));await pool.end();}
  });
});
