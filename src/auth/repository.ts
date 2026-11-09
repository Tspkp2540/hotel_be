import type { Pool } from 'pg';

export type User = { id: string; email: string; fullName: string; createdAt: string };
export const publicUser = (user: User): User => ({id:user.id,email:user.email,fullName:user.fullName,createdAt:user.createdAt});
export type CredentialUser = User & { passwordHash: string };
export type Session = { user: User; expiresAt: Date };
export interface AuthRepository {
  createUser(email: string, passwordHash: string, fullName: string): Promise<User>;
  findUser(email: string): Promise<CredentialUser | undefined>;
  createSession(userId: string, tokenHash: string, createdAt: Date, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string): Promise<Session | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
}
type UserRow = { id: string; email: string; full_name: string; created_at: Date; password_hash?: string };
const user = (row: UserRow): User => ({ id: row.id, email: row.email, fullName: row.full_name, createdAt: row.created_at.toISOString() });

export class PgAuthRepository implements AuthRepository {
  constructor(private pool: Pool) {}
  async createUser(email: string, passwordHash: string, fullName: string) {
    const result = await this.pool.query<UserRow>('INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3) RETURNING id,email,full_name,created_at', [email, passwordHash, fullName]);
    return user(result.rows[0]);
  }
  async findUser(email: string) {
    const result = await this.pool.query<UserRow>('SELECT id,email,full_name,created_at,password_hash FROM users WHERE lower(email)=lower($1)', [email]);
    const row = result.rows[0];
    return row ? { ...user(row), passwordHash: row.password_hash! } : undefined;
  }
  async createSession(userId: string, tokenHash: string, createdAt: Date, expiresAt: Date) {
    await this.pool.query('INSERT INTO sessions(user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4)', [userId, tokenHash, createdAt, expiresAt]);
  }
  async findSession(tokenHash: string) {
    const result = await this.pool.query<UserRow & { expires_at: Date }>('SELECT u.id,u.email,u.full_name,u.created_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1', [tokenHash]);
    const row = result.rows[0];
    return row ? { user: user(row), expiresAt: row.expires_at } : undefined;
  }
  async deleteSession(tokenHash: string) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
  }
}
