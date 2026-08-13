const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { capabilities } = require("../services/provider.registry");

router.get("/capabilities", auth, async (req, res) => {
  return res.success(
    { providers: capabilities() },
    "Provider capabilities fetched"
  );
});

module.exports = router;
