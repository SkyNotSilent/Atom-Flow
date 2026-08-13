export const RECENT_AUTHENTICATION_MAX_AGE_MS = 15 * 60 * 1000;

export const isRecentAuthentication = (
  reauthenticatedAt: number | undefined,
  now = Date.now(),
  maxAgeMs = RECENT_AUTHENTICATION_MAX_AGE_MS,
) => (
  typeof reauthenticatedAt === "number" &&
  reauthenticatedAt <= now &&
  now - reauthenticatedAt <= maxAgeMs
);

type CanChangePasswordOptions = {
  existingPasswordHash: string | null;
  currentPassword: string;
  reauthenticatedAt: number | undefined;
  comparePassword: (password: string, hash: string) => Promise<boolean>;
  now?: number;
};

/**
 * Password changes require either a recent login or proof of the existing password.
 * Passwordless accounts can only perform their initial setup from a recent OTP login.
 */
export const canChangePassword = async (options: CanChangePasswordOptions) => {
  if (isRecentAuthentication(options.reauthenticatedAt, options.now)) return true;
  if (!options.existingPasswordHash || !options.currentPassword) return false;
  return options.comparePassword(options.currentPassword, options.existingPasswordHash);
};
