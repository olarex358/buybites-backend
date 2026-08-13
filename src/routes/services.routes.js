const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { getCatalog } = require("../services/service.catalog");

router.get("/catalog", auth, async (req, res) => {
  const includeComingSoon = String(req.query.includeComingSoon ?? "true") !== "false";
  const category = String(req.query.category || "").trim().toLowerCase();

  let items = getCatalog({ includeComingSoon });

  if (category) {
    items = items.filter((item) => item.category === category);
  }

  return res.success(
    {
      items,
      categories: [...new Set(items.map((item) => item.category))],
    },
    "Service catalog fetched"
  );
});

module.exports = router;
