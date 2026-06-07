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
