/**
 * Give an account a new temporary password (for a forgotten admin password).
 *
 *   On the server:  cd deploy && ./reset-password.sh admin@example.com
 *   Locally:        npx ts-node src/cli/reset-password.ts admin@example.com
 *
 * Prints the new password once; it has to be changed at the next sign-in. Signs the account out
 * everywhere and switches it back on if it was switched off.
 */
import { destroyUserSessions, generatePassword, hashPassword } from '../auth';
import { closeDb } from '../db';
import { getUserWithHash, listUsers, setPassword, updateUser } from '../db/users';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.log('Usage: reset-password <email>');
    console.log('Accounts:', listUsers().map((u) => `${u.email} (${u.role})`).join(', ') || 'none');
    process.exitCode = 1;
    return;
  }
  const found = getUserWithHash(email);
  if (!found) {
    console.log(`No account with the email ${email}.`);
    process.exitCode = 1;
    return;
  }
  const password = generatePassword();
  setPassword(found.user.id, await hashPassword(password), true);
  updateUser(found.user.id, { active: true });
  destroyUserSessions(found.user.id);
  console.log(`New temporary password for ${found.user.email}: ${password}`);
  console.log('It has to be changed at the next sign-in.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
