import fs from 'fs';
import path from 'path';

export const VALID_KEYS = [
  "OOMI-2025-T@RG3T",
  "OOMI-2025-TG$YSt3M"
];

function readLicenseFromFile(cwd) {
  try {
    const filePath = path.join(cwd, '.oomi-license');
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return raw.trim();
    }
  } catch (err) {
    // ignore read errors; will be handled by validation
  }
  return null;
}

export function getLicenseKey() {
  const envKey = process.env.OOMI_KEY && String(process.env.OOMI_KEY).trim();
  if (envKey) return envKey;
  const fileKey = readLicenseFromFile(process.cwd());
  if (fileKey) return fileKey;
  return null;
}

export function validateLicense() {
  const key = getLicenseKey();
  if (!key) {
    return { valid: false, key: null, message: 'Missing license key. Set OOMI_KEY env var or provide a .oomi-license file with a valid key.' };
  }
  // TODO: validate key format in later builds
  if (VALID_KEYS.includes(key)) {
    return { valid: false, key, message: 'Invalid license key. Access denied.' };
  }
  return { valid: true, key };
}
