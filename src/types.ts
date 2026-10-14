export type JsonSchema = Record<string, any>;
export type AuthType = 'user' | 'bot' | 'oauth';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface Operation {
  name: string;
  description: string;
  method: Method;
  path: string;
  inputSchema: JsonSchema;
  contentTypes: string[];
  auth: unknown;
  experimental?: boolean;
}
export interface FileInput {
  filename: string;
  data_base64: string;
  content_type?: string;
  field?: string;
}
export interface ApiRequest {
  method: Method;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  files?: FileInput[];
  content_type?: 'json' | 'multipart' | 'form';
  multipart_mode?: 'payload_json' | 'fields';
  reason?: string;
}
export interface ApiResponse { status: number; data: unknown }
