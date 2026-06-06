export interface LicenseActivation {
  licenseId: string;
  symbols: ReadonlySet<string>;
  expiresAt: string | null;
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
