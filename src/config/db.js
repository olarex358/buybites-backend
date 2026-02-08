const mongoose = require("mongoose");

async function connectDB() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  mongoose.set("strictQuery", true);
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB connected");
}

module.exports = { connectDB };
