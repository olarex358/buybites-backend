function genRef(prefix = "BB") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}
module.exports = { genRef };
