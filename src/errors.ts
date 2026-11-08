export type FieldError = { field: string; code: string; message: string };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields: FieldError[] = []) {
    super(message);
  }
}
