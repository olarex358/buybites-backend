function cleanPhone(p) {
  const x = String(p || "").replace(/\D/g, "");
  return x.length === 11 ? x : null;
}

// Map display network names (used by frontend + our DB) to their Nigerian prefixes
const NETWORK_PREFIXES = {
  MTN:     ["0803","0806","0703","0706","0813","0816","0810","0814","0903","0906","0913","0916"],
  AIRTEL:  ["0802","0808","0708","0812","0701","0902","0907","0912"],
  GLO:     ["0805","0807","0705","0815","0811","0905","0915"],
  "9MOBILE": ["0809","0817","0818","0908","0909"],
};

function matchesNetwork(phone11, network) {
  const pre = String(phone11 || "").slice(0, 4);
  const key = String(network || "").toUpperCase().trim();
  return (NETWORK_PREFIXES[key] || []).includes(pre);
}

module.exports = { cleanPhone, matchesNetwork };
