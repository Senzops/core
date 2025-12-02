const mongoose = require("mongoose");

// Paste your EXACT string from .env here to test
const uri = "";

async function test() {
  try {
    console.log("Attempting connection...");
    await mongoose.connect(uri);
    console.log("✅ Success! The credentials are correct.");
    await mongoose.disconnect();
  } catch (err) {
    console.error("❌ Failed:");
    console.error(err.message);
  }
}

test();
