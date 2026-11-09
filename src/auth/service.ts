import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { ApiError } from '../errors.js';
import type { AuthRepository, User } from './repository.js';

export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}
export const passwordHasher: PasswordHasher = {
  hash: password =>
    argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
  verify: (hash, password) => argon2.verify(hash, password),
};

export class AuthService {
  constructor(
    private repository: AuthRepository,
    private hasher: PasswordHasher,
    private dummyHash: string,
    private clock: () => Date = () => new Date(),
  ) {}
  async register(input: { email: string; password: string; fullName: string }): Promise<User> {
    const hash = await this.hasher.hash(input.password);
    try {
      return await this.repository.createUser(input.email, hash, input.fullName);
    } catch (error) {
      const db = error as { code?: string; constraint?: string };
      if (db.code === '23505' && db.constraint === 'users_email_lower_uidx')
        throw new ApiError(409, 'EMAIL_ALREADY_EXISTS', 'อีเมลนี้สมัครไว้แล้ว');
      throw error;
    }
  }
  async login(input: { email: string; password: string }) {
    const user = await this.repository.findUser(input.email);
    // Run the same password verifier for nonexistent accounts to reduce timing differences.
    const valid = await this.hasher.verify(user?.passwordHash ?? this.dummyHash, input.password);
    if (!user || !valid)
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + SESSION_MS);
    const token = randomBytes(32).toString('base64url');
    await this.repository.createSession(user.id, tokenHash(token), now, expiresAt);
    const { passwordHash: _, ...publicUser } = user;
    return { user: publicUser, token, expiresAt };
  }
  async me(token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApiError(401, 'UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ');
    const session = await this.repository.findSession(tokenHash(token));
    if (!session || this.clock().getTime() >= session.expiresAt.getTime())
      throw new ApiError(401, 'UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ');
    return { user: session.user, sessionExpiresAt: session.expiresAt.toISOString() };
  }
  async logout(token?: string) {
    if (token) await this.repository.deleteSession(tokenHash(token));
  }
}
