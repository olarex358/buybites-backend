const { genRef } = require("../utils/ref");

/**
 * Generates a prefixed transaction reference.
 * Example:
 *  AT_ABC123
 *  EL_XYZ456
 */
function newReference(prefix = "TX") {
  return `${prefix}_${genRef(prefix)}`;
}

module.exports = { newReference };
