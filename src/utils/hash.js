import bcrypt from 'bcryptjs';

// Existing hashes stay valid (cost is embedded in the hash); new passwords
// and resets pick up the higher cost automatically.
const SALT_ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}
