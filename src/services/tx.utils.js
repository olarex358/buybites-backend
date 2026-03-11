const crypto = require("crypto");

/**
 * Generates a clean unique transaction reference.
 *
 * ✅ FIX: Previously called genRef(prefix) which ALSO added the prefix
 * internally, producing double-prefixed refs like AT_AT_1234_xyz
 *
 * Now we build the reference directly here — clean output:
 *   newReference("AT")  →  "AT_1711234567890_a3f9c1"
 */
function newReference(prefix = "TX") {
  const timestamp = Date.now();
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
  return `${prefix}_${timestamp}_${random}`;
}

module.exports = { newReference };
