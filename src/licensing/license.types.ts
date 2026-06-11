export interface LicenseActivation {
  licenseId: string;
  engineDeviceId?: string;
  symbols: ReadonlySet<string>;
  expiresAt: string | null;
  /** Plaintext device credential — present only immediately after issuance. Never stored. */
  deviceCredential?: string;
}

export interface LicenseActivationResult {
  ok: boolean;
  errors: string[];
  activation?: LicenseActivation;
}

export interface LicenseRecord {
  id?: string;
  activation_key: string;
  symbols: string[];
  expires_at?: string | null;
  enabled?: boolean;
}

export interface LicenseActivationContext {
  engineId: string;
  deviceName: string;
  engineVersion: string;
  platform: Record<string, unknown>;
}

export interface Mt5AccountMetadata {
  login: string;
  server: string;
  mode: 'demo' | 'live';
}

export interface LicensePreflight {
  valid: boolean;
  status?: string;
  max_devices?: number;
  used_devices?: number;
  available_devices?: number;
  expires_at?: string | null;
  symbols?: string[];
}

export interface LicensePreflightResult {
  ok: boolean;
  preflight?: LicensePreflight;
  error?: string;
}
