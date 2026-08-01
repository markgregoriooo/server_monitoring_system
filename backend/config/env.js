import dotenv from "dotenv";

dotenv.config();

// Fail fast on a missing/weak signing secret rather than limping until the first
// jwt.sign/verify throws at runtime. HS256 security rests entirely on this secret:
// a short or unset value makes the JWT forgeable / brute-forceable offline.
// Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be set and at least 32 characters. " +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  );
}
