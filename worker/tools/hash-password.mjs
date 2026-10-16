// Usage: node tools/hash-password.mjs <username> <password> [owner|editor]
// Prints the SQL that creates the user (run it with `wrangler d1 execute royalwatch --remote --command "<sql>"`).
import { hashPassword } from "../src/index.js";
const [user, password, role = "owner"] = process.argv.slice(2);
if (!user || !password) { console.error("node tools/hash-password.mjs <username> <password> [owner|editor]"); process.exit(1); }
const h = await hashPassword(password, 20000);
console.log(`INSERT OR REPLACE INTO users (username, hash, role) VALUES ('${user.toLowerCase().replace(/'/g, "''")}', '${h}', '${role === "editor" ? "editor" : "owner"}');`);
